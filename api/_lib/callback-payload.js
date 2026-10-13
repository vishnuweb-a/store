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
import { decrypt, sha256Hex } from './crypto.js';
import { parseBody } from './http.js';

/**
 * Unwraps an Airpay callback delivered as an encrypted envelope.
 *
 * Airpay sends this endpoint two different shapes:
 *
 *   1. A plaintext IPN, with the fields spelled out (MERCID, TRANSACTIONID,
 *      TRANSACTIONSTATUS, CUSTOMVAR, ap_SecureHash, ...).
 *   2. An envelope: `merchant_id` in the clear plus `response`, which carries
 *      the same information encrypted.
 *
 * Shape 2 is the same envelope Airpay uses for its API responses, and it is
 * decoded here with the project's existing, already-verified primitive —
 * decrypt() from crypto.js, the counterpart of the encrypt() used to build
 * every outbound request. No new algorithm is introduced: this is the same
 * unwrapping parseAirpayResponse() in airpay.js already performs on the
 * `response` field.
 *
 * Best effort by contract. If the envelope cannot be decoded — wrong key,
 * different encoding, a shape we have not seen — the original payload is
 * returned untouched and the caller carries on. Decoding failure is never an
 * error, because settlement does not depend on anything in this body.
 *
 * @param {Record<string, unknown>} payload
 * @param {string|null} key - encryptionKey(); null when credentials are absent
 * @returns {{payload: Record<string, unknown>, enveloped: boolean, unwrapped: boolean, reason?: string}}
 */
export function unwrapEnvelope(payload, key) {
  const envelope = pick(payload, ['response', 'encdata', 'data']);

  if (typeof envelope !== 'string' || envelope.length <= 16) {
    return { payload, enveloped: false, unwrapped: false };
  }

  if (!key) {
    return { payload, enveloped: true, unwrapped: false, reason: 'no key configured' };
  }

  let plaintext;

  try {
    plaintext = decrypt(envelope, key);
  } catch {
    return { payload, enveloped: true, unwrapped: false, reason: 'decrypt failed' };
  }

  // The decrypted content may be JSON or form-encoded; parseBody handles both
  // and never throws.
  const decoded = parseBody(plaintext, plaintext.trim().startsWith('{') ? 'application/json' : '');

  if (!decoded || Object.keys(decoded).length === 0) {
    return { payload, enveloped: true, unwrapped: false, reason: 'empty after decode' };
  }

  // Merged, not replaced: the outer merchant_id stays available, and the
  // decoded fields become visible to the existing extractors unchanged.
  return { payload: { ...payload, ...decoded }, enveloped: true, unwrapped: true, decoded };
}

/** Field names that mark a decoded envelope as a genuine Airpay callback. */
const RECOGNISED_CALLBACK_KEYS = [
  'mercid',
  'merchant_id',
  'transactionid',
  'aptransactionid',
  'ap_transactionid',
  'orderid',
  'customvar',
  'transactionstatus',
  'transaction_status',
  'transactionpaymentstatus',
  'transaction_payment_status',
];

const MERCHANT_ID_KEYS = ['merchant_id', 'mercid', 'merchantid'];

/** Every merchant id a payload states, under any of its spellings. */
function statedMerchantIds(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const found = new Set();

  for (const [key, value] of Object.entries(payload)) {
    if (MERCHANT_ID_KEYS.includes(key.toLowerCase()) && value !== null && value !== undefined && value !== '') {
      found.add(String(value).trim());
    }
  }

  return [...found];
}

/**
 * Works out which configured Airpay merchant a callback belongs to, and opens
 * its envelope with that merchant's key.
 *
 * Order of trust:
 *
 *   1. The key that decrypts the envelope. Only the merchant's own key opens
 *      it, so this cannot be asserted by whoever sent the request.
 *   2. A stated merchant id equal to a server-configured MID. A MID is public,
 *      so on its own this is a hint: it narrows which key is tried and which
 *      account an external reference may be asked of, and nothing more.
 *
 * Nothing here is sufficient to settle an order. A local order is always
 * verified with the merchant recorded on the order itself — this result can
 * only withhold that, when it names a different one.
 *
 * Total by contract, like unwrapEnvelope(): never throws, and on any failure
 * returns the payload untouched.
 *
 * @param {Record<string, unknown>} payload - As received
 * @param {{merchant: 1|2, mid: string, key: string}[]} merchants - Configured
 *   merchants, from server configuration only
 * @returns {{payload: Record<string, unknown>, enveloped: boolean, unwrapped: boolean,
 *   merchant: 1|2|null, basis: 'envelope'|'stated_mid'|'none', statedMids: string[],
 *   foreign: boolean, reason?: string}}
 */
export function resolveCallback(payload, merchants = []) {
  const outerMids = statedMerchantIds(payload);
  const named = merchants.filter((entry) => outerMids.includes(String(entry.mid).trim()));
  // A callback naming a MID that is none of ours is another merchant's.
  const foreign = outerMids.length > 0 && named.length === 0;
  const hinted = named.length === 1 ? named[0].merchant : null;

  const base = {
    payload,
    enveloped: false,
    unwrapped: false,
    merchant: hinted,
    basis: hinted ? 'stated_mid' : 'none',
    statedMids: outerMids,
    foreign,
  };

  const envelope = pick(payload, ['response', 'encdata', 'data']);

  if (typeof envelope !== 'string' || envelope.length <= 16) {
    return base;
  }

  if (merchants.length === 0) {
    return { ...base, enveloped: true, reason: 'no key configured' };
  }

  if (foreign) {
    return { ...base, enveloped: true, reason: 'unknown merchant' };
  }

  // A stated MID narrows the candidates; without one, each configured
  // merchant's key is tried and the ciphertext decides.
  const candidates = named.length > 0 ? named : merchants;

  for (const candidate of candidates) {
    const opened = unwrapEnvelope(payload, candidate.key);

    if (!opened.unwrapped) {
      continue;
    }

    // A wrong key occasionally "decrypts" to noise that survives padding
    // removal. When more than one key is in play, the result must also read
    // as a callback before that merchant is believed.
    if (candidates.length > 1 && pick(opened.decoded, RECOGNISED_CALLBACK_KEYS) === undefined) {
      continue;
    }

    return {
      payload: opened.payload,
      enveloped: true,
      unwrapped: true,
      merchant: candidate.merchant,
      basis: 'envelope',
      statedMids: statedMerchantIds(opened.payload),
      foreign: false,
    };
  }

  return { ...base, enveloped: true, reason: 'decrypt failed' };
}

/**
 * The Airpay order id of a callback, in whatever format its owner generated.
 *
 * Unlike extractOrderRef() this is not restricted to Frontiva's own reference
 * format, because it exists for payments that belong to another system. It is
 * therefore never used to look anything up in the database — only to ask
 * Airpay about the order and to label log lines.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string|null}
 */
export function extractGatewayOrderId(payload) {
  const value = pick(payload, ['orderid', 'order_id', 'merchant_order_id', 'transactionid', 'customvar']);

  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const trimmed = String(value).trim();

  return /^[A-Za-z0-9_.-]{4,64}$/.test(trimmed) ? trimmed : null;
}

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
