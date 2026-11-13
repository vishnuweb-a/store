# 05 — Configuration: Frontiva PayIn

> **Update 2026-11-13 — multi-merchant implemented (uncommitted).** Frontiva PayIn slot 2 (`frontiva_payin_2`, off by default) and the AirPay MID 1 disablement are implemented; see [FRONTIVA-PAYIN-2-IMPLEMENTATION.md](FRONTIVA-PAYIN-2-IMPLEMENTATION.md). Line numbers below refer to `dff49ac` and may have shifted. Sections marked RECOMMENDED for multi-merchant are now implemented as described there.

Paths relative to `store/`. **No values are reproduced here.** Tags: **VERIFIED / INFERRED / UNKNOWN / RECOMMENDED**.

## 1. Variable inventory

The only PayIn names read by code (enforced by `tests/frontiva-payin.test.js:1112-1122`):

| Variable | Purpose | Required | Location | Sensitivity |
|---|---|---|---|---|
| `FRONTIVA_PAYIN_ENABLED` | Gates **new** PayIn payments. Only the literal `true` (case-insensitive) enables. Does not affect verification of existing orders. | No (default off) | Backend | Public |
| `FRONTIVA_PAYIN_BASE_URL` | Portal origin; must match `^https://[a-z0-9.-]+$` after trailing-slash trim. Default `https://portal.frontiva.online`. | No | Backend | Public |
| `FRONTIVA_PAYIN_EMAIL` | Portal login email | Yes | Backend | Confidential (account identifier) |
| `FRONTIVA_PAYIN_PASSWORD` | Portal login password | Yes | Backend | **Secret** (scrubbed from logs, `api/_lib/http.js:169`) |
| `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID` | Login refused unless `data.user.merchantId` equals it; create answers must name it | Yes | Backend | Public-ish |
| `FRONTIVA_PAYIN_ALLOWED_PAYEES` | Comma-separated UPI `pa` VPAs a QR may pay; trimmed, lower-cased, blanks dropped. Empty ⇒ gateway unavailable (never "allow all") | Yes to start payments | Backend | Public (it is in every QR) |
| `SUPABASE_URL` | PostgREST base | Yes | Backend | Public |
| `SUPABASE_SERVICE_ROLE` | Needed because `frontiva_payin_transactions` is RLS-closed | Yes | Backend | **Secret** |
| `CRON_SECRET` | Bearer for `/api/payments/frontiva-payin/reconcile` and `/api/health` probe | Yes for reconciliation | Backend | **Secret** |
| GitHub secret `FRONTIVA_RECONCILE_URL` | Target URL for the scheduled workflow | Yes for scheduler | GitHub Actions | Public-ish |
| GitHub secret `FRONTIVA_CRON_SECRET` | Must equal Vercel `CRON_SECRET` | Yes for scheduler | GitHub Actions | **Secret** |

**Slot 2 (implemented 2026-11-13).** Same roles, `_2` suffix, read only for slot 2 and never copied from slot 1:

| Variable | Purpose | Required | Sensitivity |
|---|---|---|---|
| `FRONTIVA_PAYIN_ENABLED_2` | Gates new slot-2 payments only; literal `true` | No (default off) | Public |
| `FRONTIVA_PAYIN_BASE_URL_2` | Optional; falls back to `FRONTIVA_PAYIN_BASE_URL`, then the default; https origin only | No | Public |
| `FRONTIVA_PAYIN_EMAIL_2` | Slot-2 portal login; must differ from slot 1's or slot 2 is not offered | Yes | Confidential |
| `FRONTIVA_PAYIN_PASSWORD_2` | Slot-2 portal password; scrubbed from logs | Yes | **Secret** |
| `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_2` | Slot-2 merchant ID; must differ from slot 1's or slot 2 is not offered | Yes | Public-ish |
| `FRONTIVA_PAYIN_ALLOWED_PAYEES_2` | Slot-2 VPAs; slot 1's list is never consulted for slot 2 | Yes to start | Public |
| `FRONTIVA_PAYIN_PAYEE_NAME_2` | Non-secret name shown on the QR page for slot-2 orders | No | Public |
| `FRONTIVA_PAYIN_PAYEE_NAME` | Optional override of slot 1's QR payee text (default unchanged) | No | Public |

Not configuration, **not stored anywhere**: the access token and client secret — both come from the login response and live only in function memory (`frontiva-payin.js:249-252`).

**Obsolete / must not be set** (no code reads them): `FRONTIVA_PAYIN_CLIENT_SECRET`, `FRONTIVA_PAYIN_MERCHANT_ID`, `FRONTIVA_PAYIN_LAUNCH_HOSTS`, `CLIENT_SECRET_PAYIN`.

## 2. Loading and validation

- **VERIFIED** Read directly from `process.env` on each call (`env()` trims). No startup validation: `loadFrontivaPayinConfig()` (`frontiva-payin.js:75-107`) throws `ConfigError` at request time; `isFrontivaPayinConfigured()` / `frontivaPayinAvailable()` swallow it into `false`.
- Environment selection: none in code. One set of values per Vercel environment (Production/Preview/Development) — whichever Vercel injects. There is no sandbox/production switch for PayIn.
- Payment mode is a code constant `UPI_INTENT` (`:28`), not configurable.
- Merchant identity: one portal account per **slot** (`FRONTIVA_PAYIN_MERCHANTS = [1, 2]`). Each slot is defined by its own `EMAIL`/`PASSWORD` (the login) and `EXPECTED_MERCHANT_ID` (what that login must return). `loadFrontivaPayinConfig(slot)` rejects unknown slots.
- Allowed payees: maintained only in the env var; changing requires a redeploy (Vercel env change).

## 3. State of this workspace (names only)

- `../.env` (outside the repo): all six `FRONTIVA_PAYIN_*` names present; `FRONTIVA_PAYIN_ENABLED` is `false`; **`FRONTIVA_PAYIN_ALLOWED_PAYEES` is defined three times** — which definition wins depends on the loader (dotenv-style parsers typically keep the last). Clean this up before relying on local runs.
- `apps/web/.env`: only `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_CLOUDINARY_*`. No PayIn value reaches the browser bundle (VERIFIED, and test `:1124-1128`).
- `.env.example:147-163` documents the PayIn block; its comment names the real payee VPA (non-secret).
- Vercel and GitHub secret state: **UNKNOWN** (not inspectable from the repo).
- Re-checked 2026-11-13 (names and comparisons only, no values read out):
  - Slot-2 names present: `EMAIL_2`, `PASSWORD_2`, `EXPECTED_MERCHANT_ID_2`, `ALLOWED_PAYEES_2`, `BASE_URL_2`. Missing: `ENABLED_2` (so slot 2 is off) and `PAYEE_NAME_2` (optional).
  - Slot 2's email and merchant ID differ from slot 1's. Its payee does not overlap slot 1's. Its base URL equals the default.
  - The two slots' passwords are identical. That is possible for separate accounts, but confirm it with the provider.
  - `FRONTIVA_PAYIN_ALLOWED_PAYEES` (slot 1) is still defined twice, with **different** values. The second copy sits after the slot-2 block. Resolve this before any local run.

## 4. Deployment dependencies

1. `migrations-sabpaisa.sql` (creates `payment_gateway`, `enquiry_count`, `last_checked_at`, `gateway_txn_id`), then `migrations-frontiva-payin.sql`.
2. Vercel env vars above (Production, marked Sensitive for secrets).
3. GitHub Actions secrets for `.github/workflows/frontiva-payin-reconcile.yml` (runs `*/15 * * * *`). `vercel.json` defines **no** `crons`; this workflow is the only scheduler for PayIn (VERIFIED in repo). GitHub may delay scheduled runs and disables them after 60 days without repository activity (GitHub platform behaviour).
4. Without the scheduler, abandoned or page-closed PayIn orders are only settled when someone opens `/success` for them.

## 5. Secret management requirements

- Password: Vercel Sensitive env only. Rotate if exposed; rotation needs only an env update + redeploy (cached sessions die with their instances).
- Client secret: never configure; provider-issued per login. Rotation/revocation semantics **UNKNOWN** (provider question).
- Logs: `logEvent` redacts keys including `password`, `accesstoken`, `refreshtoken`, `clientsecret`, `x-signature`, `signature`, `email`, `phone`, `customer` (`http.js:15-52`); `logFrontivaPayin` additionally passes `reason` through `scrubSecrets`. Test `:299` and `:484` assert nothing secret is logged or returned.
- Every slot's password variable must be listed in `scrubSecrets` (`http.js`), which is a hard-coded list. `FRONTIVA_PAYIN_PASSWORD_2` is listed (implemented); a future slot 3 must be added there too.
