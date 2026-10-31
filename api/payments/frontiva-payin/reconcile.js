/**
 * POST|GET /api/payments/frontiva-payin/reconcile
 *
 * Settles Frontiva PayIn orders whose customer never came back to /success.
 * There is no PayIn callback, so for those orders this sweep is the only thing
 * that finalises them. Independent of /api/payments/reconcile: it touches only
 * payment_gateway = 'frontiva_payin' rows, and nothing here can reach Airpay,
 * SabPaisa or KKChat.
 *
 * Mandatory `Authorization: Bearer $CRON_SECRET`. No request input is trusted —
 * the order set comes from the database alone. Bounded batch, one check at a
 * time (concurrency 1), a time budget, per-order backoff (listFrontivaPayinDue)
 * and the shared idempotent settlement barrier.
 */
import { confirmFrontivaPayin, listFrontivaPayinDue } from '../../_lib/frontiva-payin-orders.js';
import { isCronAuthorized, json, logEvent } from '../../_lib/http.js';

export const config = { maxDuration: 60 };

const GRACE_MINUTES = 10;
const BATCH_LIMIT = 10;
const TIME_BUDGET_MS = 40_000;

/** @param {Object} [deps] - Injectable I/O, for tests */
export function createHandler(deps = {}) {
  const listDue = deps.listDue || listFrontivaPayinDue;
  const confirm = deps.confirm || confirmFrontivaPayin;

  return async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.setHeader('Allow', 'POST, GET');
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!isCronAuthorized(req)) {
      logEvent('payment.frontiva_payin.reconcile.unauthorized', {});
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    const deadline = Date.now() + TIME_BUDGET_MS;
    const results = { checked: 0, settled: 0, unchanged: 0, errors: 0, deferred: 0 };

    try {
      const due = await listDue({ olderThanMinutes: GRACE_MINUTES, limit: BATCH_LIMIT });

      for (const order of due) {
        if (Date.now() > deadline) {
          results.deferred += 1;
          continue;
        }

        results.checked += 1;

        try {
          const outcome = await confirm(order.order_ref);
          results[outcome.changed ? 'settled' : 'unchanged'] += 1;
        } catch (error) {
          results.errors += 1;
          logEvent('payment.frontiva_payin.reconcile.order_failed', {
            order_ref: order.order_ref,
            kind: error?.isDatabaseError ? 'database' : 'unexpected',
          });
        }
      }

      logEvent('payment.frontiva_payin.reconcile.completed', results);
      json(res, 200, { ok: true, ...results });
    } catch (error) {
      logEvent('payment.frontiva_payin.reconcile.failed', { kind: error?.isDatabaseError ? 'database' : 'unexpected' });
      json(res, 500, { ok: false, error: 'Reconciliation failed' });
    }
  };
}

export default createHandler();
