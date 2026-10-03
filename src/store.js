import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { newToken, tokenHash, validateRrn } from './payment.js';

export class Store {
  constructor(path, { checkoutTokenTtlSeconds = 1800 } = {}) {
    if (!Number.isInteger(checkoutTokenTtlSeconds) || checkoutTokenTtlSeconds < 60 || checkoutTokenTtlSeconds > 3600) {
      throw new Error('Invalid checkout token TTL');
    }
    this.checkoutTokenTtlMs = checkoutTokenTtlSeconds * 1000;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS topups (
        id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, amount_paise INTEGER NOT NULL,
        token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        claimed_rrn TEXT, status TEXT NOT NULL DEFAULT 'PENDING', credited_at INTEGER,
        ownership_reason TEXT, token_expires_at INTEGER, token_revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS receipts (
        merchant_id TEXT NOT NULL, rrn TEXT NOT NULL, amount_paise INTEGER NOT NULL,
        received_at INTEGER NOT NULL, status TEXT NOT NULL, observed_at INTEGER NOT NULL,
        PRIMARY KEY (merchant_id, rrn)
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY, topup_id TEXT NOT NULL UNIQUE REFERENCES topups(id),
        reseller_id TEXT NOT NULL, merchant_id TEXT NOT NULL, rrn TEXT NOT NULL,
        amount_paise INTEGER NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE (merchant_id, rrn)
      );
      CREATE TABLE IF NOT EXISTS worker_state (
        id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL, updated_at INTEGER NOT NULL,
        scanned_pages INTEGER NOT NULL DEFAULT 0
      );`);
    // Lock migration so a starting worker and server cannot race schema changes.
    this.transaction(() => {
      const columns = new Set(this.db.prepare('PRAGMA table_info(topups)').all().map((column) => column.name));
      for (const column of ['token_expires_at', 'token_revoked_at']) {
        if (!columns.has(column)) this.db.exec(`ALTER TABLE topups ADD COLUMN ${column} INTEGER`);
      }
      this.db.prepare('UPDATE topups SET token_expires_at=MIN(expires_at,created_at+?) WHERE token_expires_at IS NULL')
        .run(this.checkoutTokenTtlMs);
      this.db.exec("UPDATE topups SET token_revoked_at=COALESCE(credited_at,created_at) WHERE status='CREDITED' AND token_revoked_at IS NULL");
    });
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createTopup(resellerId, amountPaise, now = Date.now()) {
    const id = randomUUID();
    const token = newToken();
    this.db.prepare(`INSERT INTO topups
      (id,reseller_id,amount_paise,token_hash,created_at,expires_at,token_expires_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, resellerId, amountPaise, tokenHash(token), now, now + 24 * 3600000, now + this.checkoutTokenTtlMs);
    return { ...this.topup(id), token };
  }
  topup(id) { return this.db.prepare('SELECT * FROM topups WHERE id=?').get(id); }
  authorizedTopup(id, token, now = Date.now()) {
    const topup = this.topup(id);
    return topup && typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) &&
      topup.token_revoked_at === null && topup.status !== 'CREDITED' &&
      topup.token_expires_at > now && topup.expires_at > now &&
      tokenHash(token) === topup.token_hash ? topup : null;
  }
  revokeCheckoutToken(id, now = Date.now()) {
    if (!this.topup(id)) throw new Error('Top-up not found');
    this.db.prepare('UPDATE topups SET token_revoked_at=COALESCE(token_revoked_at,?) WHERE id=?').run(now, id);
  }
  rotateCheckoutToken(id, now = Date.now()) {
    return this.transaction(() => {
      const topup = this.topup(id);
      if (!topup || topup.status === 'CREDITED' || topup.expires_at <= now) throw new Error('Top-up is closed or expired');
      const token = newToken();
      const tokenExpiresAt = Math.min(topup.expires_at, now + this.checkoutTokenTtlMs);
      this.db.prepare('UPDATE topups SET token_hash=?,token_expires_at=?,token_revoked_at=NULL WHERE id=?')
        .run(tokenHash(token), tokenExpiresAt, id);
      return { ...this.topup(id), token };
    });
  }
  claim(id, rrn, now = Date.now(), token) {
    validateRrn(rrn);
    return this.transaction(() => {
      // Public requests recheck after body reading to close expiry/revocation races.
      if (token !== undefined) now = Date.now();
      if (token !== undefined && !this.authorizedTopup(id, token, now)) {
        throw Object.assign(new Error('Top-up not found'), { code: 'CHECKOUT_UNAVAILABLE' });
      }
      const topup = this.topup(id);
      if (!topup || topup.status === 'CREDITED' || topup.expires_at <= now) throw new Error('Top-up is closed or expired');
      if (topup.claimed_rrn && topup.claimed_rrn !== rrn) throw new Error('Changing an existing claim requires operator review');
      this.db.prepare("UPDATE topups SET claimed_rrn=?,status='AWAITING_VERIFICATION' WHERE id=?").run(rrn, id);
      return this.topup(id);
    });
  }
  observe(merchantId, receipts, now = Date.now()) {
    this.transaction(() => {
      for (const receipt of receipts) {
        validateRrn(receipt.rrn);
        if (!Number.isSafeInteger(receipt.amountPaise) || receipt.amountPaise < 1 ||
            !Number.isSafeInteger(receipt.receivedAt) || receipt.receivedAt > now + 60000 ||
            !['Settled', 'Scheduled to settle'].includes(receipt.status)) throw new Error('Invalid receipt');
        const existing = this.db.prepare('SELECT * FROM receipts WHERE merchant_id=? AND rrn=?').get(merchantId, receipt.rrn);
        if (existing && (existing.amount_paise !== receipt.amountPaise || existing.received_at !== receipt.receivedAt)) {
          throw new Error('Receipt identity conflict; manual review required');
        }
        this.db.prepare(`INSERT INTO receipts VALUES (?,?,?,?,?,?)
          ON CONFLICT(merchant_id,rrn) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at`)
          .run(merchantId, receipt.rrn, receipt.amountPaise, receipt.receivedAt, receipt.status, now);
      }
    });
  }
  verify(topup, merchantId, now = Date.now()) {
    if (topup.status === 'CREDITED') return 'CREDITED';
    if (!topup.claimed_rrn) return topup.expires_at < now ? 'EXPIRED' : 'PENDING';
    const receipt = this.db.prepare('SELECT * FROM receipts WHERE merchant_id=? AND rrn=?').get(merchantId, topup.claimed_rrn);
    if (!receipt) return 'AWAITING_VERIFICATION';
    if (this.db.prepare('SELECT id FROM ledger WHERE merchant_id=? AND rrn=?').get(merchantId, receipt.rrn)) return 'ALREADY_USED';
    if (receipt.amount_paise !== topup.amount_paise || receipt.received_at < topup.created_at - 60000 ||
        receipt.received_at > topup.expires_at) return 'MISMATCH';
    if (receipt.status !== 'Settled') return 'AWAITING_SETTLEMENT';
    // Fresh observations are required for a credit; stale sessions cannot authorize it.
    if (now - receipt.observed_at > 5 * 60000) return 'AWAITING_VERIFICATION';
    return 'OWNERSHIP_REVIEW';
  }
  approve(id, merchantId, reason, now = Date.now()) {
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 1000) {
      throw new Error('Document the independently verified ownership evidence');
    }
    return this.transaction(() => {
      const topup = this.topup(id);
      if (!topup) throw new Error('Top-up not found');
      if (topup.status === 'CREDITED') return { topupId: id, status: 'CREDITED', duplicate: true };
      const worker = this.db.prepare('SELECT * FROM worker_state WHERE id=1').get();
      if (!worker || worker.status !== 'HEALTHY' || now - worker.updated_at > 5 * 60000) {
        throw new Error('Fresh healthy worker verification required');
      }
      if (this.verify(topup, merchantId, now) !== 'OWNERSHIP_REVIEW') throw new Error('Payment is not eligible for credit');
      this.db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), id, topup.reseller_id, merchantId, topup.claimed_rrn, topup.amount_paise, now);
      this.db.prepare("UPDATE topups SET status='CREDITED',credited_at=?,ownership_reason=?,token_revoked_at=? WHERE id=?")
        .run(now, reason.trim(), now, id);
      return { topupId: id, status: 'CREDITED', duplicate: false };
    });
  }
  setWorkerState(status, scannedPages = 0) {
    this.db.prepare('INSERT INTO worker_state VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,scanned_pages=excluded.scanned_pages')
      .run(status, Date.now(), scannedPages);
  }
}
