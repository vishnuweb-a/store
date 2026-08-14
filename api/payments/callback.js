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
 * There is no forwarding of any kind. Airpay callbacks terminate here.
 */
import {
  dedupeKeyFor,
  extractCallbackFields,
  isBrowserNavigation,
  verifyMerchantId,
  verifySecureHash,
} from '../_lib/callback-payload.js';
import { airpayConfig, siteOrigin } from '../_lib/config.js';
import { privateKey } from '../_lib/crypto.js';
import { logEvent, parseBody, readRawBody, redact, redirect } from '../_lib/http.js';
import { recordCallback, settleOrder } from '../_lib/orders.js';

export const config = { maxDuration: 60 };

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

  /** Answers a browser with the existing success page, and Airpay with plain text. */
  const respond = (statusCode, body, orderRef) => {
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
    const { raw, payload } = await readPayload(req);
    const fields = extractCallbackFields(payload);
    const dedupeKey = dedupeKeyFor(raw, payload);

    orderRef = fields.orderRef;

    logEvent('payment.callback.received', {
      order_ref: orderRef,
      source: isBrowser ? 'browser' : 'ipn',
      method: req.method,
      transaction_status: fields.transactionStatus,
      has_secure_hash: Boolean(fields.secureHash),
      fields: Object.keys(payload).join(','),
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
      respond(200, 'OK', null);
      return;
    }

    // --- Integrity checks. These can withhold trust, never grant it. ---
    let integrityOk = true;

    try {
      const airpay = airpayConfig();
      const midCheck = verifyMerchantId(fields, airpay.mid);

      if (midCheck === 'mismatch') {
        // Not our merchant account. Recorded, never acted on.
        logEvent('payment.callback.mid_mismatch', { order_ref: orderRef });
        integrityOk = false;
      }

      const hashCheck = verifySecureHash(
        payload,
        privateKey(airpay.apiKey, airpay.username, airpay.password),
      );

      if (hashCheck === 'invalid') {
        // Advisory only: a bad hash defers this order to reconciliation rather
        // than settling from an unauthenticated trigger.
        logEvent('payment.callback.secure_hash_invalid', { order_ref: orderRef });
        integrityOk = false;
      }
    } catch (error) {
      // Credentials unavailable: we cannot check integrity, so we do not act on
      // this delivery. Reconciliation will pick the order up.
      logEvent('payment.callback.integrity_unavailable', { order_ref: orderRef });
      integrityOk = false;
    }

    if (!integrityOk) {
      respond(200, 'OK', orderRef);
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

    respond(200, 'OK', orderRef);
  } catch (error) {
    logEvent('payment.callback.error', { kind: error?.isConfigError ? 'config' : 'unexpected' });

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
