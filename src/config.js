import { resolve } from 'node:path';

export function merchantFromUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://pay.google.com' || !/^\/g4b\/transactions\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('Use the exact HTTPS Google Pay merchant Transactions URL');
  }
  return url.pathname.split('/').filter(Boolean).at(-1);
}
export function configuration(env = process.env) {
  const transactionsUrl = env.GPAY_TRANSACTIONS_URL || '';
  const merchantId = transactionsUrl ? merchantFromUrl(transactionsUrl) : null;
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return {
    token: env.ADMIN_API_TOKEN || '', payeeVpa: env.PAYEE_VPA || '', payeeName: env.PAYEE_NAME || 'TopUpDaddy',
    host: env.HOST || '127.0.0.1', port, dbPath: resolve(env.DB_PATH || './data/payments.sqlite'),
    baseUrl: env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`, transactionsUrl, merchantId,
    profileDir: resolve(env.GPAY_PROFILE_DIR || './profiles/gpay'), channel: env.GPAY_CHANNEL || 'chrome',
    headless: env.GPAY_HEADLESS !== 'false', pollSeconds: Number(env.GPAY_POLL_SECONDS || 60),
    maxPages: Number(env.GPAY_MAX_PAGES || 10), timezone: env.GPAY_TIMEZONE || 'Asia/Kolkata'
  };
}
