import { createHash, randomBytes } from 'node:crypto';

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

export function amountToPaise(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('Amount must be a decimal string with at most two fractional digits');
  }
  const [whole, fraction = ''] = value.split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise < 1 || paise > 100000000) {
    throw new Error('Amount must be between INR 0.01 and INR 1,000,000');
  }
  return paise;
}

export const rupees = (paise) => (paise / 100).toFixed(2);
export function validateRrn(rrn) {
  if (typeof rrn !== 'string' || !/^\d{12}$/.test(rrn)) throw new Error('RRN must contain 12 digits');
  return rrn;
}

export function dashboardAmount(text) {
  const normalized = text.trim().replace(/^\u20b9\s*/, '').replace(/^INR\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('Unrecognized dashboard amount');
  }
  return amountToPaise(normalized.replaceAll(',', ''));
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dashboardTime(text) {
  const match = /^(\d{2}):(\d{2})\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(text.trim().replace(/\s+/g, ' '));
  if (!match) throw new Error('Unrecognized dashboard timestamp');
  const [, h, m, d, month, year] = match;
  const monthIndex = months.indexOf(month);
  const date = new Date(Date.UTC(+year, monthIndex, +d, +h, +m));
  if (monthIndex < 0 || +h > 23 || +m > 59 || +year < 2020 || date.getUTCDate() !== +d) {
    throw new Error('Invalid dashboard timestamp');
  }
  // The inspected dashboard uses IST, which has no daylight-saving transitions.
  return date.getTime() - 330 * 60000;
}

export function parseDashboardRow(cells) {
  if (cells.length !== 6) throw new Error('Dashboard columns changed');
  const [date, , rrn, , amount, status] = cells.map((cell) => cell.trim());
  if (!['Settled', 'Scheduled to settle'].includes(status)) throw new Error('Unknown payment status');
  return { rrn: validateRrn(rrn), amountPaise: dashboardAmount(amount), receivedAt: dashboardTime(date), status };
}
