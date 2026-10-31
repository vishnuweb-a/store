/**
 * Frontiva PayIn: signature, login/session, creation, status verification,
 * settlement, reconciliation and isolation from Airpay / SabPaisa / KKChat.
 *
 * Every request is answered by an in-memory fake (tests/helpers/fake-world.js).
 * Nothing reaches the network and no test can move money.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test, { afterEach, beforeEach, describe } from 'node:test';
import jsQR from 'jsqr';
import { QRCodeSVG } from 'qrcode.react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  classifyFrontivaStatus,
  createFrontivaPayin,
  decideFrontivaSettlement,
  fetchFrontivaPayinStatus,
  frontivaPayinAvailable,
  generateFrontivaSignature,
  getFrontivaSession,
  loadFrontivaPayinConfig,
  paiseToRupees,
  resetFrontivaSession,
  resolveFrontivaLaunch,
  rupeesToPaise,
  upiIntentProblem,
} from '../api/_lib/frontiva-payin.js';
import { confirmFrontivaPayin, findFrontivaPayinIntent, listFrontivaPayinDue } from '../api/_lib/frontiva-payin-orders.js';
import { settleOrder } from '../api/_lib/orders.js';
import createHandler from '../api/payments/frontiva-payin/create.js';
import reconcileHandler from '../api/payments/frontiva-payin/reconcile.js';
import optionsHandler from '../api/payments/options.js';
import statusHandler from '../api/payments/status.js';
import { PORTAL, installWorld, respond } from './helpers/fake-world.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

// Fixtures only. Not real credentials.
const PASSWORD = 'fixture-portal-password-xyz';
const CLIENT_SECRET = 'fixture_client_secret_123';
const ACCESS_TOKEN = 'fixture.access.token-abc';
const CRON_SECRET = 'fixture-cron-secret-for-frontiva-tests';
const REF = 'FRVTESTREF0001';
const ATTEMPT = '3f1c2a7e-8b4d-4c1a-9e2f-0a1b2c3d4e5f';

const ENV = {
  FRONTIVA_PAYIN_ENABLED: 'true',
  FRONTIVA_PAYIN_EMAIL: 'merchant@example.com',
  FRONTIVA_PAYIN_PASSWORD: PASSWORD,
  FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID: '42',
  FRONTIVA_PAYIN_ALLOWED_PAYEES: 'merchant@bank',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE: 'fixture-service-role',
  CRON_SECRET,
};

const PRODUCT = {
  id: 7, title: 'Linen Shirt', price: 1500, discount_price: null, active: true,
  track_quantity: false, stock: 0, sizes: [], sku: 'LS-1', image_url: null,
};

// Same parameter set as the verified provider sample (values are fixtures; tr differs from our reference).
const UPI = 'upi://pay?pa=merchant@bank&pn=Frontiva+Trading+Private+Limited&cu=INR&tn=Pay+to+Frontiva&am=1500.00&mc=5691&mode=04&tr=AIRPAY0000000001';

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

const loginOk = (overrides = {}) => () =>
  respond(200, {
    success: true,
    message: 'Login successful',
    data: {
      accessToken: ACCESS_TOKEN,
      refreshToken: 'fixture.refresh',
      user: { id: 2, merchantId: 42, clientSecret: CLIENT_SECRET, ...overrides },
    },
  });

const createOk = (overrides = {}) => (body) =>
  respond(201, {
    id: 810333, merchantId: 42, amount: String(body.amount), status: 'PENDING',
    merchantReference: body.merchantReference, paymentMode: 'UPI_INTENT', callbackNeeded: true,
    url: null, intent: UPI, ...overrides,
  });

const statusAnswer = (fields) => (ref) =>
  respond(200, {
    success: true,
    data: { id: 810333, merchantReference: ref, requestedAmount: '1500.00', amountToCredit: '1410', status: 'COMPLETED', utr: 'UTR123', ...fields },
  });

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
  id: 1, order_ref: REF, customer_name: 'Asha Menon', phone: '9876543210', address: 'x', landmark: null,
  payment_method: 'Online Payment', status: 'initiated', payment_status: 'initiated', total: 1500,
  items: [], payment_gateway: 'frontiva_payin', enquiry_count: 0, last_checked_at: null,
  created_at: minutesAgo(1), ...overrides,
});

const orderIn = (state, ref = REF) => state.tables.orders.find((row) => row.order_ref === ref);
const status = (ref = REF, key = null) =>
  call(statusHandler, { method: 'GET', url: `/api/payments/status?ref=${ref}${key ? `&k=${key}` : ''}` });

// --- Signature and amounts ----------------------------------------------------

describe('generateFrontivaSignature', () => {
  test('matches an independently computed HMAC-SHA256 (openssl) of the exact reference', () => {
    assert.equal(
      generateFrontivaSignature(REF, CLIENT_SECRET),
      'db6c1f0b1e61bc915289044c7aceadb2765bcdd58d2c64f8c644fe098306e138',
    );
  });

  test('is case-sensitive on the reference and refuses missing inputs', () => {
    assert.notEqual(generateFrontivaSignature(REF.toLowerCase(), CLIENT_SECRET), generateFrontivaSignature(REF, CLIENT_SECRET));
    assert.throws(() => generateFrontivaSignature(REF, ''));
    assert.throws(() => generateFrontivaSignature('', CLIENT_SECRET));
    assert.throws(() => generateFrontivaSignature(REF, undefined));
  });
});

describe('amount conversion', () => {
  test('decimal rupees to integer paise, exactly', () => {
    assert.equal(rupeesToPaise('1500'), 150000);
    assert.equal(rupeesToPaise('1500.5'), 150050);
    assert.equal(rupeesToPaise('1500.05'), 150005);
    assert.equal(rupeesToPaise(1500), 150000);
    for (const bad of ['', '1,500', '-1', '1.005', 'abc', null, undefined, true, '1e3']) {
      assert.equal(rupeesToPaise(bad), null, String(bad));
    }
  });

  test('paise to the documented decimal amount', () => {
    assert.equal(paiseToRupees(150000), 1500);
    assert.equal(paiseToRupees(150005), 1500.05);
    assert.equal(paiseToRupees(100), 1);
  });
});

// --- Configuration ------------------------------------------------------------

describe('configuration and feature flag', () => {
  test('defaults off; only an explicit true enables', () => {
    delete process.env.FRONTIVA_PAYIN_ENABLED;
    assert.equal(frontivaPayinAvailable(), false);
    process.env.FRONTIVA_PAYIN_ENABLED = 'yes';
    assert.equal(frontivaPayinAvailable(), false);
    process.env.FRONTIVA_PAYIN_ENABLED = 'true';
    assert.equal(frontivaPayinAvailable(), true);
  });

  test('missing merchant id, non-https base URL or no service role keeps it unavailable', () => {
    delete process.env.FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID;
    assert.equal(frontivaPayinAvailable(), false);
    process.env.FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID = '42';
    process.env.FRONTIVA_PAYIN_BASE_URL = 'http://portal.frontiva.online';
    assert.throws(() => loadFrontivaPayinConfig(), /https/);
    delete process.env.FRONTIVA_PAYIN_BASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    process.env.SUPABASE_ANON_KEY = 'anon';
    assert.equal(frontivaPayinAvailable(), false);
  });

  test('options names frontiva_payin only when available, leaving the old body untouched otherwise', async () => {
    assert.deepEqual((await call(optionsHandler, { method: 'GET' })).json(), {
      merchants: [], sabpaisa: false, frontiva_payin: true,
    });
    process.env.FRONTIVA_PAYIN_ENABLED = 'false';
    assert.deepEqual((await call(optionsHandler, { method: 'GET' })).json(), { merchants: [], sabpaisa: false });
  });
});

// --- Authentication -----------------------------------------------------------

describe('portal login and session', () => {
  const config = () => loadFrontivaPayinConfig();

  test('logs in once and reuses the session; concurrent callers share one login', async () => {
    const world = installWorld({ login: loginOk() });
    const sessions = await Promise.all(Array.from({ length: 5 }, () => getFrontivaSession(config())));
    await getFrontivaSession(config());
    assert.equal(world.logins.length, 1);
    assert.deepEqual(world.logins[0], { email: 'merchant@example.com', password: PASSWORD });
    assert.ok(sessions.every((s) => s.clientSecret === CLIENT_SECRET && s.merchantId === '42'));
  });

  test('invalid credentials fail, and a cooldown prevents a login storm', async () => {
    const world = installWorld({ login: () => respond(401, { success: false }) });
    await assert.rejects(getFrontivaSession(config()), { kind: 'invalid_credentials' });
    await assert.rejects(getFrontivaSession(config()), { kind: 'invalid_credentials' });
    assert.equal(world.logins.length, 1);
  });

  for (const [name, user, top] of [
    ['missing client secret', { clientSecret: undefined }, {}],
    ['missing access token', {}, { accessToken: undefined }],
  ]) {
    test(`${name} is a malformed login`, async () => {
      installWorld({
        login: () => respond(200, { success: true, data: { accessToken: ACCESS_TOKEN, user: { merchantId: 42, clientSecret: CLIENT_SECRET, ...user }, ...top } }),
      });
      await assert.rejects(getFrontivaSession(config()), { kind: 'malformed' });
    });
  }

  test('another portal merchant fails closed', async () => {
    installWorld({ login: loginOk({ merchantId: 99 }) });
    await assert.rejects(getFrontivaSession(config()), { kind: 'merchant_mismatch' });
  });

  test('the confirmed live login shape (numeric merchantId 1, refreshToken, defaultCurrency) signs with data.user.clientSecret', async () => {
    process.env.FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID = '1';
    const REFRESH = 'fixture.refresh.must-not-be-used';
    const world = installWorld({
      login: () => respond(200, {
        success: true,
        data: {
          accessToken: ACCESS_TOKEN,
          refreshToken: REFRESH,
          user: { id: 2, merchantId: 1, defaultCurrency: 'INR', clientSecret: CLIENT_SECRET },
        },
      }),
      status: statusAnswer({ merchantId: 1 }),
    });
    const answer = await fetchFrontivaPayinStatus(REF);
    assert.equal(answer.outcome, 'answered');
    const [{ headers }] = world.statuses;
    assert.equal(headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(headers['x-signature'], generateFrontivaSignature(REF, CLIENT_SECRET));
    assert.ok(!JSON.stringify(headers).includes(REFRESH), 'refresh token is never sent');
  });

  test('an expired session logs in again', async () => {
    const world = installWorld({ login: loginOk() });
    let clock = Date.now();
    await getFrontivaSession(config(), { now: () => clock });
    clock += 8 * 24 * 60 * 60_000;
    await getFrontivaSession(config(), { now: () => clock });
    assert.equal(world.logins.length, 2);
  });

  test('a login timeout is retried once, then reported unavailable', async () => {
    const world = installWorld({ login: loginOk() });
    const timeout = async (url, options) => {
      world.logins.push(options.body);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await assert.rejects(getFrontivaSession(config(), { fetch: timeout }), { kind: 'unavailable' });
    assert.equal(world.logins.length, 2);
  });

  test('never logs the password, token or client secret', async () => {
    installWorld({ login: () => respond(500, { echo: PASSWORD }) });
    await assert.rejects(getFrontivaSession(config()));
    const text = logs.join('\n');
    for (const secret of [PASSWORD, ACCESS_TOKEN, CLIENT_SECRET]) assert.ok(!text.includes(secret));
  });
});

// --- Creation -----------------------------------------------------------------

describe('POST /api/payments/frontiva-payin/create', () => {
  test('creates one order and one PayIn, signed and priced server-side, and returns only the launch', async () => {
    const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk() });
    const response = await checkout({ total: 1, amount: 1 });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.launch, { type: 'upi_intent', url: UPI });
    assert.deepEqual(Object.keys(body).sort(), ['launch', 'order_id', 'order_ref', 'total_in_cents']);

    const [{ body: sent, headers }] = world.creates;
    assert.deepEqual(sent, {
      merchantReference: body.order_ref,
      amount: 1500,
      currency: 'INR',
      paymentMode: 'UPI_INTENT',
      customer: { name: 'Asha Menon', email: 'asha@example.com', phone: '9876543210' },
    });
    assert.equal(headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(headers['x-signature'], generateFrontivaSignature(body.order_ref, CLIENT_SECRET));

    const order = orderIn(world, body.order_ref);
    assert.equal(order.payment_gateway, 'frontiva_payin');
    assert.equal(order.payment_status, 'initiated');
    assert.equal(order.airpay_merchant, undefined);

    const [txn] = world.tables.frontiva_payin_transactions;
    assert.equal(txn.checkout_attempt_id, ATTEMPT);
    assert.equal(txn.amount_in_paise, 150000);
    assert.equal(txn.create_state, 'created');
    assert.equal(txn.portal_request_id, '810333');
    assert.equal(txn.upi_intent, UPI, 'stored verbatim for QR restore');
    assert.equal(JSON.stringify(world.tables).includes('asha@example.com'), false, 'email is not stored');
    assert.deepEqual(world.forbidden, []);
  });

  test('the same attempt sent twice yields one order and one PayIn', async () => {
    const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk() });
    const [a, b] = await Promise.all([checkout(), checkout()]);
    const codes = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(codes, [200, 409]);
    assert.equal(world.creates.length, 1);
    assert.equal(world.tables.orders.length, 1);
    const dup = a.statusCode === 409 ? a.json() : b.json();
    assert.equal(dup.order_ref, world.tables.orders[0].order_ref);
  });

  for (const [name, overrides, pattern] of [
    ['missing email', { email: '' }, /email/i],
    ['invalid email', { email: 'not-an-email' }, /email/i],
    ['invalid phone', { customer: { fullName: 'Asha Menon', phone: '123', address: 'x' } }, /phone/i],
    ['missing attempt id', { attempt_id: 'x' }, /refresh/i],
  ]) {
    test(`${name} is refused before any order or PayIn`, async () => {
      const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk() });
      const response = await checkout(overrides);
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, pattern);
      assert.equal(world.tables.orders.length, 0);
      assert.equal(world.creates.length + world.logins.length, 0);
    });
  }

  test('an amount below the documented minimum is refused', async () => {
    const world = installWorld({ products: [{ ...PRODUCT, price: 0.5 }], login: loginOk(), create: createOk() });
    assert.equal((await checkout()).statusCode, 400);
    assert.equal(world.creates.length, 0);
  });

  test('switched off: 503 and nothing written', async () => {
    process.env.FRONTIVA_PAYIN_ENABLED = 'false';
    const world = installWorld({ products: [PRODUCT] });
    assert.equal((await checkout()).statusCode, 503);
    assert.equal(world.tables.orders.length, 0);
  });

  test('a provider 4xx closes the order as failed', async () => {
    const world = installWorld({ products: [PRODUCT], login: loginOk(), create: () => respond(422, { message: 'bad' }) });
    assert.equal((await checkout()).statusCode, 502);
    assert.equal(world.tables.orders[0].payment_status, 'failed');
    assert.equal(world.tables.frontiva_payin_transactions[0].create_state, 'rejected');
  });

  test('a failed login never reaches the create endpoint and fails the order', async () => {
    const world = installWorld({ products: [PRODUCT], login: () => respond(401, {}), create: createOk() });
    assert.equal((await checkout()).statusCode, 503);
    assert.equal(world.creates.length, 0);
    assert.equal(world.tables.orders[0].payment_status, 'failed');
  });

  test('a 401 on create logs in again and sends once more', async () => {
    let first = true;
    const world = installWorld({
      products: [PRODUCT],
      login: loginOk(),
      create: (body) => (first ? ((first = false), respond(401, {})) : createOk()(body)),
    });
    assert.equal((await checkout()).statusCode, 200);
    assert.equal(world.logins.length, 2);
    assert.equal(world.creates.length, 2);
  });

  test('ambiguous timeout: never re-POSTed; a PayIn found by status stays open', async () => {
    const world = installWorld({
      products: [PRODUCT],
      login: loginOk(),
      create: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
      status: statusAnswer({ status: 'PENDING' }),
    });
    assert.equal((await checkout()).statusCode, 502);
    assert.equal(world.creates.length, 1);
    assert.equal(world.statuses.length, 1);
    assert.equal(world.tables.orders[0].payment_status, 'initiated');
    assert.equal(world.tables.frontiva_payin_transactions[0].create_state, 'created_not_launched');
  });

  test('ambiguous malformed response: status says not found, so the order is failed', async () => {
    const world = installWorld({
      products: [PRODUCT],
      login: loginOk(),
      create: () => respond(200, 'not json'),
      status: () => respond(404, { success: false }),
    });
    assert.equal((await checkout()).statusCode, 502);
    assert.equal(world.creates.length, 1);
    assert.equal(world.tables.orders[0].payment_status, 'failed');
  });

  test('ambiguous and unknowable: held for review', async () => {
    const world = installWorld({
      products: [PRODUCT],
      login: loginOk(),
      create: () => respond(503, {}),
      status: () => respond(503, {}),
    });
    assert.equal((await checkout()).statusCode, 502);
    assert.equal(world.creates.length, 1);
    assert.equal(world.tables.orders[0].payment_status, 'requires_review');
  });

  test('a response for another amount or reference is not trusted', async () => {
    const world = installWorld({
      products: [PRODUCT],
      login: loginOk(),
      create: createOk({ amount: '15.00' }),
      status: () => respond(404, {}),
    });
    assert.equal((await checkout()).statusCode, 502);
    assert.equal(world.creates.length, 1);
  });

  test('a data:text/html url is never handed to the browser; the order stays open', async () => {
    const world = installWorld({
      products: [PRODUCT],
      login: loginOk(),
      create: createOk({ url: 'data:text/html;base64,PHNjcmlwdD4=', intent: null }),
    });
    const response = await checkout();
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes('data:text/html'));
    assert.equal(world.tables.orders[0].payment_status, 'initiated');
    assert.equal(world.tables.frontiva_payin_transactions[0].create_state, 'created_not_launched');
  });

  test('provider success with a failed metadata write still lets the customer pay', async () => {
    const world = installWorld({
      products: [PRODUCT],
      login: loginOk(),
      create: createOk(),
      dbFault: (table, method) => (table === 'frontiva_payin_transactions' && method === 'PATCH' ? respond(500, {}) : null),
    });
    assert.equal((await checkout()).statusCode, 200);
    assert.equal(world.creates.length, 1);
  });

  test('never logs or returns the password, token or client secret', async () => {
    installWorld({ products: [PRODUCT], login: loginOk(), create: createOk() });
    const response = await checkout();
    const text = logs.join('\n') + response.body;
    for (const secret of [PASSWORD, ACCESS_TOKEN, CLIENT_SECRET]) assert.ok(!text.includes(secret));
  });

  test('the verified provider response shape (direct object, url null, amount "10") returns the QR intent', async () => {
    process.env.FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID = '1';
    process.env.FRONTIVA_PAYIN_ALLOWED_PAYEES = 'frontivatrading373991.apy@rbl';
    const intent = 'upi://pay?pa=frontivatrading373991.apy@rbl&pn=Frontiva+Trading+Private+Limited&cu=INR&tn=Pay+to+Frontiva+Trading+Private+Limited&am=10.00&mc=5691&mode=04&tr=AIRPAY2094593073';
    const world = installWorld({
      products: [{ ...PRODUCT, price: 10 }],
      login: loginOk({ merchantId: 1 }),
      create: (body) => respond(201, {
        id: 41, merchantId: 1, amount: '10', status: 'PENDING', merchantReference: body.merchantReference,
        paymentMode: 'UPI_INTENT', callbackNeeded: true, url: null, intent,
      }),
    });
    const response = await checkout();
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.launch.url, intent, 'complete URI, unchanged');
    assert.notEqual(body.order_ref, 'AIRPAY2094593073', 'tr is the provider ref, not ours');
    assert.equal(world.creates[0].body.amount, 10);
    assert.equal(world.tables.frontiva_payin_transactions[0].create_state, 'created');
    assert.ok(logs.some((line) => line.includes('callback_needed')), 'callbackNeeded recorded for clarification');
    assert.deepEqual(world.forbidden, [], 'no Airpay, SabPaisa or KKChat traffic');
  });

  for (const [name, overrides] of [
    ['an unlisted payee', { intent: UPI.replace('merchant@bank', 'thief@bank') }],
    ['an intent amount other than the order', { intent: UPI.replace('am=1500.00', 'am=15.00') }],
    ['a duplicate amount parameter', { intent: `${UPI}&am=1.00` }],
    ['no intent at all', { intent: null }],
    ['another payment mode', { paymentMode: 'CARD' }],
  ]) {
    test(`${name}: no QR is returned, the PayIn stays open for reconciliation`, async () => {
      const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk(overrides) });
      const response = await checkout();
      assert.equal(response.statusCode, 502);
      assert.ok(!response.body.includes('upi://'));
      assert.equal(world.tables.orders[0].payment_status, 'initiated');
      const [txn] = world.tables.frontiva_payin_transactions;
      assert.equal(txn.create_state, 'created_not_launched');
      assert.equal(txn.upi_intent, null);
    });
  }

  test('a create response naming no or another merchant is not trusted', async () => {
    for (const merchantId of [undefined, 99]) {
      const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk({ merchantId }), status: () => respond(404, {}) });
      const response = await checkout();
      assert.equal(response.statusCode, 502, String(merchantId));
      assert.ok(!response.body.includes('upi://'));
      assert.equal(world.creates.length, 1);
    }
  });

  test('no allowed payee configured: not offered, and nothing is created', async () => {
    delete process.env.FRONTIVA_PAYIN_ALLOWED_PAYEES;
    const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk() });
    assert.equal(frontivaPayinAvailable(), false);
    assert.equal((await checkout()).statusCode, 503);
    assert.equal(world.creates.length + world.logins.length + world.tables.orders.length, 0);
  });
});

describe('QR restore on refresh', () => {
  test('the status endpoint returns the same intent, and no second PayIn is created', async () => {
    const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk(), status: statusAnswer({ status: 'PENDING' }) });
    const { order_ref: ref } = (await checkout()).json();

    const first = (await status(ref, ATTEMPT)).json();
    const second = (await status(ref, ATTEMPT)).json();
    assert.equal(first.payment_intent, UPI);
    assert.equal(second.payment_intent, UPI);
    assert.equal(first.order.payment_status, 'processing');
    assert.equal(world.creates.length, 1, 'refreshing never creates a PayIn');
    assert.equal(world.tables.orders.length, 1);
  });

  test('once paid, the QR is no longer returned', async () => {
    const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk(), status: statusAnswer({}) });
    const { order_ref: ref } = (await checkout()).json();
    world.tables.orders[0].created_at = minutesAgo(1);
    const body = (await status(ref, ATTEMPT)).json();
    assert.equal(body.order.payment_status, 'paid');
    assert.equal(body.payment_intent, undefined);
  });

  test('only open Frontiva PayIn orders with a created transaction carry an intent', async () => {
    const rows = [{ order_ref: REF, create_state: 'created', upi_intent: UPI }];
    const select = async () => rows;
    assert.equal(await findFrontivaPayinIntent(payinOrder(), ATTEMPT, { select }), UPI);
    assert.equal(await findFrontivaPayinIntent(payinOrder({ payment_status: 'processing' }), ATTEMPT, { select }), UPI);
    for (const s of ['paid', 'failed', 'requires_review']) {
      assert.equal(await findFrontivaPayinIntent(payinOrder({ payment_status: s }), ATTEMPT, { select }), null, s);
    }
    for (const gateway of [null, 'airpay', 'sabpaisa']) {
      assert.equal(await findFrontivaPayinIntent(payinOrder({ payment_gateway: gateway }), ATTEMPT, { select }), null, String(gateway));
    }
    assert.equal(await findFrontivaPayinIntent(payinOrder(), ATTEMPT, { select: async () => [{ upi_intent: 'https://x' }] }), null);
    assert.equal(await findFrontivaPayinIntent(payinOrder(), ATTEMPT, { select: async () => { throw new Error('db'); } }), null);
  });

  test('an Airpay order status response is unchanged (no payment_intent key)', async () => {
    installWorld({ tables: { orders: [payinOrder({ payment_gateway: null, payment_status: 'paid', status: 'paid' })] } });
    assert.deepEqual(Object.keys((await status()).json()), ['order']);
  });
});

describe('UPI intent validation', () => {
  const cfg = { allowedPayees: ['merchant@bank'] };
  const expected = { amountInPaise: 150000, allowedPayees: cfg.allowedPayees };

  test('the launch is the complete intent, byte-for-byte, with url null', () => {
    const { launch, problem } = resolveFrontivaLaunch({ url: null, paymentMode: 'UPI_INTENT', intent: UPI }, cfg, 150000);
    assert.equal(problem, null);
    assert.deepEqual(launch, { type: 'upi_intent', url: UPI });
    assert.equal(Buffer.compare(Buffer.from(launch.url), Buffer.from(UPI)), 0);
  });

  test('the verified provider sample shape passes against its own amount and payee', () => {
    const sample = 'upi://pay?pa=frontivatrading373991.apy@rbl&pn=Frontiva+Trading+Private+Limited&cu=INR&tn=Pay+to+Frontiva+Trading+Private+Limited&am=10.00&mc=5691&mode=04&tr=AIRPAY2094593073';
    assert.equal(upiIntentProblem(sample, { amountInPaise: 1000, allowedPayees: ['frontivatrading373991.apy@rbl'] }), null);
    // am is rupees: never read as paise.
    assert.match(upiIntentProblem(sample, { amountInPaise: 10, allowedPayees: ['frontivatrading373991.apy@rbl'] }), /amount/);
  });

  test('INR decimals compare exactly in paise', () => {
    for (const [am, paise] of [['1500', 150000], ['1500.0', 150000], ['1500.5', 150050], ['0.10', 10]]) {
      assert.equal(upiIntentProblem(UPI.replace('am=1500.00', `am=${am}`), { ...expected, amountInPaise: paise }), null, am);
    }
    assert.match(upiIntentProblem(UPI, { ...expected, amountInPaise: 149999 }), /does not match/);
  });

  for (const [name, intent, pattern] of [
    ['missing', undefined, /not a string/],
    ['JSON-wrapped', JSON.stringify({ upiUrl: UPI }), /upi:\/\/pay/],
    ['https', 'https://evil.example/pay?pa=merchant@bank', /upi:\/\/pay/],
    ['other upi verb', UPI.replace('upi://pay?', 'upi://mandate?'), /upi:\/\/pay/],
    ['uppercase scheme', UPI.replace('upi://', 'UPI://'), /upi:\/\/pay/],
    ['whitespace', `${UPI} `, /characters/],
    ['non-ASCII', UPI.replace('Frontiva', 'Frontivа'), /characters/],
    ['fragment', `${UPI}#x`, /fragment/],
    ['bad percent-encoding', `${UPI}&x=%zz`, /percent/],
    ['missing pa', UPI.replace('pa=merchant@bank&', ''), /payee/],
    ['malformed pa', UPI.replace('pa=merchant@bank', 'pa=merchant'), /payee/],
    ['another payee', UPI.replace('pa=merchant@bank', 'pa=thief@bank'), /ALLOWED_PAYEES/],
    ['missing cu', UPI.replace('cu=INR&', ''), /INR/],
    ['other currency', UPI.replace('cu=INR', 'cu=USD'), /INR/],
    ['missing am', UPI.replace('&am=1500.00', ''), /amount/],
    ['malformed am', UPI.replace('am=1500.00', 'am=1,500'), /amount/],
    ['negative am', UPI.replace('am=1500.00', 'am=-1500'), /amount/],
    ['three-decimal am', UPI.replace('am=1500.00', 'am=1500.001'), /amount/],
    ['exponent am', UPI.replace('am=1500.00', 'am=1.5e3'), /amount/],
    ['duplicate am', `${UPI}&am=1.00`, /duplicate/],
    ['duplicate pa', `${UPI}&pa=thief@bank`, /duplicate/],
    ['duplicate cu', `${UPI}&cu=INR`, /duplicate/],
    ['duplicate by case', `${UPI}&PA=thief@bank`, /duplicate/],
    ['duplicate by encoding', `${UPI}&p%61=thief@bank`, /duplicate/],
    ['too long', `${UPI}&tn2=${'x'.repeat(1100)}`, /too long/],
  ]) {
    test(`refuses an intent: ${name}`, () => {
      assert.match(upiIntentProblem(intent, expected), pattern);
    });
  }

  test('payee allowlist is case-insensitive on the address', () => {
    assert.equal(upiIntentProblem(UPI.replace('merchant@bank', 'Merchant@Bank'), expected), null);
  });

  test('a payment mode other than the one requested is not launched', () => {
    assert.equal(resolveFrontivaLaunch({ paymentMode: 'CARD', intent: UPI }, cfg, 150000).launch, null);
  });
});

// --- Verification -------------------------------------------------------------

describe('status verification', () => {
  test('maps the documented statuses', () => {
    assert.equal(classifyFrontivaStatus('COMPLETED'), 'success');
    assert.equal(classifyFrontivaStatus('PENDING'), 'pending');
    assert.equal(classifyFrontivaStatus('PROCESSING'), 'pending');
    assert.equal(classifyFrontivaStatus('FAILED'), 'failed');
    assert.equal(classifyFrontivaStatus('SUCCESS'), 'unknown');
  });

  for (const [name, fields, expected] of [
    ['COMPLETED with matching amount is paid', {}, 'paid'],
    ['PENDING stays processing', { status: 'PENDING' }, 'processing'],
    ['PROCESSING stays processing', { status: 'PROCESSING' }, 'processing'],
    ['FAILED fails', { status: 'FAILED' }, 'failed'],
    ['unknown status goes to review', { status: 'REFUNDED' }, 'requires_review'],
    ['amount mismatch goes to review', { requestedAmount: '15.00' }, 'requires_review'],
    ['conflicting amounts go to review', { amount: '1400' }, 'requires_review'],
    ['merchant mismatch goes to review', { merchantId: 99 }, 'requires_review'],
    ['reference mismatch goes to review', { merchantReference: 'FRVOTHER0001' }, 'requires_review'],
  ]) {
    test(name, async () => {
      const world = installWorld({ tables: { orders: [payinOrder()] }, login: loginOk(), status: statusAnswer(fields) });
      const response = await status();
      assert.equal(response.json().order.payment_status, expected);
      if (expected === 'paid') {
        assert.equal(orderIn(world).gateway_txn_id, 'UTR123');
        assert.equal(world.statuses[0].headers['x-signature'], generateFrontivaSignature(REF, CLIENT_SECRET));
      }
      assert.deepEqual(world.forbidden, []);
    });
  }

  test('an array envelope is matched by merchantReference', async () => {
    installWorld({
      tables: { orders: [payinOrder()] },
      login: loginOk(),
      status: () => respond(200, { success: true, data: [{ merchantReference: REF, requestedAmount: '1500', status: 'COMPLETED' }] }),
    });
    assert.equal((await status()).json().order.payment_status, 'paid');
  });

  test('a network failure changes nothing inside the review window', async () => {
    const world = installWorld({
      tables: { orders: [payinOrder()] },
      login: loginOk(),
      status: () => { throw new Error('reset'); },
    });
    assert.equal((await status()).json().order.payment_status, 'initiated');
    assert.equal(world.statuses.length, 2, 'GET retried once');
  });

  test('refreshes are throttled to one provider check', async () => {
    const world = installWorld({ tables: { orders: [payinOrder()] }, login: loginOk(), status: statusAnswer({ status: 'PENDING' }) });
    await status();
    await status();
    assert.equal(world.statuses.length, 1);
  });

  test('concurrent settlement applies paid exactly once', async () => {
    const world = installWorld({ tables: { orders: [payinOrder()] }, login: loginOk(), status: statusAnswer({}) });
    const results = await Promise.all([settleOrder(REF), settleOrder(REF), confirmFrontivaPayin(REF)]);
    assert.equal(results.filter((r) => r.changed).length, 1);
    assert.equal(world.statuses.length, 1);
    assert.equal(orderIn(world).payment_status, 'paid');
  });

  test('a terminal order is never re-checked or overwritten', async () => {
    const world = installWorld({ tables: { orders: [payinOrder({ payment_status: 'paid', status: 'paid' })] }, status: statusAnswer({ status: 'FAILED' }) });
    const result = await confirmFrontivaPayin(REF);
    assert.equal(result.changed, false);
    assert.equal(world.statuses.length, 0);
    assert.equal(orderIn(world).payment_status, 'paid');
  });

  test('confirmFrontivaPayin refuses non-PayIn orders', async () => {
    const world = installWorld({ tables: { orders: [payinOrder({ payment_gateway: null })] } });
    assert.equal((await confirmFrontivaPayin(REF)).changed, false);
    assert.equal(world.statuses.length, 0);
  });

  test('an expired token on status is renewed once', async () => {
    let first = true;
    const world = installWorld({
      tables: { orders: [payinOrder()] },
      login: loginOk(),
      status: (ref) => (first ? ((first = false), respond(401, {})) : statusAnswer({})(ref)),
    });
    assert.equal((await status()).json().order.payment_status, 'paid');
    assert.equal(world.logins.length, 2);
  });

  test('decision table never pays on anything but a verified COMPLETED', () => {
    const base = { outcome: 'answered', merchantReference: REF, merchantId: null, expectedMerchantId: '42', amountPaise: 150000 };
    const ctx = { orderRef: REF, expectedInPaise: 150000, pastReviewWindow: false };
    assert.equal(decideFrontivaSettlement({ ...base, status: 'COMPLETED' }, ctx).status, 'paid');
    assert.equal(decideFrontivaSettlement({ ...base, status: 'COMPLETED', amountPaise: null }, ctx).status, 'requires_review');
    assert.equal(decideFrontivaSettlement({ outcome: 'unavailable' }, ctx).status, null);
    assert.equal(decideFrontivaSettlement({ outcome: 'not_found' }, { ...ctx, pastReviewWindow: true }).status, 'requires_review');
    assert.equal(decideFrontivaSettlement({ outcome: 'auth_error' }, ctx).status, 'requires_review');
  });
});

// --- Reconciliation -----------------------------------------------------------

describe('POST /api/payments/frontiva-payin/reconcile', () => {
  const run = (secret = CRON_SECRET) => call(reconcileHandler, { headers: { authorization: `Bearer ${secret}` } });

  test('requires the cron secret', async () => {
    installWorld({});
    assert.equal((await run('wrong')).statusCode, 401);
  });

  test('settles an abandoned PayIn order and touches nothing else', async () => {
    const world = installWorld({
      tables: {
        orders: [
          payinOrder({ created_at: minutesAgo(30) }),
          payinOrder({ order_ref: 'FRVAIRPAY0001', payment_gateway: null, created_at: minutesAgo(30) }),
          payinOrder({ order_ref: 'FRVSABPAISA01', payment_gateway: 'sabpaisa', created_at: minutesAgo(30) }),
        ],
      },
      login: loginOk(),
      status: statusAnswer({}),
    });
    const body = (await run()).json();
    assert.equal(body.settled, 1);
    assert.equal(orderIn(world).payment_status, 'paid');
    assert.equal(orderIn(world, 'FRVAIRPAY0001').payment_status, 'initiated');
    assert.equal(orderIn(world, 'FRVSABPAISA01').payment_status, 'initiated');
    assert.deepEqual(world.statuses.map((s) => s.ref), [REF]);
    assert.deepEqual(world.forbidden, []);
  });

  test('backs off: a recently checked order is not due', async () => {
    installWorld({
      tables: { orders: [payinOrder({ created_at: minutesAgo(30), last_checked_at: minutesAgo(2), enquiry_count: 1 })] },
    });
    assert.deepEqual(await listFrontivaPayinDue(), []);
  });
});

// --- Isolation ----------------------------------------------------------------

describe('isolation from existing gateways', () => {
  test('no PayIn callback route, and the Airpay callback rewrites are unchanged', () => {
    const vercel = JSON.parse(read('../vercel.json'));
    assert.deepEqual(
      vercel.rewrites.filter((r) => r.destination === '/api/payments/callback').map((r) => r.source),
      ['/callback/cpm/arp/collection', '/callback/cpm/arp_frontiva/collection'],
    );
    assert.deepEqual(readdirSync(new URL('../api/payments/frontiva-payin/', import.meta.url)).sort(), ['create.js', 'reconcile.js']);
  });

  test('PayIn code never imports Airpay, SabPaisa or the KKChat forwarder', () => {
    for (const file of [
      '../api/_lib/frontiva-payin.js',
      '../api/_lib/frontiva-payin-orders.js',
      '../api/payments/frontiva-payin/create.js',
      '../api/payments/frontiva-payin/reconcile.js',
    ]) {
      assert.doesNotMatch(read(file), /airpay\.js|sabpaisa\.js|forward-callback/, file);
    }
  });

  test('checkout never sends a PayIn customer to the Airpay create endpoint', () => {
    const source = read('../apps/web/src/api/OrdersApi.js');
    const fn = source.slice(source.indexOf('export async function createFrontivaPayinPayment'), source.indexOf('export function isFrontivaPayinLaunch'));
    assert.match(fn, /\/api\/payments\/frontiva-payin\/create/);
    assert.doesNotMatch(fn, /\/api\/payments\/create'|merchant/);
  });

  test('the QR encodes the intent untransformed, and the browser never follows a data: url', () => {
    const page = read('../apps/web/src/pages/SuccessPage.jsx');
    assert.match(page, /<QRCodeSVG\s+value=\{payinIntent\}/);
    assert.doesNotMatch(page, /dangerouslySetInnerHTML|data:text\/html/);
    const checkoutPage = read('../apps/web/src/pages/CheckoutPage.jsx');
    const branch = checkoutPage.slice(checkoutPage.indexOf('createFrontivaPayinPayment({'), checkoutPage.indexOf('gateway === SABPAISA_GATEWAY) {\n      try'));
    assert.doesNotMatch(branch, /location\.assign/, 'PayIn checkout stays on site for the QR');
  });
});

// --- Release hardening --------------------------------------------------------

/** Renders the same QRCodeSVG props the success page uses, rasterises the SVG and decodes it like a scanner would. */
function decodeRenderedQr(value, { scale = 6 } = {}) {
  const svg = renderToStaticMarkup(
    createElement(QRCodeSVG, { value, size: 320, level: 'M', marginSize: 4, bgColor: '#ffffff', fgColor: '#000000' }),
  );
  const cells = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]);
  const dark = svg.split('<path')[2];
  const side = cells * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);

  for (const [, x, y, w] of dark.matchAll(/M(\d+)[ ,](\d+) ?h(\d+)v1H\d+z/g)) {
    for (let row = 0; row < scale; row += 1) {
      for (let col = 0; col < Number(w) * scale; col += 1) {
        const at = ((Number(y) * scale + row) * side + Number(x) * scale + col) * 4;
        pixels[at] = 0;
        pixels[at + 1] = 0;
        pixels[at + 2] = 0;
      }
    }
  }

  return jsQR(pixels, side, side);
}

describe('QR code round trip', () => {
  const sample = 'upi://pay?pa=frontivatrading373991.apy@rbl&pn=Frontiva+Trading+Private+Limited&cu=INR&tn=Pay+to+Frontiva+Trading+Private+Limited&am=10.00&mc=5691&mode=04&tr=AIRPAY2094593073';

  for (const [name, intent] of [['the fixture intent', UPI], ['the provider sample intent', sample]]) {
    test(`a scanner decodes ${name} to exactly the original string`, () => {
      const decoded = decodeRenderedQr(intent);
      assert.ok(decoded, 'the rendered QR must be decodable');
      assert.equal(decoded.data, intent);
    });
  }

  test('the decoded intent is still accepted by the validator for its own payee and INR amount', () => {
    const decoded = decodeRenderedQr(sample);
    assert.equal(upiIntentProblem(decoded.data, { amountInPaise: 1000, allowedPayees: ['frontivatrading373991.apy@rbl'] }), null);
  });

  test('the success page renders a white, large, responsive QR with a quiet zone', () => {
    const page = read('../apps/web/src/pages/SuccessPage.jsx');
    assert.match(page, /bgColor="#ffffff"/);
    assert.match(page, /marginSize=\{4\}/);
    assert.match(page, /size=\{320\}/);
    assert.match(page, /max-w-\[320px\][^"]*bg-white|bg-white[^"]*max-w-\[320px\]/);
    assert.match(page, /className="w-full h-auto"/);
  });
});

describe('success page markup', () => {
  const page = read('../apps/web/src/pages/SuccessPage.jsx');

  test('"Open UPI App" is a single anchor styled as a button, never a button inside a link', () => {
    assert.doesNotMatch(page, /<a\b[^>]*>\s*<Button/);
    assert.match(page, /<Button\s+asChild[\s\S]*?<a href=\{payinIntent\} aria-label=\{`Open your UPI app to pay/);
  });

  test('the UPI deep link is never opened automatically', () => {
    assert.doesNotMatch(page, /location\.(assign|replace)|location\.href\s*=|window\.open|\.click\(\)/);
  });

  test('shows the amount, the order reference, the payee name and the live status', () => {
    assert.match(page, /Amount to pay/);
    assert.match(page, /order\.order_ref/);
    assert.match(page, /Frontiva Trading Private Limited/);
    assert.match(page, /Waiting for payment/);
  });

  test('the QR renders only while the order is payable', () => {
    assert.match(page, /isPayin && POLLABLE_STATUSES\.has\(paymentStatus\)/);
  });
});

describe('payment status authorisation', () => {
  test('without the checkout attempt id there is no payment_intent, but the order still loads', async () => {
    const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk(), status: statusAnswer({ status: 'PENDING' }) });
    const { order_ref: ref } = (await checkout()).json();
    const before = world.creates.length;

    for (const key of [null, '3f1c2a7e-8b4d-4c1a-9e2f-000000000000', 'not-a-uuid', `${ATTEMPT}' or 1=1`]) {
      const body = (await status(ref, key)).json();
      assert.ok(body.order, String(key));
      assert.equal(body.payment_intent, undefined, String(key));
    }

    assert.equal((await status(ref, ATTEMPT)).json().payment_intent, UPI);
    assert.equal(world.creates.length, before, 'reading status never creates a PayIn');
  });

  test('a QR older than the validity window is no longer returned', async () => {
    const select = async () => [{ upi_intent: UPI }];
    assert.equal(await findFrontivaPayinIntent(payinOrder({ created_at: minutesAgo(31) }), ATTEMPT, { select }), null);
    assert.equal(await findFrontivaPayinIntent(payinOrder({ created_at: minutesAgo(29) }), ATTEMPT, { select }), UPI);
    assert.equal(await findFrontivaPayinIntent(payinOrder({ created_at: 'garbage' }), ATTEMPT, { select }), null);
  });

  test('Airpay and SabPaisa status responses are untouched by the key', async () => {
    for (const payment_gateway of [null, 'airpay', 'sabpaisa']) {
      installWorld({ tables: { orders: [payinOrder({ payment_gateway, payment_status: 'paid', status: 'paid' })] } });
      assert.deepEqual(Object.keys((await status(REF, ATTEMPT)).json()), ['order'], String(payment_gateway));
    }
  });
});

describe('documented provider create response', () => {
  const PAYEE = 'frontivatrading373991.apy@rbl';
  const INTENT = `upi://pay?pa=${PAYEE}&pn=Frontiva+Trading+Private+Limited&cu=INR&tn=Pay+to+Frontiva+Trading+Private+Limited&am=10.00&mc=5691&mode=04&tr=AIRPAY2094593073`;
  const customer = { name: 'Asha Menon', email: 'asha@example.com', phone: '9876543210' };

  const providerAnswer = (overrides = {}) => (body) =>
    respond(201, {
      id: 810333, merchantId: 1, amount: '10', status: 'PENDING', merchantReference: body.merchantReference,
      paymentMode: 'UPI_INTENT', callbackNeeded: true, url: null, intent: INTENT, ...overrides,
    });

  const run = async (overrides) => {
    Object.assign(process.env, { FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID: '1', FRONTIVA_PAYIN_ALLOWED_PAYEES: PAYEE });
    installWorld({ login: loginOk({ merchantId: 1 }), create: providerAnswer(overrides) });
    return createFrontivaPayin({ orderRef: REF, amountInPaise: 1000, customer, config: loadFrontivaPayinConfig() });
  };

  test('merchantId 1, amount "10", PENDING, UPI_INTENT, url null is accepted and launched untouched', async () => {
    const result = await run();
    assert.equal(result.kind, 'created');
    assert.equal(result.launch.url, INTENT);
    assert.equal(result.callbackNeeded, true, 'recorded for the pilot, never acted on');
  });

  for (const [name, overrides] of [
    ['another merchant id', { merchantId: 2 }],
    ['another merchant reference', { merchantReference: 'FRVOTHER' }],
    ['another amount', { amount: '11' }],
  ]) {
    test(`${name} is not trusted`, async () => {
      assert.equal((await run(overrides)).kind, 'ambiguous');
    });
  }

  for (const [name, overrides] of [
    ['another payee', { intent: INTENT.replace(PAYEE, 'thief@bank') }],
    ['another currency in the intent', { intent: INTENT.replace('cu=INR', 'cu=USD') }],
    ['a FAILED status', { status: 'FAILED' }],
    ['a COMPLETED status', { status: 'COMPLETED' }],
    ['an unknown status', { status: 'WEIRD' }],
  ]) {
    test(`${name}: no QR is launched`, async () => {
      const result = await run(overrides);
      assert.equal(result.kind, 'created');
      assert.equal(result.launch, null);
    });
  }

  test('a failed-status create response stores no intent and gives the customer nothing to pay', async () => {
    const world = installWorld({ products: [PRODUCT], login: loginOk(), create: createOk({ status: 'FAILED' }) });
    assert.equal((await checkout()).statusCode, 502);
    assert.equal(world.tables.frontiva_payin_transactions[0].create_state, 'created_not_launched');
    assert.ok(!world.tables.frontiva_payin_transactions[0].upi_intent);
  });
});

describe('allowed payee configuration', () => {
  test('several payees are split, trimmed and lower-cased; blanks are dropped', () => {
    process.env.FRONTIVA_PAYIN_ALLOWED_PAYEES = ' First@RBL , second@bank ,, ';
    assert.deepEqual(loadFrontivaPayinConfig().allowedPayees, ['first@rbl', 'second@bank']);
  });

  test('validation is never silently disabled: no payee means refuse, not "allow all"', () => {
    for (const value of ['', ' , ', '*']) {
      process.env.FRONTIVA_PAYIN_ALLOWED_PAYEES = value;
      const { allowedPayees } = loadFrontivaPayinConfig();
      assert.notEqual(upiIntentProblem(UPI, { amountInPaise: 150000, allowedPayees }), null, JSON.stringify(value));
    }

    process.env.FRONTIVA_PAYIN_ALLOWED_PAYEES = '';
    assert.equal(frontivaPayinAvailable(), false);
  });

  test('any one configured payee is accepted, an unlisted one is refused', () => {
    const allowedPayees = ['merchant@bank', 'second@bank'];
    assert.equal(upiIntentProblem(UPI.replace('merchant@bank', 'second@bank'), { amountInPaise: 150000, allowedPayees }), null);
    assert.match(upiIntentProblem(UPI.replace('merchant@bank', 'third@bank'), { amountInPaise: 150000, allowedPayees }), /ALLOWED_PAYEES/);
  });
});

describe('transaction lifecycle', () => {
  const settle = async (answer) => {
    const world = installWorld({ tables: { orders: [payinOrder({ created_at: minutesAgo(30) })] }, login: loginOk(), status: statusAnswer(answer) });
    await confirmFrontivaPayin(REF);
    return { world, row: orderIn(world) };
  };

  for (const [provider, expected] of [['PENDING', 'processing'], ['PROCESSING', 'processing'], ['FAILED', 'failed'], ['SUCCESS', 'requires_review'], ['', 'requires_review']]) {
    test(`provider status ${JSON.stringify(provider)} never marks the order paid (-> ${expected})`, async () => {
      const { row } = await settle({ status: provider });
      assert.equal(row.payment_status, expected);
      assert.ok(!row.paid_at);
    });
  }

  test('COMPLETED with the right reference, merchant and amount marks it paid exactly once', async () => {
    const { world, row } = await settle({});
    assert.equal(row.payment_status, 'paid');
    const stamp = row.paid_at;
    const asked = world.statuses.length;
    await Promise.all([confirmFrontivaPayin(REF), confirmFrontivaPayin(REF)]);
    assert.equal(orderIn(world).paid_at, stamp, 'a settled order is never rewritten');
    assert.equal(world.statuses.length, asked, 'a settled order is not asked about again');
  });

  for (const [name, fields] of [
    ['a different amount', { requestedAmount: '1499.99' }],
    ['a different merchant', { merchantId: 99 }],
    ['a different reference', { merchantReference: 'FRVNOTMINE' }],
  ]) {
    test(`COMPLETED with ${name} is held for review, not paid`, async () => {
      const { row } = await settle(fields);
      assert.equal(row.payment_status, 'requires_review');
    });
  }

  test('the page stops polling a settled order and bounds the polling', () => {
    const page = read('../apps/web/src/pages/SuccessPage.jsx');
    assert.match(page, /pollCount < \(isPayin \? PAYIN_MAX_POLLS : SABPAISA_MAX_POLLS\)/);
    assert.match(page, /POLLABLE_STATUSES\.has\(paymentStatus\)/);
  });
});

describe('reconciliation endpoint authorisation and methods', () => {
  const bearer = { authorization: `Bearer ${CRON_SECRET}` };

  test('GET (what Vercel Cron sends) and POST both work with the bearer secret', async () => {
    installWorld({});
    for (const method of ['GET', 'POST']) {
      assert.equal((await call(reconcileHandler, { method, headers: bearer })).statusCode, 200, method);
    }
  });

  test('other methods are refused', async () => {
    installWorld({});
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      assert.equal((await call(reconcileHandler, { method, headers: bearer })).statusCode, 405, method);
    }
  });

  test('no header, a wrong secret, a wrong scheme, or an unset CRON_SECRET are all 401', async () => {
    installWorld({});
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: CRON_SECRET }, { authorization: `Basic ${CRON_SECRET}` }]) {
      assert.equal((await call(reconcileHandler, { headers })).statusCode, 401, JSON.stringify(headers));
    }

    delete process.env.CRON_SECRET;
    assert.equal((await call(reconcileHandler, { headers: { authorization: 'Bearer ' } })).statusCode, 401);
    assert.equal((await call(reconcileHandler, { headers: { authorization: 'Bearer undefined' } })).statusCode, 401);
  });

  test('a disabled gateway still reconciles orders already started', async () => {
    process.env.FRONTIVA_PAYIN_ENABLED = 'false';
    const world = installWorld({ tables: { orders: [payinOrder({ created_at: minutesAgo(30) })] }, login: loginOk(), status: statusAnswer({}) });
    assert.equal((await call(reconcileHandler, { headers: bearer })).json().settled, 1);
    assert.equal(orderIn(world).payment_status, 'paid');
  });
});

describe('environment variables', () => {
  test('only the documented FRONTIVA_PAYIN_* names are read; no client secret or launch-host variable', () => {
    const source = ['../api/_lib/frontiva-payin.js', '../api/_lib/frontiva-payin-orders.js', '../api/payments/frontiva-payin/create.js', '../api/payments/frontiva-payin/reconcile.js']
      .map(read)
      .join('\n');
    const names = [...new Set(source.match(/FRONTIVA_PAYIN_[A-Z_]+/g))].filter((n) => !/GATEWAY|TIMEOUT_MS|PAYMENT_MODE|CURRENCY|MIN_AMOUNT|DEFAULT_BASE/.test(n)).sort();
    assert.deepEqual(names, [
      'FRONTIVA_PAYIN_ALLOWED_PAYEES', 'FRONTIVA_PAYIN_BASE_URL', 'FRONTIVA_PAYIN_EMAIL', 'FRONTIVA_PAYIN_ENABLED',
      'FRONTIVA_PAYIN_EXPECTED_MERCHANT_ID', 'FRONTIVA_PAYIN_PASSWORD',
    ]);
    assert.doesNotMatch(source, /FRONTIVA_PAYIN_CLIENT_SECRET|FRONTIVA_PAYIN_MERCHANT_ID|FRONTIVA_PAYIN_LAUNCH_HOSTS/);
  });

  test('no PayIn variable reaches the browser bundle', () => {
    for (const file of ['../apps/web/src/api/OrdersApi.js', '../apps/web/src/pages/CheckoutPage.jsx', '../apps/web/src/pages/SuccessPage.jsx']) {
      assert.doesNotMatch(read(file), /VITE_FRONTIVA|import\.meta\.env\.[A-Z_]*FRONTIVA/, file);
    }
  });
});
