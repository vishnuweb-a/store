/**
 * Airpay Response + IPN endpoint for Frontiva, for both merchant accounts.
 *
 * PUBLIC URLS (one handler, see CALLBACK_PATHS in config.js):
 *   https://frontiva.online/callback/cpm/arp_frontiva/collection
 *   https://frontiva.online/callback/cpm/arp/collection   (original, kept live)
 *
 * Each Airpay MID registers one of those paths as BOTH its Response
 * (Success/Failed) URL and its IPN URL, so this one handler serves both kinds
 * of traffic for both merchants. It is reached through the vercel.json rewrites
 * of those paths onto this function; the /api prefix is a Vercel filesystem
 * requirement, not a change of the public contract.
 *
 * The callback is evidence and a trigger, never proof. Nothing in the body can
 * mark an order paid: settlement re-verifies with Airpay's Order Confirmation
 * API, using the credentials of the merchant recorded on the order, and
 * compares the confirmed amount against the server-derived order total.
 *
 * The received callback is additionally relayed, verbatim and once, to the
 * client's existing endpoint. That relay is auxiliary: see forwardCallback().
 * Frontiva's own processing below does not consult it and cannot be affected by
 * it in any way. It does not depend on the order existing in Frontiva's
 * database either — a payment that belongs to another system is relayed all the
 * same, and simply has nothing here to settle.
 */
import { confirmExternalOrder } from '../_lib/airpay.js';
import {
  dedupeKeyFor,
  extractCallbackFields,
  extractGatewayOrderId,
  isBrowserNavigation,
  resolveCallback,
  verifyMerchantId,
  verifySecureHash,
} from '../_lib/callback-payload.js';
import { configuredMerchants, loadAirpayConfig, siteOrigin } from '../_lib/config.js';
import { encryptionKey, privateKey } from '../_lib/crypto.js';
import { forwardCallback } from '../_lib/forward-callback.js';
import { logEvent, parseBody, readRawBody, redact, redirect } from '../_lib/http.js';
import { findOrderByRef, merchantForOrder, recordCallback, settleOrder } from '../_lib/orders.js';

export const config = { maxDuration: 60 };

/**
 * Whether an ap_SecureHash mismatch blocks settlement. Off by default — see the
 * reasoning at the check itself. Turn on once the hash construction has been
 * confirmed against Airpay's merchant integration document.
 */
const ENFORCE_SECURE_HASH = String(process.env.AIRPAY_ENFORCE_SECURE_HASH || '').trim().toLowerCase() === 'true';

/**
 * Whether a callback for an order Frontiva does not hold is checked against
 * Airpay's Order Confirmation API. Off by default: the result is only logged,
 * and switching it on makes every such callback cost Airpay API calls.
 */
const verifyExternalEnabled = () =>
  String(process.env.AIRPAY_VERIFY_EXTERNAL_CALLBACKS || '').trim().toLowerCase() === 'true';

/** Upper bound on that check, so it cannot hold the acknowledgement open. */
const EXTERNAL_VERIFY_TIMEOUT_MS = 12_000;

/**
 * The configured merchants with the AES key each one's envelopes are opened
 * with, or an empty list when credentials are unavailable. Never throws: with
 * no keys an envelope is simply left encoded, which costs us the order
 * reference but nothing else.
 *
 * @returns {{merchant: 1|2, mid: string, key: string}[]}
 */
function merchantKeysOrEmpty() {
  try {
    return configuredMerchants().map((merchant) => ({
      merchant: merchant.merchant,
      mid: merchant.mid,
      key: encryptionKey(merchant.username, merchant.password),
    }));
  } catch {
    return [];
  }
}

/**
 * Reads the payload from either a form/JSON POST body or a query string, so the
 * same handler serves the IPN POST and a browser GET landing.
 */
async function readPayload(req) {
  const url = new URL(req.url, 'https://placeholder.invalid');
  const query = Object.fromEntries(url.searchParams);

  if (req.method !== 'POST') {
    return { raw: url.searchParams.toString(), payload: query };
  }

  const raw = await readRawBody(req);
  const body = parseBody(raw, String(req.headers['content-type'] || ''));

  // Body wins over query on conflict; Airpay puts the real data in the body.
  return { raw, payload: { ...query, ...body } };
}

/**
 * Handles a callback for an order Frontiva does not hold: a payment that
 * belongs to another system using one of these merchant accounts.
 *
 * There is nothing local to settle and nothing is written. Optionally the
 * outcome is confirmed with Airpay and logged, so an operator can tell a
 * genuine external payment from noise. The relay to the client has already
 * been started by the caller and does not wait on, or depend on, any of this.
 *
 * @param {Object} params
 * @param {Record<string, unknown>} params.payload - Opened callback fields
 * @param {ReturnType<typeof resolveCallback>|null} params.delivery
 */
async function noteExternalOrder({ payload, delivery }) {
  const externalRef = extractGatewayOrderId(payload);

  logEvent('payment.callback.external_order', {
    external_ref: externalRef,
    merchant: delivery?.merchant ?? null,
    basis: delivery?.basis ?? 'none',
  });

  if (!verifyExternalEnabled() || !externalRef || !delivery || delivery.foreign) {
    return;
  }

  // The merchant the delivery resolved to, or every configured one when it
  // names none. Never a merchant taken from the body on its own say-so.
  const candidates = delivery.merchant
    ? [delivery.merchant]
    : merchantKeysOrEmpty().map((entry) => entry.merchant);

  if (candidates.length === 0) {
    return;
  }

  let timer;

  try {
    const confirmation = await Promise.race([
      confirmExternalOrder(externalRef, candidates),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ verified: false, reason: 'timed out' }), EXTERNAL_VERIFY_TIMEOUT_MS);
      }),
    ]);

    logEvent('payment.callback.external_verified', {
      external_ref: externalRef,
      verified: confirmation.verified,
      merchant: confirmation.merchant ?? null,
      // Airpay's own answer, never the callback's claim.
      status: confirmation.status ?? null,
      amount_in_cents: confirmation.amountInCents ?? null,
      reason: confirmation.reason,
    });
  } catch (error) {
    logEvent('payment.callback.external_verify_failed', { external_ref: externalRef });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, GET');
    res.end('Method not allowed');
    return;
  }

  const isBrowser = isBrowserNavigation(req);
  const origin = siteOrigin(req);

  // The auxiliary relay, started as soon as the body is read. Held here so it
  // can be settled before the response, because a serverless invocation may be
  // frozen the moment it answers. It never rejects, so awaiting it is safe.
  let forwarding = Promise.resolve(null);

  /** Answers a browser with the existing success page, and Airpay with plain text. */
  const respond = async (statusCode, body, orderRef) => {
    // allSettled, not await, so that even a future change making the relay
    // throw could not reach the response path.
    await Promise.allSettled([forwarding]);

    if (isBrowser) {
      redirect(res, orderRef ? `${origin}/success?ref=${encodeURIComponent(orderRef)}` : `${origin}/success`);
      return;
    }

    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  };

  let orderRef = null;

  try {
    const { raw, payload: received } = await readPayload(req);

    logEvent('payment.callback.received', {
      source: isBrowser ? 'browser' : 'ipn',
      method: req.method,
      content_type: String(req.headers['content-type'] || '') || null,
      bytes: String(raw || '').length,
      // Field names only, never values.
      fields: Object.keys(received).join(','),
    });

    // Parsing is contained so that it cannot, under any circumstance, prevent
    // the relay below from starting.
    //
    // These helpers are all written to be total, but "written to be total" is
    // an assumption, not a guarantee — and if any of them ever threw, control
    // would jump to the outer catch with `forwarding` still unassigned. The
    // symptom would be a callback that logs payment.callback.received and then
    // no airpay.callback.forward.start at all. Parsing is a Frontiva concern;
    // the relay must not be able to fail with it.
    let payload = received;
    let fields = {};
    let dedupeKey = null;
    let delivery = null;

    try {
      // Which of the two merchants this delivery belongs to, decided by the
      // key that opens its envelope or, failing that, by a stated MID that
      // matches server configuration.
      delivery = resolveCallback(received, merchantKeysOrEmpty());

      payload = delivery.payload;
      fields = extractCallbackFields(payload);
      dedupeKey = dedupeKeyFor(raw, payload);
      orderRef = fields.orderRef;

      logEvent('airpay.callback.parsed', {
        order_ref: orderRef,
        merchant: delivery.merchant,
        merchant_basis: delivery.basis,
        enveloped: delivery.enveloped,
        unwrapped: delivery.unwrapped,
        // Present only when the envelope could not be decoded.
        reason: delivery.reason,
        transaction_status: fields.transactionStatus,
        has_secure_hash: Boolean(fields.secureHash),
        fields: Object.keys(payload).join(','),
      });
    } catch (error) {
      // Parsing failed. The relay still runs below with the raw received
      // payload; only Frontiva's own settlement is given up on.
      logEvent('airpay.callback.parse_failed', { source: isBrowser ? 'browser' : 'ipn' });
    }

    // Relay every received callback, from either merchant. Reached on every
    // path above — a parse failure cannot skip it, a null order_ref does not
    // gate it, and no database lookup precedes it, so an order Frontiva has
    // never heard of is relayed exactly like one of its own.
    forwarding = forwardCallback({
      // The payload exactly as Airpay sent it, before any unwrapping: an
      // enveloped callback is relayed still enveloped, matching the auth
      // request's data format.
      payload: received,
      raw,
      orderRef,
      // For the log line only; the request to the client is unchanged.
      merchant: delivery?.merchant ?? null,
      incomingHeaders: req.headers,
    });

    // Durable record of the delivery, and the duplicate detector. Stored
    // redacted; a redelivery is a no-op insert on the unique dedupe_key.
    const isFirstDelivery = await recordCallback({
      orderRef,
      dedupeKey,
      payload: redact(payload),
    });

    if (!isFirstDelivery) {
      logEvent('payment.callback.duplicate', { order_ref: orderRef });
    }

    if (!orderRef) {
      // Not one of Frontiva's references, so not one of Frontiva's orders.
      logEvent('payment.callback.no_order_ref', { source: isBrowser ? 'browser' : 'ipn' });
      await noteExternalOrder({ payload, delivery });
      await respond(200, 'OK', null);
      return;
    }

    // The order this callback is about, if Frontiva holds one. Read from the
    // database by reference; nothing else in the body takes part.
    let order = null;

    try {
      order = await findOrderByRef(orderRef);
    } catch (error) {
      // Cannot tell whether the order is ours. Leave it for reconciliation.
      logEvent('payment.callback.settle_failed', { order_ref: orderRef, kind: 'database' });
      await respond(200, 'OK', orderRef);
      return;
    }

    if (!order) {
      // Shaped like our reference but not in our database. Never created here.
      await noteExternalOrder({ payload, delivery });
      await respond(200, 'OK', orderRef);
      return;
    }

    // --- Integrity checks. These can withhold trust, never grant it. ---
    let blocked = false;

    try {
      // The merchant comes from the order row, which only the server writes.
      // The callback does not get to choose whose credentials check it.
      const merchant = merchantForOrder(order);
      const airpay = loadAirpayConfig(merchant);

      const namesAnotherMid = (delivery?.statedMids ?? [fields.merchantId].filter(Boolean)).some(
        (mid) => verifyMerchantId({ merchantId: mid }, airpay.mid) === 'mismatch',
      );
      const openedByAnotherKey = delivery?.basis === 'envelope' && delivery.merchant !== merchant;

      if (namesAnotherMid || openedByAnotherKey) {
        // Not this order's merchant account, so not a delivery to act on. This
        // check is exact and is enforced unconditionally.
        logEvent('payment.callback.mid_mismatch', { order_ref: orderRef, merchant });
        blocked = true;
      }

      const hashCheck = verifySecureHash(
        payload,
        privateKey(airpay.apiKey, airpay.username, airpay.password),
      );

      if (hashCheck === 'invalid') {
        logEvent('payment.callback.secure_hash_invalid', {
          order_ref: orderRef,
          enforced: ENFORCE_SECURE_HASH,
        });

        // Deliberately NOT blocking by default.
        //
        // Two reasons. First, the exact ap_SecureHash construction is not in
        // Airpay's public documentation, so a wrong formula here would reject
        // every genuine callback and strand real payments in reconciliation.
        // Second, the secret it is keyed with (privatekey) is posted from the
        // browser as part of the hosted-page form, so a mismatch is weak
        // evidence of forgery in the first place.
        //
        // Blocking is safe to skip because the hash is not what makes a payment
        // real: settleOrder() ignores this body entirely and re-verifies against
        // Airpay's Order Confirmation API. A forged callback therefore cannot
        // mark anything paid whether or not this check passes.
        //
        // Once the construction is confirmed against the merchant integration
        // document, set AIRPAY_ENFORCE_SECURE_HASH=true to make it blocking.
        if (ENFORCE_SECURE_HASH) {
          blocked = true;
        }
      }
    } catch (error) {
      // Credentials unavailable — settlement would fail anyway. Leave the order
      // open for reconciliation rather than pretending we checked anything.
      logEvent('payment.callback.integrity_unavailable', { order_ref: orderRef });
      blocked = true;
    }

    if (blocked) {
      await respond(200, 'OK', orderRef);
      return;
    }

    try {
      // Idempotent, and independent of everything in the body above: it takes
      // only the reference, resolves the order's own merchant, and asks that
      // merchant's Airpay account what actually happened.
      await settleOrder(orderRef);
    } catch (error) {
      logEvent('payment.callback.settle_failed', {
        order_ref: orderRef,
        kind: error?.isDatabaseError ? 'database' : error?.isConfigError ? 'config' : 'unexpected',
      });
    }

    await respond(200, 'OK', orderRef);
  } catch (error) {
    logEvent('payment.callback.error', { kind: error?.isConfigError ? 'config' : 'unexpected' });

    // Let the relay finish here too, so a failure in our own processing does
    // not silently drop a callback the client was meant to receive.
    await Promise.allSettled([forwarding]);

    if (isBrowser) {
      // Never strand the customer: the success page shows the real status.
      redirect(res, orderRef ? `${origin}/success?ref=${encodeURIComponent(orderRef)}` : `${origin}/success`);
      return;
    }

    // Ask Airpay to redeliver: we could not durably record this one.
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('ERROR');
  }
}
