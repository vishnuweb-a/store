# 10 — Executive Summary: Frontiva PayIn

> **Update 2026-11-13 — multi-merchant implemented (uncommitted).** Frontiva PayIn slot 2 (`frontiva_payin_2`, off by default) and the AirPay MID 1 disablement are implemented; see [FRONTIVA-PAYIN-2-IMPLEMENTATION.md](FRONTIVA-PAYIN-2-IMPLEMENTATION.md). Line numbers below refer to `dff49ac` and may have shifted. Sections marked RECOMMENDED for multi-merchant are now implemented as described there.

As of 2026-11-13, commit `dff49ac`. Details and evidence: docs 01–09 in this folder.

**1. How does it work?**
At checkout the customer picks "Pay with Frontiva PayIn" and enters an email. The server prices the cart, writes a pending order, logs in to `portal.frontiva.online`, and creates a signed PayIn request. The provider returns a `upi://pay` intent. The server validates it (allowed payee, INR, exact amount) and the success page shows it as a QR code, plus an "Open UPI App" link on phones. Payment is confirmed only by the server asking the provider's status endpoint. That happens from the success page (status on read, a poll every 10 s for 5 min, and a manual button) and from a reconciliation job every 15 min. There is no webhook.

**2. Which modules?**
`api/_lib/frontiva-payin.js` is the provider client and decision logic. `api/_lib/frontiva-payin-orders.js` handles the order lifecycle and settlement. The endpoints are `api/payments/frontiva-payin/create.js` and `reconcile.js`. Shared pieces are `api/payments/status.js`, `options.js`, `health.js` and `api/_lib/orders.js` (dispatch). Frontend: `OrdersApi.js`, `CheckoutPage.jsx` and `SuccessPage.jsx`. Schema: `migrations-frontiva-payin.sql`. Scheduler: `.github/workflows/frontiva-payin-reconcile.yml`.

**3. How is a UPI payment initiated?**
`POST {portal}/api/payin-requests` with `Authorization: Bearer <token>` and `x-signature: HMAC-SHA256(clientSecret, merchantReference)`. The body is `{merchantReference, amount (rupees), currency:'INR', paymentMode:'UPI_INTENT', customer}`. The response's `intent` is validated and used byte for byte as the QR payload.

**4. How is success verified?**
A signed `GET /api/payin-requests?merchantReference=<ref>` must return `COMPLETED`, the same reference, the same portal merchant (if named) and the same amount in paise. A conditional, idempotent update then sets `paid`, at most once. Nothing the client sends can mark an order paid through the API.

**5. Which records?**
`public.orders` holds the customer-visible state (`payment_gateway='frontiva_payin'`, `payment_status`, `enquiry_count`, `last_checked_at`, `paid_at`, `gateway_txn_id`). `public.frontiva_payin_transactions` holds one row per order (attempt id, portal ids, create state, provider status, UTR, stored intent). It has RLS on and is reachable by the service role only.

**6. Credentials?**
Six `FRONTIVA_PAYIN_*` server env vars: enabled flag, base URL, email, password, expected merchant id and allowed payees. The client secret and token come from login and are kept in memory only. Nothing reaches the browser, and secrets are redacted from logs.

**Update:** Slot 2 is now implemented and off by default. The session-cache blocker and the missing merchant binding (F-03) are fixed. AirPay MID 1 is disabled for new payments. For rollout, see [FRONTIVA-PAYIN-2-IMPLEMENTATION.md](FRONTIVA-PAYIN-2-IMPLEMENTATION.md). Answers 7 and 8 below describe the state before that change.

**7. Can another merchant be added safely?**
Yes, after minor refactoring. One correctness blocker must be fixed first: the login session cache is a single global, so two merchants would share tokens. Orders also need to record which merchant they belong to.

**8. Recommended architecture.**
Option B is a shared adapter with merchant slots, the same pattern Airpay uses. `payment_gateway` stays `'frontiva_payin'`, a new nullable `orders.frontiva_payin_merchant` column holds the slot (NULL = today's account), and env vars get a `_N` suffix. Settlement loads only the order's own slot credentials and never falls back to slot 1.

**9. Files to change.**
`frontiva-payin.js`, `frontiva-payin-orders.js`, `orders.js`, `frontiva-payin/create.js`, `options.js`, `health.js`, `http.js` (secret scrub), `status.js` (payee name), `OrdersApi.js`, `CheckoutPage.jsx`, `SuccessPage.jsx`, a new additive migration plus `supabase-schema.sql`, `.env.example`, and the tests. Airpay and SabPaisa files are not touched. The checklist is in doc 08.

**10. Main risks.**
- **Critical, already present:** the `orders` table has an open anon RLS policy, so its "paid" flag can be forged directly in Supabase (doc 06 F-01).
- **Blocker:** the shared session cache (F-02).
- **Blocker:** no merchant binding on orders (F-03). The status fallback silently loads slot 1 config.
- The status merchant check is usually skipped, so it relies on the provider scoping status lookups to the logged-in account (F-04, unknown).
- Settlement for abandoned pages depends on a GitHub Actions schedule (F-05).
- The create endpoint has no rate limit (F-06).
- The payee name on the QR page is hard-coded (F-07).
- Open provider questions: separate logins and merchant ids per account, status scoping, expiry statuses.
