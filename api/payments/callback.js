/**
 * Airpay Response + IPN endpoint for Frontiva.
 *
 * PUBLIC URL: https://frontiva.online/callback/cpm/arp/collection
 *
 * Airpay MID 366751 is configured with that exact path as BOTH the Response
 * (Success/Failed) URL and the IPN URL, so this one handler serves both. It is
 * reached through the vercel.json rewrite of that path onto this function; the
 * /api prefix is a Vercel filesystem requirement, not a change of the public
 * contract.
 *
 * The callback is evidence and a trigger, never proof. Nothing in the body can
 * mark an order paid: settlement re-verifies with Airpay's Order Confirmation
 * API and compares the confirmed amount against the server-derived order total.
 *
 * The received callback is additionally relayed, verbatim and once, to the
 * client's existing endpoint. That relay is auxiliary: see forwardCallback().
 * Frontiva's own processing below does not consult it and cannot be affected by
 * it in any way.
 */
import {
  dedupeKeyFor,
  extractCallbackFields,
  isBrowserNavigation,
  unwrapEnvelope,
  verifyMerchantId,
  verifySecureHash,
} from '../_lib/callback-payload.js';
import { airpayConfig, siteOrigin } from '../_lib/config.js';
import { encryptionKey, privateKey } from '../_lib/crypto.js';
import { forwardCallback } from '../_lib/forward-callback.js';
import { logEvent, parseBody, readRawBody, redact, redirect } from '../_lib/http.js';
import { recordCallback, settleOrder } from '../_lib/orders.js';

export const config = { maxDuration: 60 };

/**
 * Whether an ap_SecureHash mismatch blocks settlement. Off by default — see the
 * reasoning at the check itself. Turn on once the hash construction has been
 * confirmed against Airpay's merchant integration document.
 */
const ENFORCE_SECURE_HASH = String(process.env.AIRPAY_ENFORCE_SECURE_HASH || '').trim().toLowerCase() === 'true';

/**
 * The AES key for unwrapping an enveloped callback, or null when credentials
 * are unavailable. Never throws: a missing key simply means the envelope is
 * left encoded, which costs us the order reference but nothing else.
 *
 * @returns {string|null}
 */
function encryptionKeyOrNull() {
  try {
    const config = airpayConfig();
    return encryptionKey(config.username, config.password);
  } catch {
    return null;
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

    // Airpay sends this endpoint either a plaintext IPN or an encrypted
    // envelope ({merchant_id, response}). Best effort, never throws: a payload
    // that cannot be decoded passes through untouched.
    const envelope = unwrapEnvelope(received, encryptionKeyOrNull());
    const payload = envelope.payload;

    const fields = extractCallbackFields(payload);
    const dedupeKey = dedupeKeyFor(raw, payload);

    orderRef = fields.orderRef;

    logEvent('airpay.callback.parsed', {
      order_ref: orderRef,
      enveloped: envelope.enveloped,
      unwrapped: envelope.unwrapped,
      // Present only when the envelope could not be decoded.
      reason: envelope.reason,
      transaction_status: fields.transactionStatus,
      has_secure_hash: Boolean(fields.secureHash),
      fields: Object.keys(payload).join(','),
    });

    // Relay every received callback, verbatim. Deliberately placed after
    // parsing only so the log line can carry order_ref: nothing above can
    // prevent it, because unwrapEnvelope() and extractCallbackFields() are
    // total functions that never throw. A null order_ref does not gate it.
    forwarding = forwardCallback({
      raw,
      contentType: String(req.headers['content-type'] || ''),
      orderRef,
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
      logEvent('payment.callback.no_order_ref', { source: isBrowser ? 'browser' : 'ipn' });
      await respond(200, 'OK', null);
      return;
    }

    // --- Integrity checks. These can withhold trust, never grant it. ---
    let blocked = false;

    try {
      const airpay = airpayConfig();

      if (verifyMerchantId(fields, airpay.mid) === 'mismatch') {
        // Not our merchant account, so not ours to act on. This check is exact
        // and is enforced unconditionally.
        logEvent('payment.callback.mid_mismatch', { order_ref: orderRef });
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
      // only the reference and asks Airpay what actually happened.
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
