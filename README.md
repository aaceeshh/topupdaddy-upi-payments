# TopUpDaddy UPI Payments

A separate application built on [bhar4t/upiqr](https://github.com/bhar4t/upiqr), using its published `upiqr` package for QR codes and UPI intent links. Includes a checkout page, a headless Playwright worker for the **same Google Pay for Business merchant dashboard**, and an atomic SQLite credit ledger. This is an independent repository, not an upstream fork.

## What is implemented

- Backend-created top-ups with exact integer-paise amounts, reseller IDs, 24-hour payment windows, and secret checkout links.
- QR payment and a `upi://pay` link for installed UPI apps where supported by the phone/browser.
- Receipt submission using a 12-digit UPI transaction ID/RRN, preserving leading zeroes.
- Read-only transaction-list polling with a persistent browser session, pagination, strict column/status parsing, and manual-login recovery.
- Receipt checks for merchant, RRN, amount, timestamp window, `Settled` status, and freshness.
- Separate ownership approval and credit, enforced through an authenticated backend API. Unique constraints prevent reuse of a receipt or double-crediting a top-up.
- Tests for payment parsing, duplicate protection, authentication, pagination, browser rendering, and mobile layout.

## Important matching limitation

The inspected dashboard shows Date, Payer, UPI transaction ID, Payment app, Amount, and Status. It does **not** expose the order reference embedded in the UPI link. Payer details are masked and do not reliably identify a reseller.

An RRN entered by a customer can identify a real receipt, but cannot establish ownership of that receipt. The service therefore returns `OWNERSHIP_REVIEW` after finding a settled matching payment. It never automatically credits on an RRN assertion or amount alone. Your trusted backend/operator must independently establish ownership before calling the approval endpoint. For fully automatic crediting, add a bank/PSP integration that returns your server-generated order reference and a trustworthy final payment result.

The included ledger is a standalone credit ledger. It does not mutate an existing TopUpDaddy wallet database. Integrate it with your wallet using `topup_id` as an idempotency key and a transactional outbox or one shared database transaction. Do not independently increment a wallet after every poll of `/api/admin/ledger`.

## Setup

Use Node.js 24+ and Google Chrome, or install Playwright Chromium and set `GPAY_CHANNEL=chromium`.

```sh
npm ci
```

Copy `.env.example` to `.env` and configure:

- `ADMIN_API_TOKEN`: a random secret of at least 32 characters; never send it to a browser.
- `PAYEE_VPA`: the receiving merchant UPI ID associated with this dashboard.
- `PAYEE_NAME`: registered receiving merchant name.
- `GPAY_TRANSACTIONS_URL`: the exact Transactions URL from your existing dashboard.
- `PUBLIC_BASE_URL`: public checkout origin. Use HTTPS in deployment.

Generate an API secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

Before accepting real payments, independently confirm that the configured VPA belongs to the merchant in `GPAY_TRANSACTIONS_URL`. The table alone does not prove that association. Confirm dashboard timestamps use IST and English formatting.

## Google Pay session

```sh
npm run login
```

This opens a dedicated visible Chrome profile. Sign in manually to your **existing** Google Pay merchant account and complete MFA yourself. When the transaction table is visible, return to the terminal and press Enter. Then:

```sh
npm run worker
```

The worker runs headless by default. It uses the same merchant dashboard and the session saved by the login command. It does not attach to or copy your daily Chrome profile, and it does not require another merchant account. Only one process may use the worker profile at a time.

If Google blocks headless access, use `GPAY_HEADLESS=false` after manual login. There is no stealth mode, CAPTCHA solver, password storage, or MFA bypass. Session expiry, changed columns, unknown status, receipt conflicts, and stalled pagination stop verification. Inspect `/api/admin/worker` and restart after fixing the cause.

Start the checkout server in another terminal:

```sh
npm start
```

The default local URL is `http://127.0.0.1:3000`. The root page intentionally cannot create arbitrary reseller top-ups; your authenticated backend must issue a checkout link.

## Backend integration

All `/api/admin/*` endpoints require `Authorization: Bearer <ADMIN_API_TOKEN>`. Derive `resellerId` from your authenticated server-side user session, never from an untrusted browser field.

Create a pending top-up:

```http
POST /api/admin/topups
Authorization: Bearer <ADMIN_API_TOKEN>
Content-Type: application/json

{"resellerId":"RSL1028","amount":"5000.00"}
```

Returns `id`, `expiresAt`, and `checkoutUrl`. Send that secret link only to the intended reseller. Its fragment token is kept out of HTTP URLs and transferred into session storage. Public checkout reads/claims require `X-Checkout-Token`; knowing a top-up ID alone gives no access. Treat links as private capabilities, not identity proof.

The checkout submits `POST /api/topups/:id/claim` with `{"rrn":"001234567890"}`. The worker independently reads Google Pay. `GET /api/topups/:id` returns the verification state.

After independent ownership verification:

```http
POST /api/admin/topups/:id/approve
Authorization: Bearer <ADMIN_API_TOKEN>
Content-Type: application/json

{"ownershipVerified":true,"reason":"Describe the independently checked ownership evidence"}
```

Credit requires a healthy worker and a matching receipt seen within the last five minutes. An already credited top-up returns an idempotent success. A receipt already used for another top-up is refused. The approval flag is an authenticated operator/backend attestation, not an automated ownership check.

`GET /api/admin/ledger` returns the newest 100 credit entries. For larger deployments, add cursor pagination/outbox delivery before integrating external wallets. `GET /api/admin/worker` returns worker status, last update time, and pages scanned.

## Operations and limits

- Polling defaults to 60 seconds and the newest 10 pages (normally 100 receipts). `GPAY_MAX_PAGES` is a bounded scan, not a guarantee of full history. Raise it to cover expected volume and delayed settlements. Receipts outside the window remain unconfirmed; absence never means failed payment.
- Each scan resets only the transaction-list date/status filters to Always/Any status. It does not change merchant settings or initiate payments. All rows on the scanned pages must parse before the batch is stored.
- Only exact `Settled` permits credit. `Scheduled to settle` waits. Dashboard `Settled` is Google Pay's displayed state; this worker does not independently read bank settlement or handle later reversals/refunds. Reconcile credits with bank records.
- Google may delay displayed statuses, expire sessions, or change its UI. Check worker freshness rather than assuming receipt capture is continuously available. This is UI reconciliation, not an official webhook or bank payment-status API.
- An expired top-up refuses new claims. An existing claim may be reviewed later if the payment timestamp was within its original window. The timestamp comparison permits one minute before creation because the dashboard has minute precision.
- A claimed RRN cannot be changed through checkout; corrections require operator review. Masked payer names/handles are not stored or used for automatic identity matching.
- Keep `.env`, `data/`, and `profiles/` private and backed up securely. Browser profiles contain login credentials. They and all real receipts are excluded from Git. Run the worker on a secured persistent host, not an ephemeral GitHub Actions runner.
- Bind behind an HTTPS reverse proxy for remote access, use authentication on your main reseller portal, and restrict admin endpoints to your backend/network. The built-in request limit is per socket IP; users behind a proxy share that limit unless you implement trusted proxy handling. Do not trust arbitrary forwarded headers.
- SQLite WAL supports the server and worker on the same machine. Use one database file and local filesystem. For multiple hosts, move the ledger/receipts to a shared transactional database with equivalent unique constraints.

## Verification

```sh
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

Browser tests use synthetic receipts and a synthetic Google Pay table; they make no real payments and use no Google credentials. To test against installed Chrome, set `TEST_BROWSER_CHANNEL=chrome`. Live dashboard selectors were inspected read-only, but an authenticated headless scan still requires the separate manual login step on the deployment host. Generated test screenshots are in ignored `test-results/`.

## Attribution

UPI generation uses `upiqr` 1.4.1 by Bharat Sahu, licensed under MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Application code is MIT-licensed.
