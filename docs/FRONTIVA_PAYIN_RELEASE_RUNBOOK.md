# Frontiva PayIn — Release Runbook (controlled direct-production launch)

Status as of 2026-10-31: code committed and deployed to production with `FRONTIVA_PAYIN_ENABLED=false`. No real payment has been made; PayIn stays hidden at checkout until the owner authorizes the controlled live test.

Items marked **[needs live proof]** cannot be verified without the real provider or a real payment, and are not claimed as passed.

## 1. Environment variable matrix

Names are those the code actually reads (searched across `api/`, `apps/web/src/`, `vercel.json`, `.env.example`). "Exists" is taken from the local `.env`; **Vercel's own state could not be inspected**, so confirm each in the dashboard.

| Variable | Req. | Example (no secret) | Purpose | Used in | Scope | Exists locally | Rotate | Obsolete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FRONTIVA_PAYIN_ENABLED` | yes | `false` (ship) → `true` (pilot) | Gates **new** PayIn payments only. Open orders keep being verified when `false`. Only the literal `true` enables. | `frontiva-payin.js` `frontivaPayinEnabled` | Production (and Preview only if used for the pilot) | yes | no | no |
| `FRONTIVA_PAYIN_BASE_URL` | optional | `https://portal.frontiva.online` | Portal origin. HTTPS origin only; the password is posted here. Defaults to the value shown. | `frontiva-payin.js` `loadFrontivaPayinConfig` | Production | yes | no | no |
| `FRONTIVA_PAYIN_EMAIL` | yes | `merchant@example.com` | Portal login. | same | Production | yes | no | no |
| `FRONTIVA_PAYIN_PASSWORD` | yes | *(secret)* | Portal login. Scrubbed from logs (`http.js`). Never in the browser bundle (verified by build scan and a test). | same | Production (Sensitive) | yes | only if exposed | no |
| `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID` | yes | `1` | Login is refused unless `data.user.merchantId` equals it; create/status answers are matched to it. | same | Production | yes | no | no |
| `FRONTIVA_PAYIN_ALLOWED_PAYEES` | yes, to start payments | `frontivatrading373991.apy@rbl` (comma-separate several) | UPI `pa` addresses a QR may pay. Empty ⇒ gateway unavailable (never "allow all"). **Set only after the provider confirms ownership of the address.** | same | Production | **no — add it** | no | no |
| `SUPABASE_URL` | yes | `https://<project>.supabase.co` | REST base. | `config.js` | Production | yes | no | no |
| `SUPABASE_SERVICE_ROLE` | yes | *(secret)* | Required: `frontiva_payin_transactions` has RLS and no policy, so the anon fallback cannot record attempts (`frontivaPayinAvailable` is false without it). | `config.js` | Production (Sensitive) | yes | only if exposed | no |
| `CRON_SECRET` | yes | 64 hex chars | Bearer for `/api/payments/frontiva-payin/reconcile` (and `/api/health` probe). Unset ⇒ every call is 401. Vercel Cron sends it automatically. | `http.js` `isCronAuthorized` | Production | yes (name present; confirm non-empty) | no | no |
| `FRONTIVA_PAYIN_CLIENT_SECRET` | — | — | **Not read.** The client secret must come from the login response only. | none | **Do not set** | commented out | — | **obsolete** |
| `FRONTIVA_PAYIN_MERCHANT_ID` | — | — | **Not read** (the expected id is `…_EXPECTED_MERCHANT_ID`). | none | **Do not set** | commented out | — | **obsolete** |
| `FRONTIVA_PAYIN_LAUNCH_HOSTS` | — | — | Superseded by the UPI-intent flow; **no code reads it.** Only mentioned in older docs. | none | **Do not set** | no | — | **obsolete** |
| `CLIENT_SECRET_PAYIN` | — | — | Appears in the local `.env`; **no code reads it.** | none | **Do not set on Vercel** | yes | see §3 | **obsolete** |

No PayIn variable is `VITE_`-prefixed; none reaches the browser.

## 2. Required Vercel settings

- Framework preset: Other / Vite; build `npm run build`, output `dist/apps/web` (already in `vercel.json`).
- Node 20+ (the code uses `node:crypto`, `fetch`, `structuredClone`).
- Function `maxDuration: 60` is set per handler (`create.js`, `reconcile.js`, `status.js`). Hobby allows ≤ 60 s.
- Env vars above in **Production**; mark passwords/keys **Sensitive**. Env changes apply only to *new* deployments, so redeploy after any change.
- `vercel.json` rewrites are unchanged: only the two Airpay callback paths point at `/api/payments/callback`; PayIn has no callback route.

## 3. Findings that need the owner

1. **Stray credential in the local `.env`.** The local `.env` (outside the git repo, one folder above `store/`) holds a bare, unlabeled token-like line in the SabPaisa block and a `CLIENT_SECRET_PAYIN` entry. Neither is read by the code. During this audit one of them was printed to the session output by a careless shell command. Treat it as exposed: delete both from the file, and rotate the credential it belongs to (and the PayIn client secret if `CLIENT_SECRET_PAYIN` holds it).
2. **Payee ownership not confirmed.** `frontivatrading373991.apy@rbl` is what the provider returned in one sample. Confirm with the provider that it is stable and yours before setting `FRONTIVA_PAYIN_ALLOWED_PAYEES`.
3. **Pilot isolation is not in code.** `FRONTIVA_PAYIN_ENABLED=true` shows the option to every visitor. For a pilot limited to you, either (a) enable it only in a **Preview** deployment (Preview-scoped env vars, same Supabase project), or (b) enable it in Production for a short window and switch it off immediately after. A per-user allowlist was not added (new feature, not requested).
4. **Small-value pilot needs a payable cart.** Minimum PayIn amount is ₹1.00, but catalogue prices are ₹1,200–₹2,500. Decide whether to pay a real item or create a temporary low-priced product.
5. **Order references are not secrets.** `GET /api/payments/status?ref=` still returns the full order (name, phone, address, items) for any known reference, for **all** gateways. That is unchanged by design (backward compatible). The new PayIn control below protects the payment request only. Recommend a follow-up to require a possession token for all gateways.
6. **Open PayIns do not expire.** An unpaid `PENDING` PayIn is re-checked (10 min, then hourly) until the 100-check budget moves it to `requires_review` (about 3.5 days). It is not auto-failed, because a late payment must not be lost. The QR is no longer *shown* after 30 minutes.
7. **Read-only DB verification** (against the connected project): every column the code uses on `orders` and `frontiva_payin_transactions` is present (including `upi_intent`), the PayIn table exists, and no `frontiva_payin` order exists yet. Not verifiable read-only: the `orders_payment_gateway_check` constraint and RLS (the anon read returned 0 rows, but the table is empty, so that is inconclusive). Run this in the SQL editor to confirm (read-only):
   ```sql
   select pg_get_constraintdef(oid) from pg_constraint where conname = 'orders_payment_gateway_check';
   -- expect: ... 'airpay', 'sabpaisa', 'frontiva_payin' ...
   select relrowsecurity from pg_class where relname = 'frontiva_payin_transactions';        -- expect t
   select count(*) from pg_policies where tablename = 'frontiva_payin_transactions';         -- expect 0
   select indexname from pg_indexes where tablename in ('frontiva_payin_transactions','orders') and indexname like '%frontiva%';
   ```

## 4. Reconciliation scheduler

The app has **no scheduler**: `vercel.json` has no `crons`, and the existing `/api/payments/reconcile` is not scheduled either. `crons` was deliberately **not** added: on a Hobby plan a sub-daily cron makes the deployment fail, and enabling it is a billing/plan decision.

Endpoint behaviour (tested): accepts **GET and POST** (Vercel Cron sends GET); other methods 405; `Authorization: Bearer $CRON_SECRET` compared in constant time, anything else 401; unset secret ⇒ 401. Batch of 10 orders, one at a time, 40 s budget (function limit 60 s). Safe to retry and to overlap: each check first claims the order with a conditional update (`enquiry_count` + `last_checked_at`), and the paid transition only matches an order that is still open, so a second run cannot double-settle or double-call the provider. It touches only `payment_gateway = 'frontiva_payin'` rows. Errors are logged without provider bodies. It keeps working when `FRONTIVA_PAYIN_ENABLED=false`.

**Option A — Vercel Cron (Pro plan).** Add to `vercel.json` at deploy time (with `CRON_SECRET` set in Production):

```json
"crons": [
  { "path": "/api/payments/frontiva-payin/reconcile", "schedule": "*/10 * * * *" }
]
```

**Option B — external scheduler (any plan).** For example a GitHub Actions workflow with a repository secret `CRON_SECRET`:

```yaml
on:
  schedule: [{ cron: "*/10 * * * *" }]
jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -X POST https://frontiva.online/api/payments/frontiva-payin/reconcile -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

Manual run: `curl -s -X POST https://frontiva.online/api/payments/frontiva-payin/reconcile -H "Authorization: Bearer $CRON_SECRET"` → `{"ok":true,"checked":n,"settled":n,"unchanged":n,"errors":n,"deferred":n}`.

## 5. Deployment procedure

1. Confirm the migration (already applied by the owner) with the SQL in §3.7.
2. Clean the local `.env` and rotate as in §3.1.
3. Obtain written provider confirmation of the payee address and ask what `callbackNeeded: true` requires.
4. In Vercel (Production): set `FRONTIVA_PAYIN_EMAIL`, `…_PASSWORD`, `…_EXPECTED_MERCHANT_ID`, `…_ALLOWED_PAYEES`, check `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `CRON_SECRET`. Leave `FRONTIVA_PAYIN_ENABLED=false`.
5. Commit and deploy the code (owner's action). With the flag off, checkout is unchanged for customers.
6. Configure the scheduler (§4) and run it once manually; expect `checked: 0`.
7. Verify regressions with the flag still off: an Airpay and a SabPaisa test order behave as before; `GET /api/payments/options` does not list `frontiva_payin`.
8. Run the pilot (§6).

## 6. Authorized live-payment pilot checklist

Record the observed result of each step; leave unchecked until actually seen.

- [ ] Flag on only for the pilot window/preview; checkout lists "Pay with Frontiva PayIn" (and not for a normal visitor outside it).
- [ ] Submit checkout once: `POST …/frontiva-payin/create` returns 200 with `launch.type = upi_intent`. The logs show `payment.frontiva_payin.create.ok`.
- [ ] Note `callback_needed` in that log line.
- [ ] `/success` shows the QR, the exact INR amount, the order reference and "Waiting for payment".
- [ ] Scan with a UPI app: payee shows `Frontiva Trading Private Limited` / the allowed VPA and the exact amount.
- [ ] Refresh `/success` several times: the same QR returns; the portal shows **one** PayIn; `frontiva_payin_transactions` has **one** row for the order.
- [ ] Open `/success?ref=<ref>` **without** `&k=`: order loads, **no QR**.
- [ ] Pay. Portal shows the transaction `COMPLETED`.
- [ ] **Within a few poll cycles with no callback**, the page reaches "Thank You!" and `orders.payment_status = 'paid'`, `paid_at` and `gateway_txn_id` (UTR) set. **This is the key unverified assumption** (`callbackNeeded: true`); if it does not settle, stop and escalate to the provider (the reconcile endpoint will also settle it).
- [ ] No second order and no second PayIn for the same attempt (retry the same attempt id → 409).
- [ ] KKChat received nothing for this order (check its inbox/logs); no `forward` log lines for the PayIn order.
- [ ] A normal Airpay order and a SabPaisa order still complete.
- [ ] Switch the flag off; any still-open PayIn order keeps being verified.

## 7. Rollback

1. Set `FRONTIVA_PAYIN_ENABLED=false` in Vercel and **redeploy** (env changes apply to new deployments). New PayIn payments stop; checkout hides the option.
2. Leave the scheduler running so already-started PayIn orders still settle; leave credentials, table and constraint in place.
3. If code must be reverted: Vercel → Deployments → previous deployment → Promote/Instant Rollback. Keep the reconcile route live until open PayIn orders are settled. Do **not** narrow `orders_payment_gateway_check` while any order has `frontiva_payin`.
4. For any order stuck in `requires_review`: look it up in the portal by `merchantReference` (= `order_ref`) and settle by hand.

## 8. GO / NO-GO

**Code and tests: GO for a controlled pilot** (flag off by default, no regressions found).
**Production enablement: NO-GO until** these are done by the owner/provider: payee ownership confirmed and set; the stray credential removed and rotated; scheduler configured; a pilot order observed settling **without a callback**; pilot isolation decided (§3.3).

## 6. Owner-acknowledged security risk: Supabase `orders` access

The owner has stated that the current Supabase `orders` access policy is **intentional** and accepted it for this release. It is unchanged: no RLS policy, COD checkout or database authorization was modified. This is recorded as an **owner-acknowledged risk**, not an accidental misconfiguration.

Consequences (not safe, only accepted):

- The public anon key can read and write `orders`. Anyone holding it can read customer name, phone, address and items, and can set `payment_status` / `status` on any order, e.g. mark an unpaid order paid, without paying.
- This applies to **every** gateway (COD, Airpay, SabPaisa, Frontiva PayIn). Order fulfilment decisions that rely on `orders.payment_status` can therefore be forged by an anonymous party.
- Frontiva PayIn mitigation in this release: the payment attempt record lives in `frontiva_payin_transactions` (RLS on, no policy, service role only), and settlement is decided server-side from the provider status check, not from the client. The `orders` row remains writable by anon, so reconcile against the provider (or the PayIn table) before shipping goods.

Recommended separately (out of scope here): restrict payment-critical columns (`payment_status`, `status`, gateway ids) to the service role, move COD checkout behind a server endpoint, and require a possession token for `GET /api/payments/status?ref=`.
