import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { configuration } from './config.js';
import { Store } from './store.js';
import { scanDashboard } from './dashboard.js';

const config = configuration();
if (!config.merchantId) throw new Error('Configure GPAY_TRANSACTIONS_URL');
if (config.timezone !== 'Asia/Kolkata') throw new Error('Only the inspected IST timestamp format is supported');
if (!Number.isInteger(config.pollSeconds) || config.pollSeconds < 30 || config.pollSeconds > 3600) throw new Error('Poll interval must be 30-3600 seconds');
if (!Number.isInteger(config.maxPages) || config.maxPages < 1 || config.maxPages > 550) throw new Error('Invalid GPAY_MAX_PAGES');
const login = process.argv.includes('--login');
const once = process.argv.includes('--once');
const store = new Store(config.dbPath, { checkoutTokenTtlSeconds: config.checkoutTokenTtlSeconds });
let context;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort());
try {
  context = await chromium.launchPersistentContext(config.profileDir, {
    headless: login ? false : config.headless, channel: config.channel,
    locale: 'en-IN', timezoneId: config.timezone, acceptDownloads: false
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);
  if (login) {
    await page.goto(config.transactionsUrl);
    console.log('Sign in manually to your existing merchant account. Complete MFA yourself.');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    await input.question('When the Transactions table is visible, press Enter to save the session: ');
    input.close();
    if (new URL(page.url()).origin !== 'https://pay.google.com') throw new Error('LOGIN_REQUIRED');
    store.setWorkerState('LOGIN_SAVED');
  } else {
    while (!abort.signal.aborted) {
      const { receipts, pages } = await scanDashboard(page, config);
      store.observe(config.merchantId, receipts);
      store.setWorkerState('HEALTHY', pages);
      console.log(`Verified dashboard scan: ${receipts.length} receipts across ${pages} pages`);
      if (once) break;
      await sleep(config.pollSeconds * 1000, undefined, { signal: abort.signal });
    }
  }
} catch (error) {
  if (!abort.signal.aborted) {
    const known = ['LOGIN_REQUIRED', 'DASHBOARD_CHANGED', 'PAGINATION_STALLED', 'RECEIPT_CONFLICT'];
    const code = known.includes(error.message) ? error.message : 'WORKER_ERROR';
    store.setWorkerState(code);
    console.error(`${code}: verification stopped. Inspect the dashboard and run npm run login if needed.`);
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
  store.close();
}
