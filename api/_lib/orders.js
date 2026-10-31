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
import { SABPAISA_GATEWAY, loadSabpaisaConfig, parseMerchant } from './config.js';
import { newOrderRef } from './crypto.js';
import { FRONTIVA_PAYIN_GATEWAY } from './frontiva-payin.js';
import { settleFrontivaPayinOrder } from './frontiva-payin-orders.js';
import { logEvent } from './http.js';
import { formatInr } from './pricing.js';
import { confirmSabpaisaOrder, decideSabpaisaSettlement, logSabpaisa } from './sabpaisa.js';
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
 * @param {1|2|3} [params.merchant] - Airpay merchant the payment is started on
 * @param {'sabpaisa'|'frontiva_payin'} [params.gateway] - Set only for a non-Airpay payment.
 *   Absent means Airpay, and the insert is exactly the one Airpay has always made.
 * @param {string} [params.orderRef] - Pre-generated reference (Frontiva PayIn claims its attempt first)
 * @returns {Promise<{id: number, order_ref: string, created_at: string}>}
 */
export async function createPendingOrder({ customer, items, totalInCents, merchant = 1, gateway, orderRef: givenRef }) {
  const orderRef = gateway !== undefined && givenRef ? givenRef : newOrderRef();
  const now = new Date().toISOString();

  if (gateway !== undefined) {
    return createPendingGatewayOrder({ customer, items, totalInCents, gateway, orderRef, now });
  }

  const id = parseMerchant(merchant);

  if (!id) {
    throw new Error('Order could not be created');
  }

  const [row] = await insert('orders', {
    // Written for every merchant but 1. A null airpay_merchant means merchant
    // 1, which is what every order placed before the second account existed
    // already carries — and it keeps merchant 1's insert identical to the one
    // in production, so it does not depend on the new column existing.
    ...(id !== 1 ? { airpay_merchant: id } : {}),
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
 * The pending-order insert for a non-Airpay gateway. Kept apart from the Airpay
 * insert above so that one stays byte-for-byte what production has run. Never
 * names airpay_merchant: a SabPaisa order belongs to no Airpay account.
 */
async function createPendingGatewayOrder({ customer, items, totalInCents, gateway, orderRef, now }) {
  if (gateway !== SABPAISA_GATEWAY && gateway !== FRONTIVA_PAYIN_GATEWAY) {
    throw new Error('Order could not be created');
  }

  const [row] = await insert('orders', {
    payment_gateway: gateway,
    enquiry_count: 0,
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
  // from a callback body cannot alter the query. Matches newOrderRef().
  if (!/^FRV[A-Z0-9]{5,61}$/.test(ref)) {
    return null;
  }

  const [row] = await select('orders', `select=*&order_ref=eq.${encodeURIComponent(ref)}&limit=1`);

  return row || null;
}

/**
 * The Airpay merchant an order was placed on, read from the server-written
 * airpay_merchant column. Null (every order that predates the second account,
 * and every merchant-1 order since) is merchant 1.
 *
 * A value that is present but is not a known merchant is not guessed at: null
 * is returned and the caller refuses to settle.
 *
 * @param {Object} order
 * @returns {1|2|3|null}
 */
export function merchantForOrder(order) {
  const stored = order?.airpay_merchant;

  if (stored === null || stored === undefined) {
    return 1;
  }

  return parseMerchant(stored);
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
    // Which online gateway, so the confirmation page knows whether to poll.
    // Null for Airpay and COD, as stored.
    payment_gateway: row.payment_gateway || null,
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

  // Provider dispatch. The gateway is read from the server-written order row,
  // never from a callback or request, so an Airpay callback naming a SabPaisa
  // order can only ever trigger a SabPaisa enquiry about it.
  const gateway = order.payment_gateway ?? null;

  if (gateway === SABPAISA_GATEWAY) {
    return settleViaSabpaisa(order, deps);
  }

  if (gateway === FRONTIVA_PAYIN_GATEWAY) {
    // Portal status endpoint only; never Airpay, never KKChat.
    return settleFrontivaPayinOrder(order, deps);
  }

  if (gateway !== null && gateway !== 'airpay') {
    logEvent('payment.settle.unknown_gateway', { order_ref: orderRef });
    return { order, status: current, changed: false, reason: 'unknown gateway' };
  }

  // NULL (and 'airpay') is the original Airpay path, unchanged below.
  const merchant = merchantForOrder(order);

  if (!merchant) {
    // The order names a merchant this code does not know. Asking the wrong
    // account would prove nothing, so nothing is asked and nothing changes.
    logEvent('payment.settle.unknown_merchant', { order_ref: orderRef });
    return { order, status: current, changed: false, reason: 'unknown merchant' };
  }

  const expectedInCents = Math.round(Number(order.total) * 100);
  // Asked of the merchant the order was placed on, and no other.
  const confirmation = await confirm(orderRef, merchant);
  const decision = decideSettlement(confirmation, expectedInCents);

  if (decision.status !== 'paid') {
    logEvent('payment.settle.not_paid', {
      order_ref: orderRef,
      merchant,
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
  //
  // The null branch matters: an online order written before payment_status
  // existed carries only `status`, and `payment_status IN (...)` never matches
  // NULL in SQL — without it such an order could never settle at all. It stays
  // safe because order_ref is null on every COD row, so this filter cannot
  // reach one.
  const updated = await applyUpdate(
    'orders',
    `order_ref=eq.${encodeURIComponent(orderRef)}` +
      `&or=(payment_status.in.(${OPEN_STATUSES.join(',')}),payment_status.is.null)`,
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

  logEvent('payment.settle.applied', { order_ref: orderRef, merchant, status: decision.status });

  return { order: updated[0], status: decision.status, changed: true, reason: decision.reason };
}

/**
 * SabPaisa enquiry policy. SabPaisa allows 100 status polls per payment; the
 * automatic paths (confirmation page + reconciliation) stop at
 * SABPAISA_AUTO_ENQUIRY_BUDGET so the rest stays available to an operator.
 */
export const SABPAISA_AUTO_ENQUIRY_BUDGET = 60;

/** Minimum gap between two enquiries about one order, from any caller. */
export const SABPAISA_MIN_ENQUIRY_INTERVAL_MS = 8_000;

/**
 * How long a SabPaisa order may stay unresolved (not found, provider
 * unreachable) before it is parked in requires_review for a person. It is still
 * re-checked by reconciliation afterwards, so a late success is not lost.
 */
export const SABPAISA_REVIEW_AFTER_MS = 2 * 60 * 60_000;

/**
 * Claims the right to make one enquiry about an order. A conditional UPDATE
 * that only matches while the order is open, its enquiry count is still what
 * we read, and the last enquiry is old enough — so concurrent page loads and
 * reconciliation runs cannot both spend an enquiry, and the count is exact.
 *
 * @returns {Promise<boolean>} true when this caller may enquire
 */
async function claimSabpaisaEnquiry(order, { applyUpdate, now, minIntervalMs }) {
  const count = Number.isSafeInteger(order.enquiry_count) ? order.enquiry_count : 0;
  const cutoff = new Date(now - minIntervalMs).toISOString();

  const claimed = await applyUpdate(
    'orders',
    `order_ref=eq.${encodeURIComponent(order.order_ref)}` +
      `&payment_gateway=eq.${SABPAISA_GATEWAY}` +
      `&payment_status=in.(${OPEN_STATUSES.join(',')})` +
      (Number.isSafeInteger(order.enquiry_count) ? `&enquiry_count=eq.${count}` : '&enquiry_count=is.null') +
      `&or=(last_checked_at.is.null,last_checked_at.lt.${encodeURIComponent(cutoff)})`,
    { enquiry_count: count + 1, last_checked_at: new Date(now).toISOString() },
  );

  return claimed.length > 0;
}

/**
 * settleOrder() for an order placed through SabPaisa. Same contract and the
 * same conditional-UPDATE idempotency barrier as the Airpay path; the evidence
 * is SabPaisa's Transaction Enquiry answer and nothing else.
 */
async function settleViaSabpaisa(order, deps) {
  const orderRef = order.order_ref;
  const current = order.payment_status || order.status;
  const findOrder = deps.findOrder || findOrderByRef;
  const applyUpdate = deps.applyUpdate || update;
  const enquire = deps.sabpaisaConfirm || confirmSabpaisaOrder;
  const now = (deps.now || Date.now)();
  const count = Number.isSafeInteger(order.enquiry_count) ? order.enquiry_count : 0;
  const pastReviewWindow = now - Date.parse(order.created_at) > SABPAISA_REVIEW_AFTER_MS;

  if (count >= SABPAISA_AUTO_ENQUIRY_BUDGET) {
    // The automatic budget is spent. Park it for a person rather than keep
    // asking — and never decide failure from silence.
    return parkForReview(order, 'enquiry budget exhausted', { applyUpdate, findOrder, now });
  }

  const claimEnquiry = deps.claimEnquiry || claimSabpaisaEnquiry;
  const claimed = await claimEnquiry(order, {
    applyUpdate,
    now,
    minIntervalMs: deps.minEnquiryIntervalMs ?? SABPAISA_MIN_ENQUIRY_INTERVAL_MS,
  });

  if (!claimed) {
    // Checked moments ago, or being checked right now by another caller.
    return { order, status: current, changed: false, reason: 'enquiry throttled' };
  }

  let config = null;

  try {
    config = deps.sabpaisaConfig || loadSabpaisaConfig();
  } catch {
    // Reported by the enquiry as not_configured.
  }

  const expectedInPaise = Math.round(Number(order.total) * 100);
  const enquiry = await enquire(orderRef, config ? { config } : {});
  const decision = decideSabpaisaSettlement(enquiry, { orderRef, expectedInPaise, config, pastReviewWindow });

  if (decision.status !== 'paid') {
    logSabpaisa('payment.settle.sabpaisa_not_paid', {
      order_ref: orderRef,
      decided: decision.status,
      reason: decision.reason,
      outcome: enquiry.outcome,
      provider_status: enquiry.status ?? null,
      http_status: enquiry.httpStatus ?? null,
      trace_id: enquiry.traceId ?? null,
      expected_in_paise: expectedInPaise,
      confirmed_in_paise: enquiry.amountPaise ?? null,
      enquiry_count: count + 1,
    });
  }

  if (decision.status === null || decision.status === current) {
    return { order: (await findOrder(orderRef)) || order, status: current, changed: false, reason: decision.reason };
  }

  const stamp = new Date(now).toISOString();
  const patch = { payment_status: decision.status, status: decision.status, updated_at: stamp };

  if (enquiry.outcome === 'answered') {
    patch.verified_at = stamp;
  }

  if (decision.status === 'paid') {
    patch.paid_at = stamp;
  }

  if (enquiry.outcome === 'answered' && enquiry.merchantTxnId === orderRef && enquiry.txnId) {
    patch.gateway_txn_id = enquiry.txnId;
  }

  return applySabpaisaTransition(orderRef, patch, { applyUpdate, findOrder, current, reason: decision.reason });
}

async function parkForReview(order, reason, { applyUpdate, findOrder, now }) {
  const current = order.payment_status || order.status;

  if (current === 'requires_review') {
    return { order, status: current, changed: false, reason };
  }

  logEvent('payment.settle.sabpaisa_review', { order_ref: order.order_ref, reason });

  return applySabpaisaTransition(
    order.order_ref,
    { payment_status: 'requires_review', status: 'requires_review', updated_at: new Date(now).toISOString() },
    { applyUpdate, findOrder, current, reason },
  );
}

/** The SabPaisa idempotency barrier: only an order that is still open moves. */
async function applySabpaisaTransition(orderRef, patch, { applyUpdate, findOrder, current, reason }) {
  const updated = await applyUpdate(
    'orders',
    `order_ref=eq.${encodeURIComponent(orderRef)}` +
      `&payment_gateway=eq.${SABPAISA_GATEWAY}` +
      `&payment_status=in.(${OPEN_STATUSES.join(',')})`,
    patch,
  );

  if (updated.length === 0) {
    const latest = await findOrder(orderRef);
    return {
      order: latest,
      status: latest?.payment_status ?? latest?.status ?? current,
      changed: false,
      reason: 'already settled by a concurrent check',
    };
  }

  logEvent('payment.settle.applied', { order_ref: orderRef, gateway: SABPAISA_GATEWAY, status: patch.payment_status });

  return { order: updated[0], status: patch.payment_status, changed: true, reason };
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
 * @param {boolean} [options.airpayOnly] - Leave SabPaisa orders out, so they
 *   cannot take Airpay's places in a bounded batch. Needs the payment_gateway
 *   column (migrations-sabpaisa.sql).
 * @returns {Promise<Object[]>}
 */
export async function listUnresolvedOrders({ olderThanMinutes = 10, limit = 50, airpayOnly = false } = {}) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();

  return select(
    'orders',
    `select=order_ref,status,payment_status,created_at` +
      `&payment_method=eq.${encodeURIComponent(ONLINE_PAYMENT_METHOD)}` +
      // Includes payment_status IS NULL so orders written before the column
      // existed are swept too, rather than being stuck open forever.
      `&or=(payment_status.in.(${RECONCILABLE_STATUSES.join(',')}),payment_status.is.null)` +
      // NULL is Airpay; `neq` alone would drop NULL rows in SQL.
      (airpayOnly ? `&and=(or(payment_gateway.is.null,payment_gateway.eq.airpay))` : '') +
      `&order_ref=not.is.null` +
      `&created_at=lt.${encodeURIComponent(cutoff)}` +
      `&order=created_at.asc&limit=${Number(limit)}`,
  );
}

/**
 * Whether a database error is PostgREST saying a column does not exist —
 * i.e. migrations-sabpaisa.sql has not been run yet.
 *
 * @param {Error & {status?: number}} error
 * @returns {boolean}
 */
export function isMissingColumnError(error) {
  return Boolean(error?.isDatabaseError) && /column|schema cache/i.test(String(error.message || ''));
}

/** Reconciliation spacing for one SabPaisa order: frequent at first, then hourly. */
export function sabpaisaRecheckIntervalMs(enquiryCount) {
  return Number(enquiryCount) < 20 ? 10 * 60_000 : 60 * 60_000;
}

/**
 * SabPaisa orders reconciliation should ask about now: open, past the grace
 * period, and not checked within their recheck interval, least recently checked
 * first. Rows whose automatic budget is spent are still listed until they have
 * been parked in requires_review. Its own bounded query, so it never displaces
 * Airpay orders.
 *
 * @param {{olderThanMinutes?: number, limit?: number, now?: number}} [options]
 * @returns {Promise<Object[]>}
 */
export async function listSabpaisaDue({ olderThanMinutes = 10, limit = 10, now = Date.now() } = {}) {
  const cutoff = new Date(now - olderThanMinutes * 60_000).toISOString();
  const checkedBefore = new Date(now - sabpaisaRecheckIntervalMs(0)).toISOString();

  const rows = await select(
    'orders',
    `select=order_ref,status,payment_status,created_at,enquiry_count,last_checked_at` +
      `&payment_method=eq.${encodeURIComponent(ONLINE_PAYMENT_METHOD)}` +
      `&payment_gateway=eq.${SABPAISA_GATEWAY}` +
      `&payment_status=in.(${RECONCILABLE_STATUSES.join(',')})` +
      `&or=(enquiry_count.lt.${SABPAISA_AUTO_ENQUIRY_BUDGET},payment_status.neq.requires_review)` +
      `&created_at=lt.${encodeURIComponent(cutoff)}` +
      `&and=(or(last_checked_at.is.null,last_checked_at.lt.${encodeURIComponent(checkedBefore)}))` +
      `&order=last_checked_at.asc.nullsfirst&limit=${Number(limit) * 5}`,
  );

  return rows
    .filter((row) => {
      const last = row.last_checked_at ? Date.parse(row.last_checked_at) : 0;
      return now - last >= sabpaisaRecheckIntervalMs(row.enquiry_count);
    })
    .slice(0, Number(limit));
}
