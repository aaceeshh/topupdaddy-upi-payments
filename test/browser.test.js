import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { scanDashboard, readDashboardPage } from '../src/dashboard.js';

test('headless worker scans paginated dashboard fixture and stops on login/schema changes', { timeout: 30000 }, async (t) => {
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const url = 'https://pay.google.com/g4b/transactions/TEST_MERCHANT';
  await page.route('https://pay.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: `
    <div role="combobox" tabindex="0" onclick="document.querySelector('#dates').hidden=false">Always</div>
    <div id="dates" hidden><div role="option" onclick="this.parentElement.hidden=true">Always</div></div>
    <div role="combobox" tabindex="0" aria-label="Select transaction status" onclick="document.querySelector('#statuses').hidden=false">Any status</div>
    <div id="statuses" hidden><div role="option" onclick="this.parentElement.hidden=true">Any status</div></div>
    <table><tr><th>Date</th><th>Payer</th><th></th><th>UPI transaction ID</th><th>Payment app</th><th>Amount</th><th>Status</th></tr>
    <tr id="receipt"><td>15:03 3 Oct 2026</td><td>Test payer</td><td></td><td>001234567890</td><td>PhonePe</td><td>INR 5000.00</td><td>Settled</td></tr></table>
    <button aria-label="Go to next page" onclick="document.querySelector('#receipt').children[3].textContent='001234567891';this.disabled=true">Next</button>` }));
  const result = await scanDashboard(page, { transactionsUrl: url, maxPages: 10 });
  assert.equal(result.pages, 2); assert.equal(result.receipts.length, 2);
  await page.locator('th').first().evaluate((element) => element.textContent = 'Unexpected header');
  await assert.rejects(() => readDashboardPage(page, url), /DASHBOARD_CHANGED/);
  await page.goto('about:blank');
  await assert.rejects(() => readDashboardPage(page, url), /LOGIN_REQUIRED/);
});

test('checkout renders a real QR and submits a receipt on desktop and mobile', { timeout: 30000 }, async (t) => {
  const store = new Store(':memory:');
  const config = { token: 't'.repeat(40), payeeVpa: 'test@upi', payeeName: 'Test Merchant',
    baseUrl: 'http://127.0.0.1:3000', merchantId: 'TEST_MERCHANT' };
  const { server } = createServer(config, store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || undefined });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); store.close(); });
  const topup = store.createTopup('test-reseller', 500000);
  const url = `http://127.0.0.1:${server.address().port}/checkout/${topup.id}#token=${topup.token}`;
  await mkdir('test-results', { recursive: true });
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#payment').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#qr').naturalWidth > 0);
    assert.equal(await page.locator('#amount').innerText(), '\u20b95,000.00');
    assert.match(await page.locator('#pay-link').getAttribute('href'), /^upi:\/\/pay\?/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => {
      const img = document.querySelector('#qr');
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 0 && value < 50);
    }), true);
    await page.screenshot({ path: `test-results/checkout-${name}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    if (name === 'mobile') {
      await page.locator('#rrn').fill('001234567890');
      await page.getByRole('button', { name: 'Submit receipt' }).click();
      await page.getByText('Checking receipt', { exact: true }).waitFor();
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
      store.revokeCheckoutToken(topup.id);
      await page.reload();
      await page.getByText('This link has expired or is no longer available. Return to your reseller account.', { exact: true }).waitFor();
      assert.equal(await page.locator('#payment').isVisible(), false);
      assert.equal(await page.evaluate((id) => sessionStorage.getItem(`checkout:${id}`), topup.id), null);
    }
    await page.close();
  }
  const expired = store.createTopup('test-reseller', 500000, Date.now() - 31 * 60000);
  const page = await browser.newPage();
  await page.goto(`${config.baseUrl}/checkout/${expired.id}#token=${expired.token}`);
  await page.getByText('This link has expired or is no longer available. Return to your reseller account.', { exact: true }).waitFor();
  assert.equal(await page.locator('#payment').isVisible(), false);
});
