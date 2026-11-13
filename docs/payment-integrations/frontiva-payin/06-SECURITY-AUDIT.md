# 06 — Security & Reliability Audit: Frontiva PayIn

> **Update 2026-11-13 — multi-merchant implemented (uncommitted).** Frontiva PayIn slot 2 (`frontiva_payin_2`, off by default) and the AirPay MID 1 disablement are implemented; see [FRONTIVA-PAYIN-2-IMPLEMENTATION.md](FRONTIVA-PAYIN-2-IMPLEMENTATION.md). Line numbers below refer to `dff49ac` and may have shifted. Sections marked RECOMMENDED for multi-merchant are now implemented as described there.

Read-only audit. No fix applied. Paths relative to `store/`. Tags: **VERIFIED / INFERRED / UNKNOWN / RECOMMENDED**.

## 1. Verified controls

| Area | Control | Evidence |
|---|---|---|
| Merchant auth | Login result must name `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID`; fail closed otherwise | `frontiva-payin.js:331-334` |
| Transport | Base URL forced to an `https://` origin (password is posted there) | `:90-95` |
| Signing | HMAC-SHA256(clientSecret, merchantReference), lowercase hex; client secret from login only | `:152-162` |
| Server pricing | Browser price/merchant/gateway ignored; amount from `priceOrder` | `create.js:77-84` |
| Create answer binding | Response must match our ref, amount (paise) and session merchant, else treated as ambiguous | `:572-582` |
| No double create | POST never re-sent except after 401/403; ambiguous answers resolved via status GET | `:503-516, create.js:125-156` |
| Attempt idempotency | UNIQUE `checkout_attempt_id`, `ON CONFLICT DO NOTHING` | `frontiva-payin-orders.js:47-73` |
| UPI payee allowlist | `pa` must be in `FRONTIVA_PAYIN_ALLOWED_PAYEES`; empty list ⇒ gateway off | `:443-471`, `:129-140` |
| UPI tamper resistance | ASCII-only, no fragment, valid %-encoding, no duplicate keys after decoding, INR, exact amount; intent used byte-for-byte | `:443-471` |
| Provider HTML | `url` (incl. `data:text/html`) never forwarded to the browser | `:484-492`, test `:460` |
| Settlement truth | Only a server-side signed status GET can produce `paid`; requires COMPLETED + ref + merchant (if present) + amount | `:734-772` |
| Idempotent settlement | Conditional UPDATE on open statuses; concurrent `paid` applied once | `frontiva-payin-orders.js:259-275`, test `:722` |
| Throttle | One provider check per order per 8 s (optimistic claim) | `:189-202` |
| Bounded checks | 100 automatic checks then `requires_review` | `:176-187` |
| Reconcile auth | Bearer `CRON_SECRET`, constant-time; unset ⇒ deny | `http.js` `isCronAuthorized` |
| QR restore auth | Requires `order_ref` **and** matching `checkout_attempt_id`; ≤30 min; open only | `frontiva-payin-orders.js:110-138` |
| Ref injection | `order_ref` format-gated before PostgREST filters | `orders.js:131` |
| PII | Status response masks customer; email never stored | `status.js:29-42` |
| Secret hygiene | Log redaction + `scrubSecrets`; token/secret memory-only; tests assert no leaks | `http.js`, tests `:299, :484` |
| Isolation | PayIn never imports Airpay/SabPaisa/KKChat forwarder | test `:817` |

## 2. Findings (prioritized)

### F-01 — CRITICAL — `orders` table is writable with the public anon key
- **Files:** `supabase-schema.sql:63-65` (policy `"prototype orders access" FOR ALL USING (true) WITH CHECK (true)`), `apps/web/src/lib/supabase.js` (anon key in bundle), `docs/FRONTIVA_PAYIN_RELEASE_RUNBOOK.md:131`.
- **Explanation:** anyone can call Supabase PostgREST directly with the anon key and `PATCH orders SET payment_status='paid'` (or change `total`) for any order. All server-side PayIn verification is bypassed for the purpose of "is this order paid?". Not PayIn-specific — affects every gateway.
- **Consequence:** goods shipped against fake "paid" orders; tampered totals.
- **Status:** VERIFIED in schema file; live policy **UNKNOWN**.
- **Recommended:** move COD creation server-side, drop the open policy (service-role only for writes), or at least restrict anon to INSERT of COD rows. Until then, operations must confirm payment against the provider (`frontiva_payin_transactions.provider_status`, which anon cannot write) before fulfilment.

### F-02 — HIGH (blocker for multi-merchant; not a bug today) — single global session cache
- **Files:** `frontiva-payin.js:249-381` (`cachedSession`, `inflightLogin`, `loginBlockedUntil`, `lastLoginError` are module singletons).
- **Explanation:** `getFrontivaSession(config)` ignores which config it was given once a session is cached. With two merchant configs in one function instance, merchant B's requests would be signed with merchant A's token and client secret. A login failure on one merchant would put all merchants into cooldown.
- **Consequence (multi-merchant):** wrong-credential creates (mitigated: create response merchant check → `ambiguous`), cross-merchant status lookups (→ `not_found` → stuck/`requires_review`), cross-merchant outage.
- **Recommended:** key all four variables by merchant slot (or by `config.email + expectedMerchantId`), and assert `session.merchantId === config.expectedMerchantId` before use.

### F-03 — HIGH (multi-merchant) — order does not record its PayIn merchant
- **Files:** `orders.js:94-123`, `frontiva-payin-orders.js:163-256`, `create.js:158-165`.
- **Explanation:** settlement calls `fetchFrontivaPayinStatus(orderRef)` with the *current* env config. `portal_merchant_id` is written late and never read. If credentials are changed to a different portal account, every open order is checked against the wrong account.
- **Consequence:** silent cross-merchant verification attempts; legacy orders stuck after a credential swap.
- **Recommended:** persist the merchant slot on the order row at INSERT time; settlement loads that slot's config; unknown slot ⇒ no check (never fall back to slot 1). Cross-check `portal_merchant_id` when present.

### F-04 — MEDIUM — merchant check skipped when status omits `merchantId`
- **Files:** `frontiva-payin.js:753`.
- **Explanation:** `answer.merchantId !== null && …` — the documented status sample omits `merchantId`, so the check is usually a no-op. Correctness relies on the portal scoping status queries to the logged-in merchant (**UNKNOWN**, provider question).
- **Recommended:** confirm scoping with the provider; for multi-merchant compare `portal_request_id` from the status answer with the stored one.

### F-05 — MEDIUM — settlement depends on an external scheduler
- **Files:** `.github/workflows/frontiva-payin-reconcile.yml`, `vercel.json` (no `crons`).
- **Explanation:** no webhook by design; abandoned-page payments settle only via the GitHub cron. GitHub schedules can be delayed or auto-disabled; secrets' presence is **UNKNOWN**.
- **Recommended:** monitor `payment.frontiva_payin.reconcile.completed` log events; alert when absent > 30 min; consider a Vercel cron as a second trigger (overlap is safe — claims are idempotent).

### F-06 — MEDIUM — no rate limiting on the public create endpoint
- **Files:** `api/payments/frontiva-payin/create.js` (no throttle found; `grep -ri "rate.?limit" api` returns nothing).
- **Explanation:** each call with a fresh UUID creates a DB order and a real provider PayIn and may trigger a login.
- **Consequence:** provider-side spam/cost, DB growth, possible provider rate limiting (429 → ambiguous) affecting real customers.
- **Recommended:** per-IP/phone throttle, or Vercel WAF rate rule on `/api/payments/frontiva-payin/create`.

### F-07 — MEDIUM — hard-coded payee name on the success page
- **Files:** `apps/web/src/pages/SuccessPage.jsx:321-324` ("Frontiva Trading Private Limited").
- **Explanation:** the customer is told which payee to expect; a second merchant with a different legal name would show wrong guidance.
- **Recommended:** server-provided, per-merchant display name (non-secret) or neutral wording.

### F-08 — LOW — attempt key in URL query
- **Files:** `CheckoutPage.jsx:213`, `SuccessPage.jsx:115`.
- **Explanation:** `k=<attempt_id>` lands in browser history, Vercel request logs and possibly `Referer`. It only unlocks the QR (a payment request to our own payee) for ≤30 min.
- **Recommended:** acceptable; optionally move to `sessionStorage`.

### F-09 — LOW — `auth_error` on status goes straight to `requires_review`
- **Files:** `frontiva-payin.js:740-743`.
- **Explanation:** a transient provider 401/403 (after re-login) moves the order to review immediately; it stays open and reconcile keeps checking, but `/success` stops re-checking on read (`status.js:22`) — the customer sees "under review" and polling stops.
- **Recommended:** treat a single `auth_error` like `unavailable` inside the review window.

### F-10 — LOW — provider expiry not tracked
- **Files:** `frontiva-payin.js` (no `expiresAt` read).
- **Explanation:** QR hides after 30 min locally; provider PayIn expiry is unknown. A provider `EXPIRED` status (if it exists) maps to `requires_review` rather than `failed`.
- **Recommended:** confirm the catalogue with the provider; map an explicit expiry status to `failed`.

### F-11 — LOW — float in expected amount
- **Files:** `frontiva-payin-orders.js:204` (`Math.round(Number(order.total) * 100)`).
- **Explanation:** safe for `numeric(10,2)` ranges (rounding fixes binary error); noted only because the provider side uses exact string parsing.

### F-12 — LOW — config hygiene
- Local `../.env` defines `FRONTIVA_PAYIN_ALLOWED_PAYEES` three times. `scrubSecrets` (`http.js:150-170`) is a hard-coded list — every new secret variable must be added manually.

### F-13 — INFO — orphan transaction rows
- If the order INSERT fails after the attempt claim, a `frontiva_payin_transactions` row exists without an order. Harmless (no PayIn created, browser drops the attempt id).

## 3. Payment-integrity checklist

| Property | Status |
|---|---|
| Amount integrity (create & settle) | ✅ exact paise, both directions (subject to F-01) |
| Merchant identity consistency | ✅ login + create; ⚠ status (F-04); ❌ per-order (F-03) |
| Order reference uniqueness | ✅ UNIQUE on `orders.order_ref` and tx `order_ref` |
| Attempt uniqueness | ✅ UNIQUE `checkout_attempt_id` |
| Duplicate successful payments | ✅ one PayIn per order; ⚠ a customer can pay two different orders (two attempts) — each is a separate order |
| Trusted confirmation | ✅ server-side only (subject to F-01) |
| Status transition validation | ✅ open-status filter; terminal never overwritten |
| Webhook authenticity | n/a — no webhook |

## 4. Logging recommendations

- Existing events (all JSON via `logEvent`): `payment.frontiva_payin.login_failed`, `.create.ok`, `.create.refused`, `.create.ambiguous`, `.create.unsupported_launch`, `.create.duplicate_attempt`, `.create.misconfigured`, `.create.failed`, `.metadata_not_saved`, `payment.settle.frontiva_payin_not_paid`, `payment.settle.applied`, `.reconcile.completed|failed|unauthorized|order_failed`.
- **RECOMMENDED:** add a `merchant` (slot number, never credentials) field to every PayIn event once multi-merchant lands; alert on `merchant_mismatch`, `amount mismatch`, `portal merchant mismatch`, and on `requires_review` growth.
