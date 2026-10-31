# Frontiva PayIn — Integration Report

Date: 2026-10-31 · Status: **BLOCKED for go-live (payment-launch contract)**. The code is complete and tested, and the feature is off by default.

Sources: `Payin API.pdf` (portal docs v1.0.0, printed 2026-10-31; the create response is cut off mid-object), `Frontiva_API_Review_and_MID_2_Integration_Report.docx`, and this repository. No live provider call was made. That includes login.

---

## A. Architecture

Frontiva PayIn is the fifth online gateway, `orders.payment_gateway = 'frontiva_payin'`. It has its own adapter, configuration, errors, endpoints and reconciliation. It is not an Airpay MID, sends no MID selector, and never touches `airpay_merchant`.

### Payment sequence

1. Checkout shows **Pay with Frontiva PayIn** only when `GET /api/payments/options` returns `frontiva_payin: true`. When the gateway is selected, an **Email** field appears.
2. The browser sends `POST /api/payments/frontiva-payin/create` with `{customer, email, items, attempt_id}`. The `attempt_id` is a UUID that stays the same for this attempt.
3. The server:
   1. Validates the input.
   2. Prices the order from Supabase with the existing `priceOrder`. The browser's amount is ignored.
   3. Claims the attempt by inserting into `frontiva_payin_transactions` (unique `checkout_attempt_id`). A repeat of the same attempt returns 409 with the existing `order_ref`.
   4. Writes the pending order.
   5. Logs in to the portal (the session is cached).
   6. Signs the `merchantReference` (= `order_ref`) with HMAC.
   7. Sends `POST /api/payin-requests`.
4. The response is checked for the same reference, the same amount and the same portal merchant (the `merchantId` is required). Its `intent` must pass `upiIntentProblem()`: a `upi://pay` URI whose payee is in `FRONTIVA_PAYIN_ALLOWED_PAYEES`, with `cu=INR`, `am` equal to the order in exact paise, and no repeated parameter. The server stores the intent verbatim (`frontiva_payin_transactions.upi_intent`) and returns only `launch: {type: 'upi_intent', url: <intent>}`. `url: null` is normal and ignored.
5. The browser goes to `/success?ref=…`, which shows the amount, the QR (the intent byte-for-byte), the order reference and a pending indicator, plus "Open UPI App" on phones. A refresh restores the same QR from `GET /api/payments/status` (`payment_intent`, only while the order is `initiated`/`processing`). No second PayIn is ever created.
6. Settlement runs through `GET /api/payin-requests?merchantReference=…` and nothing else. It is triggered by `/api/payments/status` (on page load and while polling) and by `POST /api/payments/frontiva-payin/reconcile`.

### Routing

`settleOrder()` in `orders.js` reads the gateway from the server-written order row:

| Gateway | Route |
| --- | --- |
| NULL or `airpay` | Airpay, unchanged |
| `sabpaisa` | SabPaisa, unchanged |
| `frontiva_payin` | `settleFrontivaPayinOrder()` |

The Airpay reconcile batch already excludes non-NULL gateways.

### Database lifecycle

- `orders.payment_status` moves `initiated → processing → paid | failed | requires_review`. Each move is a conditional UPDATE filtered on the open statuses and `payment_gateway = 'frontiva_payin'`, so a terminal state is never overwritten.
- `enquiry_count` and `last_checked_at` throttle checks. They are the SabPaisa columns, reused here.
- `gateway_txn_id` stores the UTR.
- `frontiva_payin_transactions` stores the attempt id, portal request id, portal merchant id, `create_state`, provider status, amount in paise, payment mode, UTR, a sanitised `last_error` and `last_verified_at`.

| Provider status | Local status |
| --- | --- |
| COMPLETED, with matching reference, merchant (when present) and exact paise amount | `paid` |
| PENDING or PROCESSING | `processing` |
| FAILED | `failed` |
| Unknown status, mismatch, auth error or invalid answer | `requires_review` |
| Not found or unreachable | No change. After 2 h, `requires_review` (still re-checked) |

## B. Code changes

| File | Change |
| --- | --- |
| `api/_lib/frontiva-payin.js` (new) | Configuration, feature flag, login and session cache, HMAC signing, exact rupee↔paise conversion, create, status, launch validation, settlement decision table |
| `api/_lib/frontiva-payin-orders.js` (new) | Attempt claim, metadata writes, `confirmFrontivaPayin()`, idempotent transitions, reconcile listing with backoff |
| `api/payments/frontiva-payin/create.js` (new) | Create endpoint |
| `api/payments/frontiva-payin/reconcile.js` (new) | Cron-authenticated sweep: 10 orders per run, concurrency 1, 40 s budget |
| `migrations-frontiva-payin.sql` (new) | Widens `orders_payment_gateway_check`, adds the table (RLS on, no policy) and a partial index |
| `tests/frontiva-payin.test.js`, `tests/helpers/fake-world.js` (new) | 59 tests |
| `api/_lib/orders.js` | One dispatch branch. `createPendingGatewayOrder` also accepts `frontiva_payin` and an optional pre-generated ref. The Airpay insert is byte-identical |
| `api/payments/options.js` | Adds `frontiva_payin: true` only when available, so the response is unchanged while the gateway is off |
| `api/health.js` | Adds a `frontiva_payin` block (booleans only, no live login) |
| `api/_lib/http.js` | Redacts token and signature keys; scrubs `FRONTIVA_PAYIN_PASSWORD` |
| `apps/web/src/api/OrdersApi.js` | Gateway id, `createFrontivaPayinPayment`, `isFrontivaPayinLaunch` |
| `apps/web/src/pages/CheckoutPage.jsx` | Option, email field (separate state, so other gateways' requests are unchanged), attempt id, launch |
| `apps/web/src/pages/SuccessPage.jsx` | Polls for `frontiva_payin` as it does for `sabpaisa` |
| `supabase-schema.sql`, `.env.example` | Mirror the migration; document the variables |
| `tests/size-selection.test.js` | Count of guarded order paths: 3 → 4 |

Nothing changed in `create.js`, `callback.js`, `return.js`, `reconcile.js`, `status.js`, `airpay.js`, `sabpaisa.js`, `forward-callback.js` or `vercel.json`. No PayIn callback route exists, and none of the PayIn code imports the Airpay, SabPaisa or KKChat modules (a test enforces this).

## C. Security

- **Authentication.** `POST /api/auth/user/login` returns `accessToken` and `data.user.clientSecret`, which are held in memory only, per function instance.
  - Concurrent callers share one login.
  - A failed login triggers a 30 s cooldown.
  - The cache expires at the JWT `exp` or 7 days, minus 10 minutes.
  - A 401/403 from the API triggers one re-login and one resend. This is safe for POST because the request was refused.
  - Login fails closed unless `data.user.merchantId` equals `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID`.
  - The refresh token is ignored because no refresh endpoint is documented.
- **Signature.** `HMAC-SHA256(clientSecret, merchantReference)` as lowercase hex, computed server-side and tested against an openssl vector.
- **Credentials.** The password, token and client secret are never logged, returned or stored (tests cover this). The customer email is sent to the provider but not stored.
- **Duplicate prevention.**
  - Each attempt is a unique row, so one attempt makes at most one order and one PayIn.
  - Create is never re-sent. An ambiguous result (timeout, 5xx, 409, 429, unreadable or mismatched response) triggers one status lookup:
    - Not found: the order is closed as `failed`. The customer never received a link.
    - Found: the order stays open and is reconciled.
    - Unknowable: the order goes to `requires_review`.
- **Verification authority.** Only the server-side status answer counts. Browser redirects and query strings are never read. Provider HTML is never rendered: a `data:text/html` URL is refused, and the browser accepts only `https:` (allowlisted host) or `upi:` (amount must match).

## D. Tests

| Command | Result |
| --- | --- |
| `npm test` | **647 pass, 0 fail, 0 skipped** (updated 2026-10-31 after release hardening; see section H) |
| `npm run lint` | Clean |
| `npm run build` | Passes |

The new tests cover:

- **Authentication:** success, invalid credentials, missing secret or token, merchant mismatch, expiry, concurrency, timeout.
- **Creation:** happy path, duplicate attempt, invalid inputs, provider 4xx, auth failure, 401 retry, three ambiguous cases, mismatched response, `data:` URL, persistence failure after provider success, secret leakage.
- **Verification:** every status, amount, reference and merchant mismatch, array envelope, network failure, throttling, concurrent settlement, terminal protection, token renewal.
- **Reconciliation, plus isolation:** no Airpay, SabPaisa or KKChat request; callback rewrites unchanged.

The existing Airpay MID 1/2/3, SabPaisa, callback, KKChat-forwarding and reconcile suites all pass unchanged.

## E. Deployment (when unblocked)

1. Run `migrations-frontiva-payin.sql` in Supabase, after `migrations-sabpaisa.sql`.
2. Set these Vercel variables:
   - `FRONTIVA_PAYIN_EMAIL`
   - `FRONTIVA_PAYIN_PASSWORD`
   - `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID` (not in the local `.env` yet)
   - `FRONTIVA_PAYIN_BASE_URL` (optional)
   - `FRONTIVA_PAYIN_ALLOWED_PAYEES` (required to start payments): the provider-confirmed UPI payee address(es). `FRONTIVA_PAYIN_LAUNCH_HOSTS` is no longer read.
   - `SUPABASE_SERVICE_ROLE` (required)
3. Schedule `POST https://frontiva.online/api/payments/frontiva-payin/reconcile` with `Authorization: Bearer $CRON_SECRET` every 10–15 minutes, alongside the existing reconcile. `vercel.json` has no cron, and Hobby crons are daily only.
4. Set `FRONTIVA_PAYIN_ENABLED=true` for a controlled pilot.

**Rollback:** set `FRONTIVA_PAYIN_ENABLED=false`. Orders already started are still verified while the credentials remain set. Leave the table and constraint in place.

## F. Outstanding issues

1. **Resolved (2026-10-31): payment launch.** A real create response returned `paymentMode: UPI_INTENT`, `url: null` and a bare `upi://pay` intent. The customer pays by QR. Still to confirm with the provider:
   - whether `pa` is a fixed merchant VPA (the allowlist assumes so);
   - whether `UPI_INTENT` is the documented request value (we now send it);
   - QR expiry, if any (none is shown);
   - what `callbackNeeded: true` requires of us. It is logged as `callback_needed` and never acted on: settlement stays status-only and no webhook was added.
2. **Return URL.** Not needed: the customer stays on `/success?ref=` while paying by QR, and reconciliation settles the order regardless.
3. **Amount unit.** The docs say decimal rupees, min 1.00, but the example request (1000) and response (`"100"`) disagree. The code sends rupees and verifies exact paise. Confirm with the provider.
4. **Payment mode.** The parameter table says UPI; the examples use CARD. Only UPI is sent.
5. **Status response shape.** It is inferred from the review report (`success/data`, `requestedAmount`). Object and array forms are both handled, and anything else goes to review.
6. **Unknowns:** PROCESSING is outside the documented catalogue; no rate limits or error schema are documented; there is no refresh-token endpoint; client-secret rotation is undocumented; nothing says whether FAILED can later become COMPLETED (locally, FAILED is terminal, as for the other gateways).
7. **Manual test.** Provider sandbox or an approved small live pilot. It must check that login yields the expected merchant id, a create plus status round trip, the launch on mobile and desktop, and an abandoned payment settled by reconciliation.

## G. Readiness

**IMPLEMENTED — VALIDATION REQUIRED.** The UPI QR path is built and tested, and the feature is disabled. Before it is enabled:
- the migration (with `upi_intent`) is run;
- the Vercel env, including `FRONTIVA_PAYIN_ALLOWED_PAYEES`, is set;
- the reconcile scheduler exists;
- one approved real UPI payment (F7) has passed.

## H. Release-hardening update (2026-10-31)

Full runbook, environment matrix, scheduler configuration, pilot checklist, rollback and GO/NO-GO: [FRONTIVA_PAYIN_RELEASE_RUNBOOK.md](FRONTIVA_PAYIN_RELEASE_RUNBOOK.md). The migration has since been applied by the owner; a read-only check of the connected project found every column the code uses present and no PayIn order yet. `FRONTIVA_PAYIN_ENABLED` is still `false`; no real payment has been made.

### Changes in this pass

| File | Reason |
| --- | --- |
| `apps/web/src/pages/SuccessPage.jsx` | "Open UPI App" was a `<button>` inside an `<a>`. Now one anchor rendered as a button (`<Button asChild><a href aria-label>`), same validated URI, never auto-opened. QR is now 320 px, responsive (`w-full max-w-[320px]`), explicit white background, 4-module quiet zone. The QR is also hidden once the order is older than 30 minutes. Reads `k` from the URL and passes it to the status call. |
| `api/_lib/frontiva-payin-orders.js` | `findFrontivaPayinIntent(order, attemptKey, deps)` returns the stored intent only when the caller presents the checkout attempt id stored on that order's transaction row, and only for 30 minutes (`FRONTIVA_QR_VALID_MS`). |
| `api/payments/status.js` | Passes the `k` query parameter through. Orders without it load exactly as before, just without `payment_intent`. Airpay and SabPaisa responses are unchanged. |
| `apps/web/src/api/OrdersApi.js`, `apps/web/src/pages/CheckoutPage.jsx` | `getOnlineOrder(ref, key)`; checkout navigates to `/success?ref=…&k=<attempt id>` (also for the duplicate-attempt path). |
| `api/_lib/frontiva-payin.js` | A create response only yields a QR when the provider status is pending (`PENDING`/`PROCESSING`). `FAILED`, `COMPLETED` or unknown create statuses are stored as `created_not_launched` and nothing is shown to the customer. |
| `tests/frontiva-payin.test.js` | 40 new tests (607 → 647) plus updated status-helper calls: real QR encode → rasterise → `jsqr` decode round trip; page markup; status authorisation; documented create response and mismatches; payee parsing; lifecycle; reconcile methods/auth; env-name audit. |
| `package.json`, `package-lock.json` | `jsqr@1.4.0` as a **dev** dependency, for the QR decode test only. |
| `docs/FRONTIVA_PAYIN_RELEASE_RUNBOOK.md` | New. |

### Security notes

- **Fixed:** a payment request (`payment_intent`) could be read by anyone who knew an `order_ref`. It now needs the browser-generated attempt UUID (122 bits, never in a URL anyone else sees, not derived from the reference), and expires after 30 minutes. No migration, no new secret, no change for other gateways.
- **Not changed (backward compatibility):** the order itself (name, phone, address, items) is still returned for any known reference, for every gateway. See runbook §3.5.
- **Response signature:** the provider documents no response signature; the request `x-signature` (HMAC-SHA256 of the reference with the login-derived client secret) is tested. Create and status answers are validated independently for merchant id, reference, exact amount, currency, payee and status.

### Still requires a real provider response or payment

- Whether status polling settles without a callback despite `callbackNeeded: true` (no callback was invented).
- Ownership/stability of `frontivatrading373991.apy@rbl`.
- QR/PayIn expiry on the provider side.
- Real-device QR scan (the automated test proves the QR decodes to the exact intent, not that a given bank app accepts it).
- The `orders_payment_gateway_check` constraint and RLS state, which need the SQL in runbook §3.7.
