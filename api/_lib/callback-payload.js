/**
 * Parsing and integrity checks for Airpay callback / response payloads.
 *
 * Everything here treats the payload as hostile. Nothing it returns is
 * sufficient to mark an order paid — that requires Airpay's Order Confirmation
 * API. These helpers only decide *which* order to go and verify, and whether
 * the delivery looks authentic enough to act on at all.
 *
 * Airpay echoes fields back with different casing and names depending on the
 * product and channel, so each field is looked up against a candidate list
 * rather than assuming one spelling.
 */
import crypto from 'node:crypto';
import { sha256Hex } from './crypto.js';

/** Case-insensitive lookup across a list of candidate field names. */
function pick(payload, names) {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const lowered = new Map(Object.entries(payload).map(([key, value]) => [key.toLowerCase(), value]));

  for (const name of names) {
    const value = lowered.get(name.toLowerCase());

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return undefined;
}

/**
 * Extracts the documented Airpay callback fields into one stable shape.
 *
 * @param {Record<string, unknown>} payload
 * @returns {{merchantId: string|null, orderRef: string|null, transactionId: string|null,
 *   amount: string|null, transactionStatus: string|null, paymentStatus: string|null,
 *   message: string|null, secureHash: string|null, customerVpa: string|null}}
 */
export function extractCallbackFields(payload) {
  const asString = (value) => (value === undefined ? null : String(value));

  return {
    merchantId: asString(pick(payload, ['merchant_id', 'mercid', 'merchantid'])),
    orderRef: extractOrderRef(payload),
    transactionId: asString(pick(payload, ['ap_transactionid', 'aptransactionid', 'transactionid', 'txnid'])),
    amount: asString(pick(payload, ['amount', 'transaction_amount', 'txnamount'])),
    transactionStatus: asString(pick(payload, ['transaction_status', 'transactionstatus', 'txnstatus'])),
    paymentStatus: asString(pick(payload, ['transaction_payment_status', 'transactionpaymentstatus', 'payment_status'])),
    message: asString(pick(payload, ['message', 'msg', 'response_message'])),
    secureHash: asString(pick(payload, ['ap_securehash', 'apsecurehash', 'securehash', 'secure_hash'])),
    customerVpa: asString(pick(payload, ['customer_vpa', 'customervpa', 'vpa'])),
  };
}

/**
 * The shape newOrderRef() generates. Requiring the FRV prefix — rather than
 * just an alphanumeric run — means a foreign identifier such as Airpay's own
 * numeric transaction id can never be mistaken for one of our references.
 */
const ORDER_REF_PATTERN = /^FRV[A-Z0-9]{5,61}$/;

/**
 * Finds the merchant order reference.
 *
 * Confirmed against a real Airpay IPN: our reference comes back in both
 * CUSTOMVAR (which we set) and TRANSACTIONID (Airpay's name for the merchant's
 * own order id — APTRANSACTIONID is Airpay's id, and is deliberately not used
 * here). The others are accepted as fallbacks.
 *
 * The format gate is a security control, not a convenience: this value flows
 * into a PostgREST filter, so anything outside the generated reference format
 * is rejected outright.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string|null}
 */
export function extractOrderRef(payload) {
  const value = pick(payload, ['customvar', 'transactionid', 'orderid', 'order_id', 'merchant_order_id']);

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return ORDER_REF_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Confirms the callback names our own merchant id.
 *
 * A callback for a different MID is not ours to act on. Compared in constant
 * time — the MID is not secret, but the check is cheap and uniform.
 *
 * @param {ReturnType<typeof extractCallbackFields>} fields
 * @param {string} expectedMid - AIRPAY_MID
 * @returns {'match'|'mismatch'|'absent'}
 */
export function verifyMerchantId(fields, expectedMid) {
  if (!fields.merchantId) {
    return 'absent';
  }

  const left = Buffer.from(sha256Hex(fields.merchantId.trim()), 'utf8');
  const right = Buffer.from(sha256Hex(String(expectedMid).trim()), 'utf8');

  return crypto.timingSafeEqual(left, right) ? 'match' : 'mismatch';
}

/**
 * Verifies Airpay's `ap_SecureHash` over the callback fields.
 *
 * IMPORTANT — this result is ADVISORY ONLY. It can withhold trust from a
 * delivery, but it can never grant it: settlement always re-verifies against
 * Airpay's Order Confirmation API regardless of what this returns. That is
 * deliberate, because the exact hash construction is not published in Airpay's
 * public documentation and must be confirmed against the merchant's integration
 * document. Because the check is advisory, an incorrect formula here can only
 * defer a settlement to reconciliation — it can never cause a wrong one.
 *
 * @param {Record<string, unknown>} payload
 * @param {string} secret - privatekey, per the merchant integration document
 * @returns {'valid'|'invalid'|'unavailable'}
 */
export function verifySecureHash(payload, secret) {
  const fields = extractCallbackFields(payload);

  if (!fields.secureHash || !secret) {
    return 'unavailable';
  }

  // Same construction Airpay uses elsewhere: values in ascending key order,
  // concatenated without separators, salted with the shared secret.
  const signed = Object.keys(payload)
    .filter((key) => !/securehash/i.test(key))
    .sort()
    .map((key) => {
      const value = payload[key];
      return value === null || value === undefined ? '' : String(value);
    })
    .join('');

  const expected = sha256Hex(`${signed}${secret}`);
  const provided = fields.secureHash.trim().toLowerCase();

  if (provided.length !== expected.length) {
    return 'invalid';
  }

  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'))
    ? 'valid'
    : 'invalid';
}

/**
 * Stable identity for one callback delivery, so a redelivery is recognised as
 * the same event. Falls back to hashing the raw body when the payload carries
 * no identifiers we recognise.
 *
 * @param {string} raw - Raw request body
 * @param {Record<string, unknown>} payload
 * @returns {string} SHA-256 hex digest
 */
export function dedupeKeyFor(raw, payload) {
  const fields = extractCallbackFields(payload);
  const identity = fields.orderRef || fields.transactionId;

  const basis = identity
    ? `${fields.orderRef || ''}|${fields.transactionId || ''}|${fields.transactionStatus || ''}`
    : raw;

  return crypto.createHash('sha256').update(String(basis), 'utf8').digest('hex');
}

/**
 * Distinguishes a browser landing on the Response URL from a server-to-server
 * IPN delivery, since Airpay is configured to send both to the same path.
 *
 * Browsers announce themselves: a navigation Sec-Fetch header, or an Accept
 * header asking for HTML. Airpay's server-to-server POST does neither.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isBrowserNavigation(req) {
  const headers = req?.headers || {};

  if (String(headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate') {
    return true;
  }

  if (String(headers['sec-fetch-dest'] || '').toLowerCase() === 'document') {
    return true;
  }

  return String(headers.accept || '').toLowerCase().includes('text/html');
}
