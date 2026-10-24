# SabPaisa PG 3.0 — Production Integration Report

Frontiva (`https://frontiva.online`) · repository root `store/` · base commit `cf52392` (branch `main`) · 2026-10-24

**Status: implemented and tested against mocks only. Not deployed. Migration not applied. `SABPAISA_ENABLED` is off.**

SabPaisa is the fourth online gateway, next to Airpay merchants 1, 2 and 3 and Cash on Delivery. It uses the PG 3.0 v2 REST API on the production host `https://merchant-api.sabpaisa.in`. There is no SabPaisa webhook or callback; payment is confirmed only by the server-side Transaction Enquiry API.

---

## A. Existing architecture (verified in the repository)

| Concern | Where | Behaviour |
|---|---|---|
| Merchant selection | `api/payments/options.js`, `config.checkoutMerchants()` | Returns `{ merchants: [...] }`, built from `AIRPAY_ENABLED_MERCHANTS` and limited to merchants that are fully configured. If the request fails, the checkout falls back to `[1]`. |
| Payment creation | `api/payments/create.js` | Prices the cart on the server (`priceOrder`), runs Airpay OAuth *before* writing the order, then `createPendingOrder()`. Returns the encrypted form that the browser POSTs to Airpay. |
| Merchant identity | `orders.airpay_merchant` | NULL means merchant 1. Merchants 2 and 3 write `2` and `3`. |
| Callback / IPN | `api/payments/callback.js`, rewrites in `vercel.json` (`/callback/cpm/arp/collection`, `/callback/cpm/arp_frontiva/collection`) | Every delivery is relayed verbatim to `kkchat.in` (`forward-callback.js`). The relay is auxiliary and cannot affect settlement. Integrity checks can only withhold trust, never grant it. Settlement is then triggered. |
| Settlement | `orders.settleOrder()` | Re-verifies with Airpay's Order Confirmation API using the order's own merchant. Becomes `paid` only when the confirmed amount matches the order. Applies a conditional UPDATE on open statuses, which is the idempotency barrier. |
| Customer return | `/success?ref=…` → `api/payments/status.js` | Makes one settlement attempt for `initiated` / `processing` orders. |
| Reconciliation | `api/payments/reconcile.js` | Requires `Bearer $CRON_SECRET`. Handles at most 25 open online orders older than 10 minutes, oldest first. **No scheduler exists in `vercel.json`; an external caller must invoke it.** |
| COD | `apps/web/src/api/OrdersApi.js` → `createCodOrder()` | The browser inserts the order directly with the anon key. No server involvement. |

## B. New SabPaisa architecture

```
Checkout (Pay with SabPaisa)
  → POST /api/payments/sabpaisa/create
      price on server → insert order (payment_gateway='sabpaisa', initiated)
      → POST merchant-api.sabpaisa.in/api/v2/payments  (X-Api-Key, HMAC checksum)
      → validate echo + checkout host → return checkoutUrl?clientSecret=…
  → SabPaisa hosted checkout
  → https://frontiva.online/success?ref=<order_ref>   (browser redirect only — not evidence)
  → GET /api/payments/status?ref=…   (unchanged file)
      → settleOrder() → dispatch on orders.payment_gateway
      → POST merchant-api.sabpaisa.in/api/v2/payments/enquiry {clientCode, merchantTxnId}
      → paid | processing | failed | requires_review | unchanged
```

**Independent reconciliation.** `POST /api/payments/reconcile` first runs the Airpay batch, which still has 25 slots and now excludes SabPaisa rows. It then runs a separate SabPaisa batch of up to 10 orders. That batch only includes orders that are open, older than 10 minutes, and not checked within their recheck interval: 10 minutes for the first 20 enquiries, hourly after that. It stops starting new checks after 40 seconds, which keeps it inside the 60-second function limit.

**Enquiry accounting.** Every enquiry, from any caller, first claims the order with a conditional UPDATE. The UPDATE matches only if all of these hold:

- the order is still open
- `enquiry_count` still equals the value just read
- `last_checked_at` is older than 8 seconds

That single step handles three things:

- **Throttling:** page refreshes cannot fire repeated enquiries.
- **Exact counting:** SabPaisa allows 100 polls per payment. The automatic paths stop at 60, leaving 40 for manual checks.
- **Race safety:** a browser check and reconciliation running at the same time spend one enquiry, not two.

## C. Files changed

**New**
- `api/_lib/sabpaisa.js`: checksum, customer and amount validation, session creation, checkout URL validation, enquiry, status classification, settlement decision.
- `api/payments/sabpaisa/create.js`: `POST /api/payments/sabpaisa/create`.
- `migrations-sabpaisa.sql`
- `tests/sabpaisa.test.js`: 75 tests.
- `docs/SABPAISA_PRODUCTION_INTEGRATION_REPORT.md`: this report.

**Modified (all additive)**
- `api/_lib/config.js`: SabPaisa config loader, feature flag, return origin, buyer email, production-host constant.
- `api/_lib/orders.js`:
  - `createPendingOrder({ gateway })` uses a separate insert. The Airpay insert is unchanged.
  - Gateway dispatch in `settleOrder()`, placed after the shared COD and terminal-state guards.
  - `settleViaSabpaisa()`, enquiry claim, `listSabpaisaDue()`.
  - `listUnresolvedOrders({ airpayOnly })`.
  - `presentOrder()` now includes `payment_gateway`.
- `api/_lib/http.js`: SabPaisa keys added to `scrubSecrets`; `clientsecret` and `checkouturl` added to the redaction list.
- `api/payments/options.js`: adds `sabpaisa: boolean`.
- `api/payments/reconcile.js`: Airpay-only listing (with a fallback if the migration has not run), plus the separate SabPaisa batch.
- `api/health.js`: non-secret `sabpaisa` block. Not part of `ok`.
- `apps/web/src/api/OrdersApi.js`: `getPaymentGateways()` appends `'sabpaisa'`; adds `createSabpaisaPayment()`, `isSabpaisaCheckoutUrl()`, `redirectToSabpaisa()`.
- `apps/web/src/pages/CheckoutPage.jsx`: "Pay with SabPaisa" option, SabPaisa-only name and phone rules, separate submit branch.
- `apps/web/src/pages/SuccessPage.jsx`: keeps only the leading `FRV…` reference from `ref`; polls SabPaisa orders every 10 seconds, at most 6 times.
- `supabase-schema.sql`, `.env.example`: new columns and variables documented.
- `tests/dual-airpay.test.js` (3 lines), `tests/size-selection.test.js` (1 line). See H.

**Unchanged, verified with `git diff`:** `api/payments/create.js`, `callback.js`, `return.js`, `status.js`, `api/_lib/airpay.js`, `callback-payload.js`, `forward-callback.js`, `crypto.js`, `vercel.json`.

## D. Database changes — `migrations-sabpaisa.sql`

Adds nullable columns with no defaults: `payment_gateway text` (check: NULL, `'airpay'` or `'sabpaisa'`), `gateway_payment_id text`, `gateway_txn_id text`, `last_checked_at timestamptz`, `enquiry_count integer` (check: ≥ 0). Also adds a partial index on `last_checked_at` where `payment_gateway = 'sabpaisa'`.

The migration:
- does not backfill, update or delete any rows
- does not change any RLS policy
- is idempotent

NULL keeps meaning Airpay. The Airpay insert never names the column, so new Airpay orders stay NULL. `airpay_merchant` is untouched.

**Manual procedure:** open the Supabase SQL editor, paste `migrations-sabpaisa.sql`, run it, then confirm `select payment_gateway, count(*) from orders group by 1;` returns only NULL. Run this **before** setting `SABPAISA_ENABLED=true`. If the migration has not run, a SabPaisa insert is refused (the customer sees "choose another option"), and reconciliation silently keeps its original Airpay query.

## E. Configuration

| Variable (canonical) | Also read as | Local `.env` (outside the repo) | Vercel |
|---|---|---|---|
| `SABPAISA_API_KEY` | `SUBPAISA_API_KEY` | present (as `SUBPAISA_*`) | **not verified** |
| `SABPAISA_SECRET_KEY` | `SUBPAISA_SECRET_KEY` | present (as `SUBPAISA_*`) | **not verified** |
| `SABPAISA_CLIENT_CODE` | `SUBPAISA_CLIENT_CODE` | present (as `SUBPAISA_*`) | **not verified** |
| `SABPAISA_MERCHANT_ID` | `SUBPAISA_MERCHANT_ID`, `MERCHANT_ID` | present (as `MERCHANT_ID`) | **not verified** |
| `SABPAISA_ENABLED` | — | **absent → off** | set `false` until go-live |
| `SABPAISA_RETURN_ORIGIN` | — | absent → `https://frontiva.online` | optional |
| `SABPAISA_BUYER_EMAIL` | `AIRPAY_FALLBACK_BUYER_EMAIL` | absent → `orders@frontiva.online` | recommended |
| `SABPAISA_BASE_URL` | — | absent | ignored unless it equals the production URL |

Notes:
- The configured merchant ID and client code are separate variables but hold the **same value**. This was checked by comparing them without displaying either. The code reads them independently, and enquiry identity checks accept either value.
- The API key does not carry the documented sandbox prefix (`sk_test_`). Sandbox keys are refused at load time.
- `MERCHANT_NAME` is present but unused.
- `GET /api/health` reports which variable *name* each role was read from, never the values.

## F. Security

- **Checksum:** HMAC-SHA256 over `merchantId|merchantTxnId|amount|currency|timestamp`, keyed with the secret key, as UTF-8 and lowercase hex. The timestamp is in Unix seconds from the server clock. It is generated on the server only and checked against an independent `openssl` test vector.
- **Amount:** the integer paise total from the existing `priceOrder()` (`totalInCents`) is sent as is and never multiplied again. It must fall within the documented 100 to 100,000,000 range. Prices sent by the browser are ignored (tested).
- **Paid only if all of these hold:**
  - enquiry `success: true` and `status: SUCCESS`
  - `merchantTxnId` equals the stored `order_ref`
  - `merchantId` equals the configured merchant ID or client code
  - `currency` is INR
  - `txnId` is present
  - `amountPaise` equals the order total
  - `paidAmount`, when present, agrees with `amountPaise`

  Any missing or mismatched field results in `requires_review`.
- **Return URL parameters** (`status`, `signature`, `amount`, …) are never read. A forged `status=SUCCESS` changes nothing (tested).
- **Checkout redirect:** the code uses the `checkoutUrl` SabPaisa returns and appends `clientSecret`, as the API reference documents. It does not build a host. The host must be HTTPS, `*.sabpaisa.in`, and not a staging, sandbox, UAT or test host. The browser checks this again before navigating. The secret is never stored or logged (tested by scanning captured logs).
- **Ambiguous creation** (timeout, 5xx, `DUPLICATE_TRANSACTION`, an unreadable response, or a mismatched echo) leaves the order `initiated` and is never retried with the same reference. A definite 4xx rejection marks the order `failed`.
- **Idempotency:** the final transition is a conditional UPDATE filtered on `payment_gateway='sabpaisa'` and the open statuses. Concurrent settlement applies `paid` exactly once (tested).
- **Gateway isolation:** the gateway is read from the order row that the server wrote. An Airpay callback naming a SabPaisa order can only trigger a SabPaisa enquiry; Airpay is never consulted for it (tested end to end through the real callback handler, with the KKChat relay still delivered).

## G. Compatibility

- Airpay merchants 1, 2 and 3: create, OAuth, callback, relay and status files are unchanged.
- `settleOrder()` follows the original Airpay code path for `payment_gateway` NULL or `'airpay'`. Regression tests cover NULL → merchant 1, and NULL with `airpay_merchant=3` → merchant 3.
- The Airpay insert is byte-for-byte the same and works before the migration (tested against a database without the new columns).
- Callback URLs, rewrites, KKChat destination and acknowledgement behaviour are unchanged (`vercel.json` and `callback.js` have no diff).
- `options` keeps `merchants` from `checkoutMerchants()`. Older clients ignore the new `sabpaisa` field, and the existing fallback to `[1]` is unchanged.
- Reconciliation keeps 25 Airpay slots that SabPaisa rows cannot occupy (tested with 30 stale SabPaisa rows).
- COD: `createCodOrder()` and its checkout branch are unchanged. The cart is still cleared only for COD or a confirmed `paid` order.

## H. Test results (`npm test`, Node test runner, all mocked)

| | Count |
|---|---|
| Baseline before changes | 430 pass / 0 fail |
| **Total after** | **505** |
| Passed | 505 |
| Failed | 0 |
| Skipped / todo / cancelled | 0 |

New tests: 75, in `tests/sabpaisa.test.js`. They cover all 35 required scenarios and use an in-memory PostgREST fake that applies the real conditional filters, so races behave as they would in Postgres.

**Lint:** `npm run lint` passes with 0 errors; `eslint` on the changed frontend files reports 0 warnings.
**Build:** `npm run build` succeeds with no warnings.
**Type checking:** not available; the project is JavaScript with no `tsc` step.

Existing tests changed, and why:
- `dual-airpay.test.js`: three `deepEqual` expectations on `/api/payments/options` now include `sabpaisa: false`. This response field is required by the spec. The `merchants` values are unchanged.
- `size-selection.test.js`: the expected count of `size:` assignments in `OrdersApi.js` goes from 2 to 3, because SabPaisa is a new order path. The test still verifies that every assignment uses the sized-product guard.
- Two other existing source-shape tests (`cod-regression`, `reconcile`) initially failed. They were fixed by adjusting the new code, not the tests.

## I. Verified vs. unverified

**Verified with mocks:** every code path above, end to end through the real handlers. No network calls were made, and no money was moved.

**Not verified (needs a live check):**
1. That the merchant account has PG 3.0 v2 enabled, and that these credentials authenticate against `merchant-api.sabpaisa.in`.
2. The production checkout host. The docs only show `staging-sb-checkout.sabpaisa.in`; the allow-list accepts any HTTPS `*.sabpaisa.in` host that is not staging.
3. Whether `checkoutUrl` already contains `clientSecret`. The quick-start says it does; the API reference says to append it. Both cases are handled.
4. The real enquiry `merchantId` value: whether it matches the configured merchant ID or client code.
5. How SabPaisa appends return parameters to a `returnUrl` that already has `?ref=`. The page tolerates a second `?`.
6. Whether `https://frontiva.online/success` is approved as the return URL.
7. Whether SabPaisa accepts `orders@frontiva.online` as `customerEmail`, since checkout collects no customer email.
8. The full set of enquiry status values. Undocumented values go to review.

## J. Manual deployment steps

1. Review and commit the changes (nothing has been committed).
2. In Supabase, run `migrations-sabpaisa.sql` and verify as described in D.
3. In Vercel, set `SABPAISA_API_KEY`, `SABPAISA_SECRET_KEY`, `SABPAISA_MERCHANT_ID` and `SABPAISA_CLIENT_CODE`, or the existing `SUBPAISA_*` / `MERCHANT_ID` names. Also set `SABPAISA_BUYER_EMAIL` and `SABPAISA_ENABLED=false`.
4. Deploy. Check `GET /api/health`: `sabpaisa.configured: true`, `enabled: false`, `base_url_override_ignored: false`, and Airpay `ok` unchanged.
5. Confirm with SabPaisa:
   - PG 3.0 is enabled
   - the return URL is approved
   - the production checkout host
   - the buyer-email policy
   - **that the account can go live without a webhook** (see L)
6. Schedule reconciliation: `POST https://frontiva.online/api/payments/reconcile` with `Authorization: Bearer $CRON_SECRET`, every 10–15 minutes (for example, cron-job.org or GitHub Actions). This is **required** for SabPaisa.
7. Only after explicit approval, set `SABPAISA_ENABLED=true` and redeploy (or update the environment). Make one low-value live payment and confirm it moves to `paid` through enquiry.
8. Monitor the logs for `payment.sabpaisa.create.*`, `payment.settle.sabpaisa_not_paid` and `payment.settle.sabpaisa_review`.

## K. Rollback

Set `SABPAISA_ENABLED=false`. SabPaisa disappears from checkout immediately, and Airpay and COD are unaffected.

**Keep the credentials set.** Pending SabPaisa orders still settle from `/success` and through reconciliation only while the credentials are present. Leave the columns in place: dropping them while SabPaisa orders exist would route those orders to Airpay verification. To revert the code entirely, wait until no SabPaisa order is open (`payment_gateway='sabpaisa' and payment_status in ('initiated','processing','requires_review')`).

## L. Operational limitations (no webhook)

- If a customer pays and never returns, the order is settled only by reconciliation. It stays `initiated` until the next scheduled run after the 10-minute grace period. **Without a scheduler, such orders never settle.**
- `TRANSACTION_NOT_FOUND`, provider timeouts and 429/5xx responses never fail an order. After 2 hours unresolved, the order moves to `requires_review`. Reconciliation keeps re-checking it (hourly after 20 enquiries) until 60 enquiries are used, so a late success is still recorded. **Abandoned checkouts will therefore build up in `requires_review`**; this is the cost of not having a webhook.
- `401` / `403` responses (credential or client-code problems) put orders straight into `requires_review`. Reconciliation retries them once the credentials are fixed.
- **Finding unresolved payments:**
  ```sql
  select order_ref, payment_status, enquiry_count, last_checked_at, created_at
  from orders where payment_gateway = 'sabpaisa'
    and payment_status in ('initiated','processing','requires_review')
  order by created_at;
  ```
  Rows with `enquiry_count >= 60` are no longer checked automatically; check them in the SabPaisa dashboard.
- **SabPaisa production checklist items left incomplete on purpose:** #5–8, #15, #40–42 and #45 (webhook signature, replay window, HTTPS webhook, idempotency, dashboard registration, handler behaviour, delivery monitoring) and #55 (webhook secret). Items not covered by code: #9 IP whitelisting, #13 CORS, #20–34 live payment testing, #44–48 monitoring, #51–53 policy pages. **If SabPaisa requires a registered webhook to activate production, that blocks go-live. No webhook has been added.**

### Findings outside SabPaisa (not changed)

- **Exposed secret:** the live `CRON_SECRET` value is hardcoded in the tracked file `tests/reconcile.test.js` and in git history, which has been pushed to `origin`. **Rotate `CRON_SECRET`** in Vercel and your scheduler, then replace the test fixture with a dummy value.
- The local `.env` sets `PUBLIC_SITE_ORIGIN=https://www.frontiva.online`, while `.env.example` and the Airpay registration require the apex domain without `www`. Check the value in Vercel. SabPaisa does not depend on it.
- RLS on `orders` is open to the anon key (`for all using (true)`), so anyone holding the public anon key can read every order. This predates this change. No secret is stored in the new columns.
