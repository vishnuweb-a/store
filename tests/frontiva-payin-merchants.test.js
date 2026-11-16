/**
 * Frontiva PayIn multi-merchant: slot 2 (a second portal account) beside slot 1.
 * Credential, session, payee, order and settlement isolation; no fallback from
 * slot 2 to slot 1, ever. PayIn slots are unrelated to Airpay merchant numbers.
 *
 * Every request is answered by the in-memory fake (tests/helpers/fake-world.js).
 * Nothing reaches the network and no test can move money.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach, describe } from 'node:test';
import {
  FRONTIVA_PAYIN_MERCHANTS,
  availableFrontivaMerchants,
  fetchFrontivaPayinStatus,
  frontivaPayinAvailable,
  generateFrontivaSignature,
  getFrontivaSession,
  loadFrontivaPayinConfig,
  parseFrontivaMerchant,
  resetFrontivaSession,
} from '../api/_lib/frontiva-payin.js';
import { confirmFrontivaPayin, frontivaSlotForOrder } from '../api/_lib/frontiva-payin-orders.js';
import { scrubSecrets } from '../api/_lib/http.js';
import healthHandler from '../api/health.js';
import createHandler from '../api/payments/frontiva-payin/create.js';
import reconcileHandler from '../api/payments/frontiva-payin/reconcile.js';
import optionsHandler from '../api/payments/options.js';
import statusHandler from '../api/payments/status.js';
import { installWorld, respond } from './helpers/fake-world.js';
import { decodeRenderedQr } from './helpers/qr.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

// Fixtures only. Not real credentials.
const CRON_SECRET = 'fixture-cron-secret-for-merchant-tests';
const ATTEMPT = '3f1c2a7e-8b4d-4c1a-9e2f-0a1b2c3d4e5f';
const ATTEMPT_2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const SLOT = {
  1: { email: 'merchant@example.com', password: 'fixture-portal-password-one', merchantId: 42, token: 'fixture.token.one', secret: 'fixture_secret_one', payee: 'merchant@bank' },
  2: { email: 'second@example.com', password: 'fixture-portal-password-two', merchantId: 77, token: 'fixture.token.two', secret: 'fixture_secret_two', payee: 'second@bank' },
  3: { email: 'third@example.com', password: 'fixture-portal-password-three', merchantId: 91, token: 'fixture.token.three', secret: 'fixture_secret_three', payee: 'third@bank' },
};

// Slot 3 is added per-suite (SLOT3_ENV), so the slot-1/2 suites keep their original world.
const SLOT3_ENV = {
  FRONTIVA_PAYIN_ENABLED_3: 'true',
  FRONTIVA_PAYIN_EMAIL_3: SLOT[3].email,
  FRONTIVA_PAYIN_PASSWORD_3: SLOT[3].password,
  FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_3: '91',
  FRONTIVA_PAYIN_ALLOWED_PAYEES_3: SLOT[3].payee,
  FRONTIVA_PAYIN_PAYEE_NAME_3: 'Third Trading LLP',
};

const ENV = {
  FRONTIVA_PAYIN_ENABLED: 'true',
  FRONTIVA_PAYIN_EMAIL: SLOT[1].email,
  FRONTIVA_PAYIN_PASSWORD: SLOT[1].password,
  FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID: '42',
  FRONTIVA_PAYIN_ALLOWED_PAYEES: SLOT[1].payee,
  FRONTIVA_PAYIN_ENABLED_2: 'true',
  FRONTIVA_PAYIN_EMAIL_2: SLOT[2].email,
  FRONTIVA_PAYIN_PASSWORD_2: SLOT[2].password,
  FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_2: '77',
  FRONTIVA_PAYIN_ALLOWED_PAYEES_2: SLOT[2].payee,
  FRONTIVA_PAYIN_PAYEE_NAME_2: 'Second Trading LLP',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE: 'fixture-service-role',
  CRON_SECRET,
};

const PRODUCT = {
  id: 7, title: 'Linen Shirt', price: 1500, discount_price: null, active: true,
  track_quantity: false, stock: 0, sizes: [], sku: 'LS-1', image_url: null,
};

const intentFor = (payee) => `upi://pay?pa=${payee}&pn=Fixture+Payee&cu=INR&am=1500.00&mc=5691&mode=04&tr=AIRPAY0000000001`;

let originalFetch;
let originalEnv;
let originalLog;
let logs;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = { ...process.env };
  originalLog = console.log;
  for (const name of Object.keys(process.env)) {
    if (/^(AIRPAY_|SABPAISA_|SUBPAISA_|FRONTIVA_)/.test(name)) delete process.env[name];
  }
  Object.assign(process.env, ENV);
  resetFrontivaSession();
  logs = [];
  console.log = (line) => logs.push(String(line));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  console.log = originalLog;
});

/** Which fixture account a request authenticates as, from its bearer token. */
const slotOfToken = (headers) => Number(Object.keys(SLOT).find((slot) => headers?.Authorization === `Bearer ${SLOT[slot].token}`)) || null;

/** The portal answers each login as the account its email belongs to. */
const login = ({ merchantIdFor = {} } = {}) => (body) => {
  const slot = Object.keys(SLOT).find((key) => SLOT[key].email === body.email && SLOT[key].password === body.password);
  if (!slot) return respond(401, { success: false });
  const { token, secret, merchantId } = SLOT[slot];
  return respond(200, { success: true, data: { accessToken: token, user: { merchantId: merchantIdFor[slot] ?? merchantId, clientSecret: secret } } });
};

/** Each account creates under its own merchant id, with its own payee unless told otherwise. */
const create = ({ payeeFor = {} } = {}) => (body, headers) => {
  const slot = slotOfToken(headers);
  return respond(201, {
    id: 810000 + slot, merchantId: SLOT[slot].merchantId, amount: String(body.amount), status: 'PENDING',
    merchantReference: body.merchantReference, paymentMode: 'UPI_INTENT', url: null,
    intent: intentFor(payeeFor[slot] ?? SLOT[slot].payee),
  });
};

/** Each account knows only the references in its own book. */
const status = (books) => (ref, headers) => {
  const slot = slotOfToken(headers);
  const entry = books[slot]?.[ref];
  if (!entry) return respond(404, { success: false });
  return respond(200, { success: true, data: { id: 810000 + slot, merchantId: SLOT[slot].merchantId, merchantReference: ref, requestedAmount: '1500.00', utr: `UTR-${slot}`, ...entry } });
};

async function call(handler, { method = 'POST', url = '/', headers = {}, body } = {}) {
  const out = { statusCode: 200, headers: {}, body: '' };
  const res = {
    set statusCode(v) { out.statusCode = v; },
    get statusCode() { return out.statusCode; },
    setHeader: (n, v) => { out.headers[n.toLowerCase()] = v; },
    end: (v = '') => { out.body = v; },
  };
  await handler({ method, url, headers, body }, res);
  return { ...out, json: () => JSON.parse(out.body) };
}

const checkout = (overrides = {}) =>
  call(createHandler, {
    body: {
      customer: { fullName: 'Asha Menon', phone: '9876543210', address: '12 MG Road, Kochi', landmark: '' },
      email: 'asha@example.com',
      items: [{ product_id: 7, size: null, quantity: 1 }],
      attempt_id: ATTEMPT,
      ...overrides,
    },
  });

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const payinOrder = (overrides = {}) => ({
  id: 1, order_ref: 'FRVSLOTTWO0001', customer_name: 'Asha Menon', phone: '9876543210', address: 'x', landmark: null,
  payment_method: 'Online Payment', status: 'initiated', payment_status: 'initiated', total: 1500,
  items: [], payment_gateway: 'frontiva_payin', enquiry_count: 0, last_checked_at: null,
  created_at: minutesAgo(1), ...overrides,
});

const orderIn = (state, ref) => state.tables.orders.find((row) => row.order_ref === ref);
const events = () => logs.map((line) => { try { return JSON.parse(line); } catch { return {}; } });

// --- Registry and configuration -----------------------------------------------

describe('merchant registry and configuration', () => {
  test('slots 1, 2 and 3 are known; anything else is rejected', () => {
    assert.deepEqual(FRONTIVA_PAYIN_MERCHANTS, [1, 2, 3]);
    assert.equal(parseFrontivaMerchant(2), 2);
    assert.equal(parseFrontivaMerchant('2'), 2);
    assert.equal(parseFrontivaMerchant(3), 3);
    assert.equal(parseFrontivaMerchant('3'), 3);
    for (const bad of [0, 4, '4', 100, -1, 1.5, '02', ' 2', 'two', null, undefined, true, {}, [2]]) {
      assert.equal(parseFrontivaMerchant(bad), null, JSON.stringify(bad));
    }
    assert.throws(() => loadFrontivaPayinConfig(4), /Unknown Frontiva PayIn merchant/);
  });

  test('slot 2 loads only its own credentials, payees and payee name', () => {
    const two = loadFrontivaPayinConfig(2);
    assert.equal(two.slot, 2);
    assert.equal(two.email, SLOT[2].email);
    assert.equal(two.password, SLOT[2].password);
    assert.equal(two.expectedMerchantId, '77');
    assert.deepEqual(two.allowedPayees, [SLOT[2].payee]);
    assert.equal(two.payeeName, 'Second Trading LLP');
    assert.equal(two.baseUrl, 'https://portal.frontiva.online');

    const one = loadFrontivaPayinConfig();
    assert.equal(one.slot, 1);
    assert.equal(one.email, SLOT[1].email);
    assert.deepEqual(one.allowedPayees, [SLOT[1].payee]);
  });

  test('a missing slot-2 value is an error naming the _2 variable, never slot 1\'s value', () => {
    for (const name of ['FRONTIVA_PAYIN_EMAIL_2', 'FRONTIVA_PAYIN_PASSWORD_2', 'FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_2']) {
      const saved = process.env[name];
      process.env[name] = '   ';
      assert.throws(() => loadFrontivaPayinConfig(2), new RegExp(name));
      assert.equal(frontivaPayinAvailable(2), false);
      assert.equal(frontivaPayinAvailable(1), true, 'slot 1 unaffected');
      process.env[name] = saved;
    }
  });

  test('the base URL is optional for slot 2 and must still be https', () => {
    process.env.FRONTIVA_PAYIN_BASE_URL_2 = 'http://portal.frontiva.online';
    assert.throws(() => loadFrontivaPayinConfig(2), /FRONTIVA_PAYIN_BASE_URL_2 must be an https origin/);
    process.env.FRONTIVA_PAYIN_BASE_URL_2 = 'https://portal.frontiva.online/';
    assert.equal(loadFrontivaPayinConfig(2).baseUrl, 'https://portal.frontiva.online');
  });

  test('each slot has its own switch; default off; only an explicit true', () => {
    delete process.env.FRONTIVA_PAYIN_ENABLED_2;
    assert.deepEqual(availableFrontivaMerchants(), [1]);
    process.env.FRONTIVA_PAYIN_ENABLED_2 = 'yes';
    assert.deepEqual(availableFrontivaMerchants(), [1]);
    process.env.FRONTIVA_PAYIN_ENABLED_2 = 'true';
    process.env.FRONTIVA_PAYIN_ENABLED = 'false';
    assert.deepEqual(availableFrontivaMerchants(), [2]);
  });

  test('slot 2 without its own payee allowlist is not offered', () => {
    delete process.env.FRONTIVA_PAYIN_ALLOWED_PAYEES_2;
    assert.equal(frontivaPayinAvailable(2), false);
    assert.equal(frontivaPayinAvailable(1), true);
  });

  test('slot 2 sharing slot 1\'s login or merchant id is never offered; slot 1 is never switched off by it', () => {
    process.env.FRONTIVA_PAYIN_EMAIL_2 = SLOT[1].email.toUpperCase();
    assert.equal(frontivaPayinAvailable(2), false);
    assert.equal(frontivaPayinAvailable(1), true);

    process.env.FRONTIVA_PAYIN_EMAIL_2 = SLOT[2].email;
    process.env.FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_2 = '42';
    assert.equal(frontivaPayinAvailable(2), false);
    assert.equal(frontivaPayinAvailable(1), true);
  });
});

// --- Sessions -----------------------------------------------------------------

describe('per-merchant sessions', () => {
  test('each slot logs in with its own credentials and never reuses the other\'s token', async () => {
    const world = installWorld({ login: login() });
    const [one, two] = await Promise.all([getFrontivaSession(loadFrontivaPayinConfig(1)), getFrontivaSession(loadFrontivaPayinConfig(2))]);
    await getFrontivaSession(loadFrontivaPayinConfig(1));
    await getFrontivaSession(loadFrontivaPayinConfig(2));

    assert.deepEqual(world.logins, [
      { email: SLOT[1].email, password: SLOT[1].password },
      { email: SLOT[2].email, password: SLOT[2].password },
    ]);
    assert.equal(one.accessToken, SLOT[1].token);
    assert.equal(two.accessToken, SLOT[2].token);
    assert.equal(two.merchantId, '77');
  });

  test('a slot-2 login naming another portal merchant fails closed', async () => {
    installWorld({ login: login({ merchantIdFor: { 2: 42 } }) });
    await assert.rejects(getFrontivaSession(loadFrontivaPayinConfig(2)), { kind: 'merchant_mismatch' });
  });

  test('a failed slot-2 login and its cooldown leave slot 1 untouched', async () => {
    process.env.FRONTIVA_PAYIN_PASSWORD_2 = 'wrong-password';
    const world = installWorld({ login: login() });

    await assert.rejects(getFrontivaSession(loadFrontivaPayinConfig(2)), { kind: 'invalid_credentials' });
    await assert.rejects(getFrontivaSession(loadFrontivaPayinConfig(2)), { kind: 'invalid_credentials' });
    assert.equal(world.logins.length, 1, 'slot 2 cools down');

    const one = await getFrontivaSession(loadFrontivaPayinConfig(1));
    assert.equal(one.accessToken, SLOT[1].token, 'slot 1 logs in normally');
    assert.ok(events().some((e) => e.event === 'payment.frontiva_payin.login_failed' && e.merchant === 2));
  });

  test('a slot-2 token refused by the portal is dropped for slot 2 only', async () => {
    let refuseTwo = true;
    const world = installWorld({
      login: login(),
      status: (ref, headers) => {
        if (slotOfToken(headers) === 2 && refuseTwo) {
          refuseTwo = false;
          return respond(401, { success: false });
        }
        return status({ 1: { [ref]: { status: 'PENDING' } }, 2: { [ref]: { status: 'PENDING' } } })(ref, headers);
      },
    });

    await getFrontivaSession(loadFrontivaPayinConfig(1));
    await getFrontivaSession(loadFrontivaPayinConfig(2));
    assert.equal(world.logins.length, 2);

    assert.equal((await fetchFrontivaPayinStatus('FRVREF0000001', { config: loadFrontivaPayinConfig(2) })).outcome, 'answered');
    assert.deepEqual(world.logins.map((entry) => entry.email), [SLOT[1].email, SLOT[2].email, SLOT[2].email], 'only slot 2 logged in again');

    await fetchFrontivaPayinStatus('FRVREF0000001', { config: loadFrontivaPayinConfig(1) });
    assert.equal(world.logins.length, 3, 'slot 1 still on its first session');
  });

  test('a cached session is not presented once the slot expects a different portal merchant', async () => {
    const world = installWorld({ login: login({ merchantIdFor: { 2: 77 } }) });
    await getFrontivaSession(loadFrontivaPayinConfig(2));
    process.env.FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_2 = '78';
    await assert.rejects(getFrontivaSession(loadFrontivaPayinConfig(2)), { kind: 'merchant_mismatch' });
    assert.equal(world.logins.length, 2, 'cache bypassed, fresh login checked');
  });
});

// --- Creation -----------------------------------------------------------------

describe('POST /api/payments/frontiva-payin/create with merchant: 2', () => {
  test('creates with slot-2 credentials and signature, validates slot-2 payees, and binds the order to slot 2', async () => {
    const world = installWorld({ products: [PRODUCT], login: login(), create: create() });
    const response = await checkout({ merchant: 2 });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.launch, { type: 'upi_intent', url: intentFor(SLOT[2].payee) });
    assert.deepEqual(Object.keys(body).sort(), ['launch', 'order_id', 'order_ref', 'total_in_cents']);

    assert.deepEqual(world.logins, [{ email: SLOT[2].email, password: SLOT[2].password }], 'slot 1 never logged in');
    const [{ body: sent, headers }] = world.creates;
    assert.equal(headers.Authorization, `Bearer ${SLOT[2].token}`);
    assert.equal(headers['x-signature'], generateFrontivaSignature(body.order_ref, SLOT[2].secret));
    assert.ok(!('merchant' in sent), 'the slot is never sent to the provider');

    const order = orderIn(world, body.order_ref);
    assert.equal(order.payment_gateway, 'frontiva_payin');
    assert.equal(order.frontiva_payin_merchant, 2);
    assert.equal(order.airpay_merchant, undefined, 'not an Airpay merchant');

    const [txn] = world.tables.frontiva_payin_transactions;
    assert.equal(txn.portal_merchant_id, '77');
    assert.equal(txn.upi_intent, intentFor(SLOT[2].payee));
    assert.ok(events().some((e) => e.event === 'payment.frontiva_payin.create.ok' && e.merchant === 2));
    assert.deepEqual(world.forbidden, [], 'no Airpay, SabPaisa or KKChat call');
  });

  test('a slot-2 QR encodes the slot-2 intent untransformed', async () => {
    installWorld({ products: [PRODUCT], login: login(), create: create() });
    const { launch } = (await checkout({ merchant: 2 })).json();
    assert.equal(decodeRenderedQr(launch.url)?.data, intentFor(SLOT[2].payee));
  });

  test('a slot-2 intent paying slot 1\'s payee is refused (each slot has its own allowlist)', async () => {
    const world = installWorld({ products: [PRODUCT], login: login(), create: create({ payeeFor: { 2: SLOT[1].payee } }) });
    const response = await checkout({ merchant: 2 });

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().code, 'frontiva_payin_not_started');
    assert.ok(!JSON.stringify(response.json()).includes('upi://'));
    assert.equal(world.tables.frontiva_payin_transactions[0].create_state, 'created_not_launched');
  });

  test('slot 1 keeps its original request and order insert (no merchant key, no slot column)', async () => {
    const world = installWorld({ products: [PRODUCT], login: login(), create: create() });
    const response = await checkout();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(world.logins, [{ email: SLOT[1].email, password: SLOT[1].password }]);
    const order = orderIn(world, response.json().order_ref);
    assert.ok(!('frontiva_payin_merchant' in order), 'slot 1 never names the new column');

    installWorld({ products: [PRODUCT], login: login(), create: create() });
    resetFrontivaSession();
    assert.equal((await checkout({ merchant: 1, attempt_id: ATTEMPT_2 })).statusCode, 200, 'an explicit 1 is slot 1');
  });

  test('invalid merchant values are refused before any login, order or PayIn', async () => {
    for (const merchant of [0, 4, '4', -1, 1.5, 'two', null, '', {}, [2], true]) {
      const world = installWorld({ products: [PRODUCT], login: login(), create: create() });
      const response = await checkout({ merchant });

      assert.equal(response.statusCode, 400, JSON.stringify(merchant));
      assert.equal(response.json().code, 'invalid_merchant');
      assert.equal(world.logins.length + world.creates.length + world.tables.orders.length, 0);
    }
  });

  test('a disabled slot 2 is refused and never moved to slot 1; slot 1 carries on', async () => {
    process.env.FRONTIVA_PAYIN_ENABLED_2 = 'false';
    const world = installWorld({ products: [PRODUCT], login: login(), create: create() });

    const refused = await checkout({ merchant: 2 });
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.json().code, 'frontiva_payin_unavailable');
    assert.equal(world.logins.length + world.creates.length + world.tables.orders.length, 0);

    assert.equal((await checkout()).statusCode, 200);
    assert.deepEqual(world.logins.map((entry) => entry.email), [SLOT[1].email]);
  });

  test('slot 2 missing its config is refused, never served with slot 1\'s credentials', async () => {
    delete process.env.FRONTIVA_PAYIN_PASSWORD_2;
    const world = installWorld({ products: [PRODUCT], login: login(), create: create() });
    assert.equal((await checkout({ merchant: 2 })).statusCode, 503);
    assert.equal(world.logins.length, 0);
  });

  test('the same slot-2 attempt sent twice creates one order and one PayIn', async () => {
    const world = installWorld({ products: [PRODUCT], login: login(), create: create() });
    const first = await checkout({ merchant: 2 });
    const second = await checkout({ merchant: 2 });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().order_ref, first.json().order_ref);
    assert.equal(world.creates.length, 1);
    assert.equal(world.tables.orders.length, 1);
  });

  test('slot 1 and slot 2 orders get distinct references', async () => {
    installWorld({ products: [PRODUCT], login: login(), create: create() });
    const one = (await checkout()).json().order_ref;
    const two = (await checkout({ merchant: 2, attempt_id: ATTEMPT_2 })).json().order_ref;
    assert.notEqual(one, two);
  });
});

// --- Settlement ---------------------------------------------------------------

describe('settlement uses the merchant the order was placed on', () => {
  test('frontivaSlotForOrder: NULL is slot 1, a known value is itself, anything else is null', () => {
    assert.equal(frontivaSlotForOrder({}), 1);
    assert.equal(frontivaSlotForOrder({ frontiva_payin_merchant: null }), 1);
    assert.equal(frontivaSlotForOrder({ frontiva_payin_merchant: 2 }), 2);
    assert.equal(frontivaSlotForOrder({ frontiva_payin_merchant: '2' }), 2);
    assert.equal(frontivaSlotForOrder({ frontiva_payin_merchant: 3 }), 3);
    for (const bad of [0, 4, 7, 'x', 1.5]) assert.equal(frontivaSlotForOrder({ frontiva_payin_merchant: bad }), null);
  });

  test('a slot-2 order is checked with slot-2 credentials only and paid on a verified COMPLETED', async () => {
    const row = payinOrder({ frontiva_payin_merchant: 2 });
    const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({ 2: { [row.order_ref]: { status: 'COMPLETED' } } }) });

    const result = await confirmFrontivaPayin(row.order_ref);

    assert.equal(result.status, 'paid');
    assert.deepEqual(world.logins.map((entry) => entry.email), [SLOT[2].email]);
    assert.ok(world.statuses.every(({ headers }) => headers.Authorization === `Bearer ${SLOT[2].token}`));
    assert.equal(orderIn(world, row.order_ref).gateway_txn_id, 'UTR-2');
  });

  test('a legacy order (NULL slot) is still checked with slot 1', async () => {
    const row = payinOrder({ order_ref: 'FRVLEGACY00001' });
    const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({ 1: { [row.order_ref]: { status: 'COMPLETED' } } }) });

    assert.equal((await confirmFrontivaPayin(row.order_ref)).status, 'paid');
    assert.deepEqual(world.logins.map((entry) => entry.email), [SLOT[1].email]);
  });

  test('slot-1 and slot-2 orders settle side by side, each paid against its own account only', async () => {
    const one = payinOrder({ id: 1, order_ref: 'FRVSLOTONE0001' });
    const two = payinOrder({ id: 2, order_ref: 'FRVSLOTTWO0001', frontiva_payin_merchant: 2 });
    // Account 1 knows only order one, account 2 only order two.
    const world = installWorld({
      tables: { orders: [one, two] },
      login: login(),
      status: status({ 1: { [one.order_ref]: { status: 'COMPLETED' } }, 2: { [two.order_ref]: { status: 'FAILED' } } }),
    });

    assert.equal((await confirmFrontivaPayin(one.order_ref)).status, 'paid');
    assert.equal((await confirmFrontivaPayin(two.order_ref)).status, 'failed');
    assert.equal(orderIn(world, one.order_ref).payment_status, 'paid');
    assert.equal(orderIn(world, two.order_ref).payment_status, 'failed', 'a failed slot-2 payment is never paid');
  });

  test('slot 2 PENDING stays open; answers naming slot 1\'s merchant or the wrong amount are not paid', async () => {
    for (const [entry, expected] of [
      [{ status: 'PENDING' }, 'processing'],
      [{ status: 'COMPLETED', merchantId: 42 }, 'requires_review'],
      [{ status: 'COMPLETED', requestedAmount: '1.00' }, 'requires_review'],
    ]) {
      resetFrontivaSession();
      const row = payinOrder({ frontiva_payin_merchant: 2 });
      const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({ 2: { [row.order_ref]: entry } }) });
      assert.equal((await confirmFrontivaPayin(row.order_ref)).status, expected, JSON.stringify(entry));
      assert.notEqual(orderIn(world, row.order_ref).payment_status, 'paid');
    }
  });

  test('concurrent checks of one slot-2 order pay it exactly once', async () => {
    const row = payinOrder({ frontiva_payin_merchant: 2 });
    const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({ 2: { [row.order_ref]: { status: 'COMPLETED' } } }) });

    const results = await Promise.all([confirmFrontivaPayin(row.order_ref), confirmFrontivaPayin(row.order_ref), confirmFrontivaPayin(row.order_ref)]);

    assert.equal(results.filter((r) => r.changed).length, 1);
    assert.equal(world.statuses.length, 1, 'one provider check');
    assert.equal(events().filter((e) => e.event === 'payment.settle.applied').length, 1);
    assert.equal(orderIn(world, row.order_ref).payment_status, 'paid');
    assert.equal((await confirmFrontivaPayin(row.order_ref)).changed, false, 'a paid order never moves again');
  });

  test('slot 2 unconfigured: its orders go to review and are NEVER checked with slot 1', async () => {
    delete process.env.FRONTIVA_PAYIN_EMAIL_2;
    const row = payinOrder({ frontiva_payin_merchant: 2 });
    const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({ 1: { [row.order_ref]: { status: 'COMPLETED' } } }) });

    const result = await confirmFrontivaPayin(row.order_ref);

    assert.equal(result.status, 'requires_review');
    assert.equal(world.logins.length, 0, 'no login on any account');
    assert.equal(world.statuses.length, 0, 'no status call on any account');
  });

  test('an unknown slot value makes no provider call and changes nothing', async () => {
    for (const value of [7, 0, 'x']) {
      const row = payinOrder({ frontiva_payin_merchant: value });
      const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({ 1: { [row.order_ref]: { status: 'COMPLETED' } } }) });

      const result = await confirmFrontivaPayin(row.order_ref);

      assert.equal(result.changed, false);
      assert.equal(result.reason, 'unknown frontiva merchant');
      assert.equal(world.logins.length + world.statuses.length, 0);
      assert.equal(orderIn(world, row.order_ref).payment_status, 'initiated');
    }
  });

  test('a PayIn created under another portal merchant than the slot now expects goes to review without a check', async () => {
    const row = payinOrder({ frontiva_payin_merchant: 2 });
    const world = installWorld({
      tables: { orders: [row], frontiva_payin_transactions: [{ order_ref: row.order_ref, portal_merchant_id: '55' }] },
      login: login(),
      status: status({ 2: { [row.order_ref]: { status: 'COMPLETED' } } }),
    });

    const result = await confirmFrontivaPayin(row.order_ref);

    assert.equal(result.status, 'requires_review');
    assert.equal(world.statuses.length, 0);
  });

  test('a disabled slot 2 still settles its open orders through /status and reconciliation', async () => {
    process.env.FRONTIVA_PAYIN_ENABLED_2 = 'false';
    const viaStatus = payinOrder({ order_ref: 'FRVSLOTTWO0001', frontiva_payin_merchant: 2 });
    const viaCron = payinOrder({ id: 2, order_ref: 'FRVSLOTTWO0002', frontiva_payin_merchant: 2, created_at: minutesAgo(30) });
    const world = installWorld({
      tables: { orders: [viaStatus, viaCron] },
      login: login(),
      status: status({ 2: { [viaStatus.order_ref]: { status: 'COMPLETED' }, [viaCron.order_ref]: { status: 'COMPLETED' } } }),
    });

    const page = (await call(statusHandler, { method: 'GET', url: `/api/payments/status?ref=${viaStatus.order_ref}` })).json();
    assert.equal(page.order.payment_status, 'paid');

    const cron = (await call(reconcileHandler, { headers: { authorization: `Bearer ${CRON_SECRET}` } })).json();
    assert.equal(cron.settled, 1);
    assert.equal(orderIn(world, viaCron.order_ref).payment_status, 'paid');
    assert.ok(world.logins.every((entry) => entry.email === SLOT[2].email));
  });
});

// --- Discovery, status page, health, secrets ----------------------------------

describe('options, status page, health and secrets', () => {
  test('options adds frontiva_payin_merchants only when a slot ≥ 2 is on; slot 1 key unchanged', async () => {
    const body = async () => (await call(optionsHandler, { method: 'GET' })).json();

    assert.deepEqual(await body(), { merchants: [], sabpaisa: false, frontiva_payin: true, frontiva_payin_merchants: [1, 2] });

    process.env.FRONTIVA_PAYIN_ENABLED_2 = 'false';
    assert.deepEqual(await body(), { merchants: [], sabpaisa: false, frontiva_payin: true }, 'byte-identical to before slot 2');

    process.env.FRONTIVA_PAYIN_ENABLED_2 = 'true';
    process.env.FRONTIVA_PAYIN_ENABLED = 'false';
    assert.deepEqual(await body(), { merchants: [], sabpaisa: false, frontiva_payin_merchants: [2] });
  });

  test('the status page names the payee of the order\'s own account', async () => {
    const one = payinOrder({ id: 1, order_ref: 'FRVSLOTONE0001', payment_status: 'paid', status: 'paid' });
    const two = payinOrder({ id: 2, order_ref: 'FRVSLOTTWO0001', frontiva_payin_merchant: 2, payment_status: 'paid', status: 'paid' });
    installWorld({ tables: { orders: [one, two] } });

    const get = async (ref) => (await call(statusHandler, { method: 'GET', url: `/api/payments/status?ref=${ref}` })).json();
    assert.equal((await get(one.order_ref)).payee_name, 'Frontiva Trading Private Limited');
    assert.equal((await get(two.order_ref)).payee_name, 'Second Trading LLP');

    delete process.env.FRONTIVA_PAYIN_PAYEE_NAME_2;
    assert.equal((await get(two.order_ref)).payee_name, undefined, 'never slot 1\'s name for a slot-2 order');
  });

  test('health reports slot 2 on its own key; the slot-1 block keeps its shape', async () => {
    process.env.FRONTIVA_PAYIN_ENABLED_2 = 'false';
    const body = (await call(healthHandler, { method: 'GET', url: '/api/health' })).json();

    assert.deepEqual(Object.keys(body.frontiva_payin).sort(), ['configured', 'enabled', 'offered_at_checkout']);
    assert.deepEqual(body.frontiva_payin_merchants, {
      2: { configured: true, enabled: false, offered_at_checkout: false },
      3: { configured: false, enabled: false, offered_at_checkout: false },
    });
    assert.ok(!JSON.stringify(body).includes(SLOT[2].email), 'no login email in health');
  });

  test('slot 2\'s password is scrubbed from logged text, and no secret is logged during a slot-2 payment', async () => {
    assert.equal(scrubSecrets(`echo ${SLOT[2].password} back`), 'echo [redacted] back');

    installWorld({ products: [PRODUCT], login: login(), create: create() });
    await checkout({ merchant: 2 });
    const text = logs.join('\n');
    for (const secret of [SLOT[2].password, SLOT[2].token, SLOT[2].secret, SLOT[2].email]) {
      assert.ok(!text.includes(secret), 'secret or login email leaked into logs');
    }
  });

  test('no slot-2 variable or login email reaches the browser bundle', () => {
    for (const file of ['../apps/web/src/api/OrdersApi.js', '../apps/web/src/pages/CheckoutPage.jsx', '../apps/web/src/pages/SuccessPage.jsx']) {
      // FRONTIVA_PAYIN_GATEWAY_2 is the browser's option id, not a variable.
      assert.doesNotMatch(read(file), /FRONTIVA_PAYIN_(?!GATEWAY_2\b)[A-Z_]*_2|@example\.com|frontivauser/, file);
    }
  });

  test('the migration is additive and leaves the gateway constraint alone', () => {
    const sql = read('../migrations-frontiva-payin-merchants.sql');
    assert.match(sql, /add column if not exists frontiva_payin_merchant smallint/);
    assert.match(sql, /frontiva_payin_merchant is null/);
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bdrop (column|table)\b|\bupdate\b|\bdelete\b|orders_payment_gateway_check|airpay_merchant/i);
  });
});


// --- Slot 3: replaces the Airpay MID 3 checkout option ------------------------

describe('Frontiva PayIn slot 3 (the third checkout option)', () => {
  beforeEach(() => {
    Object.assign(process.env, SLOT3_ENV);
  });

  test('slot 3 loads only its own credentials, payees and payee name', () => {
    const three = loadFrontivaPayinConfig(3);
    assert.equal(three.slot, 3);
    assert.equal(three.email, SLOT[3].email);
    assert.equal(three.password, SLOT[3].password);
    assert.equal(three.expectedMerchantId, '91');
    assert.deepEqual(three.allowedPayees, [SLOT[3].payee]);
    assert.equal(three.payeeName, 'Third Trading LLP');
    assert.equal(loadFrontivaPayinConfig(2).email, SLOT[2].email, 'slot 2 unchanged');
    assert.equal(loadFrontivaPayinConfig(1).email, SLOT[1].email, 'slot 1 unchanged');
  });

  test('a missing slot-3 value is an error for slot 3 and never borrows slot 1 or 2', () => {
    for (const name of ['EMAIL', 'PASSWORD', 'EXPECTED_MERCHANT_ID']) {
      const saved = process.env[`FRONTIVA_PAYIN_${name}_3`];
      delete process.env[`FRONTIVA_PAYIN_${name}_3`];
      assert.throws(() => loadFrontivaPayinConfig(3), undefined, name);
      assert.equal(frontivaPayinAvailable(3), false);
      process.env[`FRONTIVA_PAYIN_${name}_3`] = saved;
    }
  });

  test('is offered only when enabled; slots 1 and 2 are unaffected either way', () => {
    assert.deepEqual(availableFrontivaMerchants(), [1, 2, 3]);
    process.env.FRONTIVA_PAYIN_ENABLED_3 = 'false';
    assert.deepEqual(availableFrontivaMerchants(), [1, 2]);
    delete process.env.FRONTIVA_PAYIN_ENABLED_3;
    assert.deepEqual(availableFrontivaMerchants(), [1, 2], 'default off');
  });

  test("slot 3 reusing another slot's login or merchant id is never offered; slots 1 and 2 stay on", () => {
    process.env.FRONTIVA_PAYIN_EMAIL_3 = SLOT[2].email;
    assert.deepEqual(availableFrontivaMerchants(), [1, 2]);
    process.env.FRONTIVA_PAYIN_EMAIL_3 = SLOT[3].email;
    process.env.FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID_3 = '42';
    assert.deepEqual(availableFrontivaMerchants(), [1, 2]);
  });

  test('options lists slot 3 on the PayIn key and never as an Airpay merchant', async () => {
    const body = (await call(optionsHandler, { method: 'GET' })).json();
    assert.deepEqual(body.frontiva_payin_merchants, [1, 2, 3]);
    assert.ok(!body.merchants.includes(3), 'Airpay MID 3 is no longer offered');
  });

  test('health reports slot 3 on its own key, booleans only', async () => {
    const body = (await call(healthHandler, { method: 'GET', url: '/api/health' })).json();
    assert.deepEqual(body.frontiva_payin_merchants['3'], { configured: true, enabled: true, offered_at_checkout: true });
    const text = JSON.stringify(body);
    for (const secret of [SLOT[3].email, SLOT[3].password, SLOT[3].payee]) assert.ok(!text.includes(secret));
  });

  test('creates with slot-3 credentials and signature, validates slot-3 payees, and binds the order to slot 3', async () => {
    const world = installWorld({ products: [PRODUCT], login: login(), create: create() });
    const response = await checkout({ merchant: 3 });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.launch, { type: 'upi_intent', url: intentFor(SLOT[3].payee) });
    assert.deepEqual(world.logins, [{ email: SLOT[3].email, password: SLOT[3].password }], 'slots 1 and 2 never logged in');
    const [{ body: sent, headers }] = world.creates;
    assert.equal(headers.Authorization, `Bearer ${SLOT[3].token}`);
    assert.equal(headers['x-signature'], generateFrontivaSignature(body.order_ref, SLOT[3].secret));
    assert.ok(!('merchant' in sent), 'the slot is never sent to the provider');

    const order = orderIn(world, body.order_ref);
    assert.equal(order.payment_gateway, 'frontiva_payin');
    assert.equal(order.frontiva_payin_merchant, 3);
    assert.equal(order.airpay_merchant, undefined, 'not an Airpay merchant');
    assert.equal(world.tables.frontiva_payin_transactions[0].portal_merchant_id, '91');
    assert.equal(decodeRenderedQr(body.launch.url)?.data, intentFor(SLOT[3].payee));
    assert.ok(events().some((e) => e.event === 'payment.frontiva_payin.create.ok' && e.merchant === 3));
    assert.deepEqual(world.forbidden, [], 'no Airpay, SabPaisa or KKChat call');
  });

  test("a slot-3 intent paying another slot's payee is refused", async () => {
    for (const other of [1, 2]) {
      resetFrontivaSession();
      const world = installWorld({ products: [PRODUCT], login: login(), create: create({ payeeFor: { 3: SLOT[other].payee } }) });
      const response = await checkout({ merchant: 3, attempt_id: other === 1 ? ATTEMPT : ATTEMPT_2 });
      assert.equal(response.statusCode, 502);
      assert.equal(response.json().code, 'frontiva_payin_not_started');
      assert.ok(!JSON.stringify(response.json()).includes('upi://'));
      assert.equal(world.tables.frontiva_payin_transactions[0].create_state, 'created_not_launched');
    }
  });

  test('a disabled or unconfigured slot 3 is refused and never moved to another slot', async () => {
    for (const change of [() => { process.env.FRONTIVA_PAYIN_ENABLED_3 = 'false'; }, () => { delete process.env.FRONTIVA_PAYIN_PASSWORD_3; }]) {
      change();
      const world = installWorld({ products: [PRODUCT], login: login(), create: create() });
      const refused = await checkout({ merchant: 3 });
      assert.equal(refused.statusCode, 503);
      assert.equal(refused.json().code, 'frontiva_payin_unavailable');
      assert.equal(world.logins.length + world.creates.length + world.tables.orders.length, 0);
      Object.assign(process.env, SLOT3_ENV);
    }
  });

  test('slots 1 and 2 still send their original requests', async () => {
    const world = installWorld({ products: [PRODUCT], login: login(), create: create() });
    const one = await checkout();
    assert.equal(one.statusCode, 200);
    assert.ok(!('frontiva_payin_merchant' in orderIn(world, one.json().order_ref)));
    resetFrontivaSession();
    const two = await checkout({ merchant: 2, attempt_id: ATTEMPT_2 });
    assert.equal(orderIn(world, two.json().order_ref).frontiva_payin_merchant, 2);
    assert.deepEqual(world.logins.map((entry) => entry.email), [SLOT[1].email, SLOT[2].email]);
  });

  test('a slot-3 order is checked with slot-3 credentials only and paid on a verified COMPLETED', async () => {
    const row = payinOrder({ order_ref: 'FRVSLOTTHREE01', frontiva_payin_merchant: 3 });
    const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({ 3: { [row.order_ref]: { status: 'COMPLETED' } } }) });

    assert.equal((await confirmFrontivaPayin(row.order_ref)).status, 'paid');
    assert.deepEqual(world.logins.map((entry) => entry.email), [SLOT[3].email]);
    assert.ok(world.statuses.every(({ headers }) => headers.Authorization === `Bearer ${SLOT[3].token}`));
    assert.equal(orderIn(world, row.order_ref).gateway_txn_id, 'UTR-3');
  });

  test('slot 3 PENDING stays open; answers naming another merchant or the wrong amount are not paid', async () => {
    for (const [entry, expected] of [
      [{ status: 'PENDING' }, 'processing'],
      [{ status: 'COMPLETED', merchantId: 77 }, 'requires_review'],
      [{ status: 'COMPLETED', requestedAmount: '1.00' }, 'requires_review'],
      [{ status: 'FAILED' }, 'failed'],
    ]) {
      resetFrontivaSession();
      const row = payinOrder({ order_ref: 'FRVSLOTTHREE01', frontiva_payin_merchant: 3 });
      const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({ 3: { [row.order_ref]: entry } }) });
      assert.equal((await confirmFrontivaPayin(row.order_ref)).status, expected, JSON.stringify(entry));
      assert.notEqual(orderIn(world, row.order_ref).payment_status, 'paid');
    }
  });

  test("a slot-3 order is never verified with slot 1 or 2, even when slot 3's config is gone", async () => {
    delete process.env.FRONTIVA_PAYIN_PASSWORD_3;
    const row = payinOrder({ order_ref: 'FRVSLOTTHREE01', frontiva_payin_merchant: 3 });
    // Accounts 1 and 2 would both say COMPLETED if (wrongly) asked.
    const world = installWorld({
      tables: { orders: [row] }, login: login(),
      status: status({ 1: { [row.order_ref]: { status: 'COMPLETED' } }, 2: { [row.order_ref]: { status: 'COMPLETED' } } }),
    });

    const result = await confirmFrontivaPayin(row.order_ref);
    assert.notEqual(result.status, 'paid');
    assert.equal(world.logins.length + world.statuses.length, 0, 'no provider call on any account');
    assert.notEqual(orderIn(world, row.order_ref).payment_status, 'paid');
  });

  test('a disabled slot 3 still settles its existing orders', async () => {
    process.env.FRONTIVA_PAYIN_ENABLED_3 = 'false';
    const row = payinOrder({ order_ref: 'FRVSLOTTHREE01', frontiva_payin_merchant: 3 });
    installWorld({ tables: { orders: [row] }, login: login(), status: status({ 3: { [row.order_ref]: { status: 'COMPLETED' } } }) });
    assert.equal((await confirmFrontivaPayin(row.order_ref)).status, 'paid');
  });

  test('an unknown stored slot makes no provider call', async () => {
    const row = payinOrder({ frontiva_payin_merchant: 4 });
    const world = installWorld({ tables: { orders: [row] }, login: login(), status: status({}) });
    await confirmFrontivaPayin(row.order_ref);
    assert.equal(world.logins.length + world.statuses.length, 0);
    assert.notEqual(orderIn(world, row.order_ref).payment_status, 'paid');
  });

  test('sessions are per slot: a failed slot-3 login blocks neither slot 1 nor slot 2, and tokens are never shared', async () => {
    process.env.FRONTIVA_PAYIN_PASSWORD_3 = 'wrong-password';
    installWorld({ login: login() });
    await assert.rejects(getFrontivaSession(loadFrontivaPayinConfig(3)));
    assert.equal((await getFrontivaSession(loadFrontivaPayinConfig(1))).accessToken, SLOT[1].token);
    assert.equal((await getFrontivaSession(loadFrontivaPayinConfig(2))).accessToken, SLOT[2].token);

    process.env.FRONTIVA_PAYIN_PASSWORD_3 = SLOT[3].password;
    resetFrontivaSession();
    assert.equal((await getFrontivaSession(loadFrontivaPayinConfig(3))).accessToken, SLOT[3].token);
    assert.equal((await getFrontivaSession(loadFrontivaPayinConfig(1))).accessToken, SLOT[1].token);
  });

  test('a wrong portal merchant id at login fails slot 3 safely', async () => {
    installWorld({ login: login({ merchantIdFor: { 3: 42 } }) });
    await assert.rejects(getFrontivaSession(loadFrontivaPayinConfig(3)), { kind: 'merchant_mismatch' });
  });

  test("slot 3's password is scrubbed, and no slot-3 secret or login email is logged during a slot-3 payment", async () => {
    assert.equal(scrubSecrets(`echo ${SLOT[3].password} back`), 'echo [redacted] back');
    installWorld({ products: [PRODUCT], login: login(), create: create() });
    await checkout({ merchant: 3 });
    const text = logs.join('\n');
    for (const secret of [SLOT[3].password, SLOT[3].token, SLOT[3].secret, SLOT[3].email]) {
      assert.ok(!text.includes(secret), 'secret or login email leaked into logs');
    }
  });

  test('no slot-3 variable or login email reaches the browser bundle; Airpay 3 is commented, not live', () => {
    const files = ['../apps/web/src/api/OrdersApi.js', '../apps/web/src/pages/CheckoutPage.jsx', '../apps/web/src/pages/SuccessPage.jsx'].map(read);
    for (const source of files) {
      assert.ok(!/FRONTIVA_PAYIN_[A-Z_]*_3\b|third@/.test(source.replace(/FRONTIVA_PAYIN_GATEWAY_3/g, '')));
    }
    const checkoutPage = files[1];
    assert.match(checkoutPage, /^\s*\{ id: FRONTIVA_PAYIN_GATEWAY_3, label: 'Pay with Frontiva PayIn 3' \},$/m);
    assert.match(checkoutPage, /^\s*\/\/ \{ id: 3, label: 'Pay with Airpay 3' \},$/m);
    assert.ok(!/^\s*\{ id: 3,/m.test(checkoutPage), 'no live Airpay gateway 3 entry');
  });
});
