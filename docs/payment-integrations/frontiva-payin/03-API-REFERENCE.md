# 03 — API Reference: Frontiva PayIn

> **Update 2026-11-13 — multi-merchant implemented (uncommitted).** Frontiva PayIn slot 2 (`frontiva_payin_2`, off by default) and the AirPay MID 1 disablement are implemented; see [FRONTIVA-PAYIN-2-IMPLEMENTATION.md](FRONTIVA-PAYIN-2-IMPLEMENTATION.md). Line numbers below refer to `dff49ac` and may have shifted. Sections marked RECOMMENDED for multi-merchant are now implemented as described there.

Paths relative to `store/`. All examples are **sanitized**; no real credential, token, secret or customer appears. Tags: **VERIFIED / INFERRED / UNKNOWN / RECOMMENDED**.

---

## Part A — Internal endpoints (this application)

### A1. `GET /api/payments/options`
File: `api/payments/options.js`. Auth: none. **VERIFIED**

```json
// PayIn available
{ "merchants": [1, 3], "sabpaisa": false, "frontiva_payin": true }
// PayIn not available: key absent (response identical to pre-PayIn)
{ "merchants": [1, 3], "sabpaisa": false }
```

### A2. `POST /api/payments/frontiva-payin/create`
File: `api/payments/frontiva-payin/create.js`. Auth: none (public checkout). `maxDuration` 60 s. **VERIFIED**

Request (`application/json`):
```json
{
  "customer": { "fullName": "Example Customer", "phone": "9999999999", "address": "1 Example Road, City", "landmark": "" },
  "email": "customer@example.com",
  "items": [{ "product_id": 7, "size": null, "quantity": 1 }],
  "attempt_id": "3f1c2a9e-8b7d-4c1e-9f2a-0d4b6c8e1a23"
}
```
Any price, merchant or gateway field sent by the browser is ignored.

Responses:

| HTTP | Body | When |
|---|---|---|
| 200 | `{ "order_ref": "FRV…", "order_id": 123, "total_in_cents": 150000, "launch": { "type": "upi_intent", "url": "upi://pay?pa=<payee>@<psp>&pn=<name>&cu=INR&am=1500.00&tr=<ref>…" } }` | PayIn created, intent validated |
| 400 | `{ "error": "Please refresh the page and try again.", "code": "invalid_attempt" }` | bad `attempt_id` |
| 400 | `{ "error": "<validation message>", "invalid_items"?: [0] }` | customer/email/items/amount invalid |
| 405 | `{ "error": "Method not allowed" }` | not POST |
| 409 | `{ "error": "This payment is already being processed.", "code": "duplicate_attempt", "order_ref": "FRV…" }` | same `attempt_id` again |
| 502 | `{ "error": "We could not start the Frontiva PayIn payment. You have not been charged…", "code": "frontiva_payin_not_started" }` | rejected, ambiguous, or no usable intent |
| 502 | same message, `"code": "database"` or `"unexpected"` | DB / unexpected error |
| 503 | `{ "error": "Frontiva PayIn is temporarily unavailable…", "code": "frontiva_payin_unavailable" }` | disabled, misconfigured, login failed |

`total_in_cents` is INR **paise** (historic name).

### A3. `GET /api/payments/status?ref=<order_ref>[&k=<attempt_id>]`
File: `api/payments/status.js` (shared by all online gateways). Auth: possession of `order_ref`; `k` additionally unlocks the QR. **VERIFIED**

- `ref` must match `^FRV[A-Z0-9]{5,61}$` (`orders.js:131`), else 404.
- If `payment_status ∈ {initiated, processing}`, one `settleOrder()` call is made first (throttled server-side to one provider check per 8 s per order).
- Response: `{ "order": <presentOrder, customer masked>, "payment_intent"?: "upi://pay?..." }`. `payment_intent` only for an open (`initiated`/`processing`) `frontiva_payin` order ≤ 30 min old whose transaction row has the same `checkout_attempt_id` and `create_state='created'`.
- `order.payment_gateway` = `"frontiva_payin"` (the success page uses this to decide polling/QR).
- 400 missing ref, 404 not found / not online, 502 load failure.

### A4. `GET|POST /api/payments/frontiva-payin/reconcile`
File: `api/payments/frontiva-payin/reconcile.js`. Auth: `Authorization: Bearer $CRON_SECRET` (constant-time compare; unset secret ⇒ always 401). **VERIFIED**

- No request input is read. Lists due orders (`listFrontivaPayinDue`: open, `frontiva_payin`, older than 10 min, outside per-order backoff, budget not exhausted), max 10, sequential, 40 s budget.
- 200 `{ "ok": true, "checked": n, "settled": n, "unchanged": n, "errors": n, "deferred": n }` · 401 · 405 · 500 `{ "ok": false, "error": "Reconciliation failed" }`.

### A5. `GET /api/health`
`api/health.js:111-119`: includes `"frontiva_payin": { "configured": bool, "enabled": bool, "offered_at_checkout": bool }`. Never performs a live login. Not part of `ok`.

### A6. Not present
No PayIn callback/webhook endpoint exists (VERIFIED). `api/payments/callback.js` is Airpay's; it can trigger a PayIn status check only indirectly via `settleOrder()` dispatch for a `frontiva_payin` order (**INFERRED** from code path; harmless — still server-verified and throttled).

---

## Part B — External Frontiva PayIn portal API

Base: `FRONTIVA_PAYIN_BASE_URL`, default `https://portal.frontiva.online`; must be an `https://` origin with no path (`frontiva-payin.js:90-95`). Timeout 15 s per call. Provider doc: "Payin API — Direct Integration v1.0.0" (local copy `../Payin API.pdf`, outside the repo).

### B1. Login — `POST /api/auth/user/login`
Code: `login()` `frontiva-payin.js:282-340`. **VERIFIED** (shape confirmed by test fixture `tests/frontiva-payin.test.js:91-100, 258`).

Request headers: `Content-Type: application/json`, `Accept: application/json`.
```json
{ "email": "<FRONTIVA_PAYIN_EMAIL>", "password": "<FRONTIVA_PAYIN_PASSWORD>" }
```
Response used:
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "accessToken": "<jwt>",
    "refreshToken": "<ignored>",
    "user": { "id": 2, "merchantId": 1, "clientSecret": "<secret>", "...": "..." }
  }
}
```
- Required: `data.accessToken` (string), `data.user.clientSecret` (string), `data.user.merchantId` (must `String()`-equal `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID`).
- 400/401/403 → `invalid_credentials`; other non-2xx → `unavailable`; missing fields → `malformed`; wrong merchant → `merchant_mismatch`.
- Retries once on network error or 5xx. After any failure, a 30 s per-instance cooldown.
- Session lifetime: min(JWT `exp`, 7 days) − 10 min. `refreshToken` is **not used** (renewal contract **UNKNOWN**; re-login is used instead).
- Token and client secret live in process memory only.

### B2. Signature
`generateFrontivaSignature(merchantReference, clientSecret)` (`:152-162`):
```
x-signature = lowercase_hex( HMAC_SHA256( key = data.user.clientSecret, message = merchantReference ) )
```
Only the reference is signed — not body, amount, method, path or timestamp. Same signature scheme for create and status. Test vector cross-checked against `openssl` (`tests/frontiva-payin.test.js:154`).

### B3. Create — `POST /api/payin-requests`
Code: `createFrontivaPayin()` `:517-603`.

Headers: `Authorization: Bearer <accessToken>`, `x-signature: <hex>`, `Content-Type: application/json`, `Accept: application/json`.
```json
{
  "merchantReference": "FRVMH0XAMPLE1A2B3C4D5E",
  "amount": 1500,
  "currency": "INR",
  "paymentMode": "UPI_INTENT",
  "customer": { "name": "Example Customer", "email": "customer@example.com", "phone": "9999999999" }
}
```
- `amount` is a JSON **number in rupees** (`paiseToRupees`: 150050 paise → `1500.5`). Minimum 1.00. `merchantReference` ≤ 50 chars.
- `paymentMode` `UPI_INTENT`: **VERIFIED in code** as the value sent; the provider's doc table says `UPI` and examples say `CARD` (docx review) — the code comment states the live response reports `UPI_INTENT`. Treat as confirmed by the owner's live test, **not independently verifiable here**.

Response (verified sample shape — bare record, HTTP 201):
```json
{
  "id": 810333,
  "merchantId": 1,
  "merchantReference": "FRVMH0XAMPLE1A2B3C4D5E",
  "amount": "1500",
  "status": "PENDING",
  "paymentMode": "UPI_INTENT",
  "callbackNeeded": true,
  "url": null,
  "intent": "upi://pay?pa=<payee>@<psp>&pn=<Payee+Name>&cu=INR&tn=<note>&am=1500.00&mc=<mcc>&mode=04&tr=<provider-ref>"
}
```
Field handling:

| Field | Required | Use |
|---|---|---|
| `id` | yes (non-null) | `portal_request_id` |
| `merchantReference` | yes, must equal ours | match check |
| `amount` (or `requestedAmount`) | yes, must equal ours in paise | match check |
| `merchantId` | yes, must equal session merchant | match check |
| `status` | expected `PENDING`/`PROCESSING` to launch | `provider_status` |
| `paymentMode` | optional; if present must be `UPI_INTENT` | launch check |
| `intent` | required to launch | validated, shown as QR, stored as `upi_intent` |
| `url` | ignored (may be null or `data:text/html…`) | never forwarded |
| `callbackNeeded` | ignored, logged only | — |
| `{success, data}` envelope | accepted if present | unwrapped |

Other documented fields (fees, `amountToCredit`, wallet ids, `expiresAt`, `failureReason`) are **not read** (VERIFIED). Provider-side PayIn expiry (`expiresAt`) is therefore **UNKNOWN** to the app.

Error handling: see doc 02 §3 table (`401/403` → re-login + resend once; `409/429/5xx/timeout/mismatch` → ambiguous, never re-POSTed; other `4xx` → rejected).

### B4. Status — `GET /api/payin-requests?merchantReference=<ref>`
Code: `fetchFrontivaPayinStatus()` `:619-710`. Same headers (no body), signature over `<ref>`. One retry on transport failure; 401/403 → re-login once.

Accepted response forms: `{success:true, data:{…}}`, bare record, or `data: [ … ]` (filtered to exactly one row with our `merchantReference`).
```json
{
  "success": true,
  "data": {
    "id": 810333,
    "merchantReference": "FRVMH0XAMPLE1A2B3C4D5E",
    "requestedAmount": "1500.00",
    "amountToCredit": "1410",
    "status": "COMPLETED",
    "utr": "<bank-utr>"
  }
}
```
Returned (internal) object: `{ outcome, status, amountPaise, merchantReference, merchantId, expectedMerchantId, portalRequestId, utr, httpStatus, reason }`.

| HTTP / body | `outcome` |
|---|---|
| 404, or array with no matching row | `not_found` |
| 401/403 (after re-login), login invalid/mismatch | `auth_error` |
| 429, 5xx, timeout, network, login unavailable | `unavailable` |
| other non-2xx, `success:false`, unparsable, >1 matching rows | `invalid` |
| config missing | `not_configured` |
| 2xx readable | `answered` |

Amount: `requestedAmount` preferred, else `amount`; if both present and different → amount unknown (→ `requires_review` on COMPLETED). `merchantId` may be absent in the status answer (documented sample omits it); then the merchant check is skipped.

Provider status catalogue (documented): `COMPLETED`, `PENDING`, `FAILED`; `PROCESSING` seen in examples. Others **UNKNOWN**.

### B5. Not used
Provider webhook ("Complete Flow → receive webhook" in the provider doc): **not implemented, by owner decision**. Refresh-token endpoint: not documented, not used. Payout API: not used.
