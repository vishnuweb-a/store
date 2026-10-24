/**
 * SabPaisa PG 3.0 (v2 REST API) client: payment-session creation and
 * Transaction Enquiry against the production API only.
 *
 * There is no SabPaisa webhook or callback in this deployment. The browser's
 * return to /success is a redirect, never evidence: the only thing that can
 * mark a SabPaisa order paid is a Transaction Enquiry answer, asked from the
 * server, that names our order, our merchant, our currency and our amount.
 *
 * Fully isolated from the Airpay code — nothing here reads an Airpay variable,
 * and nothing in airpay.js reads anything here.
 */
import crypto from 'node:crypto';
import {
  SABPAISA_TIMEOUT_MS,
  loadSabpaisaConfig,
  sabpaisaAvailable,
} from './config.js';
import { fetchWithTimeout, logEvent, scrubSecrets } from './http.js';

export { loadSabpaisaConfig, sabpaisaAvailable };

/** Documented bounds on `amount`, in paise. */
export const SABPAISA_MIN_AMOUNT_PAISE = 100;
export const SABPAISA_MAX_AMOUNT_PAISE = 100_000_000;

/** Frontiva sells in INR only. */
export const SABPAISA_CURRENCY = 'INR';

class SabpaisaValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SabpaisaValidationError';
    // Same flag the shared create-endpoint error handling already understands.
    this.isValidationError = true;
  }
}

/**
 * HMAC-SHA256 over `merchantId|merchantTxnId|amount|currency|timestamp`,
 * keyed with the secret key, as lowercase hex. Server-side only.
 *
 * @param {{merchantId: string, merchantTxnId: string, amount: number, currency: string, timestamp: number}} fields
 * @param {string} secretKey
 * @returns {string} 64 lowercase hex characters
 */
export function generateSabpaisaChecksum({ merchantId, merchantTxnId, amount, currency, timestamp }, secretKey) {
  const parts = [merchantId, merchantTxnId, amount, currency, timestamp];

  if (!secretKey || parts.some((part) => part === undefined || part === null || String(part) === '')) {
    throw new Error('Checksum input is incomplete');
  }

  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(timestamp)) {
    // A float or a millisecond timestamp would sign a different string from
    // the one SabPaisa rebuilds, and fail as INVALID_SIGNATURE.
    throw new Error('Checksum amount and timestamp must be integers');
  }

  return crypto.createHmac('sha256', Buffer.from(secretKey, 'utf8')).update(parts.join('|'), 'utf8').digest('hex');
}

/**
 * The extra rules SabPaisa applies to the customer, on top of the checkout's
 * own normalizeCustomer() rules. Nothing is invented or substituted: a value
 * SabPaisa would reject is reported back so the customer can fix it or choose
 * another payment option.
 *
 * @param {{fullName: string, phone: string}} customer - From normalizeCustomer()
 * @param {string} email
 * @returns {{name: string, phone: string, email: string}}
 */
export function validateSabpaisaCustomer(customer, email) {
  const name = String(customer?.fullName ?? '').trim().replace(/\s+/g, ' ');
  const phone = String(customer?.phone ?? '').trim();

  if (!/^[A-Za-z ]{2,100}$/.test(name)) {
    throw new SabpaisaValidationError(
      'For SabPaisa, please enter your name using letters and spaces only (2–100 characters).',
    );
  }

  if (!/^[6-9]\d{9}$/.test(phone)) {
    throw new SabpaisaValidationError('For SabPaisa, please enter a valid 10-digit Indian mobile number.');
  }

  if (!isPlausibleEmail(email)) {
    // The merchant mailbox is misconfigured — not something the customer can fix.
    const error = new Error('SabPaisa buyer email is not a valid address');
    error.isConfigError = true;
    throw error;
  }

  return { name, phone, email };
}

/** @param {string} value */
export function isPlausibleEmail(value) {
  const email = String(value || '');
  return email.length <= 255 && /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email);
}

/**
 * @param {number} amountInPaise
 * @returns {number}
 */
export function validateSabpaisaAmount(amountInPaise) {
  if (
    !Number.isSafeInteger(amountInPaise) ||
    amountInPaise < SABPAISA_MIN_AMOUNT_PAISE ||
    amountInPaise > SABPAISA_MAX_AMOUNT_PAISE
  ) {
    throw new SabpaisaValidationError('This order amount cannot be paid with SabPaisa. Please choose another payment option.');
  }

  return amountInPaise;
}

/**
 * Whether a checkout URL is somewhere we are prepared to send a customer: an
 * HTTPS SabPaisa production host. Staging/sandbox hosts are refused.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isAllowedCheckoutUrl(value) {
  let url;

  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();

  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (host === 'sabpaisa.in' || host.endsWith('.sabpaisa.in')) &&
    !/(^|[.-])(staging|stage|sandbox|uat|test)([.-]|$)/.test(host)
  );
}

/**
 * The URL the customer is sent to: the provider's checkoutUrl, authenticated
 * with the session's clientSecret as the `clientSecret` query parameter, as
 * the API reference documents. If the provider already put the secret in the
 * URL it is left as given. The host is never constructed here.
 *
 * Contains a secret: never log the result.
 *
 * @param {string} checkoutUrl
 * @param {string|null} clientSecret
 * @returns {string|null} null when there is no way to authenticate the checkout
 */
export function buildCheckoutRedirect(checkoutUrl, clientSecret) {
  if (!isAllowedCheckoutUrl(checkoutUrl)) {
    return null;
  }

  const url = new URL(checkoutUrl);

  if (url.searchParams.get('clientSecret')) {
    return url.toString();
  }

  if (!clientSecret || typeof clientSecret !== 'string') {
    return null;
  }

  url.searchParams.set('clientSecret', clientSecret);

  return url.toString();
}

async function readJson(response) {
  const text = await response.text();

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const errorCode = (body) => (body?.error && typeof body.error === 'object' ? body.error.code : body?.code) || null;

/**
 * Creates a SabPaisa payment session.
 *
 * Never retried: a request whose answer we did not receive may still have
 * created a session, so the outcome is reported as `ambiguous` and the order is
 * left for enquiry to resolve, rather than being re-sent or written off.
 *
 * @param {Object} params
 * @param {string} params.orderRef - Becomes merchantTxnId
 * @param {number} params.amountInPaise - Server-priced total
 * @param {{name: string, phone: string, email: string}} params.customer - validateSabpaisaCustomer() result
 * @param {string} params.returnUrl
 * @param {ReturnType<typeof loadSabpaisaConfig>} params.config
 * @param {{fetch?: Function, now?: () => number}} [deps]
 * @returns {Promise<
 *   | {kind: 'created', paymentId: string|null, redirectUrl: string, status: string|null, expiresAt: string|null, traceId: string|null}
 *   | {kind: 'rejected', code: string|null, httpStatus: number, traceId: string|null}
 *   | {kind: 'ambiguous', reason: string, httpStatus?: number, code?: string|null, traceId?: string|null}
 * >}
 */
export async function createSabpaisaPayment({ orderRef, amountInPaise, customer, returnUrl, config }, deps = {}) {
  const doFetch = deps.fetch || fetchWithTimeout;
  const now = deps.now || Date.now;

  const timestamp = Math.floor(now() / 1000);
  const body = {
    merchantId: config.merchantId,
    merchantTxnId: orderRef,
    amount: amountInPaise,
    currency: SABPAISA_CURRENCY,
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    returnUrl,
    timestamp,
  };

  body.checksum = generateSabpaisaChecksum(body, config.secretKey);

  let response;

  try {
    response = await doFetch(
      `${config.baseUrl}/api/v2/payments`,
      {
        method: 'POST',
        headers: {
          'X-Api-Key': config.apiKey,
          'X-Merchant-Id': config.merchantId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      SABPAISA_TIMEOUT_MS,
    );
  } catch (error) {
    // Timeout or dropped connection: the session may or may not exist.
    return { kind: 'ambiguous', reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
  }

  const payload = await readJson(response);
  const code = errorCode(payload);
  const traceId = payload?.traceId ?? null;

  if (!response.ok) {
    // DUPLICATE_TRANSACTION means a session for this merchantTxnId already
    // exists; 5xx means we cannot tell. Neither is a definite "no".
    if (response.status >= 500 || code === 'DUPLICATE_TRANSACTION') {
      return { kind: 'ambiguous', reason: `http ${response.status}`, httpStatus: response.status, code, traceId };
    }

    return { kind: 'rejected', code, httpStatus: response.status, traceId };
  }

  if (!payload || payload.success === false) {
    return { kind: 'ambiguous', reason: 'unreadable response', httpStatus: response.status, code, traceId };
  }

  // The answer must be about this order, at this amount, in this currency.
  // Absent echoes are tolerated; wrong ones are not.
  const mismatch =
    (payload.merchantTxnId !== undefined && String(payload.merchantTxnId) !== orderRef) ||
    (payload.amount !== undefined && Number(payload.amount) !== amountInPaise) ||
    (payload.currency !== undefined && String(payload.currency).toUpperCase() !== SABPAISA_CURRENCY);

  if (mismatch) {
    return { kind: 'ambiguous', reason: 'response does not match the request', httpStatus: response.status, traceId };
  }

  const redirectUrl = buildCheckoutRedirect(payload.checkoutUrl, payload.clientSecret);

  if (!redirectUrl) {
    return { kind: 'ambiguous', reason: 'no usable checkout url', httpStatus: response.status, traceId };
  }

  return {
    kind: 'created',
    paymentId: payload.paymentId ? String(payload.paymentId) : null,
    redirectUrl,
    status: payload.status ?? null,
    expiresAt: payload.expiresAt ?? null,
    traceId,
  };
}

/**
 * Classifies a SabPaisa transaction status. Unknown is its own outcome — it is
 * neither paid nor failed, and goes to review.
 *
 * @param {unknown} status
 * @returns {'success'|'pending'|'failed'|'unknown'}
 */
export function classifySabpaisaStatus(status) {
  const value = String(status ?? '').trim().toUpperCase();

  if (value === 'SUCCESS') {
    return 'success';
  }

  if (['PENDING', 'PROCESSING', 'INITIATED'].includes(value)) {
    return 'pending';
  }

  // Terminal outcomes as SabPaisa itself reports them through enquiry.
  if (['FAILED', 'CANCELLED', 'EXPIRED', 'TIMEOUT'].includes(value)) {
    return 'failed';
  }

  return 'unknown';
}

/**
 * Asks SabPaisa's Transaction Enquiry API what happened to one order.
 *
 * Never throws. The result says what kind of answer came back; the decision of
 * what that means for the order is decideSabpaisaSettlement()'s.
 *
 * @param {string} orderRef - The server-stored order_ref (merchantTxnId)
 * @param {{config?: ReturnType<typeof loadSabpaisaConfig>, fetch?: Function}} [deps]
 * @returns {Promise<{
 *   outcome: 'answered'|'not_found'|'auth_error'|'rate_limited'|'unavailable'|'invalid'|'not_configured',
 *   status?: string|null, amountPaise?: number|null, paidAmountPaise?: number|null, currency?: string|null,
 *   txnId?: string|null, merchantTxnId?: string|null, merchantId?: string|null, success?: boolean,
 *   httpStatus?: number, code?: string|null, traceId?: string|null, reason?: string
 * }>}
 */
export async function confirmSabpaisaOrder(orderRef, deps = {}) {
  let config = deps.config;

  try {
    config = config || loadSabpaisaConfig();
  } catch {
    return { outcome: 'not_configured', reason: 'not configured' };
  }

  const doFetch = deps.fetch || fetchWithTimeout;
  let response;

  try {
    response = await doFetch(
      `${config.baseUrl}/api/v2/payments/enquiry`,
      {
        method: 'POST',
        headers: {
          'X-Api-Key': config.apiKey,
          'X-Merchant-Id': config.merchantId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ clientCode: config.clientCode, merchantTxnId: orderRef }),
      },
      SABPAISA_TIMEOUT_MS,
    );
  } catch (error) {
    return { outcome: 'unavailable', reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
  }

  const payload = await readJson(response);
  const code = errorCode(payload);
  const traceId = payload?.traceId ?? null;
  const meta = { httpStatus: response.status, code, traceId };

  if (response.status === 404 || code === 'TRANSACTION_NOT_FOUND') {
    return { outcome: 'not_found', ...meta, reason: 'transaction not found' };
  }

  if (response.status === 401 || response.status === 403) {
    return { outcome: 'auth_error', ...meta, reason: code || `http ${response.status}` };
  }

  if (response.status === 429) {
    return { outcome: 'rate_limited', ...meta, reason: 'rate limited' };
  }

  if (response.status >= 500 || code === 'TRANSACTION_SERVICE_ERROR' || code === 'INTERNAL_ERROR') {
    return { outcome: 'unavailable', ...meta, reason: code || `http ${response.status}` };
  }

  if (!response.ok || !payload) {
    return { outcome: 'invalid', ...meta, reason: code || `http ${response.status}` };
  }

  // The canonical amount is amountPaise. paidAmount is rupees and is only used
  // to cross-check it.
  const amountPaise = Number.isSafeInteger(payload.amountPaise) ? payload.amountPaise : null;
  const paidAmount = Number(payload.paidAmount);

  return {
    outcome: 'answered',
    success: payload.success === true,
    status: payload.status === undefined || payload.status === null ? null : String(payload.status),
    amountPaise,
    paidAmountPaise:
      payload.paidAmount === undefined || payload.paidAmount === null || !Number.isFinite(paidAmount)
        ? null
        : Math.round(paidAmount * 100),
    currency: payload.currency ? String(payload.currency).toUpperCase() : null,
    txnId: payload.txnId ? String(payload.txnId) : null,
    merchantTxnId: payload.merchantTxnId === undefined || payload.merchantTxnId === null ? null : String(payload.merchantTxnId),
    merchantId: payload.merchantId === undefined || payload.merchantId === null ? null : String(payload.merchantId),
    ...meta,
  };
}

/**
 * Turns an enquiry result into the next payment state.
 *
 * The only route to `paid`: SabPaisa answered with success:true and status
 * SUCCESS, about this merchantTxnId, for this merchant, in INR, with a
 * transaction id, and with amountPaise equal to the server-derived order total
 * (and paidAmount, when given, agreeing with it).
 *
 * `null` means "no decision": the order stays as it is and is asked again
 * later. Nothing here ever fails an order because time has passed.
 *
 * @param {Awaited<ReturnType<typeof confirmSabpaisaOrder>>} enquiry
 * @param {Object} params
 * @param {string} params.orderRef
 * @param {number} params.expectedInPaise
 * @param {{merchantId: string, clientCode: string}|null} params.config
 * @param {boolean} params.pastReviewWindow - Unresolved this long goes to a human
 * @returns {{status: 'paid'|'failed'|'processing'|'requires_review'|null, reason: string}}
 */
export function decideSabpaisaSettlement(enquiry, { orderRef, expectedInPaise, config, pastReviewWindow }) {
  const unresolved = (reason) => ({ status: pastReviewWindow ? 'requires_review' : null, reason });

  switch (enquiry.outcome) {
    case 'answered':
      break;
    case 'auth_error':
    case 'not_configured':
      // Our credentials are wrong or missing. A person needs to look.
      return { status: 'requires_review', reason: enquiry.reason || 'authentication failed' };
    case 'invalid':
      return { status: 'requires_review', reason: enquiry.reason || 'unexpected response' };
    case 'not_found':
      // Not conclusive — the customer may still be on the checkout page, or the
      // transaction may not be visible yet. Never treated as a failure.
      return unresolved('transaction not found');
    default:
      // unavailable / rate_limited: ask again later.
      return unresolved(enquiry.reason || 'enquiry unavailable');
  }

  if (enquiry.merchantTxnId !== orderRef) {
    // An answer to some other question. Proves nothing either way.
    return { status: 'requires_review', reason: 'enquiry names a different or no merchantTxnId' };
  }

  const outcome = classifySabpaisaStatus(enquiry.status);

  if (outcome === 'unknown') {
    return { status: 'requires_review', reason: 'unrecognised transaction status' };
  }

  if (outcome === 'pending') {
    return { status: 'processing', reason: 'transaction still in process at SabPaisa' };
  }

  if (outcome === 'failed') {
    return { status: 'failed', reason: `transaction ${String(enquiry.status).toUpperCase()}` };
  }

  // SUCCESS. Every check below can only withhold `paid`.
  if (enquiry.success !== true) {
    return { status: 'requires_review', reason: 'success flag not set' };
  }

  if (!enquiry.merchantId || !config || ![config.merchantId, config.clientCode].includes(enquiry.merchantId)) {
    return { status: 'requires_review', reason: 'merchant identity missing or mismatched' };
  }

  if (enquiry.currency !== SABPAISA_CURRENCY) {
    return { status: 'requires_review', reason: 'currency missing or mismatched' };
  }

  if (!enquiry.txnId) {
    return { status: 'requires_review', reason: 'no transaction id' };
  }

  if (enquiry.amountPaise === null || enquiry.amountPaise === undefined) {
    return { status: 'requires_review', reason: 'no amount in enquiry' };
  }

  if (enquiry.amountPaise !== expectedInPaise) {
    return { status: 'requires_review', reason: 'amount mismatch' };
  }

  if (enquiry.paidAmountPaise !== null && enquiry.paidAmountPaise !== undefined && enquiry.paidAmountPaise !== expectedInPaise) {
    return { status: 'requires_review', reason: 'paid amount mismatch' };
  }

  return { status: 'paid', reason: 'verified' };
}

/**
 * Logs a provider failure without echoing anything secret.
 *
 * @param {string} event
 * @param {Record<string, unknown>} fields
 */
export function logSabpaisa(event, fields) {
  logEvent(event, {
    ...fields,
    ...(fields.reason ? { reason: scrubSecrets(fields.reason, 120) } : {}),
  });
}

export { SabpaisaValidationError };
