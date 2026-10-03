import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const merchant = 'TEST_MERCHANT';
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = Date.now();
  const topup = store.createTopup('reseller-1', 500000, now);
  const receipt = { rrn: '001234567890', amountPaise: 500000, receivedAt: now, status: 'Settled' };
  store.setWorkerState('HEALTHY');
  return { store, now, topup, receipt };
}

test('a matching receipt verifies payment but cannot self-credit ownership', (t) => {
  const { store, now, topup, receipt } = setup(t);
  store.claim(topup.id, receipt.rrn, now); store.observe(merchant, [receipt], now);
  assert.equal(store.verify(store.topup(topup.id), merchant, now), 'OWNERSHIP_REVIEW');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
  assert.throws(() => store.approve(topup.id, merchant, '', now));
  assert.equal(store.approve(topup.id, merchant, 'Ownership checked against trusted payment evidence', now).duplicate, false);
  assert.equal(store.approve(topup.id, merchant, 'Ownership checked against trusted payment evidence', now).duplicate, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1);
});
test('same RRN cannot credit two reseller wallets', (t) => {
  const { store, now, topup, receipt } = setup(t);
  const other = store.createTopup('reseller-2', 500000, now);
  store.claim(topup.id, receipt.rrn, now); store.claim(other.id, receipt.rrn, now);
  store.observe(merchant, [receipt], now);
  store.approve(topup.id, merchant, 'Trusted evidence links this payment to reseller-1', now);
  assert.equal(store.verify(store.topup(other.id), merchant, now), 'ALREADY_USED');
  assert.throws(() => store.approve(other.id, merchant, 'Trusted evidence links this payment to reseller-2', now));
});
test('amount mismatch, old payment, scheduled status, and stale evidence cannot credit', (t) => {
  const { store, now, topup, receipt } = setup(t);
  store.claim(topup.id, receipt.rrn, now);
  store.observe(merchant, [{ ...receipt, amountPaise: 499999 }], now);
  assert.equal(store.verify(store.topup(topup.id), merchant, now), 'MISMATCH');
  assert.throws(() => store.observe(merchant, [receipt], now));
  const scheduled = { ...receipt, rrn: '001234567891', status: 'Scheduled to settle' };
  const pending = store.createTopup('reseller-1', 500000, now);
  store.claim(pending.id, scheduled.rrn, now); store.observe(merchant, [scheduled], now);
  assert.equal(store.verify(store.topup(pending.id), merchant, now), 'AWAITING_SETTLEMENT');
  store.observe(merchant, [{ ...scheduled, status: 'Settled' }], now);
  assert.equal(store.verify(store.topup(pending.id), merchant, now + 6 * 60000), 'AWAITING_VERIFICATION');
  const old = { ...receipt, rrn: '001234567892', receivedAt: now - 3600000 };
  const third = store.createTopup('reseller-1', 500000, now);
  store.claim(third.id, old.rrn, now); store.observe(merchant, [old], now);
  assert.equal(store.verify(store.topup(third.id), merchant, now), 'MISMATCH');
});
test('worker failure prevents approval and conflicting receipts roll back the batch', (t) => {
  const { store, now, topup, receipt } = setup(t);
  store.claim(topup.id, receipt.rrn, now); store.observe(merchant, [receipt], now);
  store.setWorkerState('LOGIN_REQUIRED');
  assert.throws(() => store.approve(topup.id, merchant, 'Trusted evidence checked by operator', now));
  assert.throws(() => store.observe(merchant, [
    { ...receipt, rrn: '001234567893' }, { ...receipt, amountPaise: 100 }
  ], now));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n, 1);
});
test('checkout capabilities protect top-up data and closed claims cannot be changed', (t) => {
  const { store, now, topup, receipt } = setup(t);
  assert.equal(store.authorizedTopup(topup.id, 'wrong'), null);
  assert.equal(store.authorizedTopup(topup.id, topup.token).id, topup.id);
  store.claim(topup.id, receipt.rrn, now);
  assert.throws(() => store.claim(topup.id, '001234567899', now));
  assert.throws(() => store.claim(topup.id, receipt.rrn, now + 25 * 3600000));
});
