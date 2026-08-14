/**
 * The auxiliary relay of the Airpay callback to the client's endpoint.
 *
 * The property under test throughout: the relay is isolated. Whatever the
 * client endpoint does — 200, 500, timeout, DNS failure — it must never reject,
 * never throw, and never be able to influence settlement.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach, describe } from 'node:test';
import {
  FORWARD_TIMEOUT_MS,
  LOOP_GUARD_HEADER,
  clientCallbackUrl,
  forwardCallback,
} from '../api/_lib/forward-callback.js';

/** A real Airpay IPN body, form-encoded exactly as Airpay sends it. */
const RAW_BODY =
  'TRANSACTIONPAYMENTSTATUS=SUCCESS&MERCID=366751&TRANSACTIONID=FRVMFA1B2C3D4E5F6' +
  '&APTRANSACTIONID=250814000123456&AMOUNT=1500.00&TRANSACTIONSTATUS=200' +
  '&MESSAGE=Transaction+Successful&CUSTOMVAR=FRVMFA1B2C3D4E5F6' +
  '&ap_SecureHash=abc123&CUSTOMERVPA=someone%40upi';

let originalFetch;
let originalEnv;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = { ...process.env };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
});

/** Mock client endpoint. No request ever leaves the test process. */
function mockClient(behaviour) {
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });

    if (behaviour.throws) {
      const error = new Error(behaviour.throws);
      error.name = behaviour.errorName || 'TypeError';
      throw error;
    }

    if (behaviour.hang) {
      // Resolve only when the caller's AbortSignal fires, mimicking a stall.
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }

    return { ok: behaviour.status < 400, status: behaviour.status };
  };

  return calls;
}

const forward = (overrides = {}) =>
  forwardCallback({
    raw: RAW_BODY,
    contentType: 'application/x-www-form-urlencoded',
    orderRef: 'FRVMFA1B2C3D4E5F6',
    incomingHeaders: {},
    ...overrides,
  });

describe('destination', () => {
  test('defaults to the client endpoint', () => {
    delete process.env.KKCHAT_CALLBACK_URL;

    assert.equal(clientCallbackUrl(), 'https://kkchat.in/callback/cpm/arp/collection');
  });

  test('is overridable by a server-only variable', () => {
    process.env.KKCHAT_CALLBACK_URL = 'https://example.test/hook';

    assert.equal(clientCallbackUrl(), 'https://example.test/hook');
  });

  test('posts to that destination', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://kkchat.in/callback/cpm/arp/collection');
    assert.equal(calls[0].options.method, 'POST');
  });
});

describe('payload fidelity', () => {
  test('forwards the original body byte for byte', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls[0].options.body, RAW_BODY);
  });

  test('does not re-encrypt, re-serialise or transform the payload', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    const body = calls[0].options.body;

    // Every field Airpay sent arrives with its original name and value.
    for (const field of [
      'TRANSACTIONPAYMENTSTATUS=SUCCESS',
      'MERCID=366751',
      'TRANSACTIONID=FRVMFA1B2C3D4E5F6',
      'APTRANSACTIONID=250814000123456',
      'AMOUNT=1500.00',
      'TRANSACTIONSTATUS=200',
      'CUSTOMVAR=FRVMFA1B2C3D4E5F6',
      'ap_SecureHash=abc123',
    ]) {
      assert.ok(body.includes(field), `missing ${field}`);
    }

    // No encryption envelope of our own was wrapped around it.
    assert.ok(!body.includes('encdata'));
    assert.ok(!body.includes('privatekey'));
  });

  test('forwards fields Frontiva itself never uses', async () => {
    const extended = `${RAW_BODY}&RRN=523612345678&CARDTYPE=UPI&IPNID=987654&UNKNOWN_FUTURE=x`;
    const calls = mockClient({ status: 200 });

    await forward({ raw: extended });

    for (const field of ['RRN=523612345678', 'CARDTYPE=UPI', 'IPNID=987654', 'UNKNOWN_FUTURE=x']) {
      assert.ok(calls[0].options.body.includes(field), `missing ${field}`);
    }
  });

  test('mirrors a form-encoded content type', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  });

  test('relays a JSON callback as JSON', async () => {
    const calls = mockClient({ status: 200 });
    const json = '{"CUSTOMVAR":"FRVMFA1B2C3D4E5F6","TRANSACTIONSTATUS":"200"}';

    await forward({ raw: json, contentType: 'application/json' });

    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].options.body, json);
  });
});

describe('no credentials are forwarded', () => {
  test('carries no Airpay secret in the body or headers', async () => {
    process.env.AIRPAY_SECRET_KEY = 'secret-key-value';
    process.env.AIRPAY_API_KEY = 'api-key-value';
    process.env.AIRPAY_PASSWORD = 'password-value';
    process.env.AIRPAY_USERNAME = 'username-value';
    process.env.CRON_SECRET = 'cron-secret-value';
    process.env.SUPABASE_SERVICE_ROLE = 'service-role-value';

    const calls = mockClient({ status: 200 });

    await forward();

    const serialised = JSON.stringify(calls[0].options);

    for (const secret of [
      'secret-key-value',
      'api-key-value',
      'password-value',
      'username-value',
      'cron-secret-value',
      'service-role-value',
    ]) {
      assert.ok(!serialised.includes(secret), `forwarded ${secret}`);
    }
  });

  test('sends no Authorization header', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    const headerNames = Object.keys(calls[0].options.headers).map((name) => name.toLowerCase());

    assert.ok(!headerNames.includes('authorization'));
    assert.ok(!headerNames.includes('cookie'));
  });
});

describe('failure isolation', () => {
  test('reports success on 200 without throwing', async () => {
    mockClient({ status: 200 });

    assert.deepEqual(await forward(), { forwarded: true, status: 200 });
  });

  test('a 500 from the client resolves, never rejects', async () => {
    mockClient({ status: 500 });

    const result = await forward();

    assert.equal(result.forwarded, false);
    assert.equal(result.status, 500);
    assert.equal(result.reason, 'non-2xx');
  });

  test('every client error status is contained', async () => {
    for (const status of [400, 401, 404, 500, 502, 503]) {
      mockClient({ status });

      const result = await forward();

      assert.equal(result.forwarded, false, `status ${status} should not report forwarded`);
      assert.equal(result.status, status);
    }
  });

  test('a network error resolves as a failure', async () => {
    mockClient({ throws: 'getaddrinfo ENOTFOUND kkchat.in' });

    const result = await forward();

    assert.equal(result.forwarded, false);
    assert.equal(result.status, null);
    assert.equal(result.reason, 'network');
  });

  test('a timeout is bounded and resolves as a failure', async () => {
    mockClient({ hang: true });

    const startedAt = Date.now();
    const result = await forward();
    const elapsed = Date.now() - startedAt;

    assert.equal(result.reason, 'timeout');
    assert.equal(result.forwarded, false);
    // Bounded by the configured timeout, not by the client endpoint.
    assert.ok(elapsed < FORWARD_TIMEOUT_MS + 2000, `took ${elapsed}ms`);
  });

  test('the timeout is within the required 3-5 second window', () => {
    assert.ok(FORWARD_TIMEOUT_MS >= 3000 && FORWARD_TIMEOUT_MS <= 5000);
  });

  test('never rejects, whatever the client does', async () => {
    for (const behaviour of [
      { status: 200 },
      { status: 500 },
      { throws: 'boom' },
      { throws: 'aborted', errorName: 'AbortError' },
    ]) {
      mockClient(behaviour);

      await assert.doesNotReject(() => forward());
    }
  });
});

describe('one attempt only', () => {
  test('does not retry on failure', async () => {
    const calls = mockClient({ status: 500 });

    await forward();

    assert.equal(calls.length, 1, 'exactly one attempt per received callback');
  });

  test('does not retry on a network error', async () => {
    const calls = mockClient({ throws: 'boom' });

    await forward();

    assert.equal(calls.length, 1);
  });
});

describe('loop prevention', () => {
  test('marks its own outbound request', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls[0].options.headers[LOOP_GUARD_HEADER], '1');
  });

  test('refuses to relay a delivery that came from this relay', async () => {
    const calls = mockClient({ status: 200 });

    const result = await forward({ incomingHeaders: { [LOOP_GUARD_HEADER]: '1' } });

    assert.equal(calls.length, 0, 'must not forward a request we originated');
    assert.equal(result.forwarded, false);
    assert.equal(result.reason, 'loop guard');
  });
});

describe('isolation from settlement', () => {
  const callbackSource = readFileSync(new URL('../api/payments/callback.js', import.meta.url), 'utf8');
  const relaySource = readFileSync(new URL('../api/_lib/forward-callback.js', import.meta.url), 'utf8');

  test('the relay result is never read by the handler', () => {
    // It is started and settled, but its value never feeds a decision.
    assert.match(callbackSource, /forwarding = forwardCallback\(/);
    assert.ok(!/if \([^)]*forwarding/.test(callbackSource), 'relay must not gate any branch');
    assert.ok(!/await forwardCallback/.test(callbackSource), 'must not be awaited inline');
  });

  test('the relay is settled with allSettled, so it cannot reject into the handler', () => {
    assert.match(callbackSource, /await Promise\.allSettled\(\[forwarding\]\)/);
  });

  test('settlement still receives only the order reference', () => {
    assert.match(callbackSource, /await settleOrder\(orderRef\)/);
    assert.ok(!/settleOrder\([^)]*(payload|fields|forward)/.test(callbackSource));
  });

  test('there is still exactly one settlement call in the handler', () => {
    // Invocations only — the import statement also contains the identifier.
    const settlements = callbackSource.match(/await settleOrder\(/g) || [];

    assert.equal(settlements.length, 1, 'the relay must not introduce a second settlement path');
  });

  test('the relay never touches orders or Supabase', () => {
    assert.ok(!/settleOrder|recordCallback|supabase|orders/i.test(relaySource.replace(/^\s*\*.*$/gm, '')));
  });

  test('the existing response behaviour is unchanged', () => {
    // Still a plain-text body for Airpay and a redirect for a browser, with
    // 'OK' passed through respond() exactly as before.
    assert.match(callbackSource, /res\.end\(body\)/);
    assert.match(callbackSource, /res\.statusCode = statusCode/);
    assert.match(callbackSource, /respond\(200, 'OK', orderRef\)/);
    assert.match(callbackSource, /redirect\(res, orderRef \?/);
  });
});

describe('the client URL never reaches the browser', () => {
  test('no VITE_ variable is used for it', () => {
    const relaySource = readFileSync(new URL('../api/_lib/forward-callback.js', import.meta.url), 'utf8');
    // Strip comments; the module documents that there is deliberately no VITE_.
    const code = relaySource.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

    assert.ok(!/VITE_/.test(code));
    assert.match(code, /process\.env\.KKCHAT_CALLBACK_URL/);
  });

  test('kkchat appears nowhere in client source', () => {
    for (const file of [
      '../apps/web/src/api/OrdersApi.js',
      '../apps/web/src/pages/CheckoutPage.jsx',
      '../apps/web/src/pages/SuccessPage.jsx',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');

      assert.ok(!/kkchat/i.test(source), `${file} references kkchat`);
    }
  });
});
