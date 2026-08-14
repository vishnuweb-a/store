/**
 * GET|POST /api/payments/return
 *
 * Where Airpay sends the customer's browser back to. This endpoint decides
 * nothing about the payment — it settles (idempotently, against Airpay's own
 * record) and then hands the customer to the existing /success page, which
 * reads the real status from /api/payments/status.
 */
import { extractOrderRef } from '../_lib/callback-payload.js';
import { siteOrigin } from '../_lib/config.js';
import { logEvent, parseBody, readRawBody, redirect } from '../_lib/http.js';
import { settleOrder } from '../_lib/orders.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const origin = siteOrigin(req);
  let orderRef = null;

  try {
    let payload = {};

    if (req.method === 'POST') {
      payload = parseBody(await readRawBody(req), req.headers['content-type']);
    }

    const url = new URL(req.url, 'https://placeholder.invalid');
    // Query parameters are merged in so a GET return works the same way.
    payload = { ...Object.fromEntries(url.searchParams), ...payload };

    orderRef = extractOrderRef(payload);

    if (orderRef) {
      // The customer may well arrive before the server-to-server callback does,
      // so settlement is attempted here too. Both paths are idempotent.
      await settleOrder(orderRef);
    } else {
      logEvent('payment.return.no_order_ref', { method: req.method });
    }
  } catch (error) {
    logEvent('payment.return.error', {
      order_ref: orderRef,
      kind: error?.isConfigError ? 'config' : error?.isDatabaseError ? 'database' : 'unexpected',
    });
    // Fall through: the customer still reaches the storefront, which will show
    // the order's real status rather than a guess made here.
  }

  redirect(res, orderRef ? `${origin}/success?ref=${encodeURIComponent(orderRef)}` : `${origin}/success`);
}
