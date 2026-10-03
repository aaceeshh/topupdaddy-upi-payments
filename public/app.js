const id = /^\/checkout\/([a-f0-9-]{36})$/.exec(location.pathname)?.[1];
const key = `checkout:${id}`;
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (fragmentToken) { sessionStorage.setItem(key, fragmentToken); history.replaceState(null, '', location.pathname); }
const token = sessionStorage.getItem(key);
const $ = (name) => document.getElementById(name);
const labels = {
  PENDING: 'Awaiting payment', EXPIRED: 'Expired', AWAITING_VERIFICATION: 'Checking receipt',
  AWAITING_SETTLEMENT: 'Awaiting settlement', OWNERSHIP_REVIEW: 'Payment found - review pending',
  MISMATCH: 'Receipt mismatch', ALREADY_USED: 'Receipt already used', CREDITED: 'Wallet credited'
};
const notes = {
  PENDING: '', EXPIRED: 'This top-up has expired.', AWAITING_VERIFICATION: 'Your payment is awaiting confirmation.',
  AWAITING_SETTLEMENT: 'Your payment has not yet settled.', OWNERSHIP_REVIEW: 'Your receipt is awaiting approval.',
  MISMATCH: 'Contact support about this receipt.', ALREADY_USED: 'Contact support about this receipt.',
  CREDITED: 'Your top-up is complete.'
};
let timer;
let pollingFailures = 0;
async function request(path, options = {}) {
  const response = await fetch(`/api/topups/${id}${path}`, {
    ...options, headers: { 'X-Checkout-Token': token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json();
  if (data.code === 'CHECKOUT_UNAVAILABLE') {
    clearInterval(timer);
    sessionStorage.removeItem(key);
    $('payment').hidden = true;
    $('intro').textContent = 'Payment link unavailable';
    throw new Error('This link has expired or is no longer available. Return to your reseller account.');
  }
  if (!response.ok) throw new Error(data.error);
  return data;
}
async function refresh() {
  const data = await request('');
  $('payment').hidden = false;
  $('intro').textContent = data.payeeName;
  $('amount').textContent = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(data.amount));
  $('qr').src = data.qr;
  $('payee-name').textContent = data.payeeName;
  $('payee-vpa').textContent = data.payeeVpa;
  $('pay-link').href = data.intent;
  $('expiry').textContent = new Date(data.tokenExpiresAt).toLocaleString('en-IN');
  $('reference').textContent = data.id;
  $('status').textContent = labels[data.status] || 'Pending';
  $('status').dataset.status = data.status;
  $('receipt-note').textContent = notes[data.status] || '';
  const closed = ['CREDITED', 'EXPIRED', 'ALREADY_USED', 'MISMATCH'].includes(data.status);
  $('pay-link').hidden = closed || !!data.claimedRrn;
  $('qr').hidden = closed || !!data.claimedRrn;
  $('claim-form').hidden = closed || !!data.claimedRrn;
  if (data.claimedRrn) $('rrn').value = data.claimedRrn;
  if (closed) clearInterval(timer);
  $('error').hidden = true;
  pollingFailures = 0;
}
function showError(error) { $('error').textContent = error.message; $('error').hidden = false; }
$('claim-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try { await request('/claim', { method: 'POST', body: JSON.stringify({ rrn: $('rrn').value.trim() }) }); await refresh(); }
  catch (error) { showError(error); }
  finally { button.disabled = false; }
});
if (!id || !token) {
  $('intro').textContent = 'Payment unavailable';
  showError(new Error('Open the payment link issued for your wallet top-up.'));
} else {
  try {
    await refresh();
    if (!['CREDITED', 'EXPIRED', 'ALREADY_USED', 'MISMATCH'].includes($('status').dataset.status)) {
      timer = setInterval(() => refresh().catch((error) => { showError(error); if (++pollingFailures >= 3) clearInterval(timer); }), 15000);
    }
  } catch (error) { showError(error); }
}
