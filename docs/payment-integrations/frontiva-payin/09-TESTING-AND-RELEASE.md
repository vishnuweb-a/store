# 09 — Testing and Release: Frontiva PayIn

> **Update 2026-11-13 — multi-merchant implemented (uncommitted).** Frontiva PayIn slot 2 (`frontiva_payin_2`, off by default) and the AirPay MID 1 disablement are implemented; see [FRONTIVA-PAYIN-2-IMPLEMENTATION.md](FRONTIVA-PAYIN-2-IMPLEMENTATION.md). Line numbers below refer to `dff49ac` and may have shifted. Sections marked RECOMMENDED for multi-merchant are now implemented as described there.

Paths relative to `store/`. Tags: **VERIFIED / INFERRED / UNKNOWN / RECOMMENDED**.

## 0. After multi-merchant implementation (VERIFIED — run on 2026-11-13)

| Command | Result |
|---|---|
| `node --test "tests/*.test.js"` | **709 passed**, 0 failed (124 suites) |
| `node --test tests/frontiva-payin-merchants.test.js` | **37 passed**: the §2 scenarios, plus collision, cross-check, payee-name, health and scrubbing tests |
| `node --test tests/frontiva-payin.test.js` | **141 passed** (slot-1 behaviour unchanged) |
| `node --test tests/dual-airpay.test.js` | **162 passed**, including the new "AIRPAY MID_1 temporarily disabled" suite |
| `npx vitest run` (apps/web) | **15 passed** (6 new PayIn 2 checkout tests) |
| `npm run lint`, `npm run build` | clean / ok |

## 1. Coverage before implementation (VERIFIED — run on 2026-11-13)

| Command | Result |
|---|---|
| `node --test tests/*.test.js` (from `store/`) | **660 passed**, 0 failed (118 suites) |
| `node --test tests/frontiva-payin.test.js` | **141 passed** |
| `npx vitest run` (from `apps/web/`) | **10 passed** (`CheckoutPage.email.test.jsx`) |

All tests use injected dependencies or a fake `globalThis.fetch` (`tests/helpers/fake-world.js:119`) with an in-memory Supabase/portal; PayIn env vars are reset per test (`tests/frontiva-payin.test.js:73-87`). **No network, no real payment.**

`tests/frontiva-payin.test.js` suites:

| Category | Suites (line) |
|---|---|
| Unit | signature `:153`, amounts `:169`, config/flag `:189`, intent validation `:596`, allowed payees `:1008`, decision table `:755` |
| Gateway contract (fixtures of verified provider shapes) | login & session `:222`, documented create response `:952`, status verification `:664` |
| Handler / integration (fake world) | create endpoint `:309`, QR restore `:552`, status authorisation `:921`, transaction lifecycle `:1032`, reconcile `:768`, reconcile auth `:1075` |
| Concurrency / idempotency | duplicate attempt `:345`, throttling `:715`, concurrent paid once `:722`, terminal never overwritten `:730` |
| QR | round trip with `jsqr` decoder `:871`, markup `:887-919` |
| Isolation / regression | no callback route, Airpay rewrites unchanged `:808`; no Airpay/SabPaisa/KKChat imports `:817`; Airpay endpoint never used `:828`; Airpay & SabPaisa status untouched `:590, :944` |
| Config guard | exact env-name set `:1112`; nothing in browser bundle `:1124` |

Other suites touching PayIn: `tests/pricing.test.js:8` (min amount), `tests/size-selection.test.js:67` (4 submit paths), `tests/dual-airpay.test.js:2378` (gateway list line), Vitest email field tests.

Gaps: no real browser E2E; no DB-level test of constraints/RLS (only the SQL in the runbook); no live contract test (by design).

## 2. Missing tests for multi-merchant (RECOMMENDED)

| # | Scenario | Expected |
|---|---|---|
| T1 | Existing slot-1 flow end-to-end | identical request body, order insert, `/options` body, logs |
| T2 | Slot-2 create | logs in with `_2` env; `frontiva_payin_merchant=2`; launch returned |
| T3 | Credential selection | fake portal records which email logged in per call |
| T4 | Wrong credentials for slot 2 | `auth_failed`, order failed, slot 1 unaffected (no shared cooldown) |
| T5 | Slot-2 QR with slot-1 payee | refused (`payee not in …`) |
| T6 | Amount unchanged | create body amount = priced total for every slot |
| T7 | Status from correct merchant | slot-2 order → status call signed with slot-2 secret |
| T8 | Merchant A cannot verify B | slot-2 order with slot-2 config missing → `requires_review`, zero calls made with slot-1 token |
| T9 | Unknown slot (e.g. 7) | no provider call, unchanged, logged |
| T10 | Duplicate check/settle | concurrent settle on slot-2 order → `paid` once |
| T11 | Disabled slot | create 503; `/options` omits it |
| T12 | Disabled slot, old pending | still settles to `paid` |
| T13 | Failed provider request | never `paid` (per slot) |
| T14 | Parallel checkouts across slots | sessions not mixed (two configs, interleaved promises) |
| T15 | Airpay & SabPaisa unaffected | existing suites pass unchanged |
| T16 | `scrubSecrets` | `_2` password redacted |
| T17 | Frontend | slot-2 option appears only when listed; email field shows; body has `merchant: 2`; slot 1 body has no `merchant` |

## 3. Regression matrix

| Area | Slot 1 PayIn | Slot N PayIn | Airpay 1/3 | SabPaisa | COD |
|---|---|---|---|---|---|
| Option listing | must be unchanged | new | unchanged | unchanged | unchanged |
| Create | unchanged | new | untouched code | untouched code | untouched |
| Order insert | byte-identical | + column | byte-identical | byte-identical | n/a |
| Settlement | NULL→slot 1 | slot N creds | untouched | untouched | never settled |
| Reconcile | unchanged | via same sweep | untouched | untouched | n/a |
| Success page | same QR/polling | payee name per slot | unchanged | unchanged | unchanged |

## 4. Local validation commands (safe)

```bash
cd store
node --test "tests/*.test.js"          # backend + source-inspection tests
npm test --prefix apps/web             # vitest
npm run build                          # optional: confirms bundle builds; then grep the bundle:
grep -rl "FRONTIVA_PAYIN" dist/apps/web || echo "no PayIn names in bundle"
```
Not run in this review: `npm run build` (it rewrites the local `dist/` build output; skipped to leave the workspace unchanged).

## 5. Safe staging verification (no real money)

**UNKNOWN**: no sandbox PayIn environment is documented. A Vercel Preview with PayIn disabled can still verify:
- `GET /api/payments/options` → no `frontiva_payin*` key while disabled.
- `GET /api/health` with Bearer `CRON_SECRET` → per-slot `configured/enabled/offered_at_checkout`.
- `POST /api/payments/frontiva-payin/create` → 503 `frontiva_payin_unavailable` while disabled.
- `GET /api/payments/frontiva-payin/reconcile` without auth → 401; with auth → 200 `checked: 0`.
- Read-only SQL from `docs/FRONTIVA_PAYIN_RELEASE_RUNBOOK.md` §3.7 (RLS on, 0 policies, indexes present).

Do **not** call the live portal create endpoint from staging: every call creates a real PayIn.

## 6. Production rollout checks

1. Migration applied (column present, constraint valid).
2. Env vars set, slot disabled; deploy; `/options` unchanged; health correct.
3. Scheduler: run `workflow_dispatch` of "Frontiva PayIn Reconciliation" once; expect 200 `{ok:true}`.
4. Owner-authorised single small live payment per new slot; confirm DB (`orders` + `frontiva_payin_transactions`) and portal agree; refresh `/success` several times → one PayIn only.
5. Enable; watch logs.

## 7. Post-deployment monitoring

Log events to watch (Vercel logs, JSON):
- `payment.settle.applied` with `gateway: frontiva_payin` — success rate.
- `payment.settle.frontiva_payin_not_paid` — `decided`/`reason` distribution; alert on `amount mismatch`, `portal merchant mismatch`, `answer names a different…`.
- `payment.frontiva_payin.login_failed` — alert on `merchant_mismatch` / `invalid_credentials`.
- `payment.frontiva_payin.create.ambiguous` / `.unsupported_launch` — provider contract drift.
- `payment.frontiva_payin.reconcile.completed` — alert if absent > 30 min.

SQL (read-only) for operations:
```sql
select payment_status, count(*) from orders
where payment_gateway = 'frontiva_payin' and created_at > now() - interval '1 day'
group by 1;

select order_ref, payment_status, enquiry_count, last_checked_at from orders
where payment_gateway = 'frontiva_payin' and payment_status = 'requires_review'
order by created_at desc limit 50;
```
