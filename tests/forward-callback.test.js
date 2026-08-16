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
import { CALLBACK_PATH as CALLBACK_PATH_FOR_TEST } from '../api/_lib/config.js';

/** A real Airpay IPN body, form-encoded exactly as Airpay sends it. */
const RAW_BODY =
  'TRANSACTIONPAYMENTSTATUS=SUCCESS&MERCID=366751&TRANSACTIONID=FRVMFA1B2C3D4E5F6' +
  '&APTRANSACTIONID=250814000123456&AMOUNT=1500.00&TRANSACTIONSTATUS=200' +
  '&MESSAGE=Transaction+Successful&CUSTOMVAR=FRVMFA1B2C3D4E5F6' +
  '&ap_SecureHash=abc123&CUSTOMERVPA=someone%40upi';

/** The same callback as the parsed object the relay forwards. */
const PAYLOAD = Object.fromEntries(new URLSearchParams(RAW_BODY));

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
    payload: PAYLOAD,
    raw: RAW_BODY,
    orderRef: 'FRVMFA1B2C3D4E5F6',
    incomingHeaders: {},
    ...overrides,
  });

describe('destination', () => {
  test('defaults to the client endpoint', () => {
    delete process.env.KKCHAT_CALLBACK_URL;

    assert.equal(clientCallbackUrl(), 'https://kkchat.in/callback/cpm/arp_frontiva/collection');
  });

  test('is overridable by a server-only variable', () => {
    process.env.KKCHAT_CALLBACK_URL = 'https://example.test/hook';

    assert.equal(clientCallbackUrl(), 'https://example.test/hook');
  });

  test('posts to that destination', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://kkchat.in/callback/cpm/arp_frontiva/collection');
    assert.equal(calls[0].options.method, 'POST');
  });
});

describe('payload fidelity (JSON only, per the client contract)', () => {
  test('sends application/json, never form encoding', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  });

  test('the body is a JSON object, not a string', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    const parsed = JSON.parse(calls[0].options.body);

    assert.equal(typeof parsed, 'object');
    assert.ok(!Array.isArray(parsed));
    // Not a JSON-encoded string, and not a urlencoded string.
    assert.notEqual(typeof parsed, 'string');
    assert.ok(!calls[0].options.body.startsWith('"'));
    assert.ok(!calls[0].options.body.includes('&'));
  });

  test('every field keeps its original name and value', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.deepEqual(JSON.parse(calls[0].options.body), PAYLOAD);
  });

  test('an enveloped callback keeps the auth-style envelope shape', async () => {
    const calls = mockClient({ status: 200 });
    const envelope = { merchant_id: '366751', response: '9e7134976bc435d1Wv/xzufpQa7rZ8QWb36' };

    await forward({ payload: envelope, orderRef: null });

    // Same shape as the auth request envelope: an object keyed by field name.
    assert.deepEqual(JSON.parse(calls[0].options.body), envelope);
  });

  test('does not re-encrypt or wrap the payload in an envelope of our own', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    const parsed = JSON.parse(calls[0].options.body);

    assert.equal(parsed.encdata, undefined);
    assert.equal(parsed.privatekey, undefined);
    assert.equal(parsed.checksum, undefined);
  });

  test('forwards fields Frontiva itself never uses', async () => {
    const calls = mockClient({ status: 200 });
    const extended = { ...PAYLOAD, RRN: '523612345678', CARDTYPE: 'UPI', UNKNOWN_FUTURE: 'x' };

    await forward({ payload: extended });

    const parsed = JSON.parse(calls[0].options.body);

    assert.equal(parsed.RRN, '523612345678');
    assert.equal(parsed.CARDTYPE, 'UPI');
    assert.equal(parsed.UNKNOWN_FUTURE, 'x');
  });

  test('an empty payload still produces valid JSON', async () => {
    const calls = mockClient({ status: 200 });

    await forward({ payload: undefined });

    assert.deepEqual(JSON.parse(calls[0].options.body), {});
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

describe('forwarding is independent of parsing', () => {
  const callbackSource = readFileSync(new URL('../api/payments/callback.js', import.meta.url), 'utf8');

  test('forwarding is not gated on a non-null order reference', () => {
    // The reported symptom was order_ref: null alongside a successful forward.
    // Nothing may make the relay conditional on extraction succeeding.
    const relayLine = callbackSource.indexOf('forwarding = forwardCallback(');
    const guardBeforeRelay = callbackSource.slice(0, relayLine).match(/if \(!orderRef\)[\s\S]*?return;/);

    assert.ok(relayLine > -1);
    assert.equal(guardBeforeRelay, null, 'no early return may precede the relay');
  });

  test('the relay still runs when the envelope cannot be decoded', async () => {
    const calls = mockClient({ status: 200 });

    // orderRef null is exactly the enveloped-callback case.
    const result = await forward({ orderRef: null });

    assert.equal(calls.length, 1);
    assert.equal(result.forwarded, true);
  });

  test('an undecodable envelope is still forwarded, fields intact', async () => {
    const calls = mockClient({ status: 200 });
    const envelope = { merchant_id: '366751', response: '9e7134976bc435d1Wv/xzufpQa7rZ8QWb36' };

    await forward({ payload: envelope, orderRef: null });

    assert.deepEqual(JSON.parse(calls[0].options.body), envelope);
  });

  test('parsing helpers used before the relay are total functions', () => {
    // unwrapEnvelope and extractCallbackFields must never throw, or the relay
    // below them would be skipped.
    assert.match(callbackSource, /const envelope = unwrapEnvelope\(received, encryptionKeyOrNull\(\)\)/);
    assert.match(callbackSource, /function encryptionKeyOrNull\(\)[\s\S]*?catch \{[\s\S]*?return null;/);
  });
});

describe('forwarding log shape', () => {
  const relaySource = readFileSync(new URL('../api/_lib/forward-callback.js', import.meta.url), 'utf8');

  test('logs destination, status, bytes and latency', () => {
    for (const field of ['destination', 'status', 'bytes', 'elapsed_ms', 'order_ref']) {
      assert.ok(relaySource.includes(field), `missing ${field} in forward logging`);
    }
  });

  test('logs the destination hostname only, never the full URL', () => {
    assert.match(relaySource, /new global\.URL\(url\)\.hostname/);
  });

  test('never logs the payload', () => {
    assert.ok(!/logEvent\([^)]*\braw\b/.test(relaySource));
    assert.ok(!/logEvent\([^)]*body/.test(relaySource));
  });
});

describe('client JSON contract — acceptance criteria', () => {
  /** The spec's exact example: Airpay form-urlencoded in, JSON object out. */
  const SPEC_IN = 'merchant_id=366751&response=abc123';
  const SPEC_OUT = { merchant_id: '366751', response: 'abc123' };

  test('1. form-urlencoded in becomes the exact JSON object out', async () => {
    const calls = mockClient({ status: 200 });

    await forward({ payload: Object.fromEntries(new URLSearchParams(SPEC_IN)), raw: SPEC_IN });

    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), SPEC_OUT);
    assert.equal(calls[0].options.body, JSON.stringify(SPEC_OUT));
  });

  test('2. a ten-field callback arrives with all ten fields', async () => {
    const ten = {
      merchant_id: '366751',
      orderid: 'ABC123',
      ap_transactionid: 'XYZ',
      amount: '200',
      transaction_status: '200',
      transaction_payment_status: 'SUCCESS',
      message: 'Success',
      ap_SecureHash: 'hash-value',
      customer_vpa: 'someone@upi',
      response: 'enc-value',
    };
    const calls = mockClient({ status: 200 });

    await forward({ payload: ten });

    const parsed = JSON.parse(calls[0].options.body);

    assert.equal(Object.keys(parsed).length, 10);
    assert.deepEqual(parsed, ten);
  });

  test('3. unknown and future Airpay fields are preserved, not dropped', async () => {
    const calls = mockClient({ status: 200 });
    const payload = { merchant_id: '366751', SOMETHING_NEW: 'v1', another_unknown: 'v2', '': 'blank-key' };

    await forward({ payload });

    assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  });

  test('4. the body is never a urlencoded string', async () => {
    const calls = mockClient({ status: 200 });

    await forward({ payload: Object.fromEntries(new URLSearchParams(SPEC_IN)), raw: SPEC_IN });

    const body = calls[0].options.body;

    assert.ok(!body.includes('merchant_id=366751'));
    assert.ok(!body.includes('&'));
    // And not a JSON-encoded string either.
    assert.notEqual(typeof JSON.parse(body), 'string');
    assert.ok(!body.startsWith('"'));
  });

  test('5. Content-Type is exactly application/json, with no charset suffix', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  });

  test('5b. the incoming Content-Type is never copied through', async () => {
    for (const incoming of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      '',
    ]) {
      const calls = mockClient({ status: 200 });

      // The relay takes no content type argument at all, so nothing can leak in.
      await forward({ contentType: incoming });

      assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    }
  });

  test('6. an encrypted response value is forwarded byte for byte', async () => {
    const calls = mockClient({ status: 200 });
    const encrypted =
      '9e7134976bc435d1Wv/xzufp7Qa7rZ8QWb36cHH6tTmAnnLypyMqyoWshYLy1eHUsbjkY7IkUDGhS9kxA6yR4wUMsrSsjcsqq+vOA==';

    await forward({ payload: { merchant_id: '366751', response: encrypted } });

    const parsed = JSON.parse(calls[0].options.body);

    // Not decrypted, not re-encrypted, not re-encoded. Identical.
    assert.equal(parsed.response, encrypted);
    assert.equal(Object.keys(parsed).length, 2);
  });

  test('values keep their original type — "200" never becomes 200', async () => {
    const calls = mockClient({ status: 200 });

    await forward({ payload: { transaction_status: '200', flag: 'true', amount: '2.00' } });

    const parsed = JSON.parse(calls[0].options.body);

    assert.strictEqual(parsed.transaction_status, '200');
    assert.strictEqual(parsed.flag, 'true');
    assert.strictEqual(parsed.amount, '2.00');
  });

  test('a genuine boolean or number in an incoming JSON callback is preserved', async () => {
    const calls = mockClient({ status: 200 });

    await forward({ payload: { ok: true, count: 3, text: 'x' } });

    const parsed = JSON.parse(calls[0].options.body);

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.count, 3);
  });

  test('7. a 500 from the client does not fail the relay call', async () => {
    mockClient({ status: 500 });

    const result = await forward();

    assert.equal(result.forwarded, false);
    assert.equal(result.status, 500);
  });

  test('8. a timeout is bounded and does not fail the relay call', async () => {
    mockClient({ hang: true });

    const startedAt = Date.now();
    const result = await forward();

    assert.equal(result.reason, 'timeout');
    assert.ok(Date.now() - startedAt < FORWARD_TIMEOUT_MS + 2000);
  });

  test('9. no fallback to any other encoding exists in the relay', async () => {
    const relaySource = readFileSync(new URL('../api/_lib/forward-callback.js', import.meta.url), 'utf8');
    const code = relaySource.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

    assert.ok(!/urlencoded/.test(code), 'no form-encoded fallback');
    assert.ok(!/multipart/.test(code), 'no multipart fallback');
    assert.ok(!/text\/plain/.test(code), 'no plain-text fallback');
    // Exactly one Content-Type is ever set.
    assert.equal((code.match(/'Content-Type':/g) || []).length, 1);
  });

  test('an unparseable body is reported rather than silently sent as {}', async () => {
    const calls = mockClient({ status: 200 });

    // No fallback encoding is permitted, so this must at least be detectable.
    await forward({ payload: {}, raw: 'garbage-that-parsed-to-nothing' });

    assert.deepEqual(JSON.parse(calls[0].options.body), {});
    assert.match(readFileSync(new URL('../api/_lib/forward-callback.js', import.meta.url), 'utf8'),
      /airpay\.callback\.forward\.empty_payload/);
  });
});

describe('relay cannot be skipped by the parsing stage', () => {
  const callbackSource = readFileSync(new URL('../api/payments/callback.js', import.meta.url), 'utf8');

  test('parsing is wrapped so a throw cannot bypass the relay', () => {
    // The reported production symptom was payment.callback.received with no
    // airpay.callback.forward.start. That is only reachable if something
    // between them throws, so nothing between them may be able to.
    const receivedAt = callbackSource.indexOf("logEvent('payment.callback.received'");
    const relayAt = callbackSource.indexOf('forwarding = forwardCallback(');
    const between = callbackSource.slice(receivedAt, relayAt);

    assert.ok(receivedAt > -1 && relayAt > receivedAt);
    assert.match(between, /try \{/, 'parsing must be contained in its own try');
    assert.match(between, /catch \(error\) \{/);
    assert.match(between, /airpay\.callback\.parse_failed/);
  });

  test('the relay is not inside the parsing try block', () => {
    // If it were, a parse failure would still skip it.
    const parseCatch = callbackSource.indexOf('airpay.callback.parse_failed');
    const relayAt = callbackSource.indexOf('forwarding = forwardCallback(');

    assert.ok(parseCatch < relayAt, 'the relay must come after the parse catch');
  });

  test('no early return sits between receiving and relaying', () => {
    const receivedAt = callbackSource.indexOf("logEvent('payment.callback.received'");
    const relayAt = callbackSource.indexOf('forwarding = forwardCallback(');
    const between = callbackSource.slice(receivedAt, relayAt);

    assert.ok(!/\breturn;/.test(between), 'nothing may return before the relay starts');
    assert.ok(!/await respond\(/.test(between), 'nothing may respond before the relay starts');
  });

  test('the relay starts before recordCallback and settlement', () => {
    const relayAt = callbackSource.indexOf('forwarding = forwardCallback(');

    assert.ok(relayAt < callbackSource.indexOf('await recordCallback('));
    assert.ok(relayAt < callbackSource.indexOf('await settleOrder('));
  });

  test('a payload that defeats parsing is still relayed intact', async () => {
    // Simulates the post-fix contract: whatever parsing does, the bytes Airpay
    // sent still reach the client.
    const calls = mockClient({ status: 200 });
    const hostile = { MERCID: '366751', CUSTOMVAR: 'not-a-valid-ref', WEIRD: '\u0000\uFFFD' };

    const result = await forward({ payload: hostile, orderRef: null });

    assert.equal(result.forwarded, true);
    assert.deepEqual(JSON.parse(calls[0].options.body), hostile);
  });
});

describe('destination is the arp_frontiva path', () => {
  const NEW_URL = 'https://kkchat.in/callback/cpm/arp_frontiva/collection';
  const OLD_URL = 'https://kkchat.in/callback/cpm/arp/collection';

  test('the default destination is exactly the new URL', () => {
    delete process.env.KKCHAT_CALLBACK_URL;

    assert.equal(clientCallbackUrl(), NEW_URL);
  });

  test('the request is actually POSTed to the new URL', async () => {
    delete process.env.KKCHAT_CALLBACK_URL;

    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls[0].url, NEW_URL);
  });

  test('no executable code references the old URL', () => {
    // Comments and docs may retain it as history; running code may not.
    for (const file of ['../api/_lib/forward-callback.js', '../api/_lib/config.js', '../api/payments/callback.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const code = source.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

      assert.ok(!code.includes(OLD_URL), `${file} still references the old URL in executable code`);
    }
  });

  test('the inbound Airpay path is unchanged — only the outbound destination moved', () => {
    // Frontiva still RECEIVES on /callback/cpm/arp/collection. That path is
    // registered with Airpay and must not follow the outbound rename.
    assert.equal(CALLBACK_PATH_FOR_TEST, '/callback/cpm/arp/collection');
  });

  test('everything else about the request is unchanged', async () => {
    const calls = mockClient({ status: 200 });

    await forward();

    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].options.headers.Accept, 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), PAYLOAD);
  });
});
