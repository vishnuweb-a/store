/**
 * POST|GET /api/payments/reconcile
 *
 * Sweeps online orders that never resolved — the customer closed the tab, the
 * IPN was lost, Airpay was briefly unreachable — and re-verifies each one
 * against Airpay's Order Confirmation API.
 *
 * Authentication is mandatory: `Authorization: Bearer $CRON_SECRET`, compared
 * in constant time. There is no unauthenticated mode, and no request input of
 * any kind is trusted — the order set comes from the database alone.
 *
 * Settlement reuses settleOrder(), so this endpoint cannot reach any state the
 * callback path could not, and cannot double-settle an order.
 */
import { isCronAuthorized, json, logEvent } from '../_lib/http.js';
import { listUnresolvedOrders, settleOrder } from '../_lib/orders.js';

export const config = { maxDuration: 60 };

/** Grace period before an order is considered stuck rather than in progress. */
const GRACE_MINUTES = 10;

/** Bounded so one invocation cannot fan out without limit. */
const BATCH_LIMIT = 25;

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

  try {
    const pending = await listUnresolvedOrders({
      olderThanMinutes: GRACE_MINUTES,
      limit: BATCH_LIMIT,
    });

    const results = { checked: 0, settled: 0, unchanged: 0, errors: 0 };

    for (const order of pending) {
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

    logEvent('payment.reconcile.completed', results);

    json(res, 200, { ok: true, ...results });
  } catch (error) {
    logEvent('payment.reconcile.failed', {
      kind: error?.isConfigError ? 'config' : error?.isDatabaseError ? 'database' : 'unexpected',
    });

    json(res, 500, { ok: false, error: 'Reconciliation failed' });
  }
}
