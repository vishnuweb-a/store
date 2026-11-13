# Frontiva PayIn 2 + AirPay MID 1 disablement — Implementation

Date: 2026-11-13. Base commit: `dff49ac` (uncommitted working tree). Paths relative to `store/`.
Implements design Option B of [07-MULTI-MERCHANT-DESIGN.md](07-MULTI-MERCHANT-DESIGN.md) following [08-NEW-INTEGRATION-PLAYBOOK.md](08-NEW-INTEGRATION-PLAYBOOK.md). No secrets appear in this document.

> **Namespaces.** Frontiva PayIn *slots* (1, 2) and AirPay *merchants* (1, 2, 3) are unrelated. PayIn slot 2 is a second Frontiva portal account; it shares nothing with AirPay MID 2 — not credentials, signing, merchant IDs, callbacks or references.

## 1. Implementation summary

| Integration | New checkout | Existing orders | How |
|---|---|---|---|
| AirPay MID 1 | **Disabled** | Still settle (callbacks on both paths, `/status`, `/reconcile`, health probe) | Hard-coded `AIRPAY_MID_1 = { enabled: false }`, same as MID 2 |
| AirPay MID 2 | Disabled (unchanged) | Still settle | `AIRPAY_MID_2 = { enabled: false }` (commit `77fd1a3`) |
| AirPay MID 3 | Unchanged | Unchanged | — |
| Frontiva PayIn slot 1 | Unchanged (`FRONTIVA_PAYIN_ENABLED`) | Unchanged; NULL slot = slot 1 | Same env names, same request body, same order insert |
| Frontiva PayIn slot 2 | **New**, off until `FRONTIVA_PAYIN_ENABLED_2=true` | Settle with slot-2 credentials only, also while disabled | Shared adapter, per-slot config and session |
| SabPaisa | Unchanged | Unchanged | No SabPaisa file changed |

## 2. Files changed

| File | Change |
|---|---|
| `api/_lib/frontiva-payin.js` | `FRONTIVA_PAYIN_MERCHANTS = [1, 2]`, `parseFrontivaMerchant`, `loadFrontivaPayinConfig(slot)` (returns `slot`, `payeeName`), `isFrontivaPayinConfigured/frontivaPayinEnabled/frontivaPayinAvailable(slot)`, `availableFrontivaMerchants()`, slot-collision check, per-slot session map with merchant-ID assertion |
| `api/_lib/frontiva-payin-orders.js` | `frontivaSlotForOrder(order)`; settlement loads only the order's slot; unknown slot ⇒ no provider call; missing slot config ⇒ `not_configured` (no slot-1 fallback); `portal_merchant_id` cross-check |
| `api/_lib/orders.js` | `createPendingOrder({…, frontivaMerchant})` writes `frontiva_payin_merchant` only for slot ≠ 1 |
| `api/payments/frontiva-payin/create.js` | Parses `merchant` (absent = 1), 400 `invalid_merchant`, 503 for a disabled slot, per-slot config, slot in every log event |
| `api/payments/options.js` | Additive `frontiva_payin_merchants` (only when a slot ≥ 2 is available) |
| `api/payments/status.js` | Additive `payee_name` for PayIn orders, from the order's slot |
| `api/health.js` | Additive `frontiva_payin_merchants: { "2": {configured, enabled, offered_at_checkout} }` |
| `api/_lib/http.js` | `scrubSecrets` covers `FRONTIVA_PAYIN_PASSWORD_2` |
| `api/_lib/config.js` | `AIRPAY_MID_1` flag; `checkoutMerchants()` excludes merchant 1 |
| `api/payments/create.js` | Comment only (MID 1 refusal goes through the existing `checkoutMerchants()` check) |
| `apps/web/src/api/OrdersApi.js` | `PAYMENT_GATEWAYS = [3]` (old lines kept commented), `FALLBACK_GATEWAYS = [3]`, `FRONTIVA_PAYIN_GATEWAY_2`, `frontivaSlotFor()`, `merchant` sent only for slot ≠ 1, `payee_name` passed through |
| `apps/web/src/pages/CheckoutPage.jsx` | Airpay 1 entry commented out, default gateway 3, new option "Pay with Frontiva PayIn 2", slot-aware PayIn predicates |
| `apps/web/src/pages/SuccessPage.jsx` | Payee name from server instead of hard-coded text |
| `migrations-frontiva-payin-merchants.sql` (new), `supabase-schema.sql` | Additive `orders.frontiva_payin_merchant` + check constraint |
| `.env.example` | Slot-2 block |
| `tests/frontiva-payin-merchants.test.js` (new) | 37 multi-merchant tests |
| `tests/helpers/qr.js` (new) | QR decode helper moved out of `frontiva-payin.test.js` for reuse |
| `tests/dual-airpay.test.js` | MID 1 flag in setup; new "AIRPAY MID_1 temporarily disabled" suite (12 tests); source pins updated |
| `tests/frontiva-payin.test.js`, `tests/sabpaisa.test.js`, `apps/web/src/pages/__tests__/CheckoutPage.email.test.jsx` | Expectations updated to the new state; 6 new checkout UI tests |

Not changed: `api/_lib/airpay.js`, `api/_lib/sabpaisa.js`, `api/payments/sabpaisa/*`, `api/payments/callback.js`, `api/payments/reconcile.js`, `api/payments/frontiva-payin/reconcile.js`, `api/_lib/callback-payload.js`, `api/_lib/forward-callback.js`, `vercel.json`, the reconcile workflow.

## 3. Frontiva PayIn 2 flow

```mermaid
sequenceDiagram
  participant B as Browser
  participant O as /api/payments/options
  participant C as /frontiva-payin/create
  participant DB as Supabase
  participant P as Portal (account 2)
  participant S as /api/payments/status + reconcile
  B->>O: GET
  O-->>B: frontiva_payin_merchants: [1, 2]
  B->>C: {customer, email, items, attempt_id, merchant: 2}
  C->>C: parseFrontivaMerchant → 2; frontivaPayinAvailable(2)
  C->>DB: claim attempt; INSERT order (payment_gateway='frontiva_payin', frontiva_payin_merchant=2)
  C->>P: login (EMAIL_2/PASSWORD_2), merchantId must = EXPECTED_MERCHANT_ID_2
  C->>P: POST /api/payin-requests (slot-2 token, HMAC with slot-2 secret)
  C->>C: intent payee ∈ ALLOWED_PAYEES_2, INR, exact amount
  C-->>B: launch {upi_intent} → QR on /success
  S->>DB: load order → frontivaSlotForOrder = 2
  S->>P: GET status (slot-2 session only)
  S->>DB: conditional UPDATE (open → paid/failed/processing/requires_review)
```

1. **Discovery** — `options` lists slot 2 only when it is enabled, fully configured, has payees, does not share slot 1's email or merchant ID, and the service role is present.
2. **Checkout** — "Pay with Frontiva PayIn 2" uses the same email field, validation, loading state, QR page and errors as slot 1. The browser sends `merchant: 2`; slot 1 sends no `merchant` key.
3. **Create** — the server rejects unknown values (400) and disabled slots (503) before any login, order or PayIn. It never moves a request to another slot.
4. **Order binding** — the slot is written in the same INSERT that creates the order, before any provider call.
5. **Settlement** — the slot is read from the stored order and nowhere else. The server loads that slot's config, logs in with that slot's session, and asks for that `merchantReference`. The answer must name the slot's merchant and the exact amount. A NULL slot is 1; an unknown value means no call and no change; a missing slot-2 config means `requires_review`, never a slot-1 call.

## 4. Environment variables (names only)

| Name | Required | Notes |
|---|---|---|
| `FRONTIVA_PAYIN_ENABLED_2` | No (default off) | Only literal `true` enables new slot-2 payments |
| `FRONTIVA_PAYIN_BASE_URL_2` | No | Falls back to `FRONTIVA_PAYIN_BASE_URL`, then `https://portal.frontiva.online`; https origin only |
| `FRONTIVA_PAYIN_EMAIL_2` | Yes | Must differ from slot 1's, or slot 2 is never offered |
| `FRONTIVA_PAYIN_PASSWORD_2` | Yes | **Secret** (scrubbed from logs) |
| `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_2` | Yes | Must differ from slot 1's, or slot 2 is never offered |
| `FRONTIVA_PAYIN_ALLOWED_PAYEES_2` | Yes to start payments | Slot 2's own UPI VPAs; slot 1's list is never consulted |
| `FRONTIVA_PAYIN_PAYEE_NAME_2` | No | Non-secret name shown on the QR page; without it the page shows no payee name for slot-2 orders |

Slot 1 names are unchanged. `FRONTIVA_PAYIN_PAYEE_NAME` (optional) can override the slot-1 QR text, which defaults to the name the page has always shown.

## 5. Database migration

File: `migrations-frontiva-payin-merchants.sql`. It is additive and idempotent: one nullable `smallint` column and a check constraint (`NULL`, or `payment_gateway = 'frontiva_payin'` and a value of 2–99). It does **not** change `orders_payment_gateway_check`. There is no backfill, and no new index (settlement reads by the unique `order_ref`).

**Status: NOT applied** to any database.

Order:
1. `migrations-sabpaisa.sql` and `migrations-frontiva-payin.sql` (already prerequisites).
2. `migrations-frontiva-payin-merchants.sql` in the Supabase SQL editor.
3. Verify with the two queries at the end of the file.
4. Only then set `FRONTIVA_PAYIN_ENABLED_2=true`.

The code is safe to deploy **before** the migration. Slot 1 never names the column, and the reconcile listing does not select it. Until the migration runs, a slot-2 insert fails (customer sees "not started"; no PayIn is created).

Permissions: the column inherits `orders`' existing policies. Doc 06 **F-01** (anon-writable `orders`) still applies: a client with the anon key could write this column on a PayIn row. The worst outcome is a mismatched or `requires_review` settlement, never `paid`. Payment still needs a verified COMPLETED answer naming our reference, merchant and amount.

## 6. Gateway availability rules

| Gateway id (browser) | Server switch | Offered when |
|---|---|---|
| `1` (AirPay MID 1) | `AIRPAY_MID_1.enabled` (code) | Never while the flag is `false` |
| `2` (AirPay MID 2) | `AIRPAY_MID_2.enabled` (code) | Never while the flag is `false` |
| `3` (AirPay MID 3) | `AIRPAY_ENABLED_MERCHANTS` + config | Unchanged |
| `sabpaisa` | `SABPAISA_ENABLED` + config | Unchanged |
| `frontiva_payin` | `FRONTIVA_PAYIN_ENABLED` + slot-1 config | Unchanged |
| `frontiva_payin_2` | `FRONTIVA_PAYIN_ENABLED_2` + slot-2 config + no collision | Server lists `frontiva_payin_merchants` containing 2 |

Browser fallback when `/options` is unreadable: `[3]`, never 1 or 2. A successful answer is always used as given, even when it is empty. An absent AirPay selection still means merchant 1, and the server now refuses it with `merchant_unavailable` (503). It is never rerouted to merchant 3.

## 7. Security checks

| Check | Result |
|---|---|
| Credential isolation | Each slot reads only its own `_N` names (base URL may be shared); tested |
| Session isolation | Map keyed by slot + base URL + email; each slot has its own token, in-flight login, cooldown and last error; invalidation clears one slot; tested |
| Merchant identity | Login must return the slot's expected merchant ID; cached session reused only if it matches; create/status answers must name it; stored `portal_merchant_id` must match |
| Cross-merchant verification | Settlement uses the stored slot only; unknown slot ⇒ no call; missing config ⇒ review; mutation-tested (injecting a slot-1 fallback fails the suite) |
| Amount integrity | Unchanged: server pricing, exact paise compare in intent and status |
| Payee allowlist | Per slot; slot-2 intent paying slot-1 VPA is refused; tested |
| Duplicates | Attempt-id claim (409) and conditional UPDATE barrier unchanged; concurrent slot-2 checks pay once; tested |
| Order reference | `newOrderRef()` unchanged, globally unique across slots |
| Secret leakage | `PASSWORD_2` scrubbed; no slot-2 password/token/secret/login email in logs during a slot-2 payment; no `_2` variable or login email in browser code; tested |
| Status spoofing | Browser never decides payment; settlement only from provider status |
| Fallback | No slot-2 → slot-1 fallback; no AirPay 1 → 3 reroute; browser fallback `[3]`; tested |
| Disabled merchant API access | Direct `merchant: 1/'1'/absent/null` (AirPay) and disabled slot 2 (PayIn) refused before OAuth/login/order; tested |
| Legacy settlement | MID 1 and MID 2 callbacks (both paths), status, reconcile tested; disabled slot 2 still settles; tested |

## 8. Test results (2026-11-13, mocked providers only)

| Command | Before | After |
|---|---|---|
| `node --test "tests/*.test.js"` | 660 passed | **709 passed**, 0 failed (124 suites) |
| `npx vitest run` (apps/web) | 10 passed | **15 passed**, 0 failed |
| `npm run lint` | clean | clean |
| `npm run build` | ok | ok |

No live portal, AirPay or SabPaisa call was made, and no payment was initiated.

## 9. Deployment procedure

1. Review and commit the change. Deploy with `FRONTIVA_PAYIN_ENABLED_2` unset or `false`.
2. Check `/api/payments/options`. `merchants` should be `[3]` (when MID 3 is enabled), and the `frontiva_payin` key should be unchanged.
3. Check `/api/health`. `merchants.1.offered_at_checkout` should be `false`, `merchants.1.configured` should be `true`, and `frontiva_payin_merchants.2.enabled` should be `false`.
4. Run `migrations-frontiva-payin-merchants.sql`, then verify it.
5. Set the slot-2 variables in Vercel Production. Mark the password Sensitive and keep slot 2 disabled. Redeploy, then confirm `frontiva_payin_merchants.2.configured: true`.
6. Settle the provider questions in doc 07 §8. Confirm each account has its own `merchantId` and payee VPA from a real create response.
7. Run one controlled live test, with owner approval. Enable slot 2, make one small payment, and confirm `paid`, `frontiva_payin_merchant = 2`, and that it appears on portal account 2 only. Then disable slot 2 again until sign-off.
8. Enable slot 2 for customers. Monitor `payment.frontiva_payin.*` and `payment.settle.frontiva_*` events for 24–48 h.

## 10. Rollback

- **Slot 2, fast:** set `FRONTIVA_PAYIN_ENABLED_2=false` and redeploy. New slot-2 payments stop, and open slot-2 orders keep settling.
- **Code rollback:** only once `select count(*) from orders where frontiva_payin_merchant = 2 and payment_status in ('initiated','processing','requires_review')` returns 0. Older code ignores the column and would verify those orders with slot 1.
- **Never** drop the column or delete the slot-2 credentials while slot-2 orders exist.
- **AirPay MID 1 re-enable:** set `AIRPAY_MID_1.enabled = true` in `api/_lib/config.js`, restore `[1, 3]` in `OrdersApi.js` `PAYMENT_GATEWAYS`/`FALLBACK_GATEWAYS`, and uncomment the `CheckoutPage.jsx` entry and default (mirror of the MID 2 reactivation). Then update the "AIRPAY MID_1 temporarily disabled" test suite.
