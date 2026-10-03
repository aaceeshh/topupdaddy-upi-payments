import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { createClientKeyResolver } from '../src/rate-limit.js';
import { tokenHash } from '../src/payment.js';

async function fixture(t, overrides = {}) {
  const store = new Store(':memory:');
  const config = { token: 'security-test-only-'.repeat(3), payeeVpa: 'test@invalid',
    payeeName: 'Test Merchant', merchantId: 'TEST', baseUrl: 'http://127.0.0.1:3000', ...overrides };
  const { server } = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  return { store, config, base: config.baseUrl, admin: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' } };
}
const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } });
const headersFor = (topup) => ({ 'X-Checkout-Token': topup.token, 'Content-Type': 'application/json' });

test('proxy identity rejects spoofed forwarding and walks only explicitly trusted hops', () => {
  const direct = createClientKeyResolver();
  assert.equal(direct(request('192.0.2.10', '198.51.100.1')), '192.0.2.10');
  const trusted = createClientKeyResolver(['127.0.0.1/32', '10.0.0.5/32']);
  assert.equal(trusted(request('127.0.0.1', '198.51.100.1, 203.0.113.9')), '203.0.113.9');
  assert.equal(trusted(request('127.0.0.1', '198.51.100.1, 10.0.0.5')), '198.51.100.1');
  assert.equal(trusted(request('127.0.0.1', 'bad-value')), '127.0.0.1');
  assert.equal(direct(request('::ffff:192.0.2.10')), '192.0.2.10');
  assert.equal(direct(request('2001:db8::1')), direct(request('2001:db8::abcd')));
  assert.notEqual(direct(request('2001:db8::1')), direct(request('2001:db8:1::1')));
  for (const ranges of [['0.0.0.0/0'], ['::/0'], ['true'], ['loopback'], ['192.0.2.1/99']]) {
    assert.throws(() => createClientKeyResolver(ranges));
  }
});

test('anonymous exhaustion cannot deny valid checkout or admin access on the same socket IP', async (t) => {
  const { store, base, admin } = await fixture(t);
  const topup = store.createTopup('r1', 500000);
  for (let i = 0; i < 65; i++) {
    const response = await fetch(`${base}/api/no-such-route`, { headers: { 'X-Forwarded-For': `198.51.100.${i}` } });
    await response.arrayBuffer();
    assert.equal(response.status, i < 60 ? 404 : 429);
    if (i >= 60) assert.ok(Number(response.headers.get('Retry-After')) >= 1);
  }
  assert.equal((await fetch(`${base}/api/topups/${topup.id}`, { headers: headersFor(topup) })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/worker`, { headers: admin })).status, 200);
});

test('trusted proxy clients have independent anonymous limits', async (t) => {
  const { base } = await fixture(t, { trustedProxyCidrs: ['127.0.0.1/32'] });
  for (let i = 0; i < 61; i++) {
    const response = await fetch(`${base}/api/unknown`, { headers: { 'X-Forwarded-For': '198.51.100.1' } });
    await response.arrayBuffer();
    assert.equal(response.status, i < 60 ? 404 : 429);
  }
  assert.equal((await fetch(`${base}/api/unknown`, { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status, 404);
});

test('failed admin authentication cannot consume the authenticated admin budget', async (t) => {
  const { base, admin } = await fixture(t);
  for (let i = 0; i < 31; i++) {
    const response = await fetch(`${base}/api/admin/worker`); await response.arrayBuffer();
    assert.equal(response.status, i < 30 ? 401 : 429);
  }
  assert.equal((await fetch(`${base}/api/admin/worker`, { headers: admin })).status, 200);
});

test('claim limits are per checkout and do not consume read or admin budgets', async (t) => {
  const { store, base, admin } = await fixture(t);
  const first = store.createTopup('r1', 500000);
  const second = store.createTopup('r2', 500000);
  for (let i = 0; i < 6; i++) {
    const response = await fetch(`${base}/api/topups/${first.id}/claim`, { method: 'POST', headers: headersFor(first), body: '{"rrn":"001234567890"}' });
    await response.arrayBuffer(); assert.equal(response.status, i < 5 ? 200 : 429);
  }
  assert.equal((await fetch(`${base}/api/topups/${second.id}/claim`, { method: 'POST', headers: headersFor(second), body: '{"rrn":"001234567891"}' })).status, 200);
  assert.equal((await fetch(`${base}/api/topups/${first.id}`, { headers: headersFor(first) })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/worker`, { headers: admin })).status, 200);
});

test('expired token rejects reads and writes even while payment window remains open', async (t) => {
  const { store, base } = await fixture(t);
  const topup = store.createTopup('r1', 500000, Date.now() - 31 * 60000);
  assert.ok(topup.expires_at > Date.now());
  assert.equal(store.authorizedTopup(topup.id, topup.token, topup.token_expires_at), null);
  for (const options of [{ headers: headersFor(topup) }, { method: 'POST', headers: headersFor(topup), body: '{"rrn":"001234567890"}' }]) {
    const response = await fetch(`${base}/api/topups/${topup.id}${options.method ? '/claim' : ''}`, options);
    assert.equal(response.status, 404);
    const body = await response.json(); assert.equal(body.code, 'CHECKOUT_UNAVAILABLE');
    assert.equal(body.amount, undefined); assert.equal(body.claimedRrn, undefined);
  }
});

test('admin can revoke or rotate tokens; customers cannot; old tokens cannot recover access', async (t) => {
  const { store, base, admin } = await fixture(t);
  const topup = store.createTopup('r1', 500000);
  const endpoint = `${base}/api/admin/topups/${topup.id}/checkout-token`;
  assert.equal((await fetch(endpoint, { method: 'POST', headers: headersFor(topup) })).status, 401);
  assert.equal((await fetch(`${endpoint}/revoke`, { method: 'POST', headers: admin })).status, 200);
  assert.equal((await fetch(`${base}/api/topups/${topup.id}`, { headers: headersFor(topup) })).status, 404);
  assert.throws(() => store.claim(topup.id, '001234567890', Date.now(), topup.token), { code: 'CHECKOUT_UNAVAILABLE' });
  const rotated = await (await fetch(endpoint, { method: 'POST', headers: admin })).json();
  const token = new URLSearchParams(new URL(rotated.checkoutUrl).hash.slice(1)).get('token');
  assert.notEqual(token, topup.token); assert.equal(rotated.expiresAt, topup.expires_at);
  assert.equal((await fetch(`${base}/api/topups/${topup.id}`, { headers: headersFor(topup) })).status, 404);
  assert.equal((await fetch(`${base}/api/topups/${topup.id}`, { headers: headersFor({ token }) })).status, 200);
});

test('credit revokes checkout access but backend retains reconciliation status', async (t) => {
  const { store, base, admin, config } = await fixture(t);
  const topup = store.createTopup('r1', 500000);
  store.claim(topup.id, '001234567890');
  store.observe(config.merchantId, [{ rrn: '001234567890', amountPaise: 500000, receivedAt: Date.now(), status: 'Settled' }]);
  store.setWorkerState('HEALTHY');
  store.approve(topup.id, config.merchantId, 'Independently verified ownership');
  assert.equal((await fetch(`${base}/api/topups/${topup.id}`, { headers: headersFor(topup) })).status, 404);
  assert.throws(() => store.rotateCheckoutToken(topup.id), /closed/);
  const detail = await (await fetch(`${base}/api/admin/topups/${topup.id}`, { headers: admin })).json();
  assert.equal(detail.status, 'CREDITED'); assert.equal(detail.token_hash, undefined);
});

test('legacy database migration expires old links without deleting payment records', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'upi-migration-'));
  const path = join(dir, 'payments.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE topups (id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, amount_paise INTEGER NOT NULL,
    token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, claimed_rrn TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING', credited_at INTEGER, ownership_reason TEXT);`);
  const old = Date.now() - 30 * 86400000;
  db.prepare('INSERT INTO topups (id,reseller_id,amount_paise,token_hash,created_at,expires_at) VALUES (?,?,?,?,?,?)')
    .run('legacy', 'r1', 500000, tokenHash('a'.repeat(64)), old, old + 86400000);
  db.close();
  for (let i = 0; i < 2; i++) {
    const store = new Store(path);
    try {
      assert.equal(store.authorizedTopup('legacy', 'a'.repeat(64)), null);
      assert.equal(store.topup('legacy').amount_paise, 500000);
      assert.equal(store.topup('legacy').token_expires_at, old + 1800000);
    } finally { store.close(); }
  }
});

test('renewal is capped at the original payment deadline and cannot reopen expired top-ups', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const topup = store.createTopup('r1', 500000);
  const renewed = store.rotateCheckoutToken(topup.id, topup.expires_at - 60000);
  assert.equal(renewed.token_expires_at, topup.expires_at);
  assert.equal(store.authorizedTopup(topup.id, renewed.token, topup.expires_at), null);
  assert.throws(() => store.rotateCheckoutToken(topup.id, topup.expires_at), /expired/);
});
