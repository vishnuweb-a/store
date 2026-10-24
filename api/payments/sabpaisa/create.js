/**
 * POST /api/payments/sabpaisa/create
 *
 * Starts a SabPaisa PG 3.0 payment. The browser sends only the customer's
 * delivery details and what is being bought; this endpoint prices the order
 * from Supabase, writes the pending order (payment_gateway = 'sabpaisa'),
 * creates a payment session on SabPaisa's production API, and returns the
 * hosted-checkout URL the browser is sent to.
 *
 * Creating a session never marks anything paid. The order is settled later,
 * only from SabPaisa's Transaction Enquiry API (see settleOrder()), when the
 * customer reaches /success or when reconciliation runs. There is no SabPaisa
 * callback endpoint.
 *
 * The response carries the checkout URL with its clientSecret, which the
 * browser needs to open the checkout. It is never logged or stored.
 */
import {
  SABPAISA_GATEWAY,
  loadSabpaisaConfig,
  sabpaisaAvailable,
  sabpaisaBuyerEmail,
  sabpaisaReturnOrigin,
} from '../../_lib/config.js';
import { allowMethods, json, logEvent, parseBody, readRawBody } from '../../_lib/http.js';
import { OPEN_STATUSES, createPendingOrder } from '../../_lib/orders.js';
import { normalizeCustomer, normalizeItems, priceOrder } from '../../_lib/pricing.js';
import {
  createSabpaisaPayment,
  logSabpaisa,
  validateSabpaisaAmount,
  validateSabpaisaCustomer,
} from '../../_lib/sabpaisa.js';
import { update } from '../../_lib/supabase.js';

export const config = { maxDuration: 60 };

const orderFilter = (orderRef) =>
  `order_ref=eq.${encodeURIComponent(orderRef)}&payment_gateway=eq.${SABPAISA_GATEWAY}` +
  `&payment_status=in.(${OPEN_STATUSES.join(',')})`;

/**
 * @param {Object} [deps] - Injectable I/O, for tests
 */
export function createHandler(deps = {}) {
  const price = deps.priceOrder || priceOrder;
  const createOrder = deps.createPendingOrder || createPendingOrder;
  const createPayment = deps.createSabpaisaPayment || createSabpaisaPayment;
  const applyUpdate = deps.applyUpdate || update;
  const available = deps.sabpaisaAvailable || sabpaisaAvailable;
  const loadConfig = deps.loadSabpaisaConfig || loadSabpaisaConfig;

  return async function handler(req, res) {
    if (!allowMethods(req, res, ['POST'])) {
      return;
    }

    let orderRef = null;

    try {
      if (!available()) {
        logEvent('payment.sabpaisa.create.unavailable', {});
        json(res, 503, {
          error: 'SabPaisa is temporarily unavailable. Please choose another payment option.',
          code: 'sabpaisa_unavailable',
        });
        return;
      }

      const body = parseBody(await readRawBody(req), req.headers['content-type']);

      // Anything the browser claims about price is ignored.
      const items = normalizeItems(body.items);
      const customer = normalizeCustomer(body.customer);
      const sabpaisaCustomer = validateSabpaisaCustomer(customer, sabpaisaBuyerEmail());
      const sabpaisa = loadConfig();

      const { items: pricedItems, totalInCents } = await price(items);

      // totalInCents is already integer paise for INR — sent as is, never
      // multiplied again.
      const amountInPaise = validateSabpaisaAmount(totalInCents);

      const order = await createOrder({ customer, items: pricedItems, totalInCents, gateway: SABPAISA_GATEWAY });
      orderRef = order.order_ref;

      const result = await createPayment({
        orderRef,
        amountInPaise,
        customer: sabpaisaCustomer,
        returnUrl: `${sabpaisaReturnOrigin()}/success?ref=${encodeURIComponent(orderRef)}`,
        config: sabpaisa,
      });

      if (result.kind === 'rejected') {
        // SabPaisa definitely refused: no session exists, so nothing can be
        // paid against this order. Closed so reconciliation does not chase it.
        logSabpaisa('payment.sabpaisa.create.rejected', {
          order_ref: orderRef,
          http_status: result.httpStatus,
          code: result.code,
          trace_id: result.traceId,
        });

        await applyUpdate('orders', orderFilter(orderRef), {
          payment_status: 'failed',
          status: 'failed',
          updated_at: new Date().toISOString(),
        }).catch(() => {
          // Left initiated; reconciliation will find nothing and park it.
        });

        json(res, 502, {
          error: 'We could not start the SabPaisa payment. Please try again, or choose another payment option.',
          code: 'sabpaisa_rejected',
        });
        return;
      }

      if (result.kind === 'ambiguous') {
        // A session may exist. The order is left open for enquiry to resolve,
        // and is never re-sent under the same reference. The customer was not
        // sent to the checkout, so they cannot have paid on it.
        logSabpaisa('payment.sabpaisa.create.ambiguous', {
          order_ref: orderRef,
          reason: result.reason,
          http_status: result.httpStatus ?? null,
          code: result.code ?? null,
          trace_id: result.traceId ?? null,
        });

        json(res, 502, {
          error:
            'We could not start the SabPaisa payment. You have not been charged. Please try again, or choose another payment option.',
          code: 'sabpaisa_unconfirmed',
        });
        return;
      }

      if (result.paymentId) {
        // Diagnostic only; settlement keys on order_ref. A failed write does
        // not stop the customer from paying.
        await applyUpdate('orders', orderFilter(orderRef), { gateway_payment_id: result.paymentId }).catch(() => {
          logEvent('payment.sabpaisa.create.payment_id_not_saved', { order_ref: orderRef });
        });
      }

      logEvent('payment.sabpaisa.create.ok', {
        order_ref: orderRef,
        amount_in_paise: amountInPaise,
        payment_id: result.paymentId,
        trace_id: result.traceId,
      });

      json(res, 200, {
        order_ref: orderRef,
        order_id: order.id,
        total_in_cents: totalInCents,
        redirect_url: result.redirectUrl,
        expires_at: result.expiresAt,
      });
    } catch (error) {
      if (error?.isValidationError) {
        if (error.invalidIndexes) {
          logEvent('payment.sabpaisa.create.unrecognised_items', { count: error.invalidIndexes.length });
        }

        json(res, 400, {
          error: error.message,
          ...(error.invalidIndexes ? { invalid_items: error.invalidIndexes } : {}),
        });
        return;
      }

      if (error?.isConfigError) {
        logEvent('payment.sabpaisa.create.misconfigured', { detail: error.message });
        json(res, 503, {
          error: 'SabPaisa is temporarily unavailable. Please choose another payment option.',
          code: 'sabpaisa_unavailable',
        });
        return;
      }

      const kind = error?.isDatabaseError ? 'database' : 'unexpected';

      logEvent('payment.sabpaisa.create.failed', { order_ref: orderRef, kind });

      json(res, 502, {
        error: 'We could not start the SabPaisa payment. Please try again, or choose another payment option.',
        code: kind,
      });
    }
  };
}

export default createHandler();
