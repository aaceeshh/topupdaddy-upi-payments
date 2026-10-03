import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { upiqrSync } from 'upiqr';
import { configuration } from './config.js';
import { Store } from './store.js';
import { amountToPaise, rupees } from './payment.js';
import { createClientKeyResolver, createRateLimits } from './rate-limit.js';

const publicDir = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/topupdaddy-logo.png', ['topupdaddy-logo.png', 'image/png']]
]);

function equalToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 8192) throw new Error('Request too large');
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON object');
  return value;
}

export function createServer(config, store = new Store(config.dbPath, { checkoutTokenTtlSeconds: config.checkoutTokenTtlSeconds })) {
  if (config.token.length < 32) throw new Error('ADMIN_API_TOKEN must be at least 32 characters');
  new URL(config.baseUrl);
  const clientKey = createClientKeyResolver(config.trustedProxyCidrs);
  const limit = createRateLimits();
  const server = http.createServer(async (req, res) => {
    const origin = new URL(config.baseUrl).origin;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(200, { status: 'ok' });
      if (req.method === 'GET' && (url.pathname === '/' || /^\/checkout\/[a-f0-9-]{36}$/.test(url.pathname))) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(await readFile(new URL('index.html', publicDir)));
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type });
        return res.end(await readFile(new URL(file, publicDir)));
      }
      if (!url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' });
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'Origin not allowed' });
      if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        return json(415, { error: 'Use application/json' });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!equalToken(req.headers.authorization, `Bearer ${config.token}`)) {
          if (!await limit('adminAuth', clientKey(req), res)) return;
          return json(401, { error: 'Unauthorized' });
        }
        if (!await limit(req.method === 'GET' ? 'adminRead' : 'adminWrite', 'backend', res)) return;
        if (req.method === 'POST' && url.pathname === '/api/admin/topups') {
          if (!/^[\w.+-]+@[\w.-]+$/.test(config.payeeVpa)) throw new Error('Configure a valid PAYEE_VPA');
          if (!config.merchantId) throw new Error('Configure GPAY_TRANSACTIONS_URL');
          const input = await body(req);
          if (typeof input.resellerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.resellerId)) throw new Error('Invalid reseller ID');
          const topup = store.createTopup(input.resellerId, amountToPaise(input.amount));
          return json(201, { id: topup.id, expiresAt: topup.expires_at, tokenExpiresAt: topup.token_expires_at,
            checkoutUrl: `${origin}/checkout/${topup.id}#token=${topup.token}` });
        }
        const checkoutToken = /^\/api\/admin\/topups\/([a-f0-9-]{36})\/checkout-token(\/revoke)?$/.exec(url.pathname);
        if (req.method === 'POST' && checkoutToken) {
          if (checkoutToken[2]) {
            store.revokeCheckoutToken(checkoutToken[1]);
            return json(200, { status: 'REVOKED' });
          }
          const topup = store.rotateCheckoutToken(checkoutToken[1]);
          return json(200, { id: topup.id, expiresAt: topup.expires_at, tokenExpiresAt: topup.token_expires_at,
            checkoutUrl: `${origin}/checkout/${topup.id}#token=${topup.token}` });
        }
        const detail = /^\/api\/admin\/topups\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (req.method === 'GET' && detail) {
          const topup = store.topup(detail[1]);
          if (!topup) return json(404, { error: 'Top-up not found' });
          return json(200, { id: topup.id, resellerId: topup.reseller_id, amount: rupees(topup.amount_paise),
            expiresAt: topup.expires_at, status: store.verify(topup, config.merchantId), creditedAt: topup.credited_at });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/worker') {
          return json(200, store.db.prepare('SELECT status,updated_at,scanned_pages FROM worker_state WHERE id=1').get() || { status: 'NOT_STARTED' });
        }
        const approve = /^\/api\/admin\/topups\/([a-f0-9-]{36})\/approve$/.exec(url.pathname);
        if (req.method === 'POST' && approve) {
          const input = await body(req);
          if (input.ownershipVerified !== true) throw new Error('Independent ownership verification is required');
          return json(200, store.approve(approve[1], config.merchantId, input.reason));
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/ledger') {
          return json(200, { entries: store.db.prepare('SELECT * FROM ledger ORDER BY created_at DESC LIMIT 100').all() });
        }
        return json(404, { error: 'Not found' });
      }
      const match = /^\/api\/topups\/([a-f0-9-]{36})(\/claim)?$/.exec(url.pathname);
      if (!match) {
        if (!await limit('anonymous', clientKey(req), res)) return;
        return json(404, { error: 'Not found' });
      }
      const topup = store.authorizedTopup(match[1], req.headers['x-checkout-token']);
      if (!topup) {
        if (!await limit('anonymous', clientKey(req), res)) return;
        return json(404, { error: 'Top-up not found', code: 'CHECKOUT_UNAVAILABLE' });
      }
      if (!await limit(req.method === 'GET' ? 'checkoutRead' : 'checkoutWrite', topup.id, res)) return;
      if (req.method === 'POST' && match[2]) {
        const input = await body(req);
        store.claim(topup.id, input.rrn, Date.now(), req.headers['x-checkout-token']);
        return json(200, { status: 'AWAITING_VERIFICATION' });
      }
      if (req.method !== 'GET' || match[2]) return json(405, { error: 'Method not allowed' });
      const { qr, intent } = upiqrSync({ payeeVPA: config.payeeVpa, payeeName: config.payeeName,
        amount: rupees(topup.amount_paise), currency: 'INR', transactionRef: topup.id.replaceAll('-', ''),
        transactionNote: `Top-up ${topup.id}` });
      return json(200, { id: topup.id, amount: rupees(topup.amount_paise), payeeName: config.payeeName,
        payeeVpa: config.payeeVpa, expiresAt: topup.expires_at, tokenExpiresAt: topup.token_expires_at, claimedRrn: topup.claimed_rrn,
        status: store.verify(topup, config.merchantId), qr, intent });
    } catch (error) {
      if (error.code === 'CHECKOUT_UNAVAILABLE') return json(404, { error: 'Top-up not found', code: error.code });
      const expected = /Amount|Invalid|RRN|closed|expired|claim|ownership|eligible|Configure|verification|required|Unrecognized|Request too large/i.test(error.message);
      json(expected ? 400 : 500, { error: expected ? error.message : 'Service error; contact the operator' });
    }
  });
  server.requestTimeout = 15000;
  return { server, store };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = configuration();
  const { server, store } = createServer(config);
  server.listen(config.port, config.host, () => console.log(`Checkout server: ${config.baseUrl}`));
  const stop = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
