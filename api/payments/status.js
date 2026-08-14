/**
 * GET /api/payments/status?ref=<order_ref>
 *
 * What the confirmation page reads after an online payment. Keyed on the
 * unguessable order_ref rather than the numeric order id, so orders cannot be
 * enumerated.
 *
 * If the order is still open — the customer beat the callback back to the site
 * — one settlement attempt is made so the page can resolve on first load.
 */
import { allowMethods, json, logEvent } from '../_lib/http.js';
import { ONLINE_PAYMENT_METHOD, findOrderByRef, presentOrder, settleOrder } from '../_lib/orders.js';

export const config = { maxDuration: 60 };

/**
 * States worth one verification attempt on read. `requires_review` is excluded:
 * it means a human needs to look, and re-hitting Airpay on every page refresh
 * would not change that.
 */
const RETRY_ON_READ = new Set(['initiated', 'processing']);

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) {
    return;
  }

  const url = new URL(req.url, 'https://placeholder.invalid');
  const ref = String(url.searchParams.get('ref') || '').trim();

  if (!ref) {
    json(res, 400, { error: 'Missing payment reference.' });
    return;
  }

  try {
    let order = await findOrderByRef(ref);

    if (!order || order.payment_method !== ONLINE_PAYMENT_METHOD) {
      json(res, 404, { error: 'We could not find that order.' });
      return;
    }

    if (RETRY_ON_READ.has(order.payment_status || order.status)) {
      // The customer often beats the IPN back to the site, so one verification
      // is attempted here. Idempotent, and it cannot reach a state the callback
      // path could not.
      const settled = await settleOrder(ref);
      order = settled.order || order;
    }

    json(res, 200, { order: presentOrder(order) });
  } catch (error) {
    logEvent('payment.status.failed', {
      kind: error?.isConfigError ? 'config' : error?.isDatabaseError ? 'database' : 'unexpected',
    });

    json(res, 502, { error: 'We could not load your order right now. Please refresh in a moment.' });
  }
}
