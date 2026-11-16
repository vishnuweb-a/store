# Frontiva PayIn 3 replaces the Airpay MID 3 checkout option

Date: 2026-11-16. Paths relative to `store/`. Builds on [FRONTIVA-PAYIN-2-IMPLEMENTATION.md](FRONTIVA-PAYIN-2-IMPLEMENTATION.md) (multi-merchant design, doc 07/08). No secret values appear here.

> **Namespaces.** Frontiva PayIn *slot 3* and Airpay *MID 3* are unrelated accounts. Only the **checkout position** moved: the third option that used to start Airpay MID 3 now starts Frontiva PayIn slot 3.

## 1. State after this change

| Integration | New checkout | Existing orders |
|---|---|---|
| Airpay MID 1, MID 2 | Disabled (unchanged) | Still settle |
| **Airpay MID 3** | **Disabled** — `AIRPAY_MID_3 = { enabled: false }` | Still settle: callbacks (both paths), `/status`, `/reconcile`, health probe |
| SabPaisa | Unchanged | Unchanged |
| Frontiva PayIn slot 1 / 2 | Unchanged | Unchanged |
| **Frontiva PayIn slot 3** | **New**; off until `FRONTIVA_PAYIN_ENABLED_3=true` | Settle with slot-3 credentials only, also while disabled |

With MID 1, 2 and 3 all disabled, `/api/payments/options` returns `merchants: []`. The browser's Airpay list (`PAYMENT_GATEWAYS`) and its unreadable-options fallback are both empty, so **no Airpay option can be offered or submitted**. Online options appear only on the server's explicit word.

## 2. Files changed

| File | Change |
|---|---|
| `api/_lib/config.js` | `AIRPAY_MID_3` flag (hard-coded, same mechanism as MID_1/2); `checkoutMerchants()` excludes merchant 3. `configuredMerchants()` is untouched, so settlement keeps merchant 3 |
| `api/_lib/frontiva-payin.js` | `FRONTIVA_PAYIN_MERCHANTS = [1, 2, 3]`. Collision check now compares a slot only with **lower** slots, so slot 3's mistake can never switch off slot 2 (slot 1/2 behaviour unchanged) |
| `api/_lib/http.js` | `scrubSecrets` covers `FRONTIVA_PAYIN_PASSWORD_3` |
| `apps/web/src/api/OrdersApi.js` | `PAYMENT_GATEWAYS = []` (old lines kept commented, MID_3 note added), `FALLBACK_GATEWAYS = []`, `FRONTIVA_PAYIN_GATEWAY_3`, `frontivaSlotFor` → 3, `getPaymentGateways` adds `frontiva_payin_3` when `/options` lists slot 3 |
| `apps/web/src/pages/CheckoutPage.jsx` | Airpay 3 entry commented out; "Pay with Frontiva PayIn 3" in its position; nothing assumed before `/options` answers |
| `.env.example` | Slot-3 block |
| `tests/…` | see §6 |

Generic code that needed **no change** because it is already slot-driven: `api/payments/frontiva-payin/create.js`, `api/_lib/frontiva-payin-orders.js` (settlement), `api/_lib/orders.js`, `api/payments/options.js`, `api/payments/status.js`, `api/health.js`, `SuccessPage.jsx`, and the DB migration (`frontiva_payin_merchant` already allows 2–99). `api/payments/create.js` got a comment only: a direct MID 3 request is refused by the existing `checkoutMerchants()` check with 503 `merchant_unavailable`, before OAuth or any order.

## 3. Slot 3 mapping and flow

| Item | Value |
|---|---|
| Gateway id (browser) | `frontiva_payin_3` |
| Request | `POST /api/payments/frontiva-payin/create` with `merchant: 3` (slot 1 still sends no `merchant` key) |
| Order binding | `orders.payment_gateway = 'frontiva_payin'`, `frontiva_payin_merchant = 3`, written in the creating INSERT |
| Settlement | slot read from the stored order only → slot-3 login, status GET, merchant-ID and amount checks |

Env names (values only in Vercel / local `.env`): `FRONTIVA_PAYIN_ENABLED_3`, `FRONTIVA_PAYIN_BASE_URL_3` (optional), `FRONTIVA_PAYIN_EMAIL_3`, `FRONTIVA_PAYIN_PASSWORD_3` (**secret**), `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_3`, `FRONTIVA_PAYIN_ALLOWED_PAYEES_3`, `FRONTIVA_PAYIN_PAYEE_NAME_3` (optional; without it the QR page shows no payee name for slot-3 orders).

Slot 3 is offered only when enabled, fully configured, has payees, the service role is present, and its email / expected merchant ID differ from slots 1 and 2.

## 4. Isolation guarantees (all tested)

- Session map is keyed by slot + base URL + email: a failed slot-3 login does not cool down slots 1/2, tokens are never shared.
- Login must return the slot's expected merchant ID, else `merchant_mismatch`.
- Slot-3 intent paying slot 1's or 2's payee is refused.
- Unknown slot never falls back to slot 1; unknown stored slot → no provider call; missing slot-3 config → no call on any account, order never `paid`.
- A frontend redirect never marks an order paid; only a verified provider answer naming our reference, merchant and exact amount does.
- Disabling slot 3 stops new payments only; open slot-3 orders keep settling.

## 5. Configuration findings (no values read out)

- The local `.env` already holds all seven `*_3` names; email, expected merchant ID and payees are **different** from slots 1 and 2.
- `FRONTIVA_PAYIN_PASSWORD_3` equals another slot's password, and `FRONTIVA_PAYIN_ENABLED_3=false`. Shared passwords are not blocked (the login email and merchant-ID checks are what separate accounts), but confirm it is intentional.
- `FRONTIVA_PAYIN_PAYEE_NAME_3` is unset (optional).
- Nothing in this work can confirm that Vercel Production holds the same values; the provider must also confirm the slot-3 account's payee VPA from a real create response.

## 6. Tests (mocked providers only)

| Command | Result |
|---|---|
| `node --test "tests/*.test.js"` | **739 passed**, 0 failed (126 suites). Was 709; +30 |
| `npx vitest run` (apps/web) | **20 passed**, 0 failed. Was 15; +5 |
| `npm run lint` | clean |
| `npm run build` | ok |

New / changed: `tests/dual-airpay.test.js` (MID_3 flag in setup; new "AIRPAY MID_3 temporarily disabled" suite, 10 tests: hidden, direct requests refused, callbacks on both paths, status, reconcile, health, browser pins), `tests/frontiva-payin-merchants.test.js` (slot registry now 1–3; new slot-3 suite, 17 tests), `CheckoutPage.email.test.jsx` (Airpay options gone; 5 slot-3 UI tests; `Full Address` label anchored because the email field can now be on screen by default). **No live provider call was made and no payment was initiated.**

## 7. Deployment

1. Deploy with `FRONTIVA_PAYIN_ENABLED_3` false. `/api/payments/options` → `merchants: []`; no PayIn 3. `/api/health` → `frontiva_payin_merchants.3.configured: true`, `offered_at_checkout: false`.
2. `migrations-frontiva-payin-merchants.sql` must already be applied (it covers slot 3). Verify with its two queries; the slot-3 INSERT fails otherwise.
3. Confirm the slot-3 variables in Vercel Production (password Sensitive).
4. Owner-approved live test: set `FRONTIVA_PAYIN_ENABLED_3=true`, one small payment, confirm `paid`, `frontiva_payin_merchant = 3`, and that it shows on portal account 3 only. Disable again if anything differs.
5. Monitor `payment.frontiva_payin.*` and `payment.settle.frontiva_*` for 24–48 h.

## 8. Rollback

- **Hide the option, keep settlement:** `FRONTIVA_PAYIN_ENABLED_3=false` and redeploy. New slot-3 payments stop; open orders keep settling.
- **Never** delete the slot-3 credentials or the column while `select count(*) from orders where frontiva_payin_merchant = 3 and payment_status in ('initiated','processing','requires_review')` is above 0. Older code would verify those orders against slot 1.
- **Re-enable Airpay MID 3:** set `AIRPAY_MID_3.enabled = true` in `api/_lib/config.js`, restore `[3]` in `OrdersApi.js` `PAYMENT_GATEWAYS`/`FALLBACK_GATEWAYS`, uncomment the `CheckoutPage.jsx` entry, and update the "AIRPAY MID_3 temporarily disabled" suite (the other suites already switch the flag on in `beforeEach`).
