# Frontiva PayIn - validation notes (2026-10-31)

Gateway stays **disabled** (`FRONTIVA_PAYIN_ENABLED=false`). Nothing here was run against the provider by Claude; the login result below comes from your Postman run.

## 1. Auth client vs the confirmed login response

| Confirmed field | Used by `api/_lib/frontiva-payin.js` `login()` |
| --- | --- |
| `data.accessToken` | Bearer token (memory only) |
| `data.user.clientSecret` | HMAC key (memory only) |
| `data.user.merchantId` = `1` (number) | `String(merchantId)` must equal `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID`, else `merchant_mismatch` (fails closed) |
| `data.refreshToken` | Ignored on purpose (no refresh endpoint documented) |
| `data.user.defaultCurrency` = `INR` | Not read; currency is hardcoded `INR` |

Covered by a new test ("the confirmed live login shape ...") that uses that exact shape with fixture values.

## 2. Config

`.env`: `FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID=1` (present) and `FRONTIVA_PAYIN_ENABLED=false` (it was `true`; changed). Vercel needs the same two values later; `FRONTIVA_PAYIN_LAUNCH_HOSTS` stays unset.

## 3. HMAC

`x-signature = HMAC-SHA256(key = data.user.clientSecret, message = exact merchantReference)`, lowercase hex. Same on create (POST) and status (GET). Verified by an openssl-vector test and by the new test asserting the sent header equals that HMAC and the refresh token is never sent.

## 4. Launch adapter: `resolveFrontivaLaunch(record, config, amountInPaise)`

**Superseded 2026-10-31** by the verified create response (`paymentMode: UPI_INTENT`, `url: null`, bare `upi://pay` intent). The adapter now accepts one form only: the intent, validated by `upiIntentProblem()` (rules in the code and in `tests/frontiva-payin.test.js` "UPI intent validation"). `url` is ignored in every form, `data:text/html` included. The https/`FRONTIVA_PAYIN_LAUNCH_HOSTS` path and the JSON scan were removed.

## 5. Postman: GET status

`docs/postman/frontiva-payin-status.postman_collection.json`. Import, create an environment with `baseUrl`, `email`, `password` (secret), `expectedMerchantId=1`, `merchantReference` (the provider-approved one). Run "1. Login" then "2. GET status". The collection has no POST create request. The pre-request script computes the HMAC from the login's clientSecret; tests check merchant, reference, known status and readable amount, and log whether `data` is an object or array (the app handles both, and the response shape is still inferred).

## 6. Non-executing inspection of a future approved create response

Do this only when the provider approves a create call for a specific reference (that is the only step that can start a PayIn).

1. Send it in Postman, not from the app. Turn off "Automatically follow redirects". Use the Postman **Raw** or **JSON** body view, never **Preview**/Visualize (Preview renders HTML).
2. Do not open, paste into a browser, or click `url`. Do not decode and open it.
3. Record only the *structure*: for `url`, the scheme and (if https) the host; for `intent`, whether it is a plain string, a `upi://` string, or JSON, plus its top-level key names. Replace values with `<redacted>` when sharing; never share tokens, the secret or the signature.
4. Offline, dry-run the adapter on the saved record with no network:
   `node -e "import('./api/_lib/frontiva-payin.js').then(m=>console.log(m.resolveFrontivaLaunch(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')),{allowedPayees:['PAYEE_VPA']},AMOUNT_IN_PAISE)))" record.json`
   (replace `PAYEE_VPA` and `AMOUNT_IN_PAISE`.) `launch: null` plus a `problem` says why the intent would be refused.
5. Confirm `merchantReference`, amount and `merchantId` in the response match what was requested.

## 7. Regression

`npm test`: 566 pass, 0 fail (565 before + 1 new). AirPay MID 1/2/3, SabPaisa, callback and KKChat-forwarding suites unchanged and passing; a test still asserts PayIn code imports none of them.

## 8. Remaining for a controlled end-to-end test

1. ~~Launch contract~~: resolved, UPI intent shown as a QR. Confirm with the provider that `pa` is a fixed merchant VPA, and what `callbackNeeded: true` means.
2. Amount unit: the verified response confirms rupees (`amount: "10"`, `am=10.00`). Payment mode: `UPI_INTENT` is now sent; confirm that it is the documented request value.
3. Run `migrations-frontiva-payin.sql` in Supabase (after `migrations-sabpaisa.sql`). It now also adds `upi_intent`. Re-running it is safe.
4. Vercel env: EMAIL, PASSWORD, EXPECTED_MERCHANT_ID=1, ALLOWED_PAYEES, `SUPABASE_SERVICE_ROLE`.
5. A scheduler calling `POST /api/payments/frontiva-payin/reconcile` with the cron secret every 10-15 min (none exists in `vercel.json`).
6. Provider-approved small test amount / sandbox, plus one approved reference for the GET status check in section 5.
7. Then, and only then, `FRONTIVA_PAYIN_ENABLED=true`, deploy, and test: create -> launch (mobile + desktop) -> pay -> status COMPLETED -> order `paid`; and an abandoned payment settled by reconciliation.
