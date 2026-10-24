/**
 * POST|GET /api/payments/reconcile
 *
 * Sweeps online orders that never resolved — the customer closed the tab, the
 * IPN was lost, Airpay was briefly unreachable — and re-verifies each one
 * against Airpay's Order Confirmation API.
 *
 * SabPaisa orders are swept here too, in their own bounded batch after the
 * Airpay one. SabPaisa has no callback in this deployment, so for a customer
 * who never returns to /success this sweep is the only thing that settles the
 * order. Each is asked through Transaction Enquiry, spaced out per order and
 * within the automatic enquiry budget (see settleOrder()).
 *
 * Authentication is mandatory: `Authorization: Bearer $CRON_SECRET`, compared
 * in constant time. There is no unauthenticated mode, and no request input of
 * any kind is trusted — the order set comes from the database alone.
 *
 * Settlement reuses settleOrder(), so this endpoint cannot reach any state the
 * callback path could not, and cannot double-settle an order.
 */
import { isCronAuthorized, json, logEvent } from '../_lib/http.js';
import { isMissingColumnError, listSabpaisaDue, listUnresolvedOrders, settleOrder } from '../_lib/orders.js';

export const config = { maxDuration: 60 };

/** Grace period before an order is considered stuck rather than in progress. */
const GRACE_MINUTES = 10;

/** Bounded so one invocation cannot fan out without limit. */
const BATCH_LIMIT = 25;

/** SabPaisa's own batch, separate from and in addition to Airpay's. */
const SABPAISA_BATCH_LIMIT = 10;

/** The SabPaisa batch stops starting new checks once this much time is used. */
const SABPAISA_TIME_BUDGET_MS = 40_000;

/**
 * Airpay orders only, so SabPaisa rows cannot take Airpay's places in the
 * batch. Until migrations-sabpaisa.sql has run the payment_gateway column does
 * not exist — and so neither can any SabPaisa order — and the original query is
 * used unchanged.
 */
async function listAirpayOrders() {
  try {
    return await listUnresolvedOrders({ olderThanMinutes: GRACE_MINUTES, limit: BATCH_LIMIT, airpayOnly: true });
  } catch (error) {
    if (!isMissingColumnError(error)) {
      throw error;
    }

    return listUnresolvedOrders({ olderThanMinutes: GRACE_MINUTES, limit: BATCH_LIMIT });
  }
}

/**
 * @param {Object[]} orders
 * @param {{checked: number, settled: number, unchanged: number, errors: number, deferred?: number}} results
 * @param {number|null} deadline - Epoch ms after which no new order is started
 */
async function settleEach(orders, results, deadline = null) {
  for (const order of orders) {
    if (deadline !== null && Date.now() > deadline) {
      results.deferred += 1;
      continue;
    }

    results.checked += 1;

    try {
      const outcome = await settleOrder(order.order_ref);

      if (outcome.changed) {
        results.settled += 1;
      } else {
        results.unchanged += 1;
      }
    } catch (error) {
      results.errors += 1;
      logEvent('payment.reconcile.order_failed', {
        order_ref: order.order_ref,
        kind: error?.isDatabaseError ? 'database' : error?.isConfigError ? 'config' : 'unexpected',
      });
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'POST, GET');
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (!isCronAuthorized(req)) {
    logEvent('payment.reconcile.unauthorized', {});
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  const startedAt = Date.now();

  try {
    const pending = await listAirpayOrders();

    const results = { checked: 0, settled: 0, unchanged: 0, errors: 0 };

    await settleEach(pending, results);

    // Separate from the Airpay batch and run after it, so a SabPaisa problem
    // can neither displace nor delay an Airpay order. Reported on its own; the
    // top-level counts stay the Airpay ones, as before.
    const sabpaisa = { checked: 0, settled: 0, unchanged: 0, errors: 0, deferred: 0 };

    try {
      const due = await listSabpaisaDue({ olderThanMinutes: GRACE_MINUTES, limit: SABPAISA_BATCH_LIMIT });
      await settleEach(due, sabpaisa, startedAt + SABPAISA_TIME_BUDGET_MS);
    } catch (error) {
      // A missing column only means the migration has not run, so there
      // cannot be any SabPaisa order to sweep yet.
      if (!isMissingColumnError(error)) {
        sabpaisa.errors += 1;
        logEvent('payment.reconcile.sabpaisa_failed', {
          kind: error?.isConfigError ? 'config' : error?.isDatabaseError ? 'database' : 'unexpected',
        });
      }
    }

    logEvent('payment.reconcile.completed', { ...results, sabpaisa });

    json(res, 200, { ok: true, ...results, sabpaisa });
  } catch (error) {
    logEvent('payment.reconcile.failed', {
      kind: error?.isConfigError ? 'config' : error?.isDatabaseError ? 'database' : 'unexpected',
    });

    json(res, 500, { ok: false, error: 'Reconciliation failed' });
  }
}
