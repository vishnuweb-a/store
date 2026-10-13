/**
 * Two Airpay merchant accounts behind one checkout.
 *
 * The properties under test throughout:
 *   - each merchant's credentials, token and encryption key are used for that
 *     merchant only, and a missing merchant 2 never becomes merchant 1;
 *   - an order is verified with the merchant it was placed on, taken from the
 *     order row and never from a callback;
 *   - every callback is relayed to the client, whether or not Frontiva holds
 *     the order, and relaying never settles anything.
 *
 * No request leaves the process: Airpay, Supabase and the client endpoint are
 * all served by the fetch stub below. No real credential is used.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach, describe } from 'node:test';
import { confirmExternalOrder, confirmOrder, getAccessToken } from '../api/_lib/airpay.js';
import { extractGatewayOrderId, resolveCallback } from '../api/_lib/callback-payload.js';
import {
  CALLBACK_PATH,
  CALLBACK_PATH_FRONTIVA,
  callbackPathFor,
  checkoutMerchants,
  configuredMerchants,
  isMerchantConfigured,
  loadAirpayConfig,
  parseMerchant,
} from '../api/_lib/config.js';
import { decrypt, encrypt, encryptionKey, privateKey } from '../api/_lib/crypto.js';
import { LOOP_GUARD_HEADER, forwardCallback } from '../api/_lib/forward-callback.js';
import { ONLINE_PAYMENT_METHOD, merchantForOrder, settleOrder } from '../api/_lib/orders.js';
import callbackHandler from '../api/payments/callback.js';
import createHandler from '../api/payments/create.js';
import optionsHandler from '../api/payments/options.js';
import statusHandler from '../api/payments/status.js';

const M1 = {
  AIRPAY_MID: '111111',
  AIRPAY_CLIENT_ID: 'client-one',
  AIRPAY_SECRET_KEY: 'secret-one',
  AIRPAY_API_KEY: 'apikey-one',
  AIRPAY_USERNAME: 'user-one',
  AIRPAY_PASSWORD: 'pass-one',
};

const M2 = {
  AIRPAY_MID_2: '222222',
  AIRPAY_CLIENT_ID_2: 'client-two',
  AIRPAY_SECRET_KEY_2: 'secret-two',
  AIRPAY_API_KEY_2: 'apikey-two',
  AIRPAY_USERNAME_2: 'user-two',
  AIRPAY_PASSWORD_2: 'pass-two',
};

const SHARED = {
  AIRPAY_ENV: 'live',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE: 'service-role',
  PUBLIC_SITE_ORIGIN: 'https://frontiva.online',
};

const KEY = {
  1: encryptionKey(M1.AIRPAY_USERNAME, M1.AIRPAY_PASSWORD),
  2: encryptionKey(M2.AIRPAY_USERNAME_2, M2.AIRPAY_PASSWORD_2),
};

const MID = { 1: M1.AIRPAY_MID, 2: M2.AIRPAY_MID_2 };
const KKCHAT_URL = 'https://kkchat.in/callback/cpm/arp_frontiva/collection';

const AIRPAY_VARIABLES = [
  ...Object.keys(M1),
  ...Object.keys(M2),
  'AIRPAY_ENABLED_MERCHANTS',
  'AIRPAY_CALLBACK_PATH',
  'AIRPAY_CALLBACK_PATH_2',
  'AIRPAY_VERIFY_URL',
  'AIRPAY_VERIFY_EXTERNAL_CALLBACKS',
  'KKCHAT_CALLBACK_URL',
];

let originalFetch;
let originalEnv;
let originalLog;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = { ...process.env };
  originalLog = console.log;

  // Start from a known state: whatever the developer's shell holds must not
  // leak a real credential, or a real destination, into these tests.
  for (const name of AIRPAY_VARIABLES) {
    delete process.env[name];
  }

  Object.assign(process.env, M1, M2, SHARED);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  console.log = originalLog;
});

/** Captures structured log events, so behaviour can be asserted from them. */
function captureLogs() {
  const events = [];

  console.log = (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Not a structured event.
    }
  };

  return events;
}

/**
 * One in-memory world: both Airpay accounts, the orders table, the audit table
 * and the client endpoint.
 *
 * Airpay is modelled faithfully where it matters to these tests: a merchant's
 * envelope only opens with that merchant's key, a token only works for the
 * merchant it was issued to, and a merchant only knows its own transactions.
 */
function world({ orders = [], transactions = {}, client = { status: 200 }, airpayDown = false } = {}) {
  const state = {
    orders: orders.map((order) => ({ ...order })),
    events: [],
    oauth: [],
    confirmations: [],
    forwards: [],
    orderWrites: [],
    nextId: 100,
  };

  const text = (status, body) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  const merchantForMid = (mid) => (mid === MID[1] ? 1 : mid === MID[2] ? 2 : null);

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);

    if (target.startsWith('https://kraken.airpay.co.in/')) {
      if (airpayDown) {
        throw new Error('ECONNRESET');
      }

      const form = Object.fromEntries(new URLSearchParams(options.body));
      const merchant = merchantForMid(form.merchant_id);

      // Decrypting with the named merchant's key is the assertion: a request
      // encrypted with the other merchant's key throws here.
      const fields = JSON.parse(decrypt(form.encdata, KEY[merchant]));

      if (target.includes('/oauth2/')) {
        state.oauth.push({ merchant, fields });

        return text(200, { data: { success: true, access_token: `token-for-${merchant}`, expires_in: 300 } });
      }

      const token = new URL(target).searchParams.get('token');
      state.confirmations.push({ merchant, token, orderid: fields.orderid, privatekey: form.privatekey });

      if (token !== `token-for-${merchant}`) {
        return text(401, 'token was not issued to this merchant');
      }

      const transaction = transactions[`${merchant}:${fields.orderid}`];

      if (!transaction) {
        return text(200, { status: 'success', data: { success: false, message: 'No record found' } });
      }

      return text(200, {
        status_code: '200',
        status: 'success',
        data: { merchant_id: MID[merchant], orderid: fields.orderid, ...transaction },
      });
    }

    if (target.startsWith(`${SHARED.SUPABASE_URL}/rest/v1/`)) {
      const { pathname, searchParams } = new URL(target);
      const table = pathname.split('/').pop();
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;

      if (table === 'products') {
        return text(200, [
          {
            id: 7,
            title: 'Linen Shirt',
            sku: 'LS-1',
            price: 1500,
            discount_price: null,
            sizes: [],
            stock: 5,
            track_quantity: false,
            active: true,
            image_url: null,
          },
        ]);
      }

      if (table === 'payment_events') {
        if (state.events.some((event) => event.dedupe_key === body.dedupe_key)) {
          return text(200, []);
        }

        state.events.push(body);

        return text(201, [body]);
      }

      if (table === 'orders' && method === 'POST') {
        state.nextId += 1;

        const row = { id: state.nextId, created_at: '2026-10-13T06:00:00Z', ...body };

        state.orders.push(row);
        state.orderWrites.push({ method, body });

        return text(201, [row]);
      }

      const ref = (searchParams.get('order_ref') || '').replace(/^eq\./, '');
      const order = state.orders.find((row) => row.order_ref === ref);

      if (table === 'orders' && method === 'GET') {
        return text(200, order ? [{ ...order }] : []);
      }

      if (table === 'orders' && method === 'PATCH') {
        state.orderWrites.push({ method, body });

        const open = ['initiated', 'processing', 'requires_review'];

        if (!order || !(open.includes(order.payment_status) || order.payment_status == null)) {
          return text(200, []);
        }

        Object.assign(order, body);

        return text(200, [{ ...order }]);
      }
    }

    if (target === KKCHAT_URL) {
      state.forwards.push({ url: target, options, body: JSON.parse(options.body) });

      if (client.hang) {
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }

      return { ok: client.status < 400, status: client.status, headers: { get: () => client.location || null } };
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

  return {
    ...response,
    json: () => JSON.parse(response.body),
  };
}

const CART = {
  customer: { fullName: 'Asha Menon', phone: '9876543210', address: '12 MG Road, Kochi 682001', landmark: '' },
  items: [{ product_id: 7, size: null, quantity: 1 }],
};

const createPayment = (extra = {}) =>
  call(createHandler, {
    url: '/api/payments/create',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...CART, ...extra }),
  });

const order = (overrides = {}) => ({
  id: 1,
  order_ref: 'FRVTESTORDER0001',
  customer_name: 'Asha Menon',
  phone: '9876543210',
  address: '12 MG Road',
  landmark: null,
  payment_method: ONLINE_PAYMENT_METHOD,
  status: 'initiated',
  payment_status: 'initiated',
  total: 1500,
  items: [],
  created_at: '2026-10-13T06:00:00Z',
  ...overrides,
});

const PAID = { transaction_status: 200, transaction_payment_status: 'SUCCESS', amount: '1500.00', ap_transactionid: 'AP-1' };
const FAILED = { transaction_status: 400, transaction_payment_status: 'FAILED', amount: '1500.00', ap_transactionid: 'AP-2' };
const PENDING = { transaction_status: 211, transaction_payment_status: 'INPROCESS', amount: '1500.00', ap_transactionid: 'AP-3' };

/** A plaintext IPN, form-encoded as Airpay sends it. */
const ipn = (merchant, ref, extra = {}) =>
  new URLSearchParams({
    MERCID: MID[merchant],
    TRANSACTIONID: ref,
    CUSTOMVAR: ref,
    APTRANSACTIONID: '250814000123456',
    AMOUNT: '1500.00',
    TRANSACTIONSTATUS: '200',
    TRANSACTIONPAYMENTSTATUS: 'SUCCESS',
    ...extra,
  }).toString();

/** The encrypted callback shape: merchant_id in the clear, the rest enveloped. */
const enveloped = (merchant, ref, { key = KEY[merchant], withMid = true, extra = {} } = {}) => {
  const inner = {
    MERCID: MID[merchant],
    TRANSACTIONID: ref,
    CUSTOMVAR: ref,
    APTRANSACTIONID: '250814000123456',
    AMOUNT: '1500.00',
    TRANSACTIONSTATUS: '200',
    ...extra,
  };

  return {
    ...(withMid ? { merchant_id: MID[merchant] } : {}),
    response: encrypt(JSON.stringify(inner), key),
  };
};

const postCallback = (body, { path = CALLBACK_PATH_FRONTIVA, headers = {} } = {}) =>
  call(callbackHandler, {
    url: path,
    headers: {
      'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('merchant configuration', () => {
  test('merchant 1 loads the original, unsuffixed variables', () => {
    const config = loadAirpayConfig(1);

    assert.equal(config.merchant, 1);
    assert.equal(config.mid, M1.AIRPAY_MID);
    assert.equal(config.clientId, M1.AIRPAY_CLIENT_ID);
    assert.equal(config.secretKey, M1.AIRPAY_SECRET_KEY);
    assert.equal(config.apiKey, M1.AIRPAY_API_KEY);
    assert.equal(config.username, M1.AIRPAY_USERNAME);
    assert.equal(config.password, M1.AIRPAY_PASSWORD);
  });

  test('merchant 2 loads only the _2 variables', () => {
    const config = loadAirpayConfig(2);

    assert.equal(config.merchant, 2);
    assert.equal(config.mid, M2.AIRPAY_MID_2);
    assert.equal(config.secretKey, M2.AIRPAY_SECRET_KEY_2);
    assert.equal(config.apiKey, M2.AIRPAY_API_KEY_2);

    for (const value of Object.values(M1)) {
      assert.ok(!Object.values(config).includes(value), 'merchant 2 picked up a merchant 1 value');
    }
  });

  test('a missing merchant 2 credential is an error, never a fallback to merchant 1', () => {
    for (const name of Object.keys(M2)) {
      const saved = process.env[name];

      delete process.env[name];

      assert.throws(
        () => loadAirpayConfig(2),
        (error) => error.isConfigError && error.message.includes(name),
        `${name} missing must fail`,
      );
      assert.equal(isMerchantConfigured(2), false);
      // Merchant 1 is untouched by merchant 2's absence.
      assert.equal(loadAirpayConfig(1).mid, M1.AIRPAY_MID);

      process.env[name] = saved;
    }
  });

  test('a config error names the variable and never a value', () => {
    process.env.AIRPAY_API_KEY_2 = '   ';

    const error = (() => {
      try {
        return loadAirpayConfig(2);
      } catch (caught) {
        return caught;
      }
    })();

    for (const secret of [...Object.values(M1), ...Object.values(M2)]) {
      assert.ok(!error.message.includes(secret));
    }
  });

  test('exactly merchants 1 and 2 are accepted', () => {
    assert.equal(parseMerchant(1), 1);
    assert.equal(parseMerchant('2'), 2);

    for (const value of [0, 3, -1, 1.5, '01', 'two', '', null, undefined, true, {}, [], '1 ', 'AIRPAY_MID']) {
      assert.equal(parseMerchant(value), null, `accepted ${JSON.stringify(value)}`);
    }

    assert.throws(() => loadAirpayConfig(3), (error) => error.isConfigError);
    assert.throws(() => loadAirpayConfig(undefined), (error) => error.isConfigError);
  });

  test('checkout offers every configured merchant by default', () => {
    assert.deepEqual(checkoutMerchants(), [1, 2]);
  });

  test('an unconfigured merchant 2 is simply not offered', () => {
    delete process.env.AIRPAY_SECRET_KEY_2;

    assert.deepEqual(checkoutMerchants(), [1]);
  });

  test('AIRPAY_ENABLED_MERCHANTS=1 restores merchant 1 only checkout', () => {
    process.env.AIRPAY_ENABLED_MERCHANTS = '1';

    assert.deepEqual(checkoutMerchants(), [1]);
    // Merchant 2 stays loadable, so orders already placed on it still verify.
    assert.equal(configuredMerchants().length, 2);
  });

  test('a mistyped switch cannot turn merchant 1 off', () => {
    for (const value of ['', ' ', 'none', '0', 'x,y']) {
      process.env.AIRPAY_ENABLED_MERCHANTS = value;

      assert.deepEqual(checkoutMerchants(), [1, 2], `value ${JSON.stringify(value)}`);
    }
  });

  test('each merchant names its own registered callback path', () => {
    assert.equal(callbackPathFor(1), '/callback/cpm/arp/collection');
    assert.equal(callbackPathFor(2), '/callback/cpm/arp_frontiva/collection');
  });

  test('a callback path override is honoured only for a path this site serves', () => {
    process.env.AIRPAY_CALLBACK_PATH = CALLBACK_PATH_FRONTIVA;
    assert.equal(callbackPathFor(1), CALLBACK_PATH_FRONTIVA);

    process.env.AIRPAY_CALLBACK_PATH = 'https://evil.example/collect';
    assert.equal(callbackPathFor(1), CALLBACK_PATH);
  });
});

describe('Airpay protocol operations are per merchant', () => {
  test('each merchant authenticates with its own client credentials', async () => {
    const state = world();

    const one = await getAccessToken(1);
    const two = await getAccessToken(2);

    assert.equal(one.accessToken, 'token-for-1');
    assert.equal(two.accessToken, 'token-for-2');
    assert.deepEqual(state.oauth[0].fields, {
      client_id: 'client-one',
      client_secret: 'secret-one',
      merchant_id: '111111',
      grant_type: 'client_credentials',
    });
    assert.deepEqual(state.oauth[1].fields, {
      client_id: 'client-two',
      client_secret: 'secret-two',
      merchant_id: '222222',
      grant_type: 'client_credentials',
    });
  });

  test('a confirmation presents the token and privatekey of the merchant asked', async () => {
    const state = world({ transactions: { '1:FRVA0000001': PAID, '2:FRVB0000002': PAID } });

    await confirmOrder('FRVA0000001', 1);
    await confirmOrder('FRVB0000002', 2);

    assert.equal(state.confirmations[0].token, 'token-for-1');
    assert.equal(state.confirmations[0].privatekey, privateKey('apikey-one', 'user-one', 'pass-one'));
    assert.equal(state.confirmations[1].token, 'token-for-2');
    assert.equal(state.confirmations[1].privatekey, privateKey('apikey-two', 'user-two', 'pass-two'));
  });

  test('a token is requested fresh for each call, so none can be reused across merchants', async () => {
    const state = world({ transactions: { '1:FRVA0000001': PAID } });

    await confirmOrder('FRVA0000001', 1);
    await confirmOrder('FRVA0000001', 2);

    assert.deepEqual(state.oauth.map((entry) => entry.merchant), [1, 2]);
    assert.deepEqual(state.confirmations.map((entry) => entry.token), ['token-for-1', 'token-for-2']);
  });

  test('the wrong merchant cannot confirm an order', async () => {
    world({ transactions: { '2:FRVB0000002': PAID } });

    const wrong = await confirmOrder('FRVB0000002', 1);
    const right = await confirmOrder('FRVB0000002', 2);

    assert.equal(wrong.verified, false);
    assert.equal(right.verified, true);
    assert.equal(right.merchant, 2);
  });

  test('an unconfigured merchant is unverified, not answered by the other one', async () => {
    const state = world({ transactions: { '1:FRVA0000001': PAID } });

    delete process.env.AIRPAY_PASSWORD_2;

    const result = await confirmOrder('FRVA0000001', 2);

    assert.equal(result.verified, false);
    assert.equal(result.reason, 'not configured');
    assert.equal(state.oauth.length, 0, 'no request may be made with another merchant');
  });
});

describe('Order Confirmation parsing', () => {
  /** Serves one fixed confirmation body to merchant 1. */
  const confirmWith = async (body) => {
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify(String(url).includes('/oauth2/') ? { access_token: 'tok', expires_in: 60 } : body),
    });

    return confirmOrder('FRVA0000001', 1);
  };

  test('a transport-level status is not mistaken for the transaction status', async () => {
    // The outer "success" describes the API call. The transaction failed.
    const result = await confirmWith({
      status_code: '200',
      status: 'success',
      data: { transaction_status: 400, amount: '1500.00' },
    });

    assert.equal(result.verified, true);
    assert.equal(result.status, '400');
  });

  test('the same holds when the result arrives encrypted', async () => {
    const result = await confirmWith({
      status: 'success',
      response: encrypt(JSON.stringify({ transaction_status: 400, amount: '1500.00' }), KEY[1]),
    });

    assert.equal(result.status, '400');
  });

  test('an outer status alone, with an inner result that has none, is not a status', async () => {
    const result = await confirmWith({ status: 'success', data: { amount: '1500.00', message: 'ok' } });

    assert.equal(result.verified, false);
  });

  test('conflicting status fields are never a success', async () => {
    const result = await confirmWith({
      data: { transaction_status: 200, transaction_payment_status: 'FAILED', amount: '1500.00' },
    });

    assert.equal(result.verified, false);
    assert.match(result.reason, /conflicting/);
  });

  test('agreeing status fields are accepted', async () => {
    const result = await confirmWith({ data: PAID });

    assert.equal(result.verified, true);
    assert.equal(result.status, '200');
    assert.equal(result.amountInCents, 150000);
    assert.equal(result.transactionId, 'AP-1');
  });

  test('a confirmation for a different order is rejected', async () => {
    const result = await confirmWith({ data: { ...PAID, orderid: 'FRVSOMEONEELSE' } });

    assert.equal(result.verified, false);
    assert.match(result.reason, /different order/);
  });

  test('a confirmation naming a different merchant is rejected', async () => {
    const result = await confirmWith({ data: { ...PAID, merchant_id: MID[2] } });

    assert.equal(result.verified, false);
    assert.match(result.reason, /different merchant/);
  });

  test('a flat response with only a transaction status still works', async () => {
    const result = await confirmWith({ TRANSACTIONSTATUS: '200', AMOUNT: '1500.00', APTRANSACTIONID: 'AP-9' });

    assert.equal(result.verified, true);
    assert.equal(result.status, '200');
  });
});

describe('POST /api/payments/create — merchant selection', () => {
  test('merchant 1 is used when the customer chooses it', async () => {
    const state = world();
    const response = await createPayment({ merchant: 1 });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(state.oauth.map((entry) => entry.merchant), [1]);
    assert.equal(body.fields.merchant_id, MID[1]);
    assert.match(body.action, /token=token-for-1$/);
  });

  test('merchant 2 is used when the customer chooses it', async () => {
    const state = world();
    const response = await createPayment({ merchant: 2 });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(state.oauth.map((entry) => entry.merchant), [2]);
    assert.equal(body.fields.merchant_id, MID[2]);
    assert.match(body.action, /token=token-for-2$/);
  });

  test('an absent selection is merchant 1, as before the second account existed', async () => {
    const state = world();
    const response = await createPayment();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(state.oauth.map((entry) => entry.merchant), [1]);
    assert.equal(response.json().fields.merchant_id, MID[1]);
  });

  test('the hand-off is encrypted and signed with the chosen merchant only', async () => {
    world();

    for (const merchant of [1, 2]) {
      const other = merchant === 1 ? 2 : 1;
      const { fields } = (await createPayment({ merchant })).json();
      const config = loadAirpayConfig(merchant);

      const sent = JSON.parse(decrypt(fields.encdata, KEY[merchant]));

      assert.equal(sent.amount, '1500.00');
      assert.equal(fields.privatekey, privateKey(config.apiKey, config.username, config.password));
      // The other merchant's key does not open it.
      assert.throws(() => JSON.parse(decrypt(fields.encdata, KEY[other])));
    }
  });

  test('both merchants are priced identically, by the server', async () => {
    world();

    const one = (await createPayment({ merchant: 1, total: 1, amount: 1 })).json();
    const two = (await createPayment({ merchant: 2, total: 1, amount: 1 })).json();

    assert.equal(one.total_in_cents, 150000);
    assert.equal(two.total_in_cents, 150000);
    assert.equal(JSON.parse(decrypt(two.fields.encdata, KEY[2])).amount, '1500.00');
  });

  test('each merchant sends the return URL its own dashboard registers', async () => {
    world();

    const one = JSON.parse(decrypt((await createPayment({ merchant: 1 })).json().fields.encdata, KEY[1]));
    const two = JSON.parse(decrypt((await createPayment({ merchant: 2 })).json().fields.encdata, KEY[2]));

    assert.equal(one.successUrl, 'https://frontiva.online/callback/cpm/arp/collection');
    assert.equal(two.successUrl, 'https://frontiva.online/callback/cpm/arp_frontiva/collection');
  });

  test('the merchant is recorded on a merchant 2 order', async () => {
    const state = world();
    const { order_ref: ref } = (await createPayment({ merchant: 2 })).json();
    const row = state.orders.find((entry) => entry.order_ref === ref);

    assert.equal(row.airpay_merchant, 2);
    assert.equal(merchantForOrder(row), 2);
    assert.match(ref, /^FRV[A-Z0-9]{5,61}$/, 'the reference format is unchanged');
  });

  test('a merchant 1 order writes exactly the columns it always did', async () => {
    const state = world();
    const { order_ref: ref } = (await createPayment({ merchant: 1 })).json();
    const row = state.orders.find((entry) => entry.order_ref === ref);

    // No new column is named, so merchant 1 does not depend on the migration.
    assert.ok(!('airpay_merchant' in state.orderWrites[0].body));
    assert.equal(merchantForOrder(row), 1);
  });

  test('an invalid selection is rejected before anything is created', async () => {
    for (const merchant of [3, 0, 'airpay', '1; drop', { id: 2 }, [2], true, 2.5]) {
      const state = world();
      const response = await createPayment({ merchant });

      assert.equal(response.statusCode, 400, `accepted ${JSON.stringify(merchant)}`);
      assert.equal(state.oauth.length, 0);
      assert.equal(state.orders.length, 0);
    }
  });

  test('nothing but the merchant number is read from the browser', async () => {
    const state = world();

    const response = await createPayment({
      merchant: 2,
      mid: '999999',
      merchant_id: '999999',
      AIRPAY_MID_2: '999999',
      action: 'https://evil.example/pay',
      returnUrl: 'https://evil.example/return',
      secretKey: 'attacker',
    });
    const body = response.json();

    assert.equal(body.fields.merchant_id, MID[2]);
    assert.ok(body.action.startsWith('https://payments.airpay.co.in/pay/v4/'));
    assert.ok(!JSON.stringify(body).includes('evil.example'));
    assert.equal(state.oauth[0].fields.client_secret, 'secret-two');
  });

  test('merchant 2 missing its configuration fails safely and never becomes merchant 1', async () => {
    const state = world();

    delete process.env.AIRPAY_API_KEY_2;

    const response = await createPayment({ merchant: 2 });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'merchant_unavailable');
    assert.equal(state.oauth.length, 0, 'no token may be requested from merchant 1 instead');
    assert.equal(state.orders.length, 0);

    // And merchant 1 still works.
    assert.equal((await createPayment({ merchant: 1 })).statusCode, 200);
  });

  test('merchant 2 switched off is refused, while merchant 1 carries on', async () => {
    const state = world();

    process.env.AIRPAY_ENABLED_MERCHANTS = '1';

    assert.equal((await createPayment({ merchant: 2 })).statusCode, 503);
    assert.equal(state.orders.length, 0);
    assert.equal((await createPayment({ merchant: 1 })).statusCode, 200);
  });

  test('an Airpay failure creates no order and names no credential', async () => {
    const state = world({ airpayDown: true });
    const response = await createPayment({ merchant: 2 });

    assert.equal(response.statusCode, 502);
    assert.equal(state.orders.length, 0);

    for (const secret of [...Object.values(M1), ...Object.values(M2)]) {
      assert.ok(!response.body.includes(secret));
    }
  });

  test('no credential of either merchant is in a successful response', async () => {
    world();

    for (const merchant of [1, 2]) {
      const response = await createPayment({ merchant });

      for (const secret of ['secret-one', 'apikey-one', 'pass-one', 'secret-two', 'apikey-two', 'pass-two']) {
        assert.ok(!response.body.includes(secret), `merchant ${merchant} response leaked ${secret}`);
      }
    }
  });
});

describe('GET /api/payments/options', () => {
  const options = async () => (await call(optionsHandler, { method: 'GET', url: '/api/payments/options' })).json();

  test('lists both merchants when both are configured', async () => {
    assert.deepEqual(await options(), { merchants: [1, 2] });
  });

  test('lists merchant 1 alone when merchant 2 is not configured', async () => {
    for (const name of Object.keys(M2)) {
      delete process.env[name];
    }

    assert.deepEqual(await options(), { merchants: [1] });
  });

  test('returns numbers only — no MID and no credential', async () => {
    const response = await call(optionsHandler, { method: 'GET', url: '/api/payments/options' });

    for (const value of [...Object.values(M1), ...Object.values(M2)]) {
      assert.ok(!response.body.includes(value));
    }
  });
});

describe('merchant-aware settlement', () => {
  const settleWith = (row, confirmation) => {
    const asked = [];
    const state = { ...row };

    return {
      asked,
      state,
      run: () =>
        settleOrder(row.order_ref, {
          findOrder: async () => ({ ...state }),
          confirm: async (ref, merchant) => {
            asked.push({ ref, merchant });
            return confirmation;
          },
          applyUpdate: async (table, query, patch) => {
            Object.assign(state, patch);
            return [{ ...state }];
          },
        }),
    };
  };

  const confirmedPaid = { verified: true, status: '200', amountInCents: 150000, transactionId: 'AP-1' };

  test('a historic order with no merchant recorded is verified with merchant 1', async () => {
    const h = settleWith(order(), confirmedPaid);
    const result = await h.run();

    assert.deepEqual(h.asked, [{ ref: 'FRVTESTORDER0001', merchant: 1 }]);
    assert.equal(result.status, 'paid');
  });

  test('a merchant 2 order is verified with merchant 2', async () => {
    const h = settleWith(order({ airpay_merchant: 2 }), confirmedPaid);
    const result = await h.run();

    assert.deepEqual(h.asked, [{ ref: 'FRVTESTORDER0001', merchant: 2 }]);
    assert.equal(result.status, 'paid');
  });

  test('an order naming an unknown merchant is not settled at all', async () => {
    for (const stored of [3, 0, 'x', '12']) {
      const h = settleWith(order({ airpay_merchant: stored }), confirmedPaid);
      const result = await h.run();

      assert.equal(h.asked.length, 0, 'no account may be asked on a guess');
      assert.equal(result.changed, false);
      assert.equal(h.state.payment_status, 'initiated');
    }
  });

  test('merchantForOrder maps null to merchant 1 and nothing else implicitly', () => {
    assert.equal(merchantForOrder({}), 1);
    assert.equal(merchantForOrder({ airpay_merchant: null }), 1);
    assert.equal(merchantForOrder({ airpay_merchant: 1 }), 1);
    assert.equal(merchantForOrder({ airpay_merchant: '2' }), 2);
    assert.equal(merchantForOrder({ airpay_merchant: 9 }), null);
  });

  test('end to end: each merchant settles its own order, at the right amount', async () => {
    for (const merchant of [1, 2]) {
      const row = order(merchant === 2 ? { airpay_merchant: 2 } : {});
      const state = world({ orders: [row], transactions: { [`${merchant}:${row.order_ref}`]: PAID } });

      const result = await settleOrder(row.order_ref);

      assert.equal(result.status, 'paid', `merchant ${merchant}`);
      assert.deepEqual(state.confirmations.map((entry) => entry.merchant), [merchant]);
      assert.equal(state.orders[0].payment_status, 'paid');
      assert.equal(state.orders[0].airpay_transaction_id, 'AP-1');
    }
  });

  test('end to end: failed and pending are applied per merchant', async () => {
    for (const merchant of [1, 2]) {
      for (const [transaction, expected] of [[FAILED, 'failed'], [PENDING, 'processing']]) {
        const row = order(merchant === 2 ? { airpay_merchant: 2 } : {});
        const state = world({ orders: [row], transactions: { [`${merchant}:${row.order_ref}`]: transaction } });

        assert.equal((await settleOrder(row.order_ref)).status, expected, `merchant ${merchant}`);
        assert.equal(state.orders[0].paid_at, undefined);
      }
    }
  });

  test('an amount mismatch requires review on either merchant', async () => {
    for (const merchant of [1, 2]) {
      const row = order(merchant === 2 ? { airpay_merchant: 2 } : {});

      world({ orders: [row], transactions: { [`${merchant}:${row.order_ref}`]: { ...PAID, amount: '1.00' } } });

      assert.equal((await settleOrder(row.order_ref)).status, 'requires_review');
    }
  });

  test('a payment made on merchant 1 cannot settle a merchant 2 order', async () => {
    // The order is merchant 2's, but only merchant 1 knows a paid transaction
    // by that reference. Merchant 2 is asked, finds nothing, and nothing is paid.
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PAID } });

    const result = await settleOrder(row.order_ref);

    assert.notEqual(result.status, 'paid');
    assert.deepEqual(state.confirmations.map((entry) => entry.merchant), [2]);
  });

  test('Airpay being unreachable never marks an order paid', async () => {
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], airpayDown: true });

    assert.equal((await settleOrder(row.order_ref)).status, 'requires_review');
    assert.equal(state.orders[0].paid_at, undefined);
  });

  test('a duplicate settlement writes once', async () => {
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], transactions: { [`2:${row.order_ref}`]: PAID } });

    const [first, second] = [await settleOrder(row.order_ref), await settleOrder(row.order_ref)];

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(state.orderWrites.length, 1);
  });

  test('a Cash on Delivery order is never touched', async () => {
    const row = order({ payment_method: 'Cash on Delivery', status: 'processing', payment_status: null });
    const state = world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PAID } });

    const result = await settleOrder(row.order_ref);

    assert.equal(result.changed, false);
    assert.equal(state.confirmations.length, 0);
    assert.equal(state.orderWrites.length, 0);
  });
});

describe('resolving which merchant a callback belongs to', () => {
  const merchants = () =>
    configuredMerchants().map((entry) => ({
      merchant: entry.merchant,
      mid: entry.mid,
      key: encryptionKey(entry.username, entry.password),
    }));

  test('a stated MID narrows to that merchant', () => {
    for (const merchant of [1, 2]) {
      const result = resolveCallback({ MERCID: MID[merchant], CUSTOMVAR: 'FRVA0000001' }, merchants());

      assert.equal(result.merchant, merchant);
      assert.equal(result.basis, 'stated_mid');
    }
  });

  test('an envelope is opened with its own merchant’s key', () => {
    for (const merchant of [1, 2]) {
      const result = resolveCallback(enveloped(merchant, 'FRVA0000001'), merchants());

      assert.equal(result.unwrapped, true);
      assert.equal(result.merchant, merchant);
      assert.equal(result.basis, 'envelope');
      assert.equal(result.payload.CUSTOMVAR, 'FRVA0000001');
    }
  });

  test('with no MID stated, the key that decrypts decides', () => {
    for (const merchant of [1, 2]) {
      const result = resolveCallback(enveloped(merchant, 'FRVA0000001', { withMid: false }), merchants());

      assert.equal(result.merchant, merchant, `merchant ${merchant}`);
      assert.equal(result.basis, 'envelope');
    }
  });

  test('a stated MID does not let one merchant’s envelope pass as the other’s', () => {
    // Claims merchant 1, but is encrypted with merchant 2's key.
    const forged = { merchant_id: MID[1], response: enveloped(2, 'FRVA0000001').response };
    const result = resolveCallback(forged, merchants());

    assert.equal(result.unwrapped, false);
    assert.notEqual(result.basis, 'envelope');
  });

  test('a MID that is neither merchant is foreign, and its envelope is not opened', () => {
    const result = resolveCallback({ merchant_id: '999999', response: enveloped(1, 'FRVA0000001').response }, merchants());

    assert.equal(result.foreign, true);
    assert.equal(result.merchant, null);
    assert.equal(result.unwrapped, false);
  });

  test('an unreadable envelope resolves to no merchant on the strength of decryption', () => {
    const result = resolveCallback({ response: 'not-an-envelope-at-all-just-noise-0123456789' }, merchants());

    assert.equal(result.unwrapped, false);
    assert.equal(result.merchant, null);
  });

  test('with no merchants configured it degrades rather than throwing', () => {
    const result = resolveCallback(enveloped(1, 'FRVA0000001'), []);

    assert.equal(result.unwrapped, false);
    assert.match(result.reason, /no key/);
  });

  test('never throws on empty, malformed or hostile input', () => {
    for (const payload of [{}, null, undefined, 'x', 42, [], { response: {} }, { merchant_id: {} }, { MERCID: null }]) {
      assert.doesNotThrow(() => resolveCallback(payload, merchants()));
      assert.equal(resolveCallback(payload, merchants()).merchant, null);
    }
  });

  test('extractGatewayOrderId accepts foreign formats but nothing unsafe', () => {
    assert.equal(extractGatewayOrderId({ orderid: 'KK-2026-000123' }), 'KK-2026-000123');
    assert.equal(extractGatewayOrderId({ TRANSACTIONID: 'ORD123456' }), 'ORD123456');

    for (const value of ['', 'a', '../../etc/passwd', "x' or 1=1", 'a b', 'x'.repeat(65), '<script>']) {
      assert.equal(extractGatewayOrderId({ orderid: value }), null);
    }
  });
});

describe('the callback endpoint', () => {
  test('both public paths are routed to the one handler, ahead of the SPA', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    const spa = vercel.rewrites.findIndex((entry) => entry.destination === '/index.html');

    for (const path of [CALLBACK_PATH, CALLBACK_PATH_FRONTIVA]) {
      const index = vercel.rewrites.findIndex((entry) => entry.source === path);

      assert.ok(index > -1, `${path} is not routed`);
      assert.equal(vercel.rewrites[index].destination, '/api/payments/callback');
      assert.ok(index < spa, `${path} must precede the SPA fallback`);
    }

    assert.equal(CALLBACK_PATH_FRONTIVA, '/callback/cpm/arp_frontiva/collection');
    assert.equal(CALLBACK_PATH, '/callback/cpm/arp/collection');
  });

  test('a merchant 1 IPN settles a merchant 1 order and is forwarded', async () => {
    const row = order();
    const state = world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PAID } });
    const body = ipn(1, row.order_ref);

    const response = await postCallback(body, { path: CALLBACK_PATH });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'OK');
    assert.equal(state.orders[0].payment_status, 'paid');
    assert.deepEqual(state.confirmations.map((entry) => entry.merchant), [1]);
    assert.equal(state.forwards.length, 1);
    assert.deepEqual(state.forwards[0].body, Object.fromEntries(new URLSearchParams(body)));
  });

  test('a merchant 2 IPN settles a merchant 2 order and is forwarded', async () => {
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], transactions: { [`2:${row.order_ref}`]: PAID } });
    const body = ipn(2, row.order_ref);

    const response = await postCallback(body);

    assert.equal(response.statusCode, 200);
    assert.equal(state.orders[0].payment_status, 'paid');
    assert.deepEqual(state.confirmations.map((entry) => entry.merchant), [2]);
    assert.equal(state.forwards.length, 1);
    assert.equal(state.forwards[0].url, KKCHAT_URL);
    assert.deepEqual(state.forwards[0].body, Object.fromEntries(new URLSearchParams(body)));
  });

  test('an encrypted callback is opened with the right merchant’s key and settles', async () => {
    for (const merchant of [1, 2]) {
      const row = order(merchant === 2 ? { airpay_merchant: 2 } : {});
      const state = world({ orders: [row], transactions: { [`${merchant}:${row.order_ref}`]: PAID } });
      const envelope = enveloped(merchant, row.order_ref);

      await postCallback(envelope);

      assert.equal(state.orders[0].payment_status, 'paid', `merchant ${merchant}`);
      assert.deepEqual(state.confirmations.map((entry) => entry.merchant), [merchant]);
      // Relayed still encrypted, byte for byte.
      assert.deepEqual(state.forwards[0].body, envelope);
    }
  });

  test('a callback claiming success cannot pay an order Airpay says failed', async () => {
    for (const merchant of [1, 2]) {
      const row = order(merchant === 2 ? { airpay_merchant: 2 } : {});
      const state = world({ orders: [row], transactions: { [`${merchant}:${row.order_ref}`]: FAILED } });

      await postCallback(ipn(merchant, row.order_ref, { TRANSACTIONSTATUS: '200' }));

      assert.equal(state.orders[0].payment_status, 'failed');
      assert.equal(state.orders[0].paid_at, undefined);
    }
  });

  test('a forged success with no transaction at Airpay pays nothing', async () => {
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row] });

    await postCallback(ipn(2, row.order_ref));

    assert.notEqual(state.orders[0].payment_status, 'paid');
    assert.equal(state.orders[0].paid_at, undefined);
  });

  test('a callback naming the other merchant does not settle the order', async () => {
    // A merchant 2 order, with a real paid transaction on merchant 2 — but the
    // delivery says it is merchant 1's. It is not acted on.
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], transactions: { [`2:${row.order_ref}`]: PAID } });
    const logs = captureLogs();

    const response = await postCallback(ipn(1, row.order_ref));

    assert.equal(response.statusCode, 200);
    assert.equal(state.orders[0].payment_status, 'initiated');
    assert.equal(state.confirmations.length, 0);
    assert.ok(logs.some((entry) => entry.event === 'payment.callback.mid_mismatch'));
    // Still relayed: forwarding is not Frontiva's judgement of the payment.
    assert.equal(state.forwards.length, 1);
  });

  test('an envelope from the other merchant does not settle the order', async () => {
    const row = order();
    const state = world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PAID } });

    await postCallback(enveloped(2, row.order_ref));

    assert.equal(state.orders[0].payment_status, 'initiated');
    assert.equal(state.confirmations.length, 0);
  });

  test('a callback for an unknown MID does not settle, and is still forwarded', async () => {
    const row = order();
    const state = world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PAID } });

    await postCallback(new URLSearchParams({ MERCID: '999999', CUSTOMVAR: row.order_ref }).toString());

    assert.equal(state.orders[0].payment_status, 'initiated');
    assert.equal(state.forwards.length, 1);
  });

  test('the order’s merchant being unconfigured blocks settlement instead of using the other', async () => {
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], transactions: { [`2:${row.order_ref}`]: PAID } });

    delete process.env.AIRPAY_SECRET_KEY_2;

    const response = await postCallback(ipn(2, row.order_ref));

    assert.equal(response.statusCode, 200);
    assert.equal(state.orders[0].payment_status, 'initiated');
    assert.equal(state.oauth.length, 0);
  });

  test('an unreadable envelope is acknowledged, forwarded, and settles nothing', async () => {
    const row = order();
    const state = world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PAID } });
    const garbage = { merchant_id: MID[1], response: 'ffffffffffffffffnot+really/base64==' };

    const response = await postCallback(garbage);

    assert.equal(response.statusCode, 200);
    assert.equal(state.orders[0].payment_status, 'initiated');
    assert.deepEqual(state.forwards[0].body, garbage);
  });

  test('empty and malformed bodies are acknowledged and settle nothing', async () => {
    for (const body of ['', '{not json', '%%%', '[]', 'null', '=&=&=']) {
      const row = order();
      const state = world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PAID } });

      const response = await call(callbackHandler, {
        url: CALLBACK_PATH_FRONTIVA,
        headers: { 'content-type': 'application/json' },
        body,
      });

      assert.equal(response.statusCode, 200, `body ${JSON.stringify(body)}`);
      assert.equal(state.orders[0].payment_status, 'initiated');
      assert.equal(state.orderWrites.length, 0);
    }
  });

  test('a duplicate IPN and a browser return settle once', async () => {
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], transactions: { [`2:${row.order_ref}`]: PAID } });
    const body = ipn(2, row.order_ref);

    await postCallback(body);
    await postCallback(body);
    const browser = await postCallback(body, { headers: { 'sec-fetch-mode': 'navigate' } });

    assert.equal(state.orderWrites.length, 1, 'exactly one settlement write');
    assert.equal(state.confirmations.length, 1, 'a settled order is not re-verified');
    assert.equal(state.events.length, 1, 'redeliveries dedupe in the audit table');
    assert.equal(browser.statusCode, 303);
    assert.equal(browser.headers.location, `https://frontiva.online/success?ref=${row.order_ref}`);
    // Each delivery is relayed, as before.
    assert.equal(state.forwards.length, 3);
  });

  test('a GET browser landing is redirected to the success page', async () => {
    const row = order();

    world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PAID } });

    const response = await call(callbackHandler, {
      method: 'GET',
      url: `${CALLBACK_PATH_FRONTIVA}?CUSTOMVAR=${row.order_ref}&MERCID=${MID[1]}`,
      headers: { accept: 'text/html' },
    });

    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, `https://frontiva.online/success?ref=${row.order_ref}`);
  });

  test('other methods are refused', async () => {
    world();

    assert.equal((await call(callbackHandler, { method: 'DELETE', url: CALLBACK_PATH_FRONTIVA })).statusCode, 405);
  });
});

describe('callbacks for orders Frontiva does not hold', () => {
  test('an external order is forwarded although no local order exists', async () => {
    for (const merchant of [1, 2]) {
      const state = world();
      const body = ipn(merchant, 'KKORDER-2026-0042');

      const response = await postCallback(body);

      assert.equal(response.statusCode, 200);
      assert.equal(response.body, 'OK');
      assert.equal(state.forwards.length, 1, `merchant ${merchant}`);
      assert.deepEqual(state.forwards[0].body, Object.fromEntries(new URLSearchParams(body)));
    }
  });

  test('nothing is created or changed in the orders table for it', async () => {
    const mine = order();
    const state = world({ orders: [mine], transactions: { '2:KKORDER-2026-0042': PAID } });

    await postCallback(ipn(2, 'KKORDER-2026-0042'));
    await postCallback(enveloped(2, 'KKORDER-2026-0042'));

    assert.equal(state.orderWrites.length, 0);
    assert.equal(state.orders.length, 1);
    assert.equal(state.orders[0].payment_status, 'initiated');
  });

  test('a Frontiva-shaped reference that is not in the database is forwarded, not created', async () => {
    const state = world({ transactions: { '1:FRVNOTINDATABASE1': PAID } });

    const response = await postCallback(ipn(1, 'FRVNOTINDATABASE1'));

    assert.equal(response.statusCode, 200);
    assert.equal(state.forwards.length, 1);
    assert.equal(state.orders.length, 0);
    assert.equal(state.orderWrites.length, 0);
  });

  test('forwarding does not wait on, or need, the database', async () => {
    const state = world();

    // Supabase is gone entirely.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.VITE_SUPABASE_ANON_KEY;

    const response = await postCallback(ipn(2, 'KKORDER-2026-0042'));

    assert.equal(response.statusCode, 200);
    assert.equal(state.forwards.length, 1);
  });

  test('by default no Airpay call is made for an external order', async () => {
    const state = world({ transactions: { '2:KKORDER-2026-0042': PAID } });

    await postCallback(ipn(2, 'KKORDER-2026-0042'));

    assert.equal(state.oauth.length, 0);
    assert.equal(state.confirmations.length, 0);
  });

  test('when enabled, the outcome is confirmed with the resolved merchant and only logged', async () => {
    process.env.AIRPAY_VERIFY_EXTERNAL_CALLBACKS = 'true';

    const state = world({ transactions: { '2:KKORDER-2026-0042': FAILED } });
    const logs = captureLogs();

    // The callback claims success; Airpay says it failed.
    await postCallback(enveloped(2, 'KKORDER-2026-0042'));

    const verified = logs.find((entry) => entry.event === 'payment.callback.external_verified');

    assert.deepEqual(state.confirmations.map((entry) => entry.merchant), [2]);
    assert.equal(verified.verified, true);
    assert.equal(verified.merchant, 2);
    assert.equal(verified.status, '400', 'the logged status is Airpay’s, not the callback’s');
    assert.equal(state.orderWrites.length, 0);
    assert.equal(state.forwards.length, 1);
  });

  test('when the merchant is unknown, each is asked and only a single answer is accepted', async () => {
    const paid = { verified: true, status: '200', amountInCents: 100, transactionId: 'x', merchant: 2 };
    const none = { verified: false, status: null, amountInCents: null, transactionId: null, merchant: null };

    const one = await confirmExternalOrder('KK1', [1, 2], { confirm: async (ref, merchant) => (merchant === 2 ? paid : none) });
    const neither = await confirmExternalOrder('KK1', [1, 2], { confirm: async () => none });
    const both = await confirmExternalOrder('KK1', [1, 2], { confirm: async () => paid });

    assert.equal(one.verified, true);
    assert.equal(one.merchant, 2);
    assert.equal(neither.verified, false);
    assert.equal(both.verified, false, 'an ambiguous answer is not an answer');
  });

  test('a foreign MID is never checked against our accounts', async () => {
    process.env.AIRPAY_VERIFY_EXTERNAL_CALLBACKS = 'true';

    const state = world();

    await postCallback(new URLSearchParams({ MERCID: '999999', TRANSACTIONID: 'KKORDER-2026-0042' }).toString());

    assert.equal(state.oauth.length, 0);
    assert.equal(state.forwards.length, 1);
  });
});

describe('forwarding to the client endpoint', () => {
  test('the destination is the fixed KKChat URL for both merchants', async () => {
    for (const merchant of [1, 2]) {
      const state = world();

      await postCallback(ipn(merchant, 'KKORDER-2026-0042'));

      assert.equal(state.forwards[0].url, 'https://kkchat.in/callback/cpm/arp_frontiva/collection');
      assert.equal(state.forwards[0].options.method, 'POST');
      assert.equal(state.forwards[0].options.headers['Content-Type'], 'application/json');
      assert.equal(state.forwards[0].options.headers[LOOP_GUARD_HEADER], '1');
    }
  });

  test('the destination cannot be chosen by the request', async () => {
    const state = world();

    await postCallback(
      `${ipn(2, 'KKORDER-2026-0042')}&callback_url=https%3A%2F%2Fevil.example%2Fx&forward_to=https%3A%2F%2Fevil.example`,
      { path: `${CALLBACK_PATH_FRONTIVA}?KKCHAT_CALLBACK_URL=https://evil.example/q` },
    );

    assert.equal(state.forwards.length, 1);
    assert.equal(state.forwards[0].url, KKCHAT_URL);
  });

  test('successful, failed and pending callbacks are all forwarded as received', async () => {
    for (const status of ['200', '400', '211']) {
      const state = world();
      const body = ipn(2, 'KKORDER-2026-0042', { TRANSACTIONSTATUS: status });

      await postCallback(body);

      assert.equal(state.forwards[0].body.TRANSACTIONSTATUS, status);
      assert.equal(state.forwards[0].body.MERCID, MID[2], 'field casing and values are Airpay’s own');
    }
  });

  test('no verification claim is added to what is forwarded', async () => {
    const state = world();
    const body = ipn(2, 'KKORDER-2026-0042');

    await postCallback(body);

    // Nothing in the body or headers asserts that Frontiva verified anything.
    assert.deepEqual(Object.keys(state.forwards[0].body).sort(), [...new URLSearchParams(body).keys()].sort());
    assert.ok(!Object.keys(state.forwards[0].options.headers).some((name) => /verif|status|paid/i.test(name)));
  });

  test('a receiver failure or timeout changes neither the reply nor any order', async () => {
    for (const client of [{ status: 500 }, { status: 404 }, { hang: true }]) {
      const row = order({ airpay_merchant: 2 });
      const state = world({ orders: [row], transactions: { [`2:${row.order_ref}`]: PAID }, client });

      const response = await postCallback(ipn(2, row.order_ref));

      assert.equal(response.statusCode, 200);
      assert.equal(response.body, 'OK');
      // Settlement followed Airpay, not the receiver.
      assert.equal(state.orders[0].payment_status, 'paid');
      assert.equal(state.forwards.length, 1, 'one attempt, no retry');
    }
  });

  test('a receiver that answers 200 does not make an unpaid order paid', async () => {
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], client: { status: 200 } });

    await postCallback(ipn(2, row.order_ref));

    assert.notEqual(state.orders[0].payment_status, 'paid');
  });

  test('a delivery that came from this relay is not relayed again', async () => {
    const state = world();

    await postCallback(ipn(1, 'KKORDER-2026-0042'), { headers: { [LOOP_GUARD_HEADER]: '1' } });

    assert.equal(state.forwards.length, 0);
  });

  test('a redirect to another host is not followed', async () => {
    const calls = [];

    globalThis.fetch = async (url, options) => {
      calls.push({ url, redirect: options.redirect });

      return { ok: false, status: 307, headers: { get: () => 'https://evil.example/collect' } };
    };

    const result = await forwardCallback({ payload: { a: '1' }, raw: 'a=1' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(result.forwarded, false);
    assert.equal(result.reason, 'redirect not followed');
  });

  test('a method-preserving redirect on the same host is followed once', async () => {
    const calls = [];

    globalThis.fetch = async (url, options) => {
      calls.push({ url, body: options.body });

      return calls.length === 1
        ? { ok: false, status: 308, headers: { get: () => '/callback/cpm/arp_frontiva/collection/' } }
        : { ok: true, status: 200, headers: { get: () => null } };
    };

    const result = await forwardCallback({ payload: { a: '1' }, raw: 'a=1' });

    assert.equal(result.forwarded, true);
    assert.equal(calls[1].url, 'https://kkchat.in/callback/cpm/arp_frontiva/collection/');
    assert.equal(calls[1].body, calls[0].body);
  });

  test('a 301/302, or a downgrade to http, is not followed', async () => {
    for (const [status, location] of [
      [301, 'https://kkchat.in/elsewhere'],
      [302, 'https://kkchat.in/elsewhere'],
      [308, 'http://kkchat.in/callback/cpm/arp_frontiva/collection'],
    ]) {
      const calls = [];

      globalThis.fetch = async (url) => {
        calls.push(url);
        return { ok: false, status, headers: { get: () => location } };
      };

      const result = await forwardCallback({ payload: { a: '1' }, raw: 'a=1' });

      assert.equal(calls.length, 1, `status ${status}`);
      assert.equal(result.forwarded, false);
    }
  });
});

describe('GET /api/payments/status', () => {
  const status = (ref) => call(statusHandler, { method: 'GET', url: `/api/payments/status?ref=${ref}` });

  test('an order placed on merchant 2 is checked with merchant 2', async () => {
    const row = order({ airpay_merchant: 2 });
    const state = world({ orders: [row], transactions: { [`2:${row.order_ref}`]: PAID } });

    const response = await status(row.order_ref);

    assert.equal(response.json().order.payment_status, 'paid');
    assert.deepEqual(state.confirmations.map((entry) => entry.merchant), [2]);
    assert.ok(!state.oauth.some((entry) => entry.merchant === 1), 'merchant 1 must not be queried');
  });

  test('an order placed on merchant 1 is checked with merchant 1', async () => {
    const row = order();
    const state = world({ orders: [row], transactions: { [`1:${row.order_ref}`]: PENDING } });

    const response = await status(row.order_ref);

    assert.equal(response.json().order.payment_status, 'processing');
    assert.deepEqual(state.confirmations.map((entry) => entry.merchant), [1]);
  });

  test('no merchant detail or credential is exposed to the success page', async () => {
    const row = order({ airpay_merchant: 2 });

    world({ orders: [row], transactions: { [`2:${row.order_ref}`]: PAID } });

    const response = await status(row.order_ref);

    for (const value of [...Object.values(M1), ...Object.values(M2)]) {
      assert.ok(!response.body.includes(value));
    }
  });
});

describe('the browser never holds a merchant credential', () => {
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
  const ordersApi = read('../apps/web/src/api/OrdersApi.js');
  const checkout = read('../apps/web/src/pages/CheckoutPage.jsx');

  test('client code names no Airpay variable, MID or endpoint', () => {
    for (const source of [ordersApi, checkout]) {
      assert.ok(!/AIRPAY_|VITE_AIRPAY|airpay\.co\.in|_2\b.*(KEY|SECRET|PASSWORD)/.test(source));
    }
  });

  test('the checkout sends the chosen gateway number and nothing else new', () => {
    assert.match(ordersApi, /JSON\.stringify\(\{ customer, items, merchant \}\)/);
    assert.match(checkout, /createOnlinePayment\(\{ customer: customerInfo, cartItems, merchant: gateway \}\)/);
  });

  test('gateway 1 is the default selection', () => {
    assert.match(checkout, /const \[gateway, setGateway\] = useState\(1\)/);
    assert.match(ordersApi, /createOnlinePayment\(\{ customer, cartItems, merchant = 1 \}\)/);
  });

  test('the gateway choice is shown only for online payment', () => {
    assert.match(checkout, /\{isOnline && gatewayOptions\.length > 1 && \(/);
    assert.match(checkout, /Pay with Airpay 1/);
    assert.match(checkout, /Pay with Airpay 2/);
  });

  test('the selection is validated in the browser as well as on the server', () => {
    assert.match(checkout, /paymentMethod === 'online' && !availableGateways\.includes\(gateway\)/);
    assert.match(ordersApi, /if \(!PAYMENT_GATEWAYS\.includes\(merchant\)\)/);
  });

  test('a failed payment start leaves the cart alone', () => {
    const onlineBranch = checkout.slice(
      checkout.indexOf("if (paymentMethod === 'online')"),
      checkout.indexOf('const order = await createCodOrder'),
    );

    assert.ok(!onlineBranch.includes('clearCart'));
    assert.match(onlineBranch, /setIsProcessing\(false\)/);
  });
});
