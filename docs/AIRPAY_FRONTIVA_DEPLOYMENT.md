# Airpay online payment — Frontiva deployment guide

Online payment ("Pay Online") is an addition to the existing Frontiva checkout.
Cash on Delivery is unchanged: it still runs entirely in the browser against
Supabase and does not touch anything described here.

---

## 1. Architecture

```
Frontiva checkout
  -> POST /api/payments/create      (server prices from Supabase, creates order)
  -> Airpay OAuth2
  -> Airpay hosted payment page
  -> customer pays
  -> Airpay
  -> https://frontiva.online/callback/cpm/arp/collection
  -> Frontiva verification
  -> Airpay Order Confirmation      (the authority)
  -> Supabase
  -> order = PAID
```

`/callback/cpm/arp/collection` is the exact path Airpay has registered against
MID 366751 as **both** the Response (Success/Failed) URL **and** the IPN URL, so
one handler serves both kinds of traffic. `vercel.json` rewrites that path onto
`api/payments/callback.js` — the `/api` prefix is a Vercel filesystem
requirement, not a change to the public contract.

### kkchat.in

`frontiva.online/callback/cpm/arp/collection -> kkchat.in/...` was a **different,
pre-existing client integration**. It is not part of this Airpay integration and
is not implemented here. An earlier revision of this work did add such a relay;
it has been removed in full. Every remaining `kkchat` occurrence in this
repository is a comment, a doc line, or a test name — no executable code
contacts it, and `tests/callback.test.js` asserts it cannot come back.

---

## 2. What was added

Before this feature the site was a static SPA with no server tier. Online
payment requires one: the amount must be computed server-side and the Airpay
credentials must never reach the browser. That tier is a set of Vercel
Serverless Functions under `store/api/`. The SPA build is untouched.

| Path | Purpose |
| --- | --- |
| `api/payments/create.js` | Prices the cart from Supabase, creates the pending order, gets an Airpay token, returns the encrypted form for the hosted page |
| `api/payments/callback.js` | Airpay Response + IPN endpoint (public path `/callback/cpm/arp/collection`) |
| `api/payments/return.js` | Compatibility alias for the browser return; same verification path |
| `api/payments/status.js` | What `/success` polls for the real payment state |
| `api/payments/reconcile.js` | Cron-authenticated sweep of unresolved payments |
| `api/health.js` | Config health check and live OAuth verification |
| `api/_lib/*` | Config, crypto, Airpay client, Supabase REST, pricing, order lifecycle |

---

## 3. Airpay credential mapping

Do not swap these.

| Variable | Role |
| --- | --- |
| `AIRPAY_CLIENT_ID` | OAuth2 `client_id` |
| `AIRPAY_SECRET_KEY` | OAuth2 `client_secret` |
| `AIRPAY_MID` | `merchant_id` |
| `AIRPAY_API_KEY` | `privatekey` derivation secret **only** |
| `AIRPAY_USERNAME` / `AIRPAY_PASSWORD` | AES key derivation, and `privatekey` derivation |

```
privatekey     = sha256(AIRPAY_API_KEY + "@" + AIRPAY_USERNAME + ":|:" + AIRPAY_PASSWORD)
encryption key = md5(AIRPAY_USERNAME + "~:~" + AIRPAY_PASSWORD)   // literal 32-char ASCII hex, NOT hex-decoded
encdata        = IV(16 hex chars from 8 random bytes) + base64(AES-256-CBC ciphertext, PKCS#7)
checksum       = sha256(values sorted by key, concatenated, + IST date YYYY-MM-DD)   // Asia/Kolkata
```

**Envelope shapes differ by endpoint:**

- OAuth2 body: `merchant_id`, `encdata`, `checksum` — **no `privatekey`**.
- Token-authenticated transactional APIs: the above **plus** `privatekey`.

---

## 4. Environment variables

Set in **Vercel → Project → Settings → Environment Variables**. None may be
prefixed `VITE_` — that would inline the value into the browser bundle.

| Variable | Required | Notes |
| --- | --- | --- |
| `AIRPAY_MID` | yes | |
| `AIRPAY_CLIENT_ID` | yes | |
| `AIRPAY_SECRET_KEY` | yes | OAuth2 client_secret |
| `AIRPAY_API_KEY` | yes | privatekey derivation |
| `AIRPAY_USERNAME` | yes | |
| `AIRPAY_PASSWORD` | yes | |
| `AIRPAY_ENV` | yes | `live` or `sandbox` |
| `AIRPAY_VERIFY_URL` | no | Order Confirmation endpoint override |
| `AIRPAY_FALLBACK_BUYER_EMAIL` | recommended | See §10 |
| `SUPABASE_URL` | yes | Same project the storefront uses |
| `SUPABASE_SERVICE_ROLE` | yes | Required — `payment_events` is closed to anon |
| `PUBLIC_SITE_ORIGIN` | yes | No trailing slash; must match the registered return URL exactly |
| `CRON_SECRET` | yes | Bearer token for `/api/payments/reconcile` and the OAuth probe |

Template: `store/.env.example`. `.env` is gitignored and must stay that way.

> **`PUBLIC_SITE_ORIGIN` must be the apex host**, `https://frontiva.online`, with
> no `www` and no trailing slash. That is the domain Airpay has registered
> against MID 366751, and Airpay validates it — `www.frontiva.online` is a
> different origin and will be rejected. If the site currently serves `www` as
> canonical, add a 301 from `www` to the apex, or change the Airpay dashboard
> registration to match. Do not mix the two.

---

## 5. Endpoints

| Role | URL |
| --- | --- |
| Airpay OAuth2 | `https://kraken.airpay.co.in/airpay/pay/v4/api/oauth2/` |
| Airpay hosted payment page | `https://payments.airpay.co.in/pay/v4/?token=<access_token>` |
| Frontiva Response + IPN | `https://frontiva.online/callback/cpm/arp/collection` |
| Frontiva return alias | `https://frontiva.online/api/payments/return` |
| Frontiva reconciliation | `https://frontiva.online/api/payments/reconcile` (cron auth) |
| Frontiva health | `https://frontiva.online/api/health` |

---

## 6. Airpay merchant dashboard configuration

These are the values Airpay has **already configured** for this MID. The
application has been aligned to them; nothing here needs changing.

| Setting | Value |
| --- | --- |
| MID | `366751` |
| Domain URL | `https://frontiva.online` |
| Response URL (Success/Failed) | `https://frontiva.online/callback/cpm/arp/collection` |
| IPN URL (Webhook) | `https://frontiva.online/callback/cpm/arp/collection` |

Neither URL is configurable per transaction — both are MID-level settings.

Confirm with Airpay support:

1. **The MID is provisioned for `frontiva.online`.** If Airpay returns
   **Invalid Domain**, that is a merchant-dashboard / domain-registration issue.
   It cannot and must not be worked around in application code — report it to
   Airpay.
2. The MID is enabled for the **Order Confirmation** API. Without it no order
   can ever be marked `paid` (see §8).
3. The OAuth2 v4 credentials are issued for this MID.
4. The IPN content type (form-encoded POST is assumed; JSON is also handled).

---

## 7. Supabase migration

Run `store/supabase-schema.sql` in the Supabase SQL editor. It is idempotent and
backwards compatible — re-running it against the live database is safe.

Adds to `public.orders` (all nullable, no defaults): `order_ref`,
`payment_status`, `airpay_transaction_id`, `verified_at`, `paid_at`,
`updated_at`; a unique index on `order_ref`; a partial index for reconciliation.
Creates `public.payment_events` with RLS enabled and no policy.

Why COD is unaffected:

- Every new column is nullable with no default, and the COD insert names none of
  them.
- `orders_order_ref_key` is a unique *index*, not a primary key — Postgres
  permits unlimited NULLs, so COD rows (no `order_ref`) are fine.
- `payment_events` has RLS on with **no policy**, so the browser's anon key
  cannot read or write it. Only the service role reaches it.

### Status model

| `payment_method` | `status` | `payment_status` |
| --- | --- | --- |
| `Cash on Delivery` | `processing` — unchanged | `null` |
| `Online Payment` | mirrored from `payment_status` | `initiated` → `processing` → `paid` \| `failed` \| `requires_review` |

`payment_status` is authoritative; `status` is mirrored so the existing admin
table keeps rendering. `requires_review` means a human must check — it is never
treated as paid.

---

## 8. What "paid" requires

An order reaches `paid` only when **all** hold:

1. Airpay's Order Confirmation API was reached and returned a transaction status.
2. `classifyTransaction()` rates that status `success` (`200` / `SUCCESS`).
3. The confirmed amount **exactly equals** the server-derived order amount.

Explicitly **not** paid:

| Situation | Result |
| --- | --- |
| Browser returned from Airpay | irrelevant — no effect |
| Callback body says SUCCESS | irrelevant — body is never an input to settlement |
| `INPROCESS` / `PENDING` | `processing` (stays open, reconciled later) |
| Amount mismatch, even by one paisa | `requires_review` |
| No amount in the confirmation | `requires_review` |
| Airpay unreachable | `requires_review` |
| Unrecognised status code | `failed` (fails closed) |

Settlement is idempotent: the transition is a conditional UPDATE filtered on the
open statuses, so concurrent or duplicate deliveries cannot settle twice — the
loser updates zero rows. Every IPN delivery is also recorded in `payment_events`
under a unique `dedupe_key`.

---

## 9. Reconciliation

`/api/payments/reconcile` re-verifies online orders still in `initiated`,
`processing` or `requires_review` and older than a 10-minute grace period,
in batches of 25.

- `Authorization: Bearer $CRON_SECRET`, compared in **constant time**.
- No unauthenticated mode. An unset `CRON_SECRET` denies.
- Reads **nothing** from the request — no body, no query string.
- Settles through the same `settleOrder()`, so it cannot reach a state the
  callback path could not, and cannot double-settle.

Schedule it with Vercel Cron (`vercel.json` → `crons`) or any external
scheduler, every 10–15 minutes.

---

## 10. Customer email

The existing checkout collects name, phone, address and landmark — no email.
Airpay requires a buyer email, so `AIRPAY_FALLBACK_BUYER_EMAIL` (a merchant-owned
mailbox) is sent rather than fabricating a customer address. If Airpay requires a
genuine per-customer email, an email field must be added to the checkout form —
a deliberate open decision, not an oversight.

---

## 11. Deployment commands

```bash
# 1. From the repo root (store/)
npm install

# 2. Verify locally before deploying
npm test          # 163 tests
npm run lint      # eslint --quiet
npm run build     # NOTE: on Windows this silently skips vite (see below);
                  # run `npx vite build --outDir ../../dist/apps/web` from apps/web instead

# 3. Confirm no credential reached the bundle
grep -ril "airpay" dist/apps/web/ || echo clean
grep -rE "AIRPAY_(SECRET_KEY|API_KEY|PASSWORD)|VITE_AIRPAY|CRON_SECRET" dist/apps/web/ || echo clean

# 4. Apply the migration
#    Paste store/supabase-schema.sql into the Supabase SQL editor and run it.

# 5. Set environment variables (§4) in Vercel Production, then deploy
vercel --prod
```

`npm run build` is a **pre-existing** Windows quirk: the script is
`node tools/generate-llms.js || true && vite build`, and `true` is not a cmd.exe
builtin, so the `&&` never fires. It is correct under Vercel's Linux shell.

---

## 12. Production verification (no money moved)

```bash
ORIGIN=https://frontiva.online

# Configuration present? Values are never returned, only booleans.
curl -s $ORIGIN/api/health

# Live OAuth round trip — proves credentials, key derivation, encryption and
# checksum, without creating a transaction.
curl -s $ORIGIN/api/health -H "Authorization: Bearer $CRON_SECRET"
# expect: "oauth":{"ok":true,"expires_in":<n>}

# Callback route reachable and NOT swallowed by the SPA? Must return plain
# text, not HTML. The reference matches no order, which is the expected result.
curl -i -X POST $ORIGIN/callback/cpm/arp/collection \
  -d "CUSTOMVAR=FRVHEALTHCHECK01&TRANSACTIONSTATUS=200"
# expect: 200 OK, and NO order anywhere becomes paid

# Reconciliation is authenticated
curl -s -o /dev/null -w '%{http_code}\n' -X POST $ORIGIN/api/payments/reconcile   # expect 401
curl -s -X POST $ORIGIN/api/payments/reconcile -H "Authorization: Bearer $CRON_SECRET"
```

Then place a **Cash on Delivery** order end to end and confirm it behaves
exactly as before: order created, cart cleared, confirmation page shows the
order number.

---

## 13. Live transaction

Do **not** transact until §12 passes and the merchant explicitly authorises it.
When authorised, use a low-value order and verify: `payment_status` moves
`initiated` → `paid`; `paid_at`, `verified_at` and `airpay_transaction_id` are
set; exactly one `payment_events` row per IPN delivery; `/success` shows the
confirmed order.

---

## 14. Logging and secrets

Server logs are structured JSON events (`payment.create.ok`,
`payment.callback.received`, `payment.settle.applied`, `payment.settle.not_paid`,
`payment.reconcile.completed`, …). `encdata`, `checksum`, `privatekey`, tokens,
card fields, phone numbers and email addresses are redacted before anything is
logged or written to `payment_events`. Credentials are never logged, never
returned in an API response, and never included in a customer-facing error.
