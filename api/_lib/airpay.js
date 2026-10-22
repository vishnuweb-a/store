/**
 * Airpay v4 client: OAuth2, hosted-payment-page payload, and the Order
 * Confirmation call that is the authoritative proof of payment.
 *
 * Credential roles (do not swap these):
 *   AIRPAY_SECRET_KEY -> OAuth2 client_secret
 *   AIRPAY_API_KEY    -> privatekey derivation secret
 *
 * Two merchant accounts are supported. Every network operation here takes the
 * merchant it is for and loads that merchant's credentials alone; nothing is
 * cached between calls, so a token or key cannot cross accounts.
 */
import {
  AIRPAY_OAUTH_URL,
  AIRPAY_PAY_URL,
  AIRPAY_TIMEOUT_MS,
  loadAirpayConfig,
} from './config.js';
import { checksum, decrypt, encrypt, encryptionKey, privateKey } from './crypto.js';
import { fetchWithTimeout, logEvent, scrubSecrets } from './http.js';

/**
 * Headers sent on every Airpay call.
 *
 * The explicit User-Agent matters: Node's fetch sends none by default, and
 * WAFs commonly reject an anonymous client outright with a 403 before the
 * request ever reaches the API.
 */
const AIRPAY_HEADERS = {
  // Airpay reads the envelope as POST form fields, not as a JSON document.
  // Sending JSON produced "403 Forbidden: Access is denied. Parameters are
  // required." — the fields were present but invisible to the server.
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
  'User-Agent': 'Frontiva/1.0 (+https://frontiva.online)',
};

/**
 * Encodes a request envelope the way Airpay expects to receive it.
 *
 * @param {Record<string, string>} envelope
 * @returns {string}
 */
function encodeEnvelope(envelope) {
  return new URLSearchParams(envelope).toString();
}

/**
 * Airpay's Order Confirmation endpoint. Overridable because merchants can be
 * onboarded onto different verification paths; when it cannot be reached, an
 * order is parked for review rather than being marked paid.
 */
const verifyUrl = () =>
  (process.env.AIRPAY_VERIFY_URL || 'https://kraken.airpay.co.in/airpay/pay/v4/api/orderconfirmation/').trim();

class AirpayError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AirpayError';
    this.isAirpayError = true;
    this.detail = detail;
  }
}

/**
 * The OAuth2 request envelope: merchant_id, encdata and checksum only.
 * `privatekey` is deliberately NOT sent here — it belongs to the transactional
 * APIs, which authenticate with the issued token instead.
 *
 * @param {Record<string, string|number>} fields - Plaintext request fields
 * @param {ReturnType<typeof loadAirpayConfig>} config
 * @returns {{merchant_id: string, encdata: string, checksum: string}}
 */
export function buildEnvelope(fields, config) {
  const key = encryptionKey(config.username, config.password);

  return {
    merchant_id: config.mid,
    encdata: encrypt(JSON.stringify(fields), key),
    checksum: checksum(fields),
  };
}

/**
 * The envelope for token-authenticated transactional APIs, which additionally
 * carry the derived privatekey.
 *
 * @param {Record<string, string|number>} fields
 * @param {ReturnType<typeof loadAirpayConfig>} config
 * @returns {{merchant_id: string, encdata: string, checksum: string, privatekey: string}}
 */
export function buildSignedEnvelope(fields, config) {
  return {
    ...buildEnvelope(fields, config),
    privatekey: privateKey(config.apiKey, config.username, config.password),
  };
}

/**
 * Walks a decoded Airpay response for a key at any depth. Airpay nests payloads
 * differently per endpoint, so fields are located rather than assumed.
 *
 * @param {unknown} value
 * @param {string[]} names - Lower-case key names to accept
 * @returns {unknown}
 */
function findField(value, names) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (names.includes(key.toLowerCase()) && entry !== null && entry !== '' && typeof entry !== 'object') {
      return entry;
    }
  }

  for (const entry of Object.values(value)) {
    const found = findField(entry, names);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/**
 * Parses an Airpay response body, transparently decrypting any encdata it
 * carries so callers see one plain object.
 *
 * @param {string} text
 * @param {string} key - encryptionKey()
 * @returns {Record<string, unknown>}
 */
export function parseAirpayResponse(text, key) {
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new AirpayError('Airpay returned an unreadable response');
  }

  if (!payload || typeof payload !== 'object') {
    throw new AirpayError('Airpay returned an unreadable response');
  }

  const encrypted = findField(payload, ['encdata', 'response', 'data']);

  if (typeof encrypted === 'string' && encrypted.length > 16 && !encrypted.trim().startsWith('{')) {
    try {
      const decrypted = JSON.parse(decrypt(encrypted, key));
      return { ...payload, decrypted };
    } catch {
      // Not an encrypted envelope after all — fall through to the raw payload.
    }
  }

  return payload;
}

/**
 * Detects the failure Airpay reports as an apparent success.
 *
 * An OAuth response can carry status_code 200, response_code "00" and
 * status "success" at the top level while `data.success` is false, which means
 * authentication FAILED. The outer fields describe the transport, not the
 * result, so they are never treated as proof.
 *
 * @param {Record<string, unknown>} payload
 * @returns {boolean} true when the inner result explicitly says failure
 */
export function hasInnerFailure(payload) {
  const containers = [payload?.data, payload?.decrypted, payload?.response, payload];

  for (const container of containers) {
    if (!container || typeof container !== 'object') {
      continue;
    }

    const success = container.success;

    if (success === false || success === 'false' || success === 0 || success === '0') {
      return true;
    }
  }

  return false;
}

/**
 * Requests an OAuth2 access token.
 *
 * Authentication is considered successful only when the response contains a
 * usable access_token AND does not carry an inner failure flag. A transport
 * success is not an authentication success.
 *
 * @param {1|2|3} merchant - Whose credentials to authenticate with
 * @returns {Promise<{accessToken: string, expiresIn: number, expiresAt: number}>}
 */
export async function getAccessToken(merchant) {
  const config = loadAirpayConfig(merchant);
  const key = encryptionKey(config.username, config.password);

  const fields = {
    client_id: config.clientId,
    client_secret: config.secretKey,
    merchant_id: config.mid,
    grant_type: 'client_credentials',
  };

  const response = await fetchWithTimeout(
    AIRPAY_OAUTH_URL,
    {
      method: 'POST',
      headers: AIRPAY_HEADERS,
      body: encodeEnvelope(buildEnvelope(fields, config)),
    },
    AIRPAY_TIMEOUT_MS,
  );

  const text = await response.text();

  if (!response.ok) {
    // The body distinguishes causes that all surface as the same status code:
    // a WAF block page, an IP-whitelisting rejection, an unregistered domain,
    // or a genuine credential error. Scrubbed and truncated before logging.
    const snippet = scrubSecrets(text);

    logEvent('airpay.oauth.http_error', {
      merchant: config.merchant,
      status: response.status,
      content_type: response.headers?.get?.('content-type') ?? null,
      body: snippet,
    });

    throw new AirpayError('Airpay authentication failed', `http ${response.status}: ${snippet}`);
  }

  const payload = parseAirpayResponse(text, key);

  if (hasInnerFailure(payload)) {
    // The documented trap: outer status success, inner data.success false.
    logEvent('airpay.oauth.inner_failure', { merchant: config.merchant, status: response.status });
    throw new AirpayError('Airpay authentication failed', 'data.success was false');
  }

  const accessToken = findField(payload, ['access_token', 'accesstoken', 'token']);

  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    // Log the coarse shape only — an OAuth error body can echo credentials back.
    logEvent('airpay.oauth.no_token', {
      merchant: config.merchant,
      status: response.status,
      keys: Object.keys(payload).join(','),
    });
    throw new AirpayError('Airpay authentication failed', 'no access_token in response');
  }

  const rawExpiry = Number(findField(payload, ['expires_in', 'expiresin', 'expiry']));
  // Airpay's reported expiry is used; the fallback applies only when absent.
  const expiresIn = Number.isFinite(rawExpiry) && rawExpiry > 0 ? Math.floor(rawExpiry) : 300;

  return {
    accessToken: accessToken.trim(),
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/**
 * Builds everything the browser needs to hand the customer to Airpay's hosted
 * payment page. The returned fields are already encrypted; no credential and no
 * client-supplied amount appears in them.
 *
 * @param {Object} params
 * @param {string} params.orderRef - Merchant order id
 * @param {number} params.amountInCents - Server-derived amount
 * @param {{fullName: string, phone: string, address: string}} params.customer
 * @param {string} params.returnUrl
 * @param {string} params.accessToken - Issued to the same merchant
 * @param {1|2|3} params.merchant - Whose credentials sign and encrypt the fields
 * @returns {{action: string, fields: Record<string, string>}}
 */
export function buildPaymentRequest({ orderRef, amountInCents, customer, returnUrl, accessToken, merchant }) {
  const config = loadAirpayConfig(merchant);
  const [firstName, ...rest] = customer.fullName.split(/\s+/);

  const fields = {
    orderid: orderRef,
    amount: (amountInCents / 100).toFixed(2),
    currency: '356',
    isocurrency: 'INR',
    buyerFirstName: firstName || customer.fullName,
    buyerLastName: rest.join(' ') || '',
    buyerAddress: customer.address,
    buyerPhone: customer.phone,
    // The storefront does not collect an email; Airpay requires one, so a
    // merchant-owned no-reply mailbox stands in rather than a fabricated
    // customer address.
    buyerEmail: (process.env.AIRPAY_FALLBACK_BUYER_EMAIL || 'orders@frontiva.online').trim(),
    // Echoed back on the callback so the order can be identified.
    customvar: orderRef,
    // Sent for completeness only. Neither the Response URL nor the IPN URL is
    // configurable per transaction — both are MID-level settings registered in
    // the Airpay dashboard, and these fields do not substitute for them.
    successUrl: returnUrl,
    failureUrl: returnUrl,
  };

  return {
    action: `${AIRPAY_PAY_URL}?token=${encodeURIComponent(accessToken)}`,
    fields: buildSignedEnvelope(fields, config),
  };
}

/** Names that can only mean the transaction's own status. */
const TRANSACTION_STATUS_KEYS = ['transaction_status', 'transactionstatus', 'txnstatus'];

/**
 * Reads the transaction status out of an Order Confirmation response.
 *
 * Airpay's responses carry a transport-level `status` ("success", 200) on the
 * outer object, which describes the API call and not the payment. A name that
 * can only mean the transaction is therefore preferred at any depth; the bare
 * `status` is a fallback, and is read from the inner result when there is one
 * so the outer transport field cannot stand in for it.
 *
 * @param {Record<string, unknown>} payload
 * @returns {unknown} undefined when no status can be identified
 */
function findTransactionStatus(payload) {
  const specific = findField(payload, TRANSACTION_STATUS_KEYS);

  if (specific !== undefined) {
    return specific;
  }

  const inner = [payload?.decrypted, payload?.data, payload?.response].find(
    (container) => container && typeof container === 'object',
  );

  return findField(inner || payload, ['status']);
}

/**
 * Asks Airpay what actually happened to an order. This — not the callback and
 * not the browser return — is what settlement is allowed to trust.
 *
 * The question is asked with one merchant's credentials. An order placed on
 * the other merchant is not visible to them, so the wrong merchant yields
 * `verified: false`, never a result.
 *
 * Never throws: an unreachable, unreadable or ambiguous verification is
 * reported as `verified: false`, which the caller turns into requires_review,
 * never paid.
 *
 * @param {string} orderRef
 * @param {1|2|3} merchant - The merchant the order was placed on
 * @returns {Promise<{verified: boolean, status: string|null, amountInCents: number|null, transactionId: string|null, merchant: 1|2|3|null, reason?: string}>}
 */
export async function confirmOrder(orderRef, merchant) {
  const unverified = (reason) => ({
    verified: false,
    status: null,
    amountInCents: null,
    transactionId: null,
    merchant: null,
    reason,
  });

  let payload;
  let config;

  try {
    config = loadAirpayConfig(merchant);

    const key = encryptionKey(config.username, config.password);
    const { accessToken } = await getAccessToken(config.merchant);

    const response = await fetchWithTimeout(
      `${verifyUrl()}?token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: AIRPAY_HEADERS,
        body: encodeEnvelope(buildSignedEnvelope({ merchant_id: config.mid, orderid: orderRef }, config)),
      },
      AIRPAY_TIMEOUT_MS,
    );

    const text = await response.text();

    if (!response.ok) {
      return unverified(`http ${response.status}`);
    }

    payload = parseAirpayResponse(text, key);

    if (hasInnerFailure(payload)) {
      return unverified('confirmation reported an inner failure');
    }
  } catch (error) {
    return unverified(error?.isConfigError ? 'not configured' : 'verification unavailable');
  }

  // A confirmation that names a different order or a different merchant is an
  // answer to some other question. Absent echoes are tolerated; wrong ones
  // are not.
  const echoedOrder = findField(payload, ['orderid', 'order_id', 'merchant_order_id']);

  if (echoedOrder !== undefined && String(echoedOrder).trim() !== String(orderRef).trim()) {
    return unverified('confirmation is for a different order');
  }

  const echoedMid = findField(payload, ['merchant_id', 'mercid', 'merchantid']);

  if (echoedMid !== undefined && String(echoedMid).trim() !== config.mid) {
    return unverified('confirmation is for a different merchant');
  }

  const status = findTransactionStatus(payload);

  if (status === undefined) {
    return unverified('no transaction status in confirmation');
  }

  // Airpay reports the outcome twice. When both are present they must agree
  // before a success is believed; a disagreement is ambiguous, and ambiguous
  // is never paid.
  const paymentStatus = findField(payload, [
    'transaction_payment_status',
    'transactionpaymentstatus',
    'payment_status',
  ]);

  if (
    paymentStatus !== undefined &&
    classifyTransaction(status) === 'success' &&
    classifyTransaction(paymentStatus) !== 'success'
  ) {
    return unverified('conflicting status fields in confirmation');
  }

  const amount = Number(findField(payload, ['amount', 'transaction_amount', 'txnamount']));
  const transactionId = findField(payload, [
    'ap_transactionid',
    'aptransactionid',
    'transactionid',
    'txnid',
  ]);

  return {
    verified: true,
    status: String(status),
    amountInCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    transactionId: transactionId === undefined ? null : String(transactionId),
    merchant: config.merchant,
  };
}

/**
 * Asks Airpay about an order reference that has no local order — a payment
 * that belongs to another system sharing one of these merchant accounts.
 *
 * Read-only by construction: it calls confirmOrder() and nothing else, so it
 * cannot create, settle or alter anything. When the merchant is not known each
 * candidate is asked, and an answer is accepted only if exactly one of them
 * recognises the order.
 *
 * @param {string} orderId - Airpay orderid as received
 * @param {(1|2|3)[]} merchants - Candidates, from server configuration only
 * @param {{confirm?: Function}} [deps] - Injectable I/O, for tests
 * @returns {Promise<Awaited<ReturnType<typeof confirmOrder>>>}
 */
export async function confirmExternalOrder(orderId, merchants, deps = {}) {
  const confirm = deps.confirm || confirmOrder;
  const answers = await Promise.all(merchants.map((merchant) => confirm(orderId, merchant)));
  const verified = answers.filter((answer) => answer.verified);

  if (verified.length === 1) {
    return verified[0];
  }

  return {
    verified: false,
    status: null,
    amountInCents: null,
    transactionId: null,
    merchant: null,
    reason: verified.length > 1 ? 'more than one merchant recognised the order' : 'no merchant confirmed the order',
  };
}

/**
 * Classifies an Airpay transaction status.
 *
 * Anything unrecognised is 'failed' rather than 'success' — an unknown code
 * must never become a payment. INPROCESS is kept distinct from failure so the
 * order stays open for reconciliation instead of being wrongly closed.
 *
 * @param {string|number|null} status
 * @returns {'success'|'pending'|'failed'}
 */
export function classifyTransaction(status) {
  if (status === null || status === undefined) {
    return 'failed';
  }

  const value = String(status).trim().toUpperCase();

  if (value === '200' || value === 'SUCCESS') {
    return 'success';
  }

  if (['INPROCESS', 'IN_PROCESS', 'PENDING', '210', '211'].includes(value)) {
    return 'pending';
  }

  return 'failed';
}

/**
 * @param {string|number|null} status
 * @returns {boolean}
 */
export function isSuccessStatus(status) {
  return classifyTransaction(status) === 'success';
}

export { AirpayError };
