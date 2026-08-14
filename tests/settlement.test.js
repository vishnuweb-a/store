/**
 * Settlement: what it takes for an order to be marked paid, and what it takes
 * for it not to be. No path here may reach 'paid' on the strength of a callback.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
import { classifyTransaction, isSuccessStatus } from '../api/_lib/airpay.js';
import { ONLINE_PAYMENT_METHOD, decideSettlement, presentOrder, settleOrder } from '../api/_lib/orders.js';

const ONLINE_ORDER = {
  id: 42,
  order_ref: 'FRVTESTREF01',
  customer_name: 'Asha Menon',
  phone: '9876543210',
  address: '12 MG Road',
  landmark: null,
  payment_method: ONLINE_PAYMENT_METHOD,
  status: 'initiated',
  payment_status: 'initiated',
  total: 1500,
  items: [],
  created_at: '2026-08-14T06:00:00Z',
};

/**
 * Builds an in-memory store whose update() honours the same status filter the
 * real conditional UPDATE uses, so races behave as they would in Postgres.
 */
function harness(order, confirmation) {
  const state = { ...order };
  const updates = [];

  return {
    state,
    updates,
    deps: {
      findOrder: async () => ({ ...state }),
      confirm: async () => confirmation,
      applyUpdate: async (table, query, patch) => {
        updates.push(patch);

        const openMatch = query.match(/payment_status\.in\.\(([^)]+)\)/);
        const open = openMatch ? openMatch[1].split(',') : [];
        const allowsNull = /payment_status\.is\.null/.test(query);
        const current = state.payment_status;

        if (!(open.includes(current) || (allowsNull && (current === null || current === undefined)))) {
          return [];
        }

        Object.assign(state, patch);

        return [{ ...state }];
      },
    },
  };
}

describe('settleOrder', () => {
  test('marks paid when Airpay confirms success at the expected amount', async () => {
    const h = harness(ONLINE_ORDER, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-1',
    });

    const result = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(result.status, 'paid');
    assert.equal(result.changed, true);
    assert.equal(h.state.airpay_transaction_id, 'AP-1');
    assert.ok(h.state.paid_at);
  });

  test('marks failed when Airpay reports a non-success status', async () => {
    const h = harness(ONLINE_ORDER, { verified: true, status: '400', amountInCents: 150000, transactionId: 'AP-2' });

    const result = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(result.status, 'failed');
    assert.equal(h.state.paid_at, undefined);
  });

  test('does NOT mark paid when the confirmed amount differs from the order', async () => {
    const h = harness(ONLINE_ORDER, { verified: true, status: '200', amountInCents: 1000, transactionId: 'AP-3' });

    const result = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(result.status, 'requires_review');
    assert.notEqual(result.status, 'paid');
  });

  test('does NOT mark paid when Airpay reports no amount', async () => {
    const h = harness(ONLINE_ORDER, { verified: true, status: '200', amountInCents: null, transactionId: 'AP-4' });

    assert.equal((await settleOrder(ONLINE_ORDER.order_ref, h.deps)).status, 'requires_review');
  });

  test('does NOT mark paid when Airpay could not be reached', async () => {
    const h = harness(ONLINE_ORDER, {
      verified: false,
      status: null,
      amountInCents: null,
      transactionId: null,
      reason: 'verification unavailable',
    });

    assert.equal((await settleOrder(ONLINE_ORDER.order_ref, h.deps)).status, 'requires_review');
  });

  test('is idempotent: a duplicate callback does not re-settle a paid order', async () => {
    const h = harness(ONLINE_ORDER, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-5',
    });

    const first = await settleOrder(ONLINE_ORDER.order_ref, h.deps);
    const second = await settleOrder(ONLINE_ORDER.order_ref, h.deps);
    const third = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(third.changed, false);
    assert.equal(h.state.payment_status, 'paid');
    // Only the first delivery wrote anything.
    assert.equal(h.updates.length, 1);
  });

  test('a concurrent settlement that loses the race reports no change', async () => {
    const h = harness(ONLINE_ORDER, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-6',
    });

    // Simulate the other caller winning between the read and the update.
    h.deps.applyUpdate = async () => [];

    const result = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(result.changed, false);
  });

  test('refuses to touch a Cash on Delivery order', async () => {
    const h = harness({ ...ONLINE_ORDER, payment_method: 'Cash on Delivery', status: 'processing', payment_status: null }, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-7',
    });

    const result = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(result.changed, false);
    assert.equal(h.updates.length, 0);
    assert.equal(h.state.status, 'processing');
  });

  test('reports unknown for a reference with no order', async () => {
    const result = await settleOrder('FRVNOSUCHREF', { findOrder: async () => null, confirm: async () => {
      throw new Error('should not be called');
    } });

    assert.equal(result.status, 'unknown');
    assert.equal(result.order, null);
  });

  test('a requires_review order can still be settled later', async () => {
    const h = harness({ ...ONLINE_ORDER, status: 'requires_review', payment_status: 'requires_review' }, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-8',
    });

    assert.equal((await settleOrder(ONLINE_ORDER.order_ref, h.deps)).status, 'paid');
  });

  test('settles an order written before payment_status existed', async () => {
    // Only `status` was set by the older revision. `payment_status IN (...)`
    // never matches NULL in SQL, so without the null branch this order could
    // never leave the open state.
    const h = harness({ ...ONLINE_ORDER, status: 'initiated', payment_status: null }, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-13',
    });

    const result = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(result.status, 'paid');
    assert.equal(result.changed, true);
    assert.equal(h.state.payment_status, 'paid');
  });

  test('the conditional update tolerates a null payment_status', async () => {
    const h = harness(ONLINE_ORDER, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-14',
    });

    let seenQuery = '';
    const inner = h.deps.applyUpdate;
    h.deps.applyUpdate = async (table, query, patch) => {
      seenQuery = query;
      return inner(table, query, patch);
    };

    await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.match(seenQuery, /payment_status\.is\.null/);
    // Still scoped to one order, so the broadened filter cannot touch anything else.
    assert.match(seenQuery, /order_ref=eq\.FRVTESTREF01/);
  });

  test('does NOT mark paid while the transaction is INPROCESS at Airpay', async () => {
    const h = harness(ONLINE_ORDER, {
      verified: true,
      status: 'INPROCESS',
      amountInCents: 150000,
      transactionId: 'AP-9',
    });

    const result = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(result.status, 'processing');
    assert.equal(h.state.paid_at, undefined);
  });

  test('an INPROCESS order stays open so reconciliation can resolve it', async () => {
    const h = harness({ ...ONLINE_ORDER, status: 'processing', payment_status: 'processing' }, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-10',
    });

    assert.equal((await settleOrder(ONLINE_ORDER.order_ref, h.deps)).status, 'paid');
  });

  test('a forged SUCCESS callback cannot mark an order paid', async () => {
    // The callback body is not an input to settlement at all: settleOrder takes
    // only a reference, and asks Airpay itself what happened.
    const h = harness(ONLINE_ORDER, {
      verified: true,
      status: '400',
      amountInCents: 150000,
      transactionId: 'AP-11',
    });

    const result = await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(result.status, 'failed');

    // Structural proof: the IPN handler passes only the order reference into
    // settlement, so no field of the callback body can influence the outcome.
    const callbackSource = readFileSync(new URL('../api/payments/callback.js', import.meta.url), 'utf8');

    assert.match(callbackSource, /await settleOrder\(orderRef\)/);
    assert.ok(!/settleOrder\([^)]*payload/.test(callbackSource));
  });

  test('records when verification actually happened', async () => {
    const h = harness(ONLINE_ORDER, {
      verified: true,
      status: '200',
      amountInCents: 150000,
      transactionId: 'AP-12',
    });

    await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.ok(h.state.verified_at);
    assert.ok(h.state.updated_at);
  });

  test('does not stamp verified_at when Airpay was unreachable', async () => {
    const h = harness(ONLINE_ORDER, {
      verified: false,
      status: null,
      amountInCents: null,
      transactionId: null,
      reason: 'verification unavailable',
    });

    await settleOrder(ONLINE_ORDER.order_ref, h.deps);

    assert.equal(h.state.verified_at, undefined);
  });
});

describe('decideSettlement', () => {
  const paid = { verified: true, status: '200', amountInCents: 150000, transactionId: 'x' };

  test('paid requires reachability, success and an exact amount match', () => {
    assert.equal(decideSettlement(paid, 150000).status, 'paid');
  });

  test('every other input is something other than paid', () => {
    const cases = [
      [{ ...paid, verified: false }, 'requires_review'],
      [{ ...paid, status: 'INPROCESS' }, 'processing'],
      [{ ...paid, status: 'PENDING' }, 'processing'],
      [{ ...paid, status: '400' }, 'failed'],
      [{ ...paid, status: 'WHAT_IS_THIS' }, 'failed'],
      [{ ...paid, amountInCents: null }, 'requires_review'],
      [{ ...paid, amountInCents: 149999 }, 'requires_review'],
      [{ ...paid, amountInCents: 150001 }, 'requires_review'],
    ];

    for (const [confirmation, expected] of cases) {
      const decided = decideSettlement(confirmation, 150000).status;

      assert.equal(decided, expected, `expected ${expected} for ${JSON.stringify(confirmation)}`);
      assert.notEqual(decided, 'paid');
    }
  });

  test('an amount one paisa off is not paid', () => {
    assert.notEqual(decideSettlement({ ...paid, amountInCents: 150001 }, 150000).status, 'paid');
  });
});

describe('classifyTransaction', () => {
  test('success only for documented success codes', () => {
    assert.equal(classifyTransaction('200'), 'success');
    assert.equal(classifyTransaction('SUCCESS'), 'success');
  });

  test('pending for in-process codes, so the order is not closed', () => {
    for (const status of ['INPROCESS', 'in_process', 'PENDING', '210', '211']) {
      assert.equal(classifyTransaction(status), 'pending', status);
    }
  });

  test('unknown codes fail closed rather than open', () => {
    for (const status of ['', null, undefined, 'OK', 'TRUE', '000', 'ABORTED']) {
      assert.equal(classifyTransaction(status), 'failed');
    }
  });
});

describe('isSuccessStatus', () => {
  test('accepts Airpay success codes', () => {
    assert.equal(isSuccessStatus('200'), true);
    assert.equal(isSuccessStatus(200), true);
    assert.equal(isSuccessStatus('SUCCESS'), true);
    assert.equal(isSuccessStatus('success'), true);
  });

  test('rejects everything else', () => {
    for (const status of ['400', '000', 'FAILED', 'PENDING', '', null, undefined, 'OK']) {
      assert.equal(isSuccessStatus(status), false, `expected ${status} to not be success`);
    }
  });
});

describe('presentOrder', () => {
  test('shapes a row the way the confirmation page expects', () => {
    const presented = presentOrder({ ...ONLINE_ORDER, status: 'paid' });

    assert.equal(presented.order_number, 'FRV-00042');
    assert.equal(presented.total_formatted, '₹1500.00');
    assert.equal(presented.total_in_cents, 150000);
    assert.equal(presented.customer.full_name, 'Asha Menon');
    assert.equal(presented.status, 'paid');
  });
});
