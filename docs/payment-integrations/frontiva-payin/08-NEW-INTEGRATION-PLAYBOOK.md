# 08 — New Integration Playbook: adding Frontiva PayIn merchant N

> **Update 2026-11-13 — multi-merchant implemented (uncommitted).** Frontiva PayIn slot 2 (`frontiva_payin_2`, off by default) and the AirPay MID 1 disablement are implemented; see [FRONTIVA-PAYIN-2-IMPLEMENTATION.md](FRONTIVA-PAYIN-2-IMPLEMENTATION.md). Line numbers below refer to `dff49ac` and may have shifted. Sections marked RECOMMENDED for multi-merchant are now implemented as described there.

Audience: an engineer or AI coding agent adding one more Frontiva PayIn merchant account. Read docs 02, 03 and 07 first. Everything here is **RECOMMENDED** implementation (design Option B, doc 07 §4). Paths relative to `store/`. Line numbers refer to commit `dff49ac`; re-check them before editing.

## 0. Preconditions (stop if any is missing)

- [ ] Provider confirms the new account has its **own portal login** (email + password) and its `merchantId`.
- [ ] `merchantId` differs from slot 1's, **or** provider confirms the status GET is scoped to the logged-in account (doc 06 F-04).
- [ ] The new account's UPI payee VPA(s) and legal payee name are known (from a real create response's `pa`/`pn`).
- [ ] Doc 06 **F-01** (anon-writable `orders`) is acknowledged by the owner; fulfilment checks provider status.
- [ ] The PayIn reconciliation scheduler is confirmed running (GitHub Actions secrets set).
- [ ] Owner approval for a controlled live test.

Hard rules: never reuse slot 1's credentials for slot N; never fall back to slot 1 for an unknown slot; never change slot 1's env names, insert body, or `/options` key; do not touch Airpay/SabPaisa files except the shared lines listed below.

## Step 1 — Merchant configuration

Env vars for slot N (N = 2 for the first new one; Vercel Production, secrets marked Sensitive):

```
FRONTIVA_PAYIN_ENABLED_N=false
FRONTIVA_PAYIN_BASE_URL_N=            # optional; falls back to slot 1's value or the default
FRONTIVA_PAYIN_EMAIL_N=
FRONTIVA_PAYIN_PASSWORD_N=            # secret
FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_N=
FRONTIVA_PAYIN_ALLOWED_PAYEES_N=
FRONTIVA_PAYIN_PAYEE_NAME_N=          # non-secret display name for the QR page
```

Code — `api/_lib/frontiva-payin.js`:
1. Add `export const FRONTIVA_PAYIN_MERCHANTS = [1, 2]` and `const SUFFIX = (slot) => (slot === 1 ? '' : `_${slot}`)`.
2. `export function parseFrontivaMerchant(value)` → integer in `FRONTIVA_PAYIN_MERCHANTS` or `null` (mirror `parseMerchant` in `api/_lib/config.js:100`).
3. `loadFrontivaPayinConfig(slot = 1)` (`:75`): read every role with `SUFFIX(slot)`; return `{ ...values, slot, baseUrl, allowedPayees, payeeName }`. Unknown slot → `ConfigError`. Slot 1 behaviour must be identical (same names, same errors).
4. `isFrontivaPayinConfigured(slot = 1)`, `frontivaPayinEnabled(slot = 1)` (reads `FRONTIVA_PAYIN_ENABLED${SUFFIX}`), `frontivaPayinAvailable(slot = 1)` (`:110-140`).
5. `export function availableFrontivaMerchants()` → `FRONTIVA_PAYIN_MERCHANTS.filter(frontivaPayinAvailable)`.
6. Optional sanity: `frontivaPayinAvailable(N)` returns false if slot N's email equals any other slot's email.

`api/_lib/http.js:150-170` — add `process.env.FRONTIVA_PAYIN_PASSWORD_2` (and each future slot) to `scrubSecrets`.

`.env.example:147-163` — add a commented slot-2 block.

## Step 2 — Session isolation (blocker; do this before anything else)

`api/_lib/frontiva-payin.js:249-381`:
- Replace the four singletons with `const sessions = new Map()` keyed by `config.slot ?? 1`, each entry `{ cached, inflight, blockedUntil, lastError }`.
- `getFrontivaSession(config, deps)` uses the entry for `config.slot`.
- `invalidateSession(session)` (`:384`) must clear only the owning slot's entry.
- `resetFrontivaSession()` clears the whole map (tests rely on it).
- After login / before use: `if (session.merchantId !== config.expectedMerchantId) throw new FrontivaPayinError('merchant_mismatch', …)`.
- New test: two configs in one process never share a token; slot 2's failed login does not cool down slot 1.

## Step 3 — Gateway registration & discovery

- `api/payments/options.js:25` — keep `frontiva_payin: true` exactly as today (slot 1). Add, only when non-empty: `frontiva_payin_merchants: availableFrontivaMerchants()`.
- `api/health.js:111-116` — keep the `frontiva_payin` block for slot 1; add `frontiva_payin_merchants: { [slot]: {configured, enabled, offered_at_checkout} }` for slots ≥ 2.
- Frontend `apps/web/src/api/OrdersApi.js`:
  - `:103` add `export const FRONTIVA_PAYIN_GATEWAY_2 = 'frontiva_payin_2'` (or a helper `frontivaGatewayId(slot)`).
  - `getPaymentGateways()` `:116-128` — append `'frontiva_payin_2'` when `payload.frontiva_payin_merchants?.includes(2)`.
  - `export function frontivaSlotFor(id)` → `1` for `'frontiva_payin'`, `N` for `'frontiva_payin_N'`, else `null`.

## Step 4 — Checkout UI

`apps/web/src/pages/CheckoutPage.jsx`:
- `:43-50` add `{ id: FRONTIVA_PAYIN_GATEWAY_2, label: '<owner-approved label>' }` — the label must be distinguishable from slot 1 (product decision; ask the owner).
- `:120` `isFrontivaPayin = isOnline && frontivaSlotFor(gateway) !== null` so the email field (`:523`) appears for any slot.
- `:159` and `:198` — same predicate instead of `=== FRONTIVA_PAYIN_GATEWAY`.
- `:202-207` pass `merchant: frontivaSlotFor(gateway)` to `createFrontivaPayinPayment`.
- `OrdersApi.createFrontivaPayinPayment` `:309-348` — accept `merchant`; include `merchant` in the body **only when it is not 1** (slot-1 body stays byte-identical).
- Tests to update: `tests/frontiva-payin.test.js:828-833` forbids `/merchant/` in that function — change it to assert the Airpay endpoint is never used and that slot 1 sends no `merchant` key. `tests/dual-airpay.test.js:2378-2380` pins the PayIn line in the gateway list — extend, don't delete.

## Step 5 — Payment initiation

`api/payments/frontiva-payin/create.js`:
1. After parsing (`:69`): `const slot = body.merchant === undefined ? 1 : parseFrontivaMerchant(body.merchant)`; `null` → 400 `{ code: 'invalid_merchant' }`.
2. Move/duplicate the availability check to use `available(slot)` (`:64` currently runs before parsing; keep a cheap `availableFrontivaMerchants().length > 0` pre-check there, then the slot check after parsing). Disabled slot → 503 `frontiva_payin_unavailable`.
3. `loadConfig(slot)` (`:81`).
4. `createOrder({ …, gateway: FRONTIVA_PAYIN_GATEWAY, orderRef, frontivaMerchant: slot })` (`:106`).
5. Everything else unchanged: `createPayin({ … config: payinConfig })` and `fetchStatus(orderRef, { config: payinConfig })` already take the config.

Reused unchanged: `generateFrontivaSignature`, `createFrontivaPayin`, `resolveFrontivaLaunch`, `upiIntentProblem`, `validateFrontivaCustomer`, `validateFrontivaAmount`, `claimCheckoutAttempt`, `recordTransaction`, `closeFrontivaOrder`.
Merchant-specific values: email, password, expected merchant id, allowed payees, (base URL), payee display name, enable flag.

Log fields: add `merchant: slot` to `create.ok/refused/ambiguous/unsupported_launch`.

## Step 6 — Database mapping

1. Run the additive migration in doc 07 §8 (new file `migrations-frontiva-payin-merchants.sql`; mirror it into `supabase-schema.sql`). Do **not** change `orders_payment_gateway_check`.
2. `api/_lib/orders.js` `createPendingGatewayOrder` (`:94-123`): accept `frontivaMerchant`; add `...(gateway === FRONTIVA_PAYIN_GATEWAY && frontivaMerchant && frontivaMerchant !== 1 ? { frontiva_payin_merchant: frontivaMerchant } : {})`. Slot 1 and SabPaisa inserts stay identical. Thread the param through `createPendingOrder` (`:49-55`).
3. Optional: `merchant_slot` on `frontiva_payin_transactions` via `claimCheckoutAttempt` for audit (not required for correctness).

## Step 7 — Status verification with the original merchant

`api/_lib/frontiva-payin-orders.js`:
1. New `export function frontivaSlotForOrder(order)`: `order.frontiva_payin_merchant == null ? 1 : parseFrontivaMerchant(order.frontiva_payin_merchant)` (null for unknown).
2. In `settleFrontivaPayinOrder` (`:163`), **before** the claim UPDATE: resolve the slot; `null` → `logEvent('payment.settle.frontiva_unknown_merchant')`, return unchanged (no provider call). Then `let config; try { config = deps.frontivaConfig || loadFrontivaPayinConfig(slot) } catch { config = null }` and call `fetchStatus(orderRef, config ? { config } : {})` — **careful**: the current fallback `{}` makes `fetchFrontivaPayinStatus` load **slot 1** config. For slot ≠ 1 with missing config you must short-circuit to `decideFrontivaSettlement({ outcome: 'not_configured' }, …)` instead of passing `{}`.
3. `findOrderByRef` already selects `*`, so the new column arrives automatically.
4. Cross-checks (doc 07 §5.5): read the tx row's `portal_merchant_id`/`portal_request_id` (one extra select) and send mismatches to `requires_review`.
5. `listFrontivaPayinDue` (`:297`) and `/frontiva-payin/reconcile` need no change (they select by gateway; settlement resolves the slot). Optionally add `frontiva_payin_merchant` to the select for logging.

What prevents cross-merchant verification: (a) slot is server-written at order creation; (b) settlement loads only that slot's credentials; (c) session cache keyed by slot with merchant-id assertion; (d) unknown slot ⇒ no call; (e) status answer must name our `merchantReference` (globally unique `order_ref`) and amount.

## Step 8 — Success and failure handling

- No change to `transition()`, `closeFrontivaOrder`, status mapping, or `settleOrder` dispatch — all keyed on `payment_gateway = 'frontiva_payin'`.
- `SuccessPage.jsx`: `isPayin` (`:129`) and polling (`:189`) already match all slots. Replace the hard-coded payee name (`:321-324`) with a server-provided value: add `payee_name` to the `/api/payments/status` response only alongside `payment_intent` (from `loadFrontivaPayinConfig(slot).payeeName`, falling back to today's text for slot 1).

## Step 9 — Testing (see doc 09 for the full matrix)

Extend `tests/frontiva-payin.test.js` (fake-world harness, `tests/helpers/fake-world.js`); never call the real portal. Minimum new tests:
- slot 2 create logs in with slot-2 env, writes `frontiva_payin_merchant = 2`, validates against slot-2 payees;
- slot 1 create body, order insert and `/options` body are byte-identical to before;
- settlement of a slot-2 order uses slot-2 credentials; NULL uses slot 1; `7` (unknown) makes no provider call;
- slot-2 config removed → slot-2 orders → `requires_review`, **never** checked with slot 1;
- two slots in one process: no shared token; cooldown isolated;
- disabled slot 2: create 503, existing slot-2 orders still settle;
- update the env-name test (`:1112`) to the new allowed set, and the isolation tests noted in Step 4.

Run: `npm test` (root: `node --test "tests/*.test.js"` + Vitest in `apps/web`). Baseline today: 660 + 10 passing.

## Step 10 — Feature flag and rollout

1. Merge code with `FRONTIVA_PAYIN_ENABLED_2` unset/false. Verify `/options` unchanged, `/api/health` shows slot 2 `enabled:false`.
2. Run the migration (doc 07 §8); verify with `select column_name from information_schema.columns where table_name='orders' and column_name='frontiva_payin_merchant';`.
3. Set slot-2 env vars (still disabled). Redeploy. Health: `configured:true, offered_at_checkout:false`.
4. Owner-approved controlled live test: enable slot 2 → one small real payment → confirm `paid`, `frontiva_payin_merchant=2`, portal shows one PayIn on account 2 only. Disable again if anything differs.
5. Enable for customers. Monitor (doc 09 §6) for 24–48 h.

## Rollback

- Fast: `FRONTIVA_PAYIN_ENABLED_2=false` + redeploy — new slot-2 payments stop; open slot-2 orders keep settling.
- Code rollback: only after all slot-2 orders are terminal (`select count(*) from orders where frontiva_payin_merchant = 2 and payment_status in ('initiated','processing','requires_review')` = 0); older code ignores the column and would check those orders against slot 1 — **do not roll back code while slot-2 orders are open.**
- Never drop the column or delete slot-2 credentials while slot-2 orders exist.

## File-by-file checklist

| File | Change |
|---|---|
| `api/_lib/frontiva-payin.js` | slot-aware config/flags/availability; per-slot session map; merchant assertion |
| `api/_lib/frontiva-payin-orders.js` | `frontivaSlotForOrder`; slot-specific config in settlement; no slot-1 fallback; cross-checks |
| `api/_lib/orders.js` | `createPendingOrder`/`createPendingGatewayOrder` accept and write `frontiva_payin_merchant` (≠1 only) |
| `api/payments/frontiva-payin/create.js` | parse `merchant`; per-slot availability/config; pass slot to order insert; log slot |
| `api/payments/options.js` | additive `frontiva_payin_merchants` |
| `api/payments/status.js` | optional `payee_name` next to `payment_intent` |
| `api/health.js` | per-slot booleans |
| `api/_lib/http.js` | scrub `FRONTIVA_PAYIN_PASSWORD_N` |
| `apps/web/src/api/OrdersApi.js` | new id, discovery, `frontivaSlotFor`, `merchant` in body (≠1) |
| `apps/web/src/pages/CheckoutPage.jsx` | new option + label; slot-aware predicates |
| `apps/web/src/pages/SuccessPage.jsx` | payee name from server |
| `migrations-frontiva-payin-merchants.sql` (new), `supabase-schema.sql` | additive column + check |
| `.env.example` | slot-2 block |
| `tests/frontiva-payin.test.js`, `tests/dual-airpay.test.js`, `apps/web/src/pages/__tests__/CheckoutPage.email.test.jsx` | new + updated tests |
| `docs/payment-integrations/frontiva-payin/*` | update after implementation |

Untouched: `api/_lib/airpay.js`, `api/_lib/sabpaisa.js`, `api/payments/create.js`, `api/payments/callback.js`, `api/payments/sabpaisa/*`, `api/payments/reconcile.js`, `vercel.json`, `.github/workflows/frontiva-payin-reconcile.yml`.
