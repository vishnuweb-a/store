/**
 * POST /api/payments/frontiva-payin/create
 *
 * Starts a Frontiva PayIn payment. The browser sends delivery details, its
 * email, what is being bought and a checkout attempt id. The server prices the
 * order, claims the attempt (one attempt → at most one order and one PayIn),
 * writes the pending order (payment_gateway = 'frontiva_payin'), creates the
 * PayIn and returns only how to launch the payment.
 *
 * Creating a PayIn never marks anything paid: settlement is the status
 * endpoint's alone (settleOrder() → confirmFrontivaPayin), on /success or by
 * reconciliation. There is no PayIn callback and no KKChat forwarding.
 */
import { ConfigError } from '../../_lib/config.js';
import { newOrderRef } from '../../_lib/crypto.js';
import {
  FRONTIVA_PAYIN_GATEWAY,
  FRONTIVA_PAYIN_PAYMENT_MODE,
  createFrontivaPayin,
  fetchFrontivaPayinStatus,
  frontivaPayinAvailable,
  loadFrontivaPayinConfig,
  logFrontivaPayin,
  validateFrontivaAmount,
  validateFrontivaCustomer,
} from '../../_lib/frontiva-payin.js';
import { claimCheckoutAttempt, closeFrontivaOrder, recordTransaction } from '../../_lib/frontiva-payin-orders.js';
import { allowMethods, json, logEvent, parseBody, readRawBody } from '../../_lib/http.js';
import { createPendingOrder } from '../../_lib/orders.js';
import { normalizeCustomer, normalizeItems, priceOrder } from '../../_lib/pricing.js';

export const config = { maxDuration: 60 };

const UNAVAILABLE = {
  error: 'Frontiva PayIn is temporarily unavailable. Please choose another payment option.',
  code: 'frontiva_payin_unavailable',
};

const NOT_STARTED = {
  error: 'We could not start the Frontiva PayIn payment. You have not been charged. Please try again, or choose another payment option.',
  code: 'frontiva_payin_not_started',
};

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {Object} [deps] - Injectable I/O, for tests */
export function createHandler(deps = {}) {
  const price = deps.priceOrder || priceOrder;
  const createOrder = deps.createPendingOrder || createPendingOrder;
  const createPayin = deps.createFrontivaPayin || createFrontivaPayin;
  const fetchStatus = deps.fetchFrontivaPayinStatus || fetchFrontivaPayinStatus;
  const claimAttempt = deps.claimCheckoutAttempt || claimCheckoutAttempt;
  const available = deps.frontivaPayinAvailable || frontivaPayinAvailable;
  const loadConfig = deps.loadFrontivaPayinConfig || loadFrontivaPayinConfig;

  return async function handler(req, res) {
    if (!allowMethods(req, res, ['POST'])) {
      return;
    }

    let orderRef = null;

    try {
      if (!available()) {
        json(res, 503, UNAVAILABLE);
        return;
      }

      const body = parseBody(await readRawBody(req), req.headers['content-type']);
      const attemptId = String(body.attempt_id ?? '');

      if (!ATTEMPT_ID.test(attemptId)) {
        json(res, 400, { error: 'Please refresh the page and try again.', code: 'invalid_attempt' });
        return;
      }

      // Anything the browser claims about price, merchant or gateway is ignored.
      const items = normalizeItems(body.items);
      const customer = normalizeCustomer(body.customer);
      const payinCustomer = validateFrontivaCustomer(customer, body.email);
      const payinConfig = loadConfig();

      const { items: pricedItems, totalInCents } = await price(items);
      const amountInPaise = validateFrontivaAmount(totalInCents);

      orderRef = newOrderRef();

      const claim = await claimAttempt({
        attemptId,
        orderRef,
        amountInPaise,
        paymentMode: FRONTIVA_PAYIN_PAYMENT_MODE,
      });

      if (!claim.claimed) {
        // Same attempt sent twice: never a second order or PayIn.
        logEvent('payment.frontiva_payin.create.duplicate_attempt', { order_ref: claim.orderRef });
        json(res, 409, {
          error: 'This payment is already being processed.',
          code: 'duplicate_attempt',
          order_ref: claim.orderRef,
        });
        return;
      }

      const order = await createOrder({
        customer,
        items: pricedItems,
        totalInCents,
        gateway: FRONTIVA_PAYIN_GATEWAY,
        orderRef,
      });

      const result = await createPayin({ orderRef, amountInPaise, customer: payinCustomer, config: payinConfig });

      if (result.kind === 'rejected' || result.kind === 'auth_failed') {
        // Definitely not created: nothing can be paid against this order.
        logFrontivaPayin('payment.frontiva_payin.create.refused', { order_ref: orderRef, kind: result.kind, reason: result.reason });
        await recordTransaction(orderRef, { create_state: result.kind, last_error: result.reason });
        await closeFrontivaOrder(orderRef, 'failed').catch(() => {});
        json(res, result.kind === 'auth_failed' ? 503 : 502, result.kind === 'auth_failed' ? UNAVAILABLE : NOT_STARTED);
        return;
      }

      if (result.kind === 'ambiguous') {
        // Never re-POST. Ask the status endpoint whether the PayIn exists.
        const lookup = await fetchStatus(orderRef, { config: payinConfig });
        const exists = lookup.outcome === 'answered' && lookup.merchantReference === orderRef;

        logFrontivaPayin('payment.frontiva_payin.create.ambiguous', {
          order_ref: orderRef,
          reason: result.reason,
          lookup: lookup.outcome,
        });

        if (lookup.outcome === 'not_found') {
          // No PayIn exists, and the customer never got a payment link.
          await recordTransaction(orderRef, { create_state: 'not_created', last_error: result.reason });
          await closeFrontivaOrder(orderRef, 'failed').catch(() => {});
        } else {
          // Exists (but we have no launch data) or unknowable: left open for
          // reconciliation; unknowable goes straight to a person.
          await recordTransaction(orderRef, {
            create_state: exists ? 'created_not_launched' : 'ambiguous',
            last_error: result.reason,
            ...(exists && lookup.portalRequestId ? { portal_request_id: lookup.portalRequestId } : {}),
          });

          if (!exists) {
            await closeFrontivaOrder(orderRef, 'requires_review').catch(() => {});
          }
        }

        json(res, 502, NOT_STARTED);
        return;
      }

      await recordTransaction(orderRef, {
        create_state: result.launch ? 'created' : 'created_not_launched',
        portal_request_id: result.portalRequestId,
        portal_merchant_id: result.merchantId,
        provider_status: result.providerStatus,
        // Kept so a refreshed payment page shows the same QR instead of creating another PayIn.
        upi_intent: result.launch ? result.launch.url : null,
      });

      if (!result.launch) {
        // No intent we can safely show (wrong payee, amount, format…). Never
        // shown to the customer; the PayIn stays open and is reconciled to its end.
        logFrontivaPayin('payment.frontiva_payin.create.unsupported_launch', { order_ref: orderRef, reason: result.launchProblem });
        json(res, 502, NOT_STARTED);
        return;
      }

      logEvent('payment.frontiva_payin.create.ok', {
        order_ref: orderRef,
        amount_in_paise: amountInPaise,
        portal_request_id: result.portalRequestId,
        launch_type: result.launch.type,
        callback_needed: result.callbackNeeded,
      });

      json(res, 200, {
        order_ref: orderRef,
        order_id: order.id,
        total_in_cents: totalInCents,
        launch: result.launch,
      });
    } catch (error) {
      if (error?.isValidationError) {
        json(res, 400, {
          error: error.message,
          ...(error.invalidIndexes ? { invalid_items: error.invalidIndexes } : {}),
        });
        return;
      }

      if (error instanceof ConfigError || error?.isConfigError) {
        logEvent('payment.frontiva_payin.create.misconfigured', { detail: error.message });
        json(res, 503, UNAVAILABLE);
        return;
      }

      const kind = error?.isDatabaseError ? 'database' : 'unexpected';
      logEvent('payment.frontiva_payin.create.failed', { order_ref: orderRef, kind });
      json(res, 502, { ...NOT_STARTED, code: kind });
    }
  };
}

export default createHandler();
