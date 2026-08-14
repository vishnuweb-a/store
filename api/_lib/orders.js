/**
 * Online-order lifecycle on top of the existing public.orders table.
 *
 * COD rows are written by the browser (apps/web/src/api/OrdersApi.js) and are
 * never touched by this module. Online rows are distinguished by
 * payment_method = 'Online Payment' and carry an order_ref; every column this
 * module adds is nullable, so existing rows and the COD path are unaffected.
 *
 * `payment_status` is the authoritative online payment state. The pre-existing
 * `status` column is mirrored from it so the admin table keeps rendering.
 */
import { classifyTransaction, confirmOrder } from './airpay.js';
import { newOrderRef } from './crypto.js';
import { logEvent } from './http.js';
import { formatInr } from './pricing.js';
import { insert, select, update } from './supabase.js';

export const ONLINE_PAYMENT_METHOD = 'Online Payment';

/**
 * Payment states an online order may still move out of. A conditional UPDATE
 * filtered on this list is what makes settlement idempotent: once an order
 * reaches `paid` or `failed`, no further transition can apply.
 */
export const OPEN_STATUSES = ['initiated', 'processing', 'requires_review'];

/** States the reconciliation job re-checks with Airpay. */
export const RECONCILABLE_STATUSES = ['initiated', 'processing', 'requires_review'];

/**
 * Creates the pending order that a payment attempt settles against. Written
 * before the customer leaves for Airpay, so any payment can be reconciled back
 * to an order whose authoritative amount we already recorded.
 *
 * @param {Object} params
 * @param {{fullName: string, phone: string, address: string, landmark: string|null}} params.customer
 * @param {Object[]} params.items - Server-priced lines
 * @param {number} params.totalInCents - Server-derived total
 * @returns {Promise<{id: number, order_ref: string, created_at: string}>}
 */
export async function createPendingOrder({ customer, items, totalInCents }) {
  const orderRef = newOrderRef();
  const now = new Date().toISOString();

  const [row] = await insert('orders', {
    customer_name: customer.fullName,
    phone: customer.phone,
    address: customer.address,
    landmark: customer.landmark,
    payment_method: ONLINE_PAYMENT_METHOD,
    status: 'initiated',
    payment_status: 'initiated',
    total: totalInCents / 100,
    items,
    order_ref: orderRef,
    updated_at: now,
  });

  if (!row) {
    throw new Error('Order could not be created');
  }

  return row;
}

/**
 * @param {string} orderRef
 * @returns {Promise<Object|null>}
 */
export async function findOrderByRef(orderRef) {
  const ref = String(orderRef || '').trim();

  // Format-gated before it reaches a PostgREST filter, so a hostile reference
  // from a callback body cannot alter the query.
  if (!/^[A-Z0-9]{8,64}$/.test(ref)) {
    return null;
  }

  const [row] = await select('orders', `select=*&order_ref=eq.${encodeURIComponent(ref)}&limit=1`);

  return row || null;
}

/**
 * Shapes an order row into the object the confirmation page already renders.
 *
 * @param {Object} row
 * @returns {Object}
 */
export function presentOrder(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const totalInCents = Math.round(Number(row.total) * 100);

  return {
    id: row.id,
    order_number: `FRV-${String(row.id).padStart(5, '0')}`,
    order_ref: row.order_ref || null,
    created_at: row.created_at,
    status: row.status,
    payment_status: row.payment_status || row.status,
    payment_method: row.payment_method,
    verified_at: row.verified_at || null,
    customer: {
      full_name: row.customer_name,
      phone: row.phone,
      address: row.address,
      landmark: row.landmark || '',
    },
    items,
    total_in_cents: totalInCents,
    total_formatted: formatInr(totalInCents),
  };
}

/**
 * Decides the next payment state from an Airpay Order Confirmation result.
 *
 * Extracted so the decision table is testable on its own and readable in one
 * place. The only route to `paid` is: Airpay was reached, Airpay said the
 * transaction succeeded, and the amount Airpay confirmed equals the amount we
 * created the order with.
 *
 * @param {Object} confirmation - Result of confirmOrder()
 * @param {number} expectedInCents - The server-derived order amount
 * @returns {{status: string, reason: string}}
 */
export function decideSettlement(confirmation, expectedInCents) {
  if (!confirmation.verified) {
    // Airpay could not be asked, so nothing is provable either way. Never a
    // reason to mark paid, and never a reason to mark failed.
    return { status: 'requires_review', reason: confirmation.reason || 'verification unavailable' };
  }

  const outcome = classifyTransaction(confirmation.status);

  if (outcome === 'pending') {
    // INPROCESS / PENDING — the transaction has not resolved at Airpay yet.
    // Stays open so reconciliation re-checks it.
    return { status: 'processing', reason: 'transaction still in process at Airpay' };
  }

  if (outcome === 'failed') {
    return { status: 'failed', reason: 'transaction not successful' };
  }

  if (confirmation.amountInCents === null) {
    return { status: 'requires_review', reason: 'no amount in confirmation' };
  }

  if (confirmation.amountInCents !== expectedInCents) {
    return { status: 'requires_review', reason: 'amount mismatch' };
  }

  return { status: 'paid', reason: 'verified' };
}

/**
 * Settles an online order against Airpay's own record of the transaction.
 *
 * Idempotent by construction:
 *   - an order already in a terminal state is returned untouched;
 *   - the transition is a conditional UPDATE filtered on the open statuses, so
 *     two concurrent callbacks cannot both apply it — the loser updates zero
 *     rows and reports no change.
 *
 * @param {string} orderRef
 * @param {{findOrder?: Function, confirm?: Function, applyUpdate?: Function}} [deps] - Injectable I/O, for tests
 * @returns {Promise<{order: Object|null, status: string, changed: boolean, reason?: string}>}
 */
export async function settleOrder(orderRef, deps = {}) {
  const findOrder = deps.findOrder || findOrderByRef;
  const confirm = deps.confirm || confirmOrder;
  const applyUpdate = deps.applyUpdate || update;

  const order = await findOrder(orderRef);

  if (!order) {
    return { order: null, status: 'unknown', changed: false };
  }

  if (order.payment_method !== ONLINE_PAYMENT_METHOD) {
    // A payment callback must never be able to rewrite a Cash on Delivery order.
    logEvent('payment.settle.wrong_method', { order_ref: orderRef });
    return { order, status: order.status, changed: false };
  }

  const current = order.payment_status || order.status;

  if (!OPEN_STATUSES.includes(current)) {
    return { order, status: current, changed: false };
  }

  const expectedInCents = Math.round(Number(order.total) * 100);
  const confirmation = await confirm(orderRef);
  const decision = decideSettlement(confirmation, expectedInCents);

  if (decision.status !== 'paid') {
    logEvent('payment.settle.not_paid', {
      order_ref: orderRef,
      decided: decision.status,
      reason: decision.reason,
      // Amounts are not secrets and are what an operator needs to triage.
      expected_in_cents: expectedInCents,
      confirmed_in_cents: confirmation.amountInCents ?? null,
    });
  }

  if (decision.status === current) {
    return { order, status: current, changed: false, reason: decision.reason };
  }

  const patch = {
    payment_status: decision.status,
    // Mirrored so the existing admin table keeps showing a meaningful state.
    status: decision.status,
    updated_at: new Date().toISOString(),
  };

  if (confirmation.verified) {
    patch.verified_at = new Date().toISOString();
  }

  if (decision.status === 'paid') {
    patch.paid_at = new Date().toISOString();
  }

  if (confirmation.transactionId) {
    patch.airpay_transaction_id = confirmation.transactionId;
  }

  // Conditional on the order still being open. This is the idempotency barrier.
  const updated = await applyUpdate(
    'orders',
    `order_ref=eq.${encodeURIComponent(orderRef)}&payment_status=in.(${OPEN_STATUSES.join(',')})`,
    patch,
  );

  if (updated.length === 0) {
    const latest = await findOrder(orderRef);
    return {
      order: latest,
      status: latest?.payment_status ?? latest?.status ?? current,
      changed: false,
      reason: 'already settled by a concurrent delivery',
    };
  }

  logEvent('payment.settle.applied', { order_ref: orderRef, status: decision.status });

  return { order: updated[0], status: decision.status, changed: true, reason: decision.reason };
}

/**
 * Records a callback delivery for audit and duplicate detection. The unique
 * index on payment_events.dedupe_key makes a redelivery a no-op insert.
 *
 * @param {Object} params
 * @param {string|null} params.orderRef
 * @param {string} params.dedupeKey
 * @param {Record<string, unknown>} params.payload - Already redacted
 * @returns {Promise<boolean>} true when this delivery was seen for the first time
 */
export async function recordCallback({ orderRef, dedupeKey, payload }) {
  try {
    const rows = await insert(
      'payment_events',
      { order_ref: orderRef, dedupe_key: dedupeKey, payload },
      { onConflict: 'dedupe_key', ignoreDuplicates: true },
    );

    return rows.length > 0;
  } catch (error) {
    // Audit must never block settlement, which is idempotent anyway.
    logEvent('payment.callback.audit_failed', { order_ref: orderRef });
    return true;
  }
}

/**
 * Lists online orders that are still unresolved, oldest first, for the
 * reconciliation job. Bounded so one run cannot fan out without limit.
 *
 * @param {Object} [options]
 * @param {number} [options.olderThanMinutes] - Grace period before an order is
 *   considered stuck; a customer may still be on the Airpay page.
 * @param {number} [options.limit]
 * @returns {Promise<Object[]>}
 */
export async function listUnresolvedOrders({ olderThanMinutes = 10, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();

  return select(
    'orders',
    `select=order_ref,status,payment_status,created_at` +
      `&payment_method=eq.${encodeURIComponent(ONLINE_PAYMENT_METHOD)}` +
      `&payment_status=in.(${RECONCILABLE_STATUSES.join(',')})` +
      `&order_ref=not.is.null` +
      `&created_at=lt.${encodeURIComponent(cutoff)}` +
      `&order=created_at.asc&limit=${Number(limit)}`,
  );
}
