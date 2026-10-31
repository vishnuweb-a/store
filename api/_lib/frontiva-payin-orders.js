/**
 * Frontiva PayIn order lifecycle: attempt records, status-based settlement and
 * the reconciliation listing. Uses the shared public.orders row for the
 * customer-visible state (payment_status), and frontiva_payin_transactions for
 * provider metadata (migrations-frontiva-payin.sql).
 *
 * Never calls Airpay or SabPaisa, and never forwards anything to KKChat.
 */
import {
  FRONTIVA_PAYIN_GATEWAY,
  decideFrontivaSettlement,
  fetchFrontivaPayinStatus,
  logFrontivaPayin,
} from './frontiva-payin.js';
import { logEvent } from './http.js';
import { ONLINE_PAYMENT_METHOD, OPEN_STATUSES, findOrderByRef } from './orders.js';
import { insert, select, update } from './supabase.js';

export const TRANSACTIONS_TABLE = 'frontiva_payin_transactions';

/** Automatic status checks per order before it is parked for a person. No provider limit is documented. */
export const FRONTIVA_AUTO_CHECK_BUDGET = 100;

/** Minimum gap between two status checks of one order, from any caller. */
export const FRONTIVA_MIN_CHECK_INTERVAL_MS = 8_000;

/** Unresolved (not found / unreachable) this long → requires_review. Still re-checked afterwards. */
export const FRONTIVA_REVIEW_AFTER_MS = 2 * 60 * 60_000;

/** Reconciliation backoff for one order: every 10 minutes at first, then hourly. */
export function frontivaRecheckIntervalMs(checkCount) {
  return Number(checkCount) < 20 ? 10 * 60_000 : 60 * 60_000;
}

const openOrderFilter = (orderRef) =>
  `order_ref=eq.${encodeURIComponent(orderRef)}` +
  `&payment_gateway=eq.${FRONTIVA_PAYIN_GATEWAY}` +
  `&payment_status=in.(${OPEN_STATUSES.join(',')})`;

/**
 * Claims a checkout attempt. The unique checkout_attempt_id makes a repeated
 * submission of the same attempt a no-op, so it can never create a second
 * order or a second PayIn.
 *
 * @returns {Promise<{claimed: true}|{claimed: false, orderRef: string|null}>}
 */
export async function claimCheckoutAttempt({ attemptId, orderRef, amountInPaise, paymentMode }, deps = {}) {
  const doInsert = deps.insert || insert;
  const doSelect = deps.select || select;

  const rows = await doInsert(
    TRANSACTIONS_TABLE,
    {
      checkout_attempt_id: attemptId,
      order_ref: orderRef,
      amount_in_paise: amountInPaise,
      payment_mode: paymentMode,
      create_state: 'requested',
    },
    { onConflict: 'checkout_attempt_id', ignoreDuplicates: true },
  );

  if (rows.length > 0) {
    return { claimed: true };
  }

  const [existing] = await doSelect(
    TRANSACTIONS_TABLE,
    `select=order_ref&checkout_attempt_id=eq.${encodeURIComponent(attemptId)}&limit=1`,
  );

  return { claimed: false, orderRef: existing?.order_ref ?? null };
}

/** Best-effort metadata write. Settlement keys on order_ref, so a failure here never blocks payment. */
export async function recordTransaction(orderRef, patch, deps = {}) {
  const doUpdate = deps.applyUpdate || update;

  try {
    await doUpdate(TRANSACTIONS_TABLE, `order_ref=eq.${encodeURIComponent(orderRef)}`, {
      ...patch,
      updated_at: new Date().toISOString(),
    });
  } catch {
    logEvent('payment.frontiva_payin.metadata_not_saved', { order_ref: orderRef });
  }
}

/** States in which the customer may still be shown the QR (not requires_review: a person is looking). */
const PAYABLE_STATUSES = new Set(['initiated', 'processing']);

/** A QR is shown for this long after the order was placed; afterwards it is not offered as payable. */
export const FRONTIVA_QR_VALID_MS = 30 * 60_000;

const ATTEMPT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The stored, already validated UPI intent of a still-payable PayIn order, so
 * a refreshed payment page shows the same QR rather than creating a second
 * PayIn. Null for every other order or on any read failure.
 *
 * Authorised by possession of the checkout attempt id (a browser-generated
 * UUID, stored on the transaction row): the order_ref alone is not enough, so
 * a guessed reference never reveals a payment request. Also null once the QR
 * is older than FRONTIVA_QR_VALID_MS.
 *
 * @param {{order_ref: string, payment_gateway?: string|null, payment_status?: string, status?: string, created_at?: string}} order
 * @param {string|null|undefined} attemptKey - checkout attempt id presented by the caller
 */
export async function findFrontivaPayinIntent(order, attemptKey, deps = {}) {
  const doSelect = deps.select || select;
  const now = (deps.now || Date.now)();

  if (order?.payment_gateway !== FRONTIVA_PAYIN_GATEWAY || !PAYABLE_STATUSES.has(order.payment_status || order.status)) {
    return null;
  }

  if (typeof attemptKey !== 'string' || !ATTEMPT_KEY.test(attemptKey)) {
    return null;
  }

  const placedAt = Date.parse(order.created_at);

  if (!Number.isFinite(placedAt) || now - placedAt > FRONTIVA_QR_VALID_MS) {
    return null;
  }

  try {
    const [row] = await doSelect(
      TRANSACTIONS_TABLE,
      `select=upi_intent&order_ref=eq.${encodeURIComponent(order.order_ref)}` +
        `&checkout_attempt_id=eq.${encodeURIComponent(attemptKey.toLowerCase())}&create_state=eq.created&limit=1`,
    );
    return typeof row?.upi_intent === 'string' && row.upi_intent.startsWith('upi://pay?') ? row.upi_intent : null;
  } catch {
    return null;
  }
}

/**
 * Settles one Frontiva PayIn order from the portal status endpoint.
 *
 * Loads the order, confirms it is a PayIn order, checks the provider, and
 * applies the result with a conditional UPDATE that only matches while the
 * order is still open — so a terminal state is never overwritten by a stale or
 * concurrent answer, and paid is applied at most once.
 *
 * @param {string} orderRef
 * @param {Object} [deps] - Injectable I/O, for tests
 */
export async function confirmFrontivaPayin(orderRef, deps = {}) {
  const findOrder = deps.findOrder || findOrderByRef;
  const order = await findOrder(orderRef);

  if (!order || order.payment_method !== ONLINE_PAYMENT_METHOD || order.payment_gateway !== FRONTIVA_PAYIN_GATEWAY) {
    return { order, status: order?.payment_status ?? 'unknown', changed: false, reason: 'not a frontiva payin order' };
  }

  return settleFrontivaPayinOrder(order, deps);
}

/** settleOrder()'s branch for payment_gateway = 'frontiva_payin'. The order is already loaded. */
export async function settleFrontivaPayinOrder(order, deps = {}) {
  const orderRef = order.order_ref;
  const current = order.payment_status || order.status;
  const findOrder = deps.findOrder || findOrderByRef;
  const applyUpdate = deps.applyUpdate || update;
  const fetchStatus = deps.frontivaStatus || fetchFrontivaPayinStatus;
  const now = (deps.now || Date.now)();
  const count = Number.isSafeInteger(order.enquiry_count) ? order.enquiry_count : 0;

  if (!OPEN_STATUSES.includes(current)) {
    return { order, status: current, changed: false };
  }

  if (count >= FRONTIVA_AUTO_CHECK_BUDGET) {
    if (current === 'requires_review') {
      return { order, status: current, changed: false, reason: 'check budget exhausted' };
    }

    return transition(orderRef, { payment_status: 'requires_review', status: 'requires_review', updated_at: new Date(now).toISOString() }, {
      applyUpdate,
      findOrder,
      current,
      reason: 'check budget exhausted',
    });
  }

  // Claim the right to make one check: concurrent page loads and reconciliation
  // cannot both call the provider, and the count stays exact.
  const cutoff = new Date(now - (deps.minCheckIntervalMs ?? FRONTIVA_MIN_CHECK_INTERVAL_MS)).toISOString();
  const claimed = await applyUpdate(
    'orders',
    openOrderFilter(orderRef) +
      (Number.isSafeInteger(order.enquiry_count) ? `&enquiry_count=eq.${count}` : '&enquiry_count=is.null') +
      `&or=(last_checked_at.is.null,last_checked_at.lt.${encodeURIComponent(cutoff)})`,
    { enquiry_count: count + 1, last_checked_at: new Date(now).toISOString() },
  );

  if (claimed.length === 0) {
    return { order, status: current, changed: false, reason: 'check throttled' };
  }

  const expectedInPaise = Math.round(Number(order.total) * 100);
  const answer = await fetchStatus(orderRef, deps.frontivaConfig ? { config: deps.frontivaConfig } : {});
  const decision = decideFrontivaSettlement(answer, {
    orderRef,
    expectedInPaise,
    pastReviewWindow: now - Date.parse(order.created_at) > FRONTIVA_REVIEW_AFTER_MS,
  });

  const verified = answer.outcome === 'answered' && answer.merchantReference === orderRef;

  if (verified) {
    await recordTransaction(
      orderRef,
      {
        provider_status: answer.status,
        last_verified_at: new Date(now).toISOString(),
        ...(answer.portalRequestId ? { portal_request_id: answer.portalRequestId } : {}),
        ...(answer.utr ? { provider_utr: answer.utr } : {}),
        last_error: null,
      },
      { applyUpdate },
    );
  } else {
    await recordTransaction(orderRef, { last_error: String(answer.reason || answer.outcome).slice(0, 120) }, { applyUpdate });
  }

  if (decision.status !== 'paid') {
    logFrontivaPayin('payment.settle.frontiva_payin_not_paid', {
      order_ref: orderRef,
      decided: decision.status,
      reason: decision.reason,
      outcome: answer.outcome,
      provider_status: answer.status ?? null,
      http_status: answer.httpStatus ?? null,
      expected_in_paise: expectedInPaise,
      confirmed_in_paise: answer.amountPaise ?? null,
      check_count: count + 1,
    });
  }

  if (decision.status === null || decision.status === current) {
    return { order: (await findOrder(orderRef)) || order, status: current, changed: false, reason: decision.reason };
  }

  const stamp = new Date(now).toISOString();
  const patch = { payment_status: decision.status, status: decision.status, updated_at: stamp };

  if (verified) patch.verified_at = stamp;
  if (decision.status === 'paid') patch.paid_at = stamp;
  if (verified && answer.utr) patch.gateway_txn_id = answer.utr;

  return transition(orderRef, patch, { applyUpdate, findOrder, current, reason: decision.reason });
}

/** The idempotency barrier: only an order that is still open moves. */
async function transition(orderRef, patch, { applyUpdate, findOrder, current, reason }) {
  const updated = await applyUpdate('orders', openOrderFilter(orderRef), patch);

  if (updated.length === 0) {
    const latest = await findOrder(orderRef);
    return {
      order: latest,
      status: latest?.payment_status ?? latest?.status ?? current,
      changed: false,
      reason: 'already settled by a concurrent check',
    };
  }

  logEvent('payment.settle.applied', { order_ref: orderRef, gateway: FRONTIVA_PAYIN_GATEWAY, status: patch.payment_status });

  return { order: updated[0], status: patch.payment_status, changed: true, reason };
}

/**
 * Closes an order for which no PayIn can exist or be paid (definite
 * rejection), conditional on it still being open.
 */
export async function closeFrontivaOrder(orderRef, status, deps = {}) {
  const applyUpdate = deps.applyUpdate || update;

  return applyUpdate('orders', openOrderFilter(orderRef), {
    payment_status: status,
    status,
    updated_at: new Date().toISOString(),
  });
}

/**
 * PayIn orders reconciliation should check now: open, past the grace period,
 * not checked within their backoff interval, least recently checked first.
 *
 * @param {{olderThanMinutes?: number, limit?: number, now?: number}} [options]
 */
export async function listFrontivaPayinDue({ olderThanMinutes = 10, limit = 10, now = Date.now() } = {}, deps = {}) {
  const doSelect = deps.select || select;
  const cutoff = new Date(now - olderThanMinutes * 60_000).toISOString();
  const checkedBefore = new Date(now - frontivaRecheckIntervalMs(0)).toISOString();

  const rows = await doSelect(
    'orders',
    `select=order_ref,payment_status,created_at,enquiry_count,last_checked_at` +
      `&payment_method=eq.${encodeURIComponent(ONLINE_PAYMENT_METHOD)}` +
      `&payment_gateway=eq.${FRONTIVA_PAYIN_GATEWAY}` +
      `&payment_status=in.(${OPEN_STATUSES.join(',')})` +
      `&or=(enquiry_count.lt.${FRONTIVA_AUTO_CHECK_BUDGET},payment_status.neq.requires_review)` +
      `&created_at=lt.${encodeURIComponent(cutoff)}` +
      `&and=(or(last_checked_at.is.null,last_checked_at.lt.${encodeURIComponent(checkedBefore)}))` +
      `&order=last_checked_at.asc.nullsfirst&limit=${Number(limit) * 5}`,
  );

  return rows
    .filter((row) => now - (row.last_checked_at ? Date.parse(row.last_checked_at) : 0) >= frontivaRecheckIntervalMs(row.enquiry_count))
    .slice(0, Number(limit));
}
