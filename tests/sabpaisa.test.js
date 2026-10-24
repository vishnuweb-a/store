/**
 * SabPaisa PG 3.0: configuration, session creation, Transaction Enquiry,
 * settlement, reconciliation, and the guarantees that keep it apart from
 * Airpay.
 *
 * Every request is answered by an in-memory fake — Supabase's PostgREST, the
 * SabPaisa production API, Airpay and the client relay. Nothing here reaches
 * the network, and no test can move money.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach, describe } from 'node:test';
import {
  SABPAISA_BASE_URL,
  isSabpaisaConfigured,
  loadSabpaisaConfig,
  sabpaisaAvailable,
  sabpaisaBaseUrlOverridden,
  sabpaisaEnabled,
} from '../api/_lib/config.js';
import {
  SABPAISA_AUTO_ENQUIRY_BUDGET,
  SABPAISA_REVIEW_AFTER_MS,
  createPendingOrder,
  listSabpaisaDue,
  presentOrder,
  settleOrder,
} from '../api/_lib/orders.js';
import {
  buildCheckoutRedirect,
  classifySabpaisaStatus,
  confirmSabpaisaOrder,
  createSabpaisaPayment,
  decideSabpaisaSettlement,
  generateSabpaisaChecksum,
  isAllowedCheckoutUrl,
  validateSabpaisaAmount,
  validateSabpaisaCustomer,
} from '../api/_lib/sabpaisa.js';
import callbackHandler from '../api/payments/callback.js';
import optionsHandler from '../api/payments/options.js';
import reconcileHandler from '../api/payments/reconcile.js';
import sabpaisaCreateHandler from '../api/payments/sabpaisa/create.js';
import statusHandler from '../api/payments/status.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

// Fixture credentials. Not real, and shaped so none can be mistaken for one.
const SABPAISA_ENV = {
  SABPAISA_API_KEY: 'sp_fixture_api_key',
  SABPAISA_SECRET_KEY: 'sec_fixture_secret',
  SABPAISA_MERCHANT_ID: 'MERCH1',
  SABPAISA_CLIENT_CODE: 'CLNT1',
  SABPAISA_ENABLED: 'true',
};

const SABPAISA_VARIABLES = [
  'SABPAISA_API_KEY',
  'SABPAISA_SECRET_KEY',
  'SABPAISA_MERCHANT_ID',
  'SABPAISA_CLIENT_CODE',
  'SABPAISA_ENABLED',
  'SABPAISA_BASE_URL',
  'SABPAISA_BUYER_EMAIL',
  'SABPAISA_RETURN_ORIGIN',
  'SUBPAISA_API_KEY',
  'SUBPAISA_SECRET_KEY',
  'SUBPAISA_CLIENT_CODE',
  'SUBPAISA_MERCHANT_ID',
  'SUBPAISA_ENABLED',
  'MERCHANT_ID',
  'MERCHANT_NAME',
];

const AIRPAY_M1 = {
  AIRPAY_MID: '900001',
  AIRPAY_CLIENT_ID: 'cid001',
  AIRPAY_SECRET_KEY: 'fixture-secret-key-merchant-0001',
  AIRPAY_API_KEY: 'fixtureapikey001',
  AIRPAY_USERNAME: 'fixtureusr1',
  AIRPAY_PASSWORD: 'fixpass1',
};

const CRON_SECRET = 'fixture-cron-secret-for-sabpaisa-tests-only';

const CONFIG = {
  apiKey: SABPAISA_ENV.SABPAISA_API_KEY,
  secretKey: SABPAISA_ENV.SABPAISA_SECRET_KEY,
  merchantId: 'MERCH1',
  clientCode: 'CLNT1',
  baseUrl: SABPAISA_BASE_URL,
};

const REF = 'FRVSPTEST0001';
const CLIENT_SECRET = 'cs_fixture_session_secret_42';

let originalFetch;
let originalEnv;
let originalLog;
let logs;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = { ...process.env };
  originalLog = console.log;

  for (const name of SABPAISA_VARIABLES) {
    delete process.env[name];
  }

  for (const name of Object.keys(process.env)) {
    if (name.startsWith('AIRPAY_')) delete process.env[name];
  }

  Object.assign(process.env, SABPAISA_ENV, {
    SUPABASE_URL: 'https://db.test',
    SUPABASE_SERVICE_ROLE: 'fixture-service-role',
    CRON_SECRET,
    PUBLIC_SITE_ORIGIN: 'https://frontiva.online',
  });

  logs = [];
  console.log = (line) => logs.push(String(line));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  console.log = originalLog;
});

// --- In-memory PostgREST ------------------------------------------------------

const SABPAISA_COLUMNS = ['payment_gateway', 'gateway_payment_id', 'gateway_txn_id', 'last_checked_at', 'enquiry_count'];

function splitTop(text) {
  const parts = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') depth -= 1;
    if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

const compare = (a, b) => {
  const da = Date.parse(a);
  const db = Date.parse(b);

  if (typeof a === 'string' && !Number.isNaN(da) && !Number.isNaN(db) && /\d{4}-/.test(b)) return da - db;
  return Number(a) - Number(b);
};

function operator(column, expression) {
  if (expression.startsWith('not.')) {
    const inner = operator(column, expression.slice(4));
    return (row) => !inner(row);
  }

  const dot = expression.indexOf('.');
  const op = expression.slice(0, dot);
  const value = expression.slice(dot + 1);

  return (row) => {
    const field = row[column];

    switch (op) {
      case 'eq':
        return field !== null && field !== undefined && String(field) === value;
      case 'neq':
        return field !== null && field !== undefined && String(field) !== value;
      case 'lt':
        return field !== null && field !== undefined && compare(field, value) < 0;
      case 'in':
        return field !== null && field !== undefined && value.slice(1, -1).split(',').includes(String(field));
      case 'is':
        return value === 'null' ? field === null || field === undefined : false;
      default:
        throw new Error(`fake PostgREST: unsupported operator ${op}`);
    }
  };
}

function condition(text) {
  const logical = text.match(/^(or|and)\((.*)\)$/);

  if (logical) {
    const parts = splitTop(logical[2]).map(condition);
    return logical[1] === 'or' ? (row) => parts.some((part) => part(row)) : (row) => parts.every((part) => part(row));
  }

  const dot = text.indexOf('.');
  return operator(text.slice(0, dot), text.slice(dot + 1));
}

function parseQuery(query) {
  const filters = [];
  let order = null;
  let limit = Infinity;

  for (const pair of query.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const key = pair.slice(0, eq);
    const value = decodeURIComponent(pair.slice(eq + 1));

    if (key === 'select' || key === 'on_conflict') continue;
    if (key === 'order') order = value;
    else if (key === 'limit') limit = Number(value);
    else if (key === 'or' || key === 'and') filters.push(condition(`${key}${value}`));
    else filters.push(operator(key, value));
  }

  return { filter: (row) => filters.every((fn) => fn(row)), order, limit };
}

function sortRows(rows, order) {
  if (!order) return rows;

  const [column, direction = 'asc', nulls] = order.split('.');
  const sign = direction === 'desc' ? -1 : 1;

  return [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];

    if (av == null && bv == null) return 0;
    if (av == null) return nulls === 'nullsfirst' ? -1 : 1;
    if (bv == null) return nulls === 'nullsfirst' ? 1 : -1;
    return sign * String(av).localeCompare(String(bv));
  });
}

const respond = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? 'application/json' },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

const PRODUCT = {
  id: 7,
  title: 'Linen Shirt',
  price: 500,
  discount_price: null,
  active: true,
  track_quantity: false,
  stock: 0,
  sizes: [],
  sku: 'LS-1',
  image_url: null,
};

const enquiryOk = (ref = REF, overrides = {}) => ({
  success: true,
  traceId: 'trace-enq',
  txnId: 'SPTXN-1',
  merchantId: 'MERCH1',
  merchantTxnId: ref,
  amountPaise: 50000,
  requestAmount: 500,
  paidAmount: 500,
  currency: 'INR',
  status: 'SUCCESS',
  ...overrides,
});

const sessionOk = (body, overrides = {}) => ({
  success: true,
  paymentId: 'sppay_fixture',
  checkoutUrl: 'https://checkout.sabpaisa.in/checkout/sppay_fixture',
  clientSecret: CLIENT_SECRET,
  status: 'PENDING',
  amount: body.amount,
  currency: body.currency,
  merchantTxnId: body.merchantTxnId,
  expiresAt: '2026-10-24T12:30:00Z',
  traceId: 'trace-create',
  ...overrides,
});

/**
 * One in-memory world. `transactions` maps merchantTxnId to SabPaisa's enquiry
 * answer: an object (200 body), a function returning [status, body], or absent
 * (404 TRANSACTION_NOT_FOUND).
 */
function world({ orders = [], migrated = true, transactions = {}, create } = {}) {
  const state = {
    orders: orders.map((order) => ({ ...order })),
    events: [],
    creates: [],
    enquiries: [],
    airpayCalls: [],
    forwards: [],
    patches: [],
    nextId: 100,
  };

  const touchesNewColumns = (text) => SABPAISA_COLUMNS.some((column) => text.includes(column));

  globalThis.fetch = async (url, options = {}) => {
    // Yield, so concurrent callers genuinely interleave.
    await new Promise((resolve) => setImmediate(resolve));

    const target = String(url);

    if (target.startsWith('https://db.test/rest/v1/')) {
      const [path, query = ''] = target.slice('https://db.test/rest/v1/'.length).split('?');
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;

      if (!migrated && path === 'orders' && (touchesNewColumns(query) || (body && touchesNewColumns(JSON.stringify(Object.keys(body)))))) {
        return respond(400, { message: 'column orders.payment_gateway does not exist' });
      }

      if (path.startsWith('products')) {
        return respond(200, [PRODUCT]);
      }

      if (path === 'payment_events') {
        state.events.push(body);
        return respond(201, [body]);
      }

      const { filter, order, limit } = parseQuery(query);

      if (method === 'GET') {
        return respond(200, sortRows(state.orders.filter(filter), order).slice(0, limit));
      }

      if (method === 'POST') {
        const row = { id: state.nextId++, created_at: new Date().toISOString(), ...body };
        state.orders.push(row);
        return respond(201, [row]);
      }

      if (method === 'PATCH') {
        const matched = state.orders.filter(filter);
        state.patches.push({ query, body, matched: matched.length });
        matched.forEach((row) => Object.assign(row, body));
        return respond(200, matched.map((row) => ({ ...row })));
      }
    }

    if (target === `${SABPAISA_BASE_URL}/api/v2/payments`) {
      const body = JSON.parse(options.body);
      state.creates.push({ body, headers: options.headers });

      if (create) {
        return create(body);
      }

      return respond(201, sessionOk(body));
    }

    if (target === `${SABPAISA_BASE_URL}/api/v2/payments/enquiry`) {
      const body = JSON.parse(options.body);
      state.enquiries.push({ body, headers: options.headers });
      const answer = transactions[body.merchantTxnId];

      if (answer === undefined) {
        return respond(404, { success: false, error: { code: 'TRANSACTION_NOT_FOUND', message: 'not found' }, traceId: 't' });
      }

      if (typeof answer === 'function') {
        const [status, payload] = answer(body);
        return respond(status, payload);
      }

      return respond(200, answer);
    }

    if (target.includes('airpay.co.in')) {
      state.airpayCalls.push(target);
      return respond(500, 'airpay must not be called in this test');
    }

    if (target.startsWith('https://kkchat.in/')) {
      state.forwards.push(options.body);
      return respond(200, 'OK');
    }

    throw new Error(`unexpected request to ${target}`);
  };

  return state;
}

/** Drives a serverless handler with a minimal request and response. */
async function call(handler, { method = 'POST', url = '/', headers = {}, body } = {}) {
  const response = { statusCode: 200, headers: {}, body: '' };
  const res = {
    set statusCode(value) {
      response.statusCode = value;
    },
    get statusCode() {
      return response.statusCode;
    },
    setHeader: (name, value) => {
      response.headers[name.toLowerCase()] = value;
    },
    end: (value = '') => {
      response.body = value;
    },
  };

  await handler({ method, url, headers, body }, res);

  return { ...response, json: () => JSON.parse(response.body) };
}

const CART = {
  customer: { fullName: 'Asha Menon', phone: '9876543210', address: '12 MG Road, Kochi 682001', landmark: '' },
  items: [{ product_id: 7, size: null, quantity: 1 }],
};

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const spOrder = (overrides = {}) => ({
  id: 1,
  order_ref: REF,
  customer_name: 'Asha Menon',
  phone: '9876543210',
  address: '12 MG Road',
  landmark: null,
  payment_method: 'Online Payment',
  status: 'initiated',
  payment_status: 'initiated',
  total: 500,
  items: [],
  payment_gateway: 'sabpaisa',
  enquiry_count: 0,
  last_checked_at: null,
  created_at: minutesAgo(1),
  ...overrides,
});

const airpayOrder = (overrides = {}) => ({
  ...spOrder({ order_ref: 'FRVAIRPAY0001', payment_gateway: null, enquiry_count: null }),
  ...overrides,
});

const order = (state, ref = REF) => state.orders.find((row) => row.order_ref === ref);
const status = (ref) => call(statusHandler, { method: 'GET', url: `/api/payments/status?ref=${ref}` });
const reconcile = () => call(reconcileHandler, { method: 'POST', headers: { authorization: `Bearer ${CRON_SECRET}` } });

// --- 1–2. Checksum ------------------------------------------------------------

describe('generateSabpaisaChecksum', () => {
  const fields = { merchantId: 'MERCH1', merchantTxnId: 'FRVTESTSP0001', amount: 50000, currency: 'INR', timestamp: 1770000000 };

  test('matches an independently computed HMAC-SHA256 (openssl) of the pipe-joined fields', () => {
    assert.equal(
      generateSabpaisaChecksum(fields, 'sec_fixture_secret'),
      '47ce078d3eeea01c8a86ae413de9bf86ec972ade6f7ecb7111db80db2f1e720f',
    );
  });

  test('is 64 lowercase hex characters and depends on field order', () => {
    const digest = generateSabpaisaChecksum(fields, 'k');
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.notEqual(digest, generateSabpaisaChecksum({ ...fields, amount: 50001 }, 'k'));
    assert.notEqual(digest, generateSabpaisaChecksum(fields, 'k2'));
  });

  test('refuses incomplete or non-integer input rather than signing it', () => {
    assert.throws(() => generateSabpaisaChecksum({ ...fields, merchantTxnId: '' }, 'k'));
    assert.throws(() => generateSabpaisaChecksum(fields, ''));
    assert.throws(() => generateSabpaisaChecksum({ ...fields, amount: 500.5 }, 'k'));
    assert.throws(() => generateSabpaisaChecksum({ ...fields, timestamp: 1770000000123.5 }, 'k'));
  });
});

// --- 3–5. Configuration ---------------------------------------------------------

describe('SabPaisa configuration', () => {
  test('loads production configuration from the SABPAISA_* names', () => {
    assert.deepEqual(loadSabpaisaConfig(), CONFIG);
    assert.equal(isSabpaisaConfigured(), true);
    assert.equal(sabpaisaAvailable(), true);
  });

  test('reads the legacy SUBPAISA_* and MERCHANT_ID names the deployment was set up with', () => {
    for (const name of ['SABPAISA_API_KEY', 'SABPAISA_SECRET_KEY', 'SABPAISA_MERCHANT_ID', 'SABPAISA_CLIENT_CODE']) {
      delete process.env[name];
    }

    Object.assign(process.env, {
      SUBPAISA_API_KEY: 'sp_legacy',
      SUBPAISA_SECRET_KEY: 'sec_legacy',
      SUBPAISA_CLIENT_CODE: 'LEG01',
      MERCHANT_ID: 'LEG01',
    });

    assert.deepEqual(loadSabpaisaConfig(), {
      apiKey: 'sp_legacy',
      secretKey: 'sec_legacy',
      merchantId: 'LEG01',
      clientCode: 'LEG01',
      baseUrl: SABPAISA_BASE_URL,
    });
  });

  test('always uses the production API, even when a staging base URL is configured', () => {
    process.env.SABPAISA_BASE_URL = 'https://staging-sb-merchant-api.sabpaisa.in';

    assert.equal(loadSabpaisaConfig().baseUrl, 'https://merchant-api.sabpaisa.in');
    assert.equal(sabpaisaBaseUrlOverridden(), true);
  });

  test('refuses a sandbox API key', () => {
    process.env.SABPAISA_API_KEY = 'sk_test_abc';
    assert.throws(() => loadSabpaisaConfig(), /sandbox/);
    assert.equal(sabpaisaAvailable(), false);
  });

  test('missing credentials hide SabPaisa, naming only the variable', () => {
    delete process.env.SABPAISA_SECRET_KEY;

    assert.throws(() => loadSabpaisaConfig(), (error) => {
      assert.equal(error.isConfigError, true);
      assert.match(error.message, /SABPAISA_SECRET_KEY/);
      return true;
    });
    assert.equal(sabpaisaAvailable(), false);
  });

  test('only an explicit true enables new payments', () => {
    for (const value of [undefined, '', 'false', '1', 'yes', 'on']) {
      if (value === undefined) delete process.env.SABPAISA_ENABLED;
      else process.env.SABPAISA_ENABLED = value;

      assert.equal(sabpaisaEnabled(), false, `SABPAISA_ENABLED=${value}`);
      assert.equal(sabpaisaAvailable(), false);
    }

    process.env.SABPAISA_ENABLED = ' TRUE ';
    assert.equal(sabpaisaEnabled(), true);
  });

  test('reads SUBPAISA_ENABLED only when SABPAISA_ENABLED is unset', () => {
    delete process.env.SABPAISA_ENABLED;
    process.env.SUBPAISA_ENABLED = 'true';
    assert.equal(sabpaisaEnabled(), true);

    process.env.SABPAISA_ENABLED = 'false';
    assert.equal(sabpaisaEnabled(), false);
  });

  test('is independent of AIRPAY_ENABLED_MERCHANTS', () => {
    process.env.AIRPAY_ENABLED_MERCHANTS = '1';
    assert.equal(sabpaisaAvailable(), true);
  });
});

describe('GET /api/payments/options', () => {
  test('adds sabpaisa: true alongside the existing merchants array', async () => {
    Object.assign(process.env, AIRPAY_M1);

    const response = await call(optionsHandler, { method: 'GET' });

    assert.deepEqual(response.json(), { merchants: [1], sabpaisa: true });
  });

  test('reports sabpaisa: false when disabled, leaving merchants unchanged', async () => {
    Object.assign(process.env, AIRPAY_M1);
    process.env.SABPAISA_ENABLED = 'false';

    assert.deepEqual((await call(optionsHandler, { method: 'GET' })).json(), { merchants: [1], sabpaisa: false });
  });
});

// --- 6–9. Amount and customer validation ----------------------------------------

describe('amount and customer validation', () => {
  test('amounts are integer paise within the documented range', () => {
    assert.equal(validateSabpaisaAmount(100), 100);
    assert.equal(validateSabpaisaAmount(50000), 50000);
    assert.equal(validateSabpaisaAmount(100_000_000), 100_000_000);
    assert.throws(() => validateSabpaisaAmount(99));
    assert.throws(() => validateSabpaisaAmount(100_000_001));
    assert.throws(() => validateSabpaisaAmount(500.5));
  });

  const customer = { fullName: 'Asha Menon', phone: '9876543210' };

  test('accepts a valid customer, collapsing repeated spaces', () => {
    assert.deepEqual(validateSabpaisaCustomer({ ...customer, fullName: 'Asha   Menon' }, 'orders@frontiva.online'), {
      name: 'Asha Menon',
      phone: '9876543210',
      email: 'orders@frontiva.online',
    });
  });

  test('rejects a phone number that is not an Indian mobile number', () => {
    for (const phone of ['5876543210', '0876543210', '987654321', '98765432101']) {
      assert.throws(() => validateSabpaisaCustomer({ ...customer, phone }, 'orders@frontiva.online'), (error) => error.isValidationError);
    }
  });

  test('rejects a name SabPaisa would refuse, without rewriting it', () => {
    for (const fullName of ['A', 'Asha M.', 'Asha1', 'x'.repeat(101)]) {
      assert.throws(() => validateSabpaisaCustomer({ ...customer, fullName }, 'orders@frontiva.online'), (error) => error.isValidationError);
    }
  });

  test('an invalid buyer email is a configuration fault, not the customer\'s', () => {
    assert.throws(() => validateSabpaisaCustomer(customer, 'not-an-email'), (error) => error.isConfigError);
  });
});

// --- 10–14. Session creation ------------------------------------------------------

describe('POST /api/payments/sabpaisa/create', () => {
  test('creates a pending SabPaisa order and returns the authenticated checkout URL', async () => {
    const state = world();

    const response = await call(sabpaisaCreateHandler, { body: CART });
    const payload = response.json();

    assert.equal(response.statusCode, 200);
    assert.match(payload.order_ref, /^FRV[A-Z0-9]+$/);
    assert.equal(payload.total_in_cents, 50000);

    const redirect = new URL(payload.redirect_url);
    assert.equal(redirect.origin, 'https://checkout.sabpaisa.in');
    assert.equal(redirect.searchParams.get('clientSecret'), CLIENT_SECRET);

    const row = order(state, payload.order_ref);
    assert.equal(row.payment_gateway, 'sabpaisa');
    assert.equal(row.payment_method, 'Online Payment');
    assert.equal(row.status, 'initiated');
    assert.equal(row.payment_status, 'initiated');
    assert.equal(row.total, 500);
    assert.equal(row.enquiry_count, 0);
    assert.equal(row.gateway_payment_id, 'sppay_fixture');
    assert.equal('airpay_merchant' in row, false);
    // The secret is never stored.
    assert.equal(JSON.stringify(state.orders).includes(CLIENT_SECRET), false);
  });

  test('sends integer paise, production headers, a valid checksum and the existing success page as returnUrl', async () => {
    const state = world();

    const payload = (await call(sabpaisaCreateHandler, { body: CART })).json();
    const { body, headers } = state.creates[0];

    assert.equal(body.amount, 50000);
    assert.equal(Number.isInteger(body.amount), true);
    assert.equal(body.currency, 'INR');
    assert.equal(body.merchantId, 'MERCH1');
    assert.equal(body.merchantTxnId, payload.order_ref);
    assert.equal(body.customerName, 'Asha Menon');
    assert.equal(body.customerPhone, '9876543210');
    assert.equal(body.customerEmail, 'orders@frontiva.online');
    assert.equal(body.returnUrl, `https://frontiva.online/success?ref=${payload.order_ref}`);
    assert.ok(Math.abs(body.timestamp - Date.now() / 1000) < 5);
    assert.equal(body.checksum, generateSabpaisaChecksum(body, SABPAISA_ENV.SABPAISA_SECRET_KEY));
    assert.equal(headers['X-Api-Key'], SABPAISA_ENV.SABPAISA_API_KEY);
    assert.equal(headers['X-Merchant-Id'], SABPAISA_ENV.SABPAISA_MERCHANT_ID);
  });

  test('ignores any price the browser sends', async () => {
    const state = world();

    await call(sabpaisaCreateHandler, {
      body: { ...CART, items: [{ product_id: 7, size: null, quantity: 1, price: 1, unit_price_in_cents: 100 }], amount: 100 },
    });

    assert.equal(state.creates[0].body.amount, 50000);
  });

  test('a definite rejection closes the order as failed', async () => {
    const state = world({
      create: () => respond(400, { success: false, error: { code: 'INVALID_EMAIL', message: 'bad' }, traceId: 't' }),
    });

    const response = await call(sabpaisaCreateHandler, { body: CART });

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().code, 'sabpaisa_rejected');
    assert.equal(response.json().redirect_url, undefined);
    assert.equal(state.orders[0].payment_status, 'failed');
  });

  test('a timeout is ambiguous: the order stays open, and the request is not retried', async () => {
    const state = world({
      create: () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    });

    const response = await call(sabpaisaCreateHandler, { body: CART });

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().code, 'sabpaisa_unconfirmed');
    assert.equal(state.creates.length, 1);
    assert.equal(state.orders[0].payment_status, 'initiated');
  });

  test('a 5xx or DUPLICATE_TRANSACTION is ambiguous, never failed', async () => {
    for (const reply of [
      () => respond(503, { success: false, error: { code: 'AUTH_CONFIG_ERROR' } }),
      () => respond(400, { success: false, error: { code: 'DUPLICATE_TRANSACTION' } }),
    ]) {
      const state = world({ create: reply });
      const response = await call(sabpaisaCreateHandler, { body: CART });

      assert.equal(response.json().code, 'sabpaisa_unconfirmed');
      assert.equal(state.orders[0].payment_status, 'initiated');
    }
  });

  test('never sends the customer to a checkout URL outside SabPaisa production', async () => {
    for (const checkoutUrl of [
      'https://evil.example/checkout/sppay_x',
      'http://checkout.sabpaisa.in/checkout/sppay_x',
      'https://staging-sb-checkout.sabpaisa.in/checkout/sppay_x',
      'https://sabpaisa.in.evil.example/checkout',
    ]) {
      world({ create: (body) => respond(201, sessionOk(body, { checkoutUrl })) });

      const response = await call(sabpaisaCreateHandler, { body: CART });

      assert.equal(response.statusCode, 502, checkoutUrl);
      assert.equal(response.json().redirect_url, undefined);
    }
  });

  test('refuses a response that names another order or amount', async () => {
    for (const overrides of [{ merchantTxnId: 'FRVSOMEONEELSE1' }, { amount: 100 }, { currency: 'USD' }]) {
      const state = world({ create: (body) => respond(201, sessionOk(body, overrides)) });
      const response = await call(sabpaisaCreateHandler, { body: CART });

      assert.equal(response.statusCode, 502);
      assert.equal(state.orders[0].payment_status, 'initiated');
    }
  });

  test('never logs the client secret or the secret-bearing URL', async () => {
    world();

    await call(sabpaisaCreateHandler, { body: CART });

    assert.ok(logs.length > 0);
    assert.equal(logs.join('\n').includes(CLIENT_SECRET), false);
    assert.equal(logs.join('\n').includes(SABPAISA_ENV.SABPAISA_SECRET_KEY), false);
    assert.equal(logs.join('\n').includes(SABPAISA_ENV.SABPAISA_API_KEY), false);
  });

  test('is unavailable when switched off, and writes no order', async () => {
    process.env.SABPAISA_ENABLED = 'false';
    const state = world();

    const response = await call(sabpaisaCreateHandler, { body: CART });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'sabpaisa_unavailable');
    assert.equal(state.orders.length, 0);
    assert.equal(state.creates.length, 0);
  });

  test('rejects customer details SabPaisa would refuse before any order is written', async () => {
    const state = world();

    const response = await call(sabpaisaCreateHandler, {
      body: { ...CART, customer: { ...CART.customer, phone: '1234567890' } },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(state.orders.length, 0);
  });
});

describe('checkout URL handling', () => {
  test('appends the clientSecret as documented, preserving existing parameters', () => {
    const url = new URL(buildCheckoutRedirect('https://checkout.sabpaisa.in/checkout/sppay_1?lang=en', 'cs a&b'));

    assert.equal(url.searchParams.get('lang'), 'en');
    assert.equal(url.searchParams.get('clientSecret'), 'cs a&b');
  });

  test('keeps a clientSecret the provider already put in the URL', () => {
    const url = buildCheckoutRedirect('https://checkout.sabpaisa.in/c/sppay_1?clientSecret=given', 'other');
    assert.equal(new URL(url).searchParams.getAll('clientSecret').join(), 'given');
  });

  test('has nothing to redirect to without a secret', () => {
    assert.equal(buildCheckoutRedirect('https://checkout.sabpaisa.in/c/sppay_1', null), null);
  });

  test('allows only HTTPS SabPaisa production hosts', () => {
    assert.equal(isAllowedCheckoutUrl('https://checkout.sabpaisa.in/x'), true);
    assert.equal(isAllowedCheckoutUrl('https://sabpaisa.in/x'), true);
    assert.equal(isAllowedCheckoutUrl('https://staging-sb-checkout.sabpaisa.in/x'), false);
    assert.equal(isAllowedCheckoutUrl('https://user:pass@checkout.sabpaisa.in/x'), false);
    assert.equal(isAllowedCheckoutUrl('javascript:alert(1)'), false);
    assert.equal(isAllowedCheckoutUrl(''), false);
  });
});

// --- 15–27. Transaction Enquiry ----------------------------------------------------

describe('confirmSabpaisaOrder', () => {
  const ask = (status, body) =>
    confirmSabpaisaOrder(REF, { config: CONFIG, fetch: async () => respond(status, body) });

  test('posts clientCode and the stored merchantTxnId to the production enquiry API', async () => {
    let request;

    await confirmSabpaisaOrder(REF, {
      config: CONFIG,
      fetch: async (url, options) => {
        request = { url, options };
        return respond(200, enquiryOk());
      },
    });

    assert.equal(request.url, 'https://merchant-api.sabpaisa.in/api/v2/payments/enquiry');
    assert.deepEqual(JSON.parse(request.options.body), { clientCode: 'CLNT1', merchantTxnId: REF });
    assert.equal(request.options.headers['X-Api-Key'], CONFIG.apiKey);
    assert.equal(request.options.headers['X-Merchant-Id'], CONFIG.merchantId);
  });

  test('reads amountPaise as the amount and cross-checks paidAmount in paise', async () => {
    const answer = await ask(200, enquiryOk(REF, { paidAmount: 499.99 }));

    assert.equal(answer.amountPaise, 50000);
    assert.equal(answer.paidAmountPaise, 49999);
  });

  test('classifies provider failures', async () => {
    assert.equal((await ask(404, { success: false, error: { code: 'TRANSACTION_NOT_FOUND' } })).outcome, 'not_found');
    assert.equal((await ask(401, { success: false, error: { code: 'UNAUTHORIZED' } })).outcome, 'auth_error');
    assert.equal((await ask(403, { success: false, error: { code: 'CLIENT_CODE_MISMATCH' } })).outcome, 'auth_error');
    assert.equal((await ask(429, {})).outcome, 'rate_limited');
    assert.equal((await ask(502, 'bad gateway')).outcome, 'unavailable');
    assert.equal((await ask(400, { success: false, error: { code: 'TRANSACTION_SERVICE_ERROR' } })).outcome, 'unavailable');
    assert.equal((await ask(200, 'not json')).outcome, 'invalid');

    const timedOut = await confirmSabpaisaOrder(REF, {
      config: CONFIG,
      fetch: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    });
    assert.equal(timedOut.outcome, 'unavailable');
  });
});

describe('classifySabpaisaStatus', () => {
  test('maps every documented status, and nothing else to success', () => {
    assert.equal(classifySabpaisaStatus('SUCCESS'), 'success');
    assert.equal(classifySabpaisaStatus('success'), 'success');

    for (const value of ['PENDING', 'PROCESSING', 'INITIATED']) assert.equal(classifySabpaisaStatus(value), 'pending');
    for (const value of ['FAILED', 'CANCELLED', 'EXPIRED', 'TIMEOUT']) assert.equal(classifySabpaisaStatus(value), 'failed');
    for (const value of ['SUCCESSFUL', 'PAID', '', null, undefined, 200]) assert.equal(classifySabpaisaStatus(value), 'unknown');
  });
});

describe('decideSabpaisaSettlement', () => {
  const answered = (overrides = {}) => ({
    outcome: 'answered',
    success: true,
    status: 'SUCCESS',
    amountPaise: 50000,
    paidAmountPaise: 50000,
    currency: 'INR',
    txnId: 'SPTXN-1',
    merchantTxnId: REF,
    merchantId: 'MERCH1',
    ...overrides,
  });

  const decide = (enquiry, pastReviewWindow = false) =>
    decideSabpaisaSettlement(enquiry, { orderRef: REF, expectedInPaise: 50000, config: CONFIG, pastReviewWindow });

  test('paid only on a fully verified success', () => {
    assert.equal(decide(answered()).status, 'paid');
    // The client code is an accepted echo of the merchant identity too.
    assert.equal(decide(answered({ merchantId: 'CLNT1' })).status, 'paid');
    // paidAmount is optional.
    assert.equal(decide(answered({ paidAmountPaise: null })).status, 'paid');
  });

  test('pending and processing stay open', () => {
    assert.equal(decide(answered({ status: 'PENDING' })).status, 'processing');
    assert.equal(decide(answered({ status: 'PROCESSING' })).status, 'processing');
  });

  test('provider-terminal failures fail, expired sessions included', () => {
    for (const value of ['FAILED', 'CANCELLED', 'EXPIRED', 'TIMEOUT']) {
      assert.equal(decide(answered({ status: value, success: true })).status, 'failed', value);
    }
  });

  test('transaction not found is never a failure, early or late', () => {
    assert.equal(decide({ outcome: 'not_found' }).status, null);
    assert.equal(decide({ outcome: 'not_found' }, true).status, 'requires_review');
  });

  test('amount, currency, merchant, reference and field mismatches go to review, never paid', () => {
    const cases = {
      'amount mismatch': { amountPaise: 49999 },
      'paid amount mismatch': { paidAmountPaise: 100 },
      'currency mismatch': { currency: 'USD' },
      'missing currency': { currency: null },
      'wrong merchant': { merchantId: 'OTHER' },
      'missing merchant': { merchantId: null },
      'missing amount': { amountPaise: null },
      'missing txn id': { txnId: null },
      'success flag false': { success: false },
      'unknown status': { status: 'SETTLED' },
    };

    for (const [name, overrides] of Object.entries(cases)) {
      assert.equal(decide(answered(overrides)).status, 'requires_review', name);
    }
  });

  test('an answer about another merchantTxnId proves nothing, whatever it says', () => {
    for (const value of ['SUCCESS', 'FAILED']) {
      assert.equal(decide(answered({ status: value, merchantTxnId: 'FRVOTHERORDER1' })).status, 'requires_review');
      assert.equal(decide(answered({ status: value, merchantTxnId: null })).status, 'requires_review');
    }
  });

  test('authentication errors go to review; 429, 5xx and timeouts wait, then review', () => {
    assert.equal(decide({ outcome: 'auth_error' }).status, 'requires_review');
    assert.equal(decide({ outcome: 'not_configured' }).status, 'requires_review');
    assert.equal(decide({ outcome: 'invalid' }).status, 'requires_review');

    for (const outcome of ['rate_limited', 'unavailable']) {
      assert.equal(decide({ outcome }).status, null, outcome);
      assert.equal(decide({ outcome }, true).status, 'requires_review', outcome);
    }
  });
});

// --- Settlement through the real endpoints ------------------------------------------

describe('SabPaisa settlement via GET /api/payments/status', () => {
  test('a verified success marks the order paid, with SabPaisa\'s transaction id', async () => {
    const state = world({ orders: [spOrder()], transactions: { [REF]: enquiryOk() } });

    const response = await status(REF);
    const row = order(state);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().order.payment_status, 'paid');
    assert.equal(response.json().order.payment_gateway, 'sabpaisa');
    assert.equal(row.status, 'paid');
    assert.ok(row.paid_at);
    assert.ok(row.verified_at);
    assert.equal(row.gateway_txn_id, 'SPTXN-1');
    assert.equal(row.enquiry_count, 1);
    assert.ok(row.last_checked_at);
    assert.equal(state.airpayCalls.length, 0);
  });

  test('pending stays processing; failure and expiry fail', async () => {
    for (const [providerStatus, expected] of [['PENDING', 'processing'], ['FAILED', 'failed'], ['EXPIRED', 'failed']]) {
      const state = world({ orders: [spOrder()], transactions: { [REF]: enquiryOk(REF, { status: providerStatus }) } });

      await status(REF);

      assert.equal(order(state).payment_status, expected, providerStatus);
    }
  });

  test('an amount mismatch is held for review, not paid', async () => {
    const state = world({ orders: [spOrder()], transactions: { [REF]: enquiryOk(REF, { amountPaise: 100, paidAmount: 1 }) } });

    await status(REF);

    assert.equal(order(state).payment_status, 'requires_review');
    assert.equal(order(state).paid_at, undefined);
  });

  test('a tampered return URL changes nothing: only the enquiry answer counts', async () => {
    const state = world({ orders: [spOrder()], transactions: {} });

    const response = await call(statusHandler, {
      method: 'GET',
      url: `/api/payments/status?ref=${REF}&status=SUCCESS&paid_amount=500&amount=500&signature=forged&merchant_txn_id=${REF}`,
    });

    assert.equal(response.json().order.payment_status, 'initiated');
    assert.equal(order(state).payment_status, 'initiated');
  });

  test('refreshing the page does not spend an enquiry each time', async () => {
    const state = world({ orders: [spOrder()], transactions: { [REF]: enquiryOk(REF, { status: 'PENDING' }) } });

    await status(REF);
    await status(REF);
    await status(REF);

    assert.equal(state.enquiries.length, 1);
    assert.equal(order(state).enquiry_count, 1);
  });

  test('a settled order is never enquired about or rewritten again', async () => {
    const state = world({ orders: [spOrder({ status: 'paid', payment_status: 'paid' })], transactions: { [REF]: enquiryOk(REF, { status: 'FAILED' }) } });

    const response = await status(REF);

    assert.equal(response.json().order.payment_status, 'paid');
    assert.equal(state.enquiries.length, 0);
    assert.equal(state.patches.length, 0);
  });

  test('a browser check and reconciliation racing settle the order once, with one enquiry', async () => {
    const state = world({
      orders: [spOrder({ created_at: minutesAgo(30) })],
      transactions: { [REF]: enquiryOk() },
    });

    const [page, sweep] = await Promise.all([status(REF), reconcile()]);

    assert.equal(page.statusCode, 200);
    assert.equal(sweep.statusCode, 200);
    assert.equal(state.enquiries.length, 1);
    assert.equal(order(state).payment_status, 'paid');
    assert.equal(state.patches.filter((patch) => patch.body.payment_status === 'paid' && patch.matched > 0).length, 1);
  });

  test('settleOrder called concurrently applies paid exactly once', async () => {
    const state = world({ orders: [spOrder()], transactions: { [REF]: enquiryOk() } });

    const results = await Promise.all([settleOrder(REF), settleOrder(REF), settleOrder(REF)]);

    assert.equal(results.filter((result) => result.changed).length, 1);
    assert.equal(state.enquiries.length, 1);
    assert.equal(order(state).payment_status, 'paid');
  });
});

describe('enquiry budget', () => {
  test('stops at the automatic budget and parks the order for review without asking', async () => {
    const state = world({
      orders: [spOrder({ enquiry_count: SABPAISA_AUTO_ENQUIRY_BUDGET })],
      transactions: { [REF]: enquiryOk() },
    });

    const result = await settleOrder(REF);

    assert.equal(result.status, 'requires_review');
    assert.equal(state.enquiries.length, 0);
  });

  test('counts the enquiry that reaches the budget', async () => {
    const state = world({
      orders: [spOrder({ enquiry_count: SABPAISA_AUTO_ENQUIRY_BUDGET - 1 })],
      transactions: { [REF]: enquiryOk(REF, { status: 'PENDING' }) },
    });

    await settleOrder(REF);

    assert.equal(state.enquiries.length, 1);
    assert.equal(order(state).enquiry_count, SABPAISA_AUTO_ENQUIRY_BUDGET);
  });

  test('leaves headroom under SabPaisa\'s 100 polls per payment', () => {
    assert.ok(SABPAISA_AUTO_ENQUIRY_BUDGET <= 80);
  });

  test('not found stays open inside the review window, then goes to review — never failed', async () => {
    const fresh = world({ orders: [spOrder()] });
    await settleOrder(REF);
    assert.equal(order(fresh).payment_status, 'initiated');

    const stale = world({ orders: [spOrder({ created_at: new Date(Date.now() - SABPAISA_REVIEW_AFTER_MS - 60_000).toISOString() })] });
    await settleOrder(REF);
    assert.equal(order(stale).payment_status, 'requires_review');
  });

  test('a late success after review is still recorded', async () => {
    const state = world({
      orders: [spOrder({ status: 'requires_review', payment_status: 'requires_review', created_at: minutesAgo(600) })],
      transactions: { [REF]: enquiryOk() },
    });

    await settleOrder(REF);

    assert.equal(order(state).payment_status, 'paid');
  });
});

// --- Reconciliation ----------------------------------------------------------------

describe('reconciliation of SabPaisa orders', () => {
  test('settles an order whose customer closed the tab and never returned', async () => {
    const state = world({ orders: [spOrder({ created_at: minutesAgo(15) })], transactions: { [REF]: enquiryOk() } });

    const response = await reconcile();

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sabpaisa.settled, 1);
    assert.equal(order(state).payment_status, 'paid');
  });

  test('requires the cron secret', async () => {
    world({ orders: [spOrder({ created_at: minutesAgo(15) })] });

    const response = await call(reconcileHandler, { method: 'POST', headers: { authorization: 'Bearer wrong' } });

    assert.equal(response.statusCode, 401);
  });

  test('spaces checks out per order', async () => {
    const now = Date.now();
    world({
      orders: [
        spOrder({ order_ref: 'FRVSPDUE00001', created_at: minutesAgo(30), last_checked_at: null }),
        spOrder({ order_ref: 'FRVSPRECENT01', created_at: minutesAgo(30), last_checked_at: minutesAgo(2) }),
        spOrder({ order_ref: 'FRVSPOLDSLOW1', created_at: minutesAgo(300), enquiry_count: 25, last_checked_at: minutesAgo(30) }),
        spOrder({ order_ref: 'FRVSPOLDDUE01', created_at: minutesAgo(300), enquiry_count: 25, last_checked_at: minutesAgo(61) }),
        spOrder({ order_ref: 'FRVSPYOUNG001', created_at: minutesAgo(2) }),
        spOrder({ order_ref: 'FRVSPSPENT001', status: 'requires_review', payment_status: 'requires_review', created_at: minutesAgo(900), enquiry_count: 60, last_checked_at: minutesAgo(120) }),
        spOrder({ order_ref: 'FRVSPPAID0001', status: 'paid', payment_status: 'paid', created_at: minutesAgo(30) }),
        airpayOrder({ created_at: minutesAgo(30) }),
      ],
    });

    const due = await listSabpaisaDue({ now });

    assert.deepEqual(due.map((row) => row.order_ref).sort(), ['FRVSPDUE00001', 'FRVSPOLDDUE01']);
  });

  test('SabPaisa rows never take Airpay\'s places in the Airpay batch', async () => {
    const stale = Array.from({ length: 30 }, (_, index) =>
      spOrder({ order_ref: `FRVSPSTALE${String(index).padStart(3, '0')}`, created_at: minutesAgo(1000 + index) }),
    );

    const state = world({ orders: [...stale, airpayOrder({ created_at: minutesAgo(20) })] });

    const response = await reconcile();

    // The Airpay order was swept (Airpay is unconfigured here, so it is parked
    // for review rather than settled — the point is that it was reached).
    assert.equal(response.json().checked, 1);
    assert.equal(order(state, 'FRVAIRPAY0001').payment_status, 'requires_review');
    assert.equal(response.json().sabpaisa.checked, 10);
    assert.equal(state.enquiries.length, 10);
  });

  test('before the migration, Airpay reconciliation falls back to its original query', async () => {
    const unmigrated = airpayOrder({ created_at: minutesAgo(20) });
    delete unmigrated.payment_gateway;
    delete unmigrated.enquiry_count;
    delete unmigrated.last_checked_at;
    const state = world({ migrated: false, orders: [unmigrated] });

    const response = await reconcile();

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().checked, 1);
    assert.equal(response.json().settled, 1);
    assert.equal(order(state, 'FRVAIRPAY0001').payment_status, 'requires_review');
    assert.equal(response.json().sabpaisa.errors, 0);
  });
});

describe('switching SabPaisa off', () => {
  test('stops new payments but still settles orders already started', async () => {
    process.env.SABPAISA_ENABLED = 'false';
    const state = world({ orders: [spOrder({ created_at: minutesAgo(15) })], transactions: { [REF]: enquiryOk() } });

    assert.equal((await call(sabpaisaCreateHandler, { body: CART })).statusCode, 503);
    assert.equal((await status(REF)).json().order.payment_status, 'paid');
    assert.equal(order(state).payment_status, 'paid');
  });
});

// --- Gateway isolation ----------------------------------------------------------------

describe('gateway isolation', () => {
  /** A harness like the Airpay settlement tests', recording which provider was asked. */
  function harness(row) {
    const state = { ...row };
    const asked = { airpay: [], sabpaisa: [] };

    return {
      state,
      asked,
      deps: {
        findOrder: async () => ({ ...state }),
        confirm: async (ref, merchant) => {
          asked.airpay.push({ ref, merchant });
          return { verified: true, status: '200', amountInCents: 50000, transactionId: 'AP-1' };
        },
        sabpaisaConfirm: async (ref) => {
          asked.sabpaisa.push(ref);
          return { outcome: 'not_found' };
        },
        claimEnquiry: async () => true,
        applyUpdate: async (table, query, patch) => {
          Object.assign(state, patch);
          return [{ ...state }];
        },
      },
    };
  }

  test('payment_gateway NULL still takes the original Airpay confirmation path', async () => {
    const h = harness(airpayOrder());

    const result = await settleOrder('FRVAIRPAY0001', h.deps);

    assert.equal(result.status, 'paid');
    assert.deepEqual(h.asked.airpay, [{ ref: 'FRVAIRPAY0001', merchant: 1 }]);
    assert.equal(h.asked.sabpaisa.length, 0);
    assert.equal(h.state.airpay_transaction_id, 'AP-1');
  });

  test('payment_gateway NULL with airpay_merchant 3 is still asked of merchant 3', async () => {
    const h = harness(airpayOrder({ airpay_merchant: 3 }));

    await settleOrder('FRVAIRPAY0001', h.deps);

    assert.deepEqual(h.asked.airpay, [{ ref: 'FRVAIRPAY0001', merchant: 3 }]);
  });

  test('a SabPaisa order is never asked of Airpay', async () => {
    const h = harness(spOrder());

    const result = await settleOrder(REF, h.deps);

    assert.equal(h.asked.airpay.length, 0);
    assert.deepEqual(h.asked.sabpaisa, [REF]);
    assert.notEqual(result.status, 'paid');
  });

  test('an unknown gateway value is left untouched', async () => {
    const h = harness(spOrder({ payment_gateway: 'stripe' }));

    const result = await settleOrder(REF, h.deps);

    assert.equal(result.changed, false);
    assert.equal(h.asked.airpay.length + h.asked.sabpaisa.length, 0);
  });

  test('an Airpay callback claiming success cannot mark a SabPaisa order paid', async () => {
    Object.assign(process.env, AIRPAY_M1);

    const state = world({ orders: [spOrder()] });

    const response = await call(callbackHandler, {
      method: 'POST',
      url: '/callback/cpm/arp/collection',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        TRANSACTIONID: REF,
        APTRANSACTIONID: '123456',
        AMOUNT: '500.00',
        TRANSACTIONSTATUS: '200',
        TRANSACTIONPAYMENTSTATUS: 'SUCCESS',
        MERCID: AIRPAY_M1.AIRPAY_MID,
      }).toString(),
    });

    assert.equal(response.statusCode, 200);
    // Airpay's confirmation API was never consulted for this order...
    assert.equal(state.airpayCalls.length, 0);
    // ...SabPaisa was, and it has no such transaction, so nothing changed.
    assert.equal(state.enquiries.length, 1);
    assert.equal(order(state).payment_status, 'initiated');
    // The relay to the client is unaffected.
    assert.equal(state.forwards.length, 1);
  });

  test('createPendingOrder without a gateway is the original Airpay insert', async () => {
    const state = world({ migrated: false });
    const customer = { fullName: 'Asha Menon', phone: '9876543210', address: '12 MG Road', landmark: null };

    await createPendingOrder({ customer, items: [], totalInCents: 50000, merchant: 1 });
    await createPendingOrder({ customer, items: [], totalInCents: 50000, merchant: 2 });

    for (const row of state.orders) {
      for (const column of SABPAISA_COLUMNS) {
        assert.equal(column in row, false, column);
      }
    }

    assert.equal('airpay_merchant' in state.orders[0], false);
    assert.equal(state.orders[1].airpay_merchant, 2);
  });

  test('presentOrder reports the gateway, null for Airpay and COD', () => {
    assert.equal(presentOrder(spOrder()).payment_gateway, 'sabpaisa');
    assert.equal(presentOrder(airpayOrder()).payment_gateway, null);
  });
});

// --- Access to order status ------------------------------------------------------------

describe('order status access', () => {
  test('a reference that is malformed, unknown or a COD order reveals nothing', async () => {
    world({ orders: [spOrder(), { ...spOrder({ order_ref: 'FRVCODORDER01', payment_method: 'Cash on Delivery', payment_gateway: null }) }] });

    for (const ref of ['1', "FRV' or 1=1", 'FRVDOESNOTEXIST', 'FRVCODORDER01']) {
      const response = await status(encodeURIComponent(ref));

      assert.equal(response.statusCode, 404, ref);
      assert.equal(response.body.includes('Asha'), false);
    }
  });

  test('order references are not guessable', async () => {
    const { newOrderRef } = await import('../api/_lib/crypto.js');
    const refs = new Set(Array.from({ length: 200 }, () => newOrderRef()));

    assert.equal(refs.size, 200);
    for (const ref of refs) assert.match(ref, /^FRV[A-Z0-9]{18,}$/);
  });
});

// --- Static guarantees ---------------------------------------------------------------

describe('static guarantees', () => {
  test('no SabPaisa webhook, callback route or rewrite exists', () => {
    const vercel = JSON.parse(read('../vercel.json'));
    const sources = vercel.rewrites.map((rule) => rule.source).join('\n');

    assert.equal(/sabpaisa/i.test(sources), false);
    assert.equal(/webhook/i.test(read('../api/payments/sabpaisa/create.js').replace(/\/\*[\s\S]*?\*\//g, '')), false);
  });

  test('the migration is additive and never rewrites existing rows', () => {
    const sql = read('../migrations-sabpaisa.sql').replace(/--.*$/gm, '');

    for (const column of SABPAISA_COLUMNS) {
      assert.match(sql, new RegExp(`add column if not exists ${column} `));
    }

    assert.doesNotMatch(sql, /not null/i);
    assert.doesNotMatch(sql, /\bdefault\b/i);
    assert.doesNotMatch(sql, /\bupdate\s+public\.orders\b/i);
    assert.doesNotMatch(sql, /\bdelete\b|\bdrop\s+column\b|\bdrop\s+table\b|\btruncate\b/i);
    assert.doesNotMatch(sql, /policy/i);
    assert.match(sql, /payment_gateway is null or payment_gateway in \('airpay', 'sabpaisa'\)/);
  });

  test('no SabPaisa credential name is ever VITE_-prefixed or read in the browser bundle', () => {
    const browser = read('../apps/web/src/api/OrdersApi.js') + read('../apps/web/src/pages/CheckoutPage.jsx');

    assert.doesNotMatch(browser, /(SABPAISA|SUBPAISA)_(API_KEY|SECRET_KEY|CLIENT_CODE|MERCHANT_ID)|X-Api-Key|import\.meta\.env\.VITE_S[AU]BPAISA/);
    assert.doesNotMatch(read('../apps/web/.env.example'), /S[AU]BPAISA/);
  });

  test('the Airpay modules do not reference SabPaisa', () => {
    for (const file of ['../api/_lib/airpay.js', '../api/payments/create.js', '../api/payments/callback.js', '../api/payments/status.js']) {
      assert.doesNotMatch(read(file), /sabpaisa/i, file);
    }
  });
});
