import test from 'node:test';
import assert from 'node:assert/strict';
import { amountToPaise, dashboardAmount, dashboardTime, validateRrn } from '../src/payment.js';
import { parseTable } from '../src/dashboard.js';
import { merchantFromUrl } from '../src/config.js';

test('money uses exact integer paise and validates decimal inputs', () => {
  assert.equal(amountToPaise('5000.01'), 500001);
  assert.equal(amountToPaise('0.1'), 10);
  for (const amount of [5000, '1e3', '-1', '0', '1.001', 'Infinity', '1000001']) assert.throws(() => amountToPaise(amount));
  assert.equal(dashboardAmount('\u20b97,000.00'), 700000);
  assert.equal(dashboardAmount('\u20b91,00,000.50'), 10000050);
  assert.throws(() => dashboardAmount('\u20b91,2,3.00'));
});
test('timestamps are validated and converted from IST', () => {
  assert.equal(dashboardTime('15:03 3 Oct 2026'), Date.parse('2026-10-03T09:33:00Z'));
  for (const date of ['31:03 3 Oct 2026', '15:03 31 Feb 2026', 'Yesterday']) assert.throws(() => dashboardTime(date));
});
test('preserve leading zero RRNs and reject bad references', () => {
  assert.equal(validateRrn('001234567890'), '001234567890');
  for (const rrn of ['123', 123456789012, '12345678901x']) assert.throws(() => validateRrn(rrn));
});
test('accept observed seven-column table and fail closed on schema/status changes', () => {
  const headers = ['Date', 'Payer', '', 'UPI transaction ID', 'Payment app', 'Amount', 'Status'];
  const row = ['15:03 3 Oct 2026', 'Test payer', '', '001234567890', 'PhonePe', '\u20b97,000.00', 'Settled'];
  assert.equal(parseTable([headers, row])[0].amountPaise, 700000);
  assert.throws(() => parseTable([headers, [...row.slice(0, 6), 'Success']]));
  assert.throws(() => parseTable([headers.slice(1), row]));
  assert.throws(() => parseTable([headers, row.map((cell, index) => index === 2 ? 'Unexpected value' : cell)]));
});
test('only allow actual Google Pay Transactions URLs', () => {
  assert.equal(merchantFromUrl('https://pay.google.com/g4b/transactions/TEST_MERCHANT'), 'TEST_MERCHANT');
  for (const url of ['http://pay.google.com/g4b/transactions/X', 'https://evil.example/g4b/transactions/X', 'https://pay.google.com/g4b/settings/X']) assert.throws(() => merchantFromUrl(url));
});
