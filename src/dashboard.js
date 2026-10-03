import { parseDashboardRow } from './payment.js';

const expectedColumns = ['Date', 'Payer', 'UPI transaction ID', 'Payment app', 'Amount', 'Status'];

export function parseTable(raw) {
  if (!raw.length) throw new Error('DASHBOARD_CHANGED');
  const headers = raw[0];
  const indices = headers.flatMap((header, index) => header ? [index] : []);
  if (indices.map((index) => headers[index]).join('|') !== expectedColumns.join('|') ||
      ![6, 7].includes(headers.length)) throw new Error('DASHBOARD_CHANGED');
  return raw.slice(1).map((cells) => {
    if (cells.length !== headers.length || headers.some((header, index) => !header && cells[index])) {
      throw new Error('DASHBOARD_CHANGED');
    }
    return parseDashboardRow(indices.map((index) => cells[index]));
  });
}

export async function readDashboardPage(page, expectedUrl) {
  if (new URL(page.url()).origin !== 'https://pay.google.com' ||
      new URL(page.url()).pathname.replace(/\/$/, '') !== new URL(expectedUrl).pathname.replace(/\/$/, '')) {
    throw new Error('LOGIN_REQUIRED');
  }
  const tables = page.getByRole('table');
  if (await tables.count() !== 1) throw new Error('DASHBOARD_CHANGED');
  const raw = await tables.evaluate((table) => Array.from(table.querySelectorAll('tr,[role="row"]')).map((row) =>
    Array.from(row.querySelectorAll('td,th,[role="cell"],[role="columnheader"]')).map((cell) => cell.innerText.trim().replace(/\s+/g, ' '))));
  const receipts = parseTable(raw);
  if (raw.length === 1) {
    const count = page.getByText(/^0 transactions$/);
    if (await count.count() !== 1) throw new Error('DASHBOARD_CHANGED');
  }
  return receipts;
}

export async function scanDashboard(page, config) {
  await page.goto(config.transactionsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try { await page.getByRole('table').waitFor({ state: 'visible', timeout: 20000 }); }
  catch { throw new Error(new URL(page.url()).hostname === 'accounts.google.com' ? 'LOGIN_REQUIRED' : 'DASHBOARD_CHANGED'); }
  // Reset only transaction-list filters. Never interact with merchant settings.
  const combos = page.getByRole('combobox');
  if (await combos.count() !== 2) throw new Error('DASHBOARD_CHANGED');
  await combos.nth(0).click();
  await page.getByRole('option', { name: 'Always', exact: true }).click();
  await page.getByRole('combobox', { name: 'Select transaction status' }).click();
  await page.getByRole('option', { name: 'Any status', exact: true }).click();
  const receipts = new Map();
  let pages = 0;
  let previous = '';
  while (pages < config.maxPages) {
    const current = await readDashboardPage(page, config.transactionsUrl);
    const signature = current.map((receipt) => receipt.rrn).join(',');
    if (pages && signature === previous) throw new Error('PAGINATION_STALLED');
    previous = signature;
    for (const receipt of current) {
      const old = receipts.get(receipt.rrn);
      if (old && JSON.stringify(old) !== JSON.stringify(receipt)) throw new Error('RECEIPT_CONFLICT');
      receipts.set(receipt.rrn, receipt);
    }
    pages++;
    const next = page.getByRole('button', { name: 'Go to next page', exact: true });
    if (await next.count() !== 1) throw new Error('DASHBOARD_CHANGED');
    if (!await next.isEnabled()) break;
    if (pages < config.maxPages) {
      await next.click();
      await page.waitForFunction((ids) => {
        const table = document.querySelector('table,[role="table"]');
        if (!table) return false;
        const text = table.innerText;
        return ids.every((id) => !text.includes(id));
      }, current.map((receipt) => receipt.rrn), { timeout: 15000 });
    }
  }
  return { receipts: [...receipts.values()], pages };
}
