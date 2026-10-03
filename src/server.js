import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { upiqrSync } from 'upiqr';
import { configuration } from './config.js';
import { Store } from './store.js';
import { amountToPaise, rupees } from './payment.js';

const publicDir = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
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

export function createServer(config, store = new Store(config.dbPath)) {
  if (config.token.length < 32) throw new Error('ADMIN_API_TOKEN must be at least 32 characters');
  new URL(config.baseUrl);
  const limits = new Map();
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
      const now = Date.now();
      const key = req.socket.remoteAddress;
      if (limits.size > 10000) for (const [ip, record] of limits) if (record.until < now) limits.delete(ip);
      const record = limits.get(key) || { count: 0, until: now + 60000 };
      if (record.until < now) { record.count = 0; record.until = now + 60000; }
      record.count++; limits.set(key, record);
      if (record.count > 240) return json(429, { error: 'Too many requests' });
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'Origin not allowed' });
      if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        return json(415, { error: 'Use application/json' });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!equalToken(req.headers.authorization, `Bearer ${config.token}`)) return json(401, { error: 'Unauthorized' });
        if (req.method === 'POST' && url.pathname === '/api/admin/topups') {
          if (!/^[\w.+-]+@[\w.-]+$/.test(config.payeeVpa)) throw new Error('Configure a valid PAYEE_VPA');
          if (!config.merchantId) throw new Error('Configure GPAY_TRANSACTIONS_URL');
          const input = await body(req);
          if (typeof input.resellerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.resellerId)) throw new Error('Invalid reseller ID');
          const topup = store.createTopup(input.resellerId, amountToPaise(input.amount));
          return json(201, { id: topup.id, expiresAt: topup.expires_at,
            checkoutUrl: `${origin}/checkout/${topup.id}#token=${topup.token}` });
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
      if (!match) return json(404, { error: 'Not found' });
      const topup = store.authorizedTopup(match[1], req.headers['x-checkout-token']);
      if (!topup) return json(404, { error: 'Top-up not found' });
      if (req.method === 'POST' && match[2]) {
        const input = await body(req);
        store.claim(topup.id, input.rrn);
        return json(200, { status: 'AWAITING_VERIFICATION' });
      }
      if (req.method !== 'GET' || match[2]) return json(405, { error: 'Method not allowed' });
      const { qr, intent } = upiqrSync({ payeeVPA: config.payeeVpa, payeeName: config.payeeName,
        amount: rupees(topup.amount_paise), currency: 'INR', transactionRef: topup.id.replaceAll('-', ''),
        transactionNote: `Top-up ${topup.id}` });
      return json(200, { id: topup.id, amount: rupees(topup.amount_paise), payeeName: config.payeeName,
        payeeVpa: config.payeeVpa, expiresAt: topup.expires_at, claimedRrn: topup.claimed_rrn,
        status: store.verify(topup, config.merchantId), qr, intent });
    } catch (error) {
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
