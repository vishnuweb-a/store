/**
 * POST /api/payments/create
 *
 * Starts an online payment. The browser sends only what is being bought; this
 * endpoint prices it from Supabase, creates a pending order, authenticates with
 * Airpay, and returns the encrypted form the browser posts to Airpay's hosted
 * payment page.
 *
 * The response contains no credential: the access token is single-use and
 * short-lived, and every other field is already encrypted.
 */
import { buildPaymentRequest, getAccessToken } from '../_lib/airpay.js';
import { CALLBACK_PATH, siteOrigin } from '../_lib/config.js';
import { allowMethods, json, logEvent, parseBody, readRawBody } from '../_lib/http.js';
import { createPendingOrder } from '../_lib/orders.js';
import { normalizeCustomer, normalizeItems, priceOrder } from '../_lib/pricing.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) {
    return;
  }

  let orderRef = null;

  try {
    const body = parseBody(await readRawBody(req), req.headers['content-type']);

    // Anything the browser claims about price is ignored — only ids, sizes and
    // quantities are read out of the request.
    const items = normalizeItems(body.items);
    const customer = normalizeCustomer(body.customer);
    const { items: pricedItems, totalInCents } = await priceOrder(items);

    const order = await createPendingOrder({ customer, items: pricedItems, totalInCents });
    orderRef = order.order_ref;

    const { accessToken } = await getAccessToken();

    const payment = buildPaymentRequest({
      orderRef,
      amountInCents: totalInCents,
      customer,
      // The Response URL registered against MID 366751 in the Airpay dashboard.
      returnUrl: `${siteOrigin(req)}${CALLBACK_PATH}`,
      accessToken,
    });

    logEvent('payment.create.ok', { order_ref: orderRef, amount_in_cents: totalInCents });

    json(res, 200, {
      order_ref: orderRef,
      order_id: order.id,
      total_in_cents: totalInCents,
      action: payment.action,
      fields: payment.fields,
    });
  } catch (error) {
    if (error?.isValidationError) {
      json(res, 400, { error: error.message });
      return;
    }

    if (error?.isConfigError) {
      logEvent('payment.create.misconfigured', { detail: error.message });
      json(res, 503, { error: 'Online payment is temporarily unavailable. Please choose Cash on Delivery.' });
      return;
    }

    // Airpay/database failures: log a safe diagnostic, tell the customer
    // nothing about our internals, and leave any pending order un-paid.
    logEvent('payment.create.failed', {
      order_ref: orderRef,
      kind: error?.isAirpayError ? 'airpay' : error?.isDatabaseError ? 'database' : 'unexpected',
      detail: error?.isAirpayError ? error.detail : undefined,
    });

    json(res, 502, {
      error: 'We could not start the online payment. Please try again, or choose Cash on Delivery.',
    });
  }
}
