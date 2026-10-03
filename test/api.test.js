import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

test('API authenticates backend requests and keeps receipt submission separate from credit', async (t) => {
  const store = new Store(':memory:');
  const config = { token: 't'.repeat(40), payeeVpa: 'test@upi', payeeName: 'Test Merchant',
    baseUrl: 'http://127.0.0.1:3000', merchantId: 'TEST_MERCHANT' };
  const { server } = createServer(config, store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminHeaders = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/admin/ledger`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/topups`, { method: 'POST', headers: { ...adminHeaders, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const created = await fetch(`${base}/api/admin/topups`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ resellerId: 'r-1', amount: '5000.00' }) });
  assert.equal(created.status, 201);
  const data = await created.json();
  const token = new URLSearchParams(new URL(data.checkoutUrl).hash.slice(1)).get('token');
  assert.equal((await fetch(`${base}/api/topups/${data.id}`)).status, 404);
  const headers = { 'X-Checkout-Token': token, 'Content-Type': 'application/json' };
  const payment = await (await fetch(`${base}/api/topups/${data.id}`, { headers })).json();
  assert.match(payment.qr, /^data:image\/png;base64,/);
  const intent = new URL(payment.intent);
  assert.equal(intent.protocol, 'upi:'); assert.equal(intent.searchParams.get('am'), '5000.00');
  assert.equal(intent.searchParams.get('pa'), 'test@upi');
  assert.equal((await fetch(`${base}/api/topups/${data.id}/claim`, { method: 'POST', headers,
    body: JSON.stringify({ rrn: '001234567890' }) })).status, 200);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
  const now = Date.now();
  store.observe(config.merchantId, [{ rrn: '001234567890', amountPaise: 500000, receivedAt: now, status: 'Settled' }], now);
  store.setWorkerState('HEALTHY');
  assert.equal((await fetch(`${base}/api/admin/topups/${data.id}/approve`, { method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ ownershipVerified: false, reason: 'Untrusted customer assertion' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/admin/topups/${data.id}/approve`, { method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ ownershipVerified: true, reason: 'Verified against independently authenticated payment evidence' }) })).status, 200);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1);
});
