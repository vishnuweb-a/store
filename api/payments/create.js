/**
 * POST /api/payments/create
 *
 * Starts an online payment. The browser sends only what is being bought and
 * which of the Airpay accounts to pay through; this endpoint prices the
 * order from Supabase, creates a pending order, authenticates with the chosen
 * Airpay merchant, and returns the encrypted form the browser posts to
 * Airpay's hosted payment page.
 *
 * The response contains no credential: the access token is single-use and
 * short-lived, and every other field is already encrypted.
 */
import { buildPaymentRequest, getAccessToken } from '../_lib/airpay.js';
import { callbackPathFor, checkoutMerchants, parseMerchant, siteOrigin } from '../_lib/config.js';
import { allowMethods, json, logEvent, parseBody, readRawBody } from '../_lib/http.js';
import { createPendingOrder } from '../_lib/orders.js';
import { normalizeCustomer, normalizeItems, priceOrder } from '../_lib/pricing.js';

/**
 * Reads the merchant selection out of the request.
 *
 * The browser may only name one of the accounts by number. It is never
 * allowed to supply a MID, a credential or an endpoint, and none is read. An
 * absent selection is merchant 1, so a checkout page cached from before the
 * second account existed keeps working exactly as it did.
 *
 * @param {Record<string, unknown>} body
 * @returns {1|2|3}
 */
function selectMerchant(body) {
  const raw = body.merchant;

  if (raw === undefined || raw === null || raw === '') {
    return 1;
  }

  const merchant = parseMerchant(raw);

  if (!merchant) {
    const error = new Error('Please choose a valid payment option.');
    error.isValidationError = true;
    throw error;
  }

  return merchant;
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) {
    return;
  }

  let orderRef = null;
  let merchant = null;

  try {
    const body = parseBody(await readRawBody(req), req.headers['content-type']);

    // Anything the browser claims about price is ignored — only ids, sizes and
    // quantities are read out of the request.
    const items = normalizeItems(body.items);
    const customer = normalizeCustomer(body.customer);

    merchant = selectMerchant(body);

    if (!checkoutMerchants().includes(merchant)) {
      // Switched off, or not configured. The customer is told to pick another
      // option; the payment is never quietly moved to another account.
      logEvent('payment.create.merchant_unavailable', { merchant });
      json(res, 503, {
        error: 'That payment option is temporarily unavailable. Please choose another payment option.',
        code: 'merchant_unavailable',
      });
      return;
    }

    const { items: pricedItems, totalInCents } = await priceOrder(items);

    // Authenticate BEFORE creating the order. If Airpay is unreachable or the
    // credentials are wrong, the customer simply sees an error and no order is
    // written — rather than an orphaned `initiated` row that reconciliation
    // would later have to park in requires_review for a human to close.
    const { accessToken } = await getAccessToken(merchant);

    const order = await createPendingOrder({ customer, items: pricedItems, totalInCents, merchant });
    orderRef = order.order_ref;

    const payment = buildPaymentRequest({
      orderRef,
      amountInCents: totalInCents,
      customer,
      // The Response URL registered against this merchant's MID in the Airpay
      // dashboard.
      returnUrl: `${siteOrigin(req)}${callbackPathFor(merchant)}`,
      accessToken,
      merchant,
    });

    logEvent('payment.create.ok', { order_ref: orderRef, merchant, amount_in_cents: totalInCents });

    json(res, 200, {
      order_ref: orderRef,
      order_id: order.id,
      total_in_cents: totalInCents,
      action: payment.action,
      fields: payment.fields,
    });
  } catch (error) {
    if (error?.isValidationError) {
      if (error.invalidIndexes) {
        // Positions only — the client maps them back to its own cart lines.
        logEvent('payment.create.unrecognised_items', { count: error.invalidIndexes.length });
      }

      json(res, 400, {
        error: error.message,
        ...(error.invalidIndexes ? { invalid_items: error.invalidIndexes } : {}),
      });
      return;
    }

    if (error?.isConfigError) {
      logEvent('payment.create.misconfigured', { merchant, detail: error.message });
      json(res, 503, { error: 'Online payment is temporarily unavailable. Please choose Cash on Delivery.' });
      return;
    }

    // Airpay/database failures: log a safe diagnostic, tell the customer
    // nothing about our internals, and leave any pending order un-paid.
    const kind = error?.isAirpayError ? 'airpay' : error?.isDatabaseError ? 'database' : 'unexpected';

    logEvent('payment.create.failed', {
      order_ref: orderRef,
      merchant,
      kind,
      detail: error?.isAirpayError ? error.detail : error?.message,
    });

    json(res, 502, {
      error: 'We could not start the online payment. Please try again, or choose Cash on Delivery.',
      // Which subsystem failed, so a failure can be triaged without log access.
      // A category name, never a message, a credential, or a stack trace.
      code: kind,
    });
  }
}
