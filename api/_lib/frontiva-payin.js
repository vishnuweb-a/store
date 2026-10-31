/**
 * Frontiva PayIn (portal.frontiva.online "Payin API — Direct Integration
 * v1.0.0") client: login, x-signature, PayIn creation and status lookup.
 *
 * A separate gateway, not an Airpay MID and not SabPaisa. Nothing here reads an
 * Airpay or SabPaisa variable, and nothing there reads anything here.
 *
 * No PayIn webhook/callback exists in this deployment (by decision). The only
 * thing that can mark a PayIn order paid is the documented status endpoint,
 * asked from the server, naming our merchantReference, our portal merchant and
 * our amount.
 *
 * Secrets: the portal password (env), and the access token and client secret
 * returned by login (memory only). None is ever logged, stored or returned.
 */
import { createHmac } from 'node:crypto';
import { ConfigError, supabaseConfig } from './config.js';
import { fetchWithTimeout, logEvent, scrubSecrets } from './http.js';

/** The value orders.payment_gateway carries for a Frontiva PayIn order. */
export const FRONTIVA_PAYIN_GATEWAY = 'frontiva_payin';

export const FRONTIVA_PAYIN_DEFAULT_BASE_URL = 'https://portal.frontiva.online';

export const FRONTIVA_PAYIN_TIMEOUT_MS = 15_000;

/** The verified provider create response reports UPI_INTENT (it returns a upi://pay intent, url null). */
export const FRONTIVA_PAYIN_PAYMENT_MODE = 'UPI_INTENT';

export const FRONTIVA_PAYIN_CURRENCY = 'INR';

/** Documented minimum: amount 1.00. */
export const FRONTIVA_PAYIN_MIN_AMOUNT_PAISE = 100;

/** Documented merchantReference limit. */
const MAX_REFERENCE_LENGTH = 50;

/** Docs say the access token lasts 7 days; we stop using it a little early. */
const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const TOKEN_EARLY_EXPIRY_MS = 10 * 60_000;

/** After a failed login, further logins wait this long (no login storms). */
const LOGIN_FAILURE_COOLDOWN_MS = 30_000;

class FrontivaPayinError extends Error {
  /** @param {string} kind @param {string} message */
  constructor(kind, message) {
    super(message);
    this.name = 'FrontivaPayinError';
    this.kind = kind;
  }
}

class FrontivaPayinValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrontivaPayinValidationError';
    // Same flag the create endpoints' error handling already understands.
    this.isValidationError = true;
  }
}

// --- Configuration ------------------------------------------------------------

function env(name) {
  return String(process.env[name] || '').trim();
}

/**
 * Independent of FRONTIVA_PAYIN_ENABLED: the flag gates NEW payments only, and
 * orders already started must stay verifiable after it is switched off.
 *
 * @returns {{baseUrl: string, email: string, password: string, expectedMerchantId: string, allowedPayees: string[]}}
 */
export function loadFrontivaPayinConfig() {
  const values = {};

  for (const [role, name] of [
    ['email', 'FRONTIVA_PAYIN_EMAIL'],
    ['password', 'FRONTIVA_PAYIN_PASSWORD'],
    ['expectedMerchantId', 'FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID'],
  ]) {
    values[role] = env(name);

    if (!values[role]) {
      throw new ConfigError(`Missing required environment variable: ${name}`);
    }
  }

  const configured = env('FRONTIVA_PAYIN_BASE_URL').replace(/\/+$/, '') || FRONTIVA_PAYIN_DEFAULT_BASE_URL;

  // Origin only, HTTPS only: the password is posted here.
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(configured)) {
    throw new ConfigError('FRONTIVA_PAYIN_BASE_URL must be an https origin');
  }

  return {
    ...values,
    baseUrl: configured,
    // UPI payee addresses (pa) a QR may pay. Without one, no payment is started:
    // a forged intent must never send a customer's money to another payee.
    allowedPayees: env('FRONTIVA_PAYIN_ALLOWED_PAYEES')
      .split(',')
      .map((vpa) => vpa.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** @returns {boolean} */
export function isFrontivaPayinConfigured() {
  try {
    loadFrontivaPayinConfig();
    return true;
  } catch {
    return false;
  }
}

/** Only an explicit `true` enables new PayIn payments. Default off. */
export function frontivaPayinEnabled() {
  return env('FRONTIVA_PAYIN_ENABLED').toLowerCase() === 'true';
}

/**
 * Whether checkout may START a PayIn payment: on, configured, and the server
 * holds the Supabase service role (frontiva_payin_transactions has RLS with no
 * policy, so the anon fallback could not record the attempt).
 */
export function frontivaPayinAvailable() {
  if (!frontivaPayinEnabled() || !isFrontivaPayinConfigured()) {
    return false;
  }

  try {
    // No allowed payee: every QR would be refused, so do not start (and waste) PayIns.
    return loadFrontivaPayinConfig().allowedPayees.length > 0 && supabaseConfig().usingServiceRole;
  } catch {
    return false;
  }
}

// --- Signature ----------------------------------------------------------------

/**
 * x-signature: HMAC-SHA256 of the exact merchantReference, keyed with the
 * portal client secret, lowercase hex. Not the body, not the AirPay key.
 *
 * @param {string} merchantReference
 * @param {string} clientSecret
 * @returns {string}
 */
export function generateFrontivaSignature(merchantReference, clientSecret) {
  if (typeof merchantReference !== 'string' || !merchantReference) {
    throw new Error('Signature reference is missing');
  }

  if (typeof clientSecret !== 'string' || !clientSecret) {
    throw new Error('Signature secret is missing');
  }

  return createHmac('sha256', clientSecret).update(merchantReference).digest('hex');
}

// --- Amounts ------------------------------------------------------------------

/**
 * Exact decimal-rupee → integer-paise conversion, no float arithmetic.
 * Accepts 1500, "1500", "1500.5", "1500.50". Anything else is null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function rupeesToPaise(value) {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null;
  }

  const text = String(value).trim();
  const match = text.match(/^(\d{1,12})(?:\.(\d{1,2}))?$/);

  if (!match) {
    return null;
  }

  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

/** Integer paise → the decimal rupee number the API documents (min 1.00). */
export function paiseToRupees(amountInPaise) {
  return Number(`${Math.trunc(amountInPaise / 100)}.${String(amountInPaise % 100).padStart(2, '0')}`);
}

// --- Customer -----------------------------------------------------------------

/** @param {unknown} value */
export function isValidEmail(value) {
  const email = String(value ?? '').trim();
  return email.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/.test(email);
}

/**
 * PayIn's customer rules on top of normalizeCustomer(). Email is required by
 * the API, so it is the customer's own, collected at checkout — never a
 * substituted merchant mailbox.
 *
 * @param {{fullName: string, phone: string}} customer - normalizeCustomer() result
 * @param {unknown} email
 * @returns {{name: string, email: string, phone: string}}
 */
export function validateFrontivaCustomer(customer, email) {
  const name = String(customer?.fullName ?? '').trim().replace(/\s+/g, ' ');
  const phone = String(customer?.phone ?? '');
  const address = String(email ?? '').trim();

  if (name.length < 2 || name.length > 100) {
    throw new FrontivaPayinValidationError('Please enter your full name (up to 100 characters).');
  }

  if (!/^\d{10}$/.test(phone)) {
    throw new FrontivaPayinValidationError('Enter a valid 10-digit phone number.');
  }

  if (!isValidEmail(address)) {
    throw new FrontivaPayinValidationError('Please enter a valid email address to pay with Frontiva PayIn.');
  }

  return { name, email: address, phone };
}

/** @param {number} amountInPaise */
export function validateFrontivaAmount(amountInPaise) {
  if (!Number.isSafeInteger(amountInPaise) || amountInPaise < FRONTIVA_PAYIN_MIN_AMOUNT_PAISE) {
    throw new FrontivaPayinValidationError('This order amount cannot be paid with Frontiva PayIn. Please choose another payment option.');
  }

  return amountInPaise;
}

// --- Authentication -----------------------------------------------------------

/**
 * Per-instance session cache. On Vercel every function instance has its own
 * memory, so each logs in once and reuses the token until it nears expiry or
 * the API refuses it. Concurrent callers share one in-flight login.
 *
 * shortcut: no cross-instance token sharing (storing the token would persist a
 * secret); move to a secret store if login volume ever becomes a problem.
 */
let cachedSession = null;
let inflightLogin = null;
let loginBlockedUntil = 0;
let lastLoginError = null;

/** Test hook: forget the cached session and any login cooldown. */
export function resetFrontivaSession() {
  cachedSession = null;
  inflightLogin = null;
  loginBlockedUntil = 0;
  lastLoginError = null;
}

/** Reads `exp` from a JWT without trusting it for anything but cache expiry. */
function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function readJson(response) {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function login(config, { doFetch, now }) {
  let response;
  let attempt = 0;

  // Login is idempotent, so one retry on a transport error or 5xx is safe.
  for (;;) {
    attempt += 1;

    try {
      response = await doFetch(
        `${config.baseUrl}/api/auth/user/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: config.email, password: config.password }),
        },
        FRONTIVA_PAYIN_TIMEOUT_MS,
      );
    } catch (error) {
      if (attempt < 2) continue;
      throw new FrontivaPayinError('unavailable', error?.name === 'AbortError' ? 'login timeout' : 'login network error');
    }

    if (response.status >= 500 && attempt < 2) continue;
    break;
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new FrontivaPayinError('invalid_credentials', `login refused (http ${response.status})`);
  }

  if (!response.ok) {
    throw new FrontivaPayinError('unavailable', `login http ${response.status}`);
  }

  const body = await readJson(response);
  const data = body?.data;
  const accessToken = data?.accessToken;
  const clientSecret = data?.user?.clientSecret;
  const merchantId = data?.user?.merchantId;

  if (body?.success === false || typeof accessToken !== 'string' || !accessToken) {
    throw new FrontivaPayinError('malformed', 'login response has no access token');
  }

  if (typeof clientSecret !== 'string' || !clientSecret) {
    throw new FrontivaPayinError('malformed', 'login response has no client secret');
  }

  if (merchantId === undefined || merchantId === null || String(merchantId) !== config.expectedMerchantId) {
    // Fail closed: these credentials belong to some other portal merchant.
    throw new FrontivaPayinError('merchant_mismatch', 'portal merchant does not match FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID');
  }

  const issuedAt = now();
  const expiry = Math.min(jwtExpiryMs(accessToken) ?? Infinity, issuedAt + TOKEN_LIFETIME_MS) - TOKEN_EARLY_EXPIRY_MS;

  return { accessToken, clientSecret, merchantId: String(merchantId), expiresAt: expiry };
}

/**
 * A usable session: cached when still valid, otherwise one shared login.
 *
 * @returns {Promise<{accessToken: string, clientSecret: string, merchantId: string, expiresAt: number}>}
 */
export async function getFrontivaSession(config, deps = {}) {
  const now = deps.now || Date.now;
  const doFetch = deps.fetch || fetchWithTimeout;

  if (cachedSession && cachedSession.expiresAt > now()) {
    return cachedSession;
  }

  if (inflightLogin) {
    return inflightLogin;
  }

  if (now() < loginBlockedUntil) {
    throw lastLoginError || new FrontivaPayinError('unavailable', 'login cooling down');
  }

  inflightLogin = login(config, { doFetch, now })
    .then((session) => {
      cachedSession = session;
      lastLoginError = null;
      return session;
    })
    .catch((error) => {
      cachedSession = null;
      lastLoginError = error;
      loginBlockedUntil = now() + LOGIN_FAILURE_COOLDOWN_MS;
      logFrontivaPayin('payment.frontiva_payin.login_failed', { kind: error?.kind, reason: error?.message });
      throw error;
    })
    .finally(() => {
      inflightLogin = null;
    });

  return inflightLogin;
}

/** Drops a session the API refused, unless a newer one already replaced it. */
function invalidateSession(session) {
  if (cachedSession === session) {
    cachedSession = null;
  }
}

/**
 * One signed API call. A 401/403 means the request was refused before it was
 * processed, so it is safe to log in again and send it once more — even a POST.
 */
async function signedRequest(config, { method, path, reference, body }, deps = {}) {
  const doFetch = deps.fetch || fetchWithTimeout;

  for (let attempt = 1; ; attempt += 1) {
    const session = await getFrontivaSession(config, deps);
    const response = await doFetch(
      `${config.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'x-signature': generateFrontivaSignature(reference, session.clientSecret),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      FRONTIVA_PAYIN_TIMEOUT_MS,
    );

    if ((response.status === 401 || response.status === 403) && attempt === 1) {
      invalidateSession(session);
      continue;
    }

    return { response, session };
  }
}

// --- Payment launch -----------------------------------------------------------

/** A UPI virtual payment address: handle@psp. */
const VPA = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;

/** Generous for a UPI intent (the verified sample is ~210 chars); bounds the QR size. */
const MAX_INTENT_LENGTH = 1024;

/**
 * Checks a provider `intent` as a payment-ready `upi://pay` URI. Returns null
 * when it is valid, otherwise why not. The URI is only read, never rebuilt:
 * whatever passes is used byte-for-byte as the QR payload.
 *
 * `tr` (the UPI transaction ref) is deliberately not compared with our
 * merchantReference: the verified provider sample shows they differ.
 *
 * @param {unknown} intent
 * @param {{amountInPaise: number, allowedPayees: string[]}} expected
 * @returns {string|null}
 */
export function upiIntentProblem(intent, { amountInPaise, allowedPayees }) {
  if (typeof intent !== 'string') return 'intent is not a string';
  if (intent.length > MAX_INTENT_LENGTH) return 'intent too long';
  // Printable ASCII only: no whitespace, control or non-ASCII characters to hide anything in.
  if (!/^[\x21-\x7e]+$/.test(intent)) return 'intent has unexpected characters';
  if (!intent.startsWith('upi://pay?')) return 'not a upi://pay URI';
  if (intent.includes('#')) return 'intent has a fragment';
  if (/%(?![0-9A-Fa-f]{2})/.test(intent)) return 'intent has malformed percent-encoding';

  // Decoded keys, so `p%61` is caught as a second `pa`.
  const params = [...new URLSearchParams(intent.slice('upi://pay?'.length))];
  const keys = params.map(([key]) => key.toLowerCase());
  // Any repeated key could be read differently by different UPI apps: refuse them all.
  if (new Set(keys).size !== keys.length) return 'duplicate parameter';

  const get = (name) => params.find(([key]) => key.toLowerCase() === name)?.[1];
  const payee = get('pa');

  if (!payee || !VPA.test(payee)) return 'payee address missing or invalid';
  if (!allowedPayees.includes(payee.toLowerCase())) return 'payee not in FRONTIVA_PAYIN_ALLOWED_PAYEES';
  if (get('cu') !== FRONTIVA_PAYIN_CURRENCY) return 'currency is not INR';

  // `am` is rupees ("10.00"); compared in integer paise, never rewritten.
  const amount = get('am');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(amount ?? '')) return 'amount missing or malformed';
  if (rupeesToPaise(amount) !== amountInPaise) return 'amount does not match the order';

  return null;
}

/**
 * How the customer pays: a validated UPI intent, shown as a QR (and as a
 * tap-to-open link on phones), or null when the provider's answer has none we
 * can use safely. `url` is ignored: it is null for UPI_INTENT, and the
 * documented `data:text/html` form is never handed to a browser.
 *
 * @param {Record<string, unknown>} record - The create response record
 * @param {{allowedPayees: string[]}} config
 * @param {number} amountInPaise
 * @returns {{launch: {type: 'upi_intent', url: string}|null, problem: string|null}}
 */
export function resolveFrontivaLaunch(record, config, amountInPaise) {
  if (record?.paymentMode != null && String(record.paymentMode) !== FRONTIVA_PAYIN_PAYMENT_MODE) {
    return { launch: null, problem: 'payment mode differs from the request' };
  }

  const problem = upiIntentProblem(record?.intent, { amountInPaise, allowedPayees: config.allowedPayees });

  return problem ? { launch: null, problem } : { launch: { type: 'upi_intent', url: record.intent }, problem: null };
}

// --- Create -------------------------------------------------------------------

/** Unwraps `{success, data}` or returns the bare record (create is documented unwrapped). */
function recordOf(body) {
  if (!body) return null;
  if (body.data && typeof body.data === 'object') return body.data;
  return body;
}

/**
 * Creates one PayIn request. Never re-sent under the same reference: a request
 * whose answer we did not get may still have created a PayIn, so the result is
 * `ambiguous` and the caller resolves it through the status endpoint.
 *
 * @param {{orderRef: string, amountInPaise: number, customer: {name: string, email: string, phone: string}, config: ReturnType<typeof loadFrontivaPayinConfig>}} params
 * @param {{fetch?: Function, now?: () => number}} [deps]
 * @returns {Promise<
 *   | {kind: 'created', portalRequestId: string, providerStatus: string|null, merchantId: string, callbackNeeded: boolean, launch: {type: 'upi_intent', url: string}|null, launchProblem: string|null}
 *   | {kind: 'rejected', httpStatus: number, reason: string}
 *   | {kind: 'auth_failed', reason: string}
 *   | {kind: 'ambiguous', reason: string, httpStatus?: number}
 * >}
 */
export async function createFrontivaPayin({ orderRef, amountInPaise, customer, config }, deps = {}) {
  if (typeof orderRef !== 'string' || orderRef.length > MAX_REFERENCE_LENGTH) {
    throw new Error('merchantReference is invalid');
  }

  let response;
  let session;

  try {
    ({ response, session } = await signedRequest(
      config,
      {
        method: 'POST',
        path: '/api/payin-requests',
        reference: orderRef,
        body: {
          merchantReference: orderRef,
          amount: paiseToRupees(amountInPaise),
          currency: FRONTIVA_PAYIN_CURRENCY,
          paymentMode: FRONTIVA_PAYIN_PAYMENT_MODE,
          customer: { name: customer.name, email: customer.email, phone: customer.phone },
        },
      },
      deps,
    ));
  } catch (error) {
    if (error instanceof FrontivaPayinError) {
      // Login failed: nothing was sent to the create endpoint.
      return { kind: 'auth_failed', reason: error.kind };
    }

    return { kind: 'ambiguous', reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
  }

  const body = await readJson(response);

  if (response.status === 401 || response.status === 403) {
    return { kind: 'auth_failed', reason: `http ${response.status}` };
  }

  if (response.status >= 500 || response.status === 409 || response.status === 429) {
    // 5xx: unknown outcome. 409: a PayIn with this reference may exist. 429: unclear whether counted.
    return { kind: 'ambiguous', reason: `http ${response.status}`, httpStatus: response.status };
  }

  if (!response.ok) {
    return { kind: 'rejected', httpStatus: response.status, reason: `http ${response.status}` };
  }

  const record = recordOf(body);

  if (!record || body?.success === false || record.id === undefined || record.id === null) {
    return { kind: 'ambiguous', reason: 'unreadable response', httpStatus: response.status };
  }

  // The answer must be about this order, this amount, this portal merchant
  // (the verified create response always names its merchantId).
  if (
    String(record.merchantReference ?? '') !== orderRef ||
    rupeesToPaise(record.amount ?? record.requestedAmount) !== amountInPaise ||
    record.merchantId === undefined ||
    record.merchantId === null ||
    String(record.merchantId) !== session.merchantId
  ) {
    return { kind: 'ambiguous', reason: 'response does not match the request', httpStatus: response.status };
  }

  const providerStatus = record.status ? String(record.status).toUpperCase() : null;

  // A QR is only ever shown for a PayIn the provider reports as awaiting payment
  // (documented create answer: PENDING). FAILED / COMPLETED / unknown never launch.
  const { launch, problem } =
    classifyFrontivaStatus(providerStatus) === 'pending'
      ? resolveFrontivaLaunch(record, config, amountInPaise)
      : { launch: null, problem: 'create status is not pending' };

  return {
    kind: 'created',
    portalRequestId: String(record.id),
    providerStatus,
    merchantId: session.merchantId,
    // Provider integration detail awaiting clarification; logged, never acted on.
    callbackNeeded: record.callbackNeeded === true,
    launch,
    launchProblem: problem,
  };
}

// --- Status -------------------------------------------------------------------

/**
 * Asks the status endpoint about one merchantReference. Never throws.
 *
 * @param {string} orderRef
 * @param {{config?: ReturnType<typeof loadFrontivaPayinConfig>, fetch?: Function, now?: () => number}} [deps]
 * @returns {Promise<{
 *   outcome: 'answered'|'not_found'|'auth_error'|'unavailable'|'invalid'|'not_configured',
 *   status?: string|null, amountPaise?: number|null, merchantReference?: string|null,
 *   merchantId?: string|null, expectedMerchantId?: string, portalRequestId?: string|null,
 *   utr?: string|null, httpStatus?: number, reason?: string
 * }>}
 */
export async function fetchFrontivaPayinStatus(orderRef, deps = {}) {
  let config = deps.config;

  try {
    config = config || loadFrontivaPayinConfig();
  } catch {
    return { outcome: 'not_configured', reason: 'not configured' };
  }

  let response;
  let session;

  // GET is idempotent: one retry on a transport failure.
  for (let attempt = 1; ; attempt += 1) {
    try {
      ({ response, session } = await signedRequest(
        config,
        {
          method: 'GET',
          path: `/api/payin-requests?merchantReference=${encodeURIComponent(orderRef)}`,
          reference: orderRef,
        },
        deps,
      ));
      break;
    } catch (error) {
      if (error instanceof FrontivaPayinError) {
        return {
          outcome: error.kind === 'unavailable' ? 'unavailable' : 'auth_error',
          reason: error.kind,
        };
      }

      if (attempt >= 2) {
        return { outcome: 'unavailable', reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
      }
    }
  }

  const body = await readJson(response);
  const meta = { httpStatus: response.status };

  if (response.status === 404) {
    return { outcome: 'not_found', ...meta, reason: 'payin not found' };
  }

  if (response.status === 401 || response.status === 403) {
    return { outcome: 'auth_error', ...meta, reason: `http ${response.status}` };
  }

  if (response.status === 429 || response.status >= 500) {
    return { outcome: 'unavailable', ...meta, reason: `http ${response.status}` };
  }

  if (!response.ok || !body || body.success === false) {
    return { outcome: 'invalid', ...meta, reason: `http ${response.status}` };
  }

  let record = recordOf(body);

  if (Array.isArray(record)) {
    const matches = record.filter((row) => String(row?.merchantReference ?? '') === orderRef);

    if (matches.length === 0) {
      return { outcome: 'not_found', ...meta, reason: 'payin not found' };
    }

    if (matches.length > 1) {
      return { outcome: 'invalid', ...meta, reason: 'several payins share this reference' };
    }

    [record] = matches;
  }

  // Status documents requestedAmount; create documents amount. If both are
  // present they must agree, or the amount is treated as unknown.
  const requested = rupeesToPaise(record.requestedAmount);
  const plain = rupeesToPaise(record.amount);
  const conflicting = record.requestedAmount != null && record.amount != null && requested !== plain;

  return {
    outcome: 'answered',
    status: record.status === undefined || record.status === null ? null : String(record.status).toUpperCase(),
    amountPaise: conflicting ? null : (requested ?? plain),
    merchantReference: record.merchantReference == null ? null : String(record.merchantReference),
    merchantId: record.merchantId == null ? null : String(record.merchantId),
    expectedMerchantId: session.merchantId,
    portalRequestId: record.id == null ? null : String(record.id),
    utr: record.utr ? String(record.utr) : null,
    ...meta,
  };
}

/**
 * @param {unknown} status
 * @returns {'success'|'pending'|'failed'|'unknown'}
 */
export function classifyFrontivaStatus(status) {
  const value = String(status ?? '').trim().toUpperCase();

  if (value === 'COMPLETED') return 'success';
  // PROCESSING is not in the documented catalogue but appears in the create example.
  if (value === 'PENDING' || value === 'PROCESSING') return 'pending';
  if (value === 'FAILED') return 'failed';
  return 'unknown';
}

/**
 * Turns a status answer into the next payment state. The only route to `paid`:
 * an answer about this merchantReference, status COMPLETED, our portal
 * merchant (when the answer names one), and an amount equal to the order's.
 * `null` means no decision yet; silence never fails an order.
 *
 * @returns {{status: 'paid'|'failed'|'processing'|'requires_review'|null, reason: string}}
 */
export function decideFrontivaSettlement(answer, { orderRef, expectedInPaise, pastReviewWindow }) {
  const unresolved = (reason) => ({ status: pastReviewWindow ? 'requires_review' : null, reason });

  switch (answer.outcome) {
    case 'answered':
      break;
    case 'auth_error':
    case 'not_configured':
    case 'invalid':
      return { status: 'requires_review', reason: answer.reason || answer.outcome };
    default:
      // not_found / unavailable: ask again later.
      return unresolved(answer.reason || answer.outcome);
  }

  if (answer.merchantReference !== orderRef) {
    return { status: 'requires_review', reason: 'answer names a different or no merchantReference' };
  }

  if (answer.merchantId !== null && answer.merchantId !== answer.expectedMerchantId) {
    return { status: 'requires_review', reason: 'portal merchant mismatch' };
  }

  const outcome = classifyFrontivaStatus(answer.status);

  if (outcome === 'unknown') return { status: 'requires_review', reason: 'unrecognised status' };
  if (outcome === 'pending') return { status: 'processing', reason: `payin ${answer.status}` };
  if (outcome === 'failed') return { status: 'failed', reason: 'payin FAILED' };

  if (answer.amountPaise === null || answer.amountPaise === undefined) {
    return { status: 'requires_review', reason: 'no readable amount' };
  }

  if (answer.amountPaise !== expectedInPaise) {
    return { status: 'requires_review', reason: 'amount mismatch' };
  }

  return { status: 'paid', reason: 'verified' };
}

/** Logs without echoing a secret. */
export function logFrontivaPayin(event, fields) {
  logEvent(event, { ...fields, ...(fields.reason ? { reason: scrubSecrets(fields.reason, 120) } : {}) });
}

export { FrontivaPayinError, FrontivaPayinValidationError };
