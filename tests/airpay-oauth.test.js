/**
 * Airpay OAuth2 and the request envelope.
 *
 * The rule under test throughout: a transport-level success is not an
 * authentication success. Only an access_token counts.
 */
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import {
  buildEnvelope,
  buildSignedEnvelope,
  getAccessToken,
  hasInnerFailure,
  parseAirpayResponse,
} from '../api/_lib/airpay.js';
import { airpayConfig } from '../api/_lib/config.js';
import { checksum, decrypt, encrypt, encryptionKey, privateKey } from '../api/_lib/crypto.js';

const ENV = {
  AIRPAY_MID: '123456',
  AIRPAY_CLIENT_ID: 'client-id',
  AIRPAY_SECRET_KEY: 'client-secret',
  AIRPAY_API_KEY: 'api-key',
  AIRPAY_USERNAME: 'user',
  AIRPAY_PASSWORD: 'pass',
  AIRPAY_ENV: 'live',
};

const KEY = encryptionKey(ENV.AIRPAY_USERNAME, ENV.AIRPAY_PASSWORD);

let originalFetch;
let originalEnv;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = { ...process.env };
  Object.assign(process.env, ENV);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
});

/** Installs a fetch stub and records the request it received. */
function stubFetch(response) {
  const calls = [];

  globalThis.fetch = async (url, options) => {
    // Airpay receives a form-encoded envelope; decode it back for assertions.
    const body = Object.fromEntries(new URLSearchParams(options.body));

    calls.push({ url, options, body });

    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => response.text,
    };
  };

  return calls;
}

describe('buildEnvelope', () => {
  test('sends merchant_id, encdata and checksum only', () => {
    const envelope = buildEnvelope({ a: '1' }, airpayConfig());

    assert.deepEqual(Object.keys(envelope).sort(), ['checksum', 'encdata', 'merchant_id']);
  });

  test('does NOT send privatekey — that belongs to the transactional APIs', () => {
    assert.equal(buildEnvelope({ a: '1' }, airpayConfig()).privatekey, undefined);
  });

  test('encrypts the fields so no credential travels in the clear', () => {
    const fields = { client_id: 'client-id', client_secret: 'client-secret' };
    const envelope = buildEnvelope(fields, airpayConfig());

    assert.ok(!envelope.encdata.includes('client-secret'));
    assert.deepEqual(JSON.parse(decrypt(envelope.encdata, KEY)), fields);
  });

  test('checksums the plaintext fields, not the ciphertext', () => {
    const fields = { b: '2', a: '1' };

    assert.equal(buildEnvelope(fields, airpayConfig()).checksum, checksum(fields));
  });

});

describe('buildSignedEnvelope', () => {
  test('adds privatekey for the token-authenticated APIs', () => {
    const envelope = buildSignedEnvelope({ a: '1' }, airpayConfig());

    assert.deepEqual(Object.keys(envelope).sort(), ['checksum', 'encdata', 'merchant_id', 'privatekey']);
  });

  test('derives privatekey from AIRPAY_API_KEY, not AIRPAY_SECRET_KEY', () => {
    const envelope = buildSignedEnvelope({}, airpayConfig());

    assert.equal(
      envelope.privatekey,
      privateKey(ENV.AIRPAY_API_KEY, ENV.AIRPAY_USERNAME, ENV.AIRPAY_PASSWORD),
    );
    // The credential roles must not be swapped.
    assert.notEqual(
      envelope.privatekey,
      privateKey(ENV.AIRPAY_SECRET_KEY, ENV.AIRPAY_USERNAME, ENV.AIRPAY_PASSWORD),
    );
  });
});

describe('hasInnerFailure', () => {
  test('detects data.success false behind an outer success', () => {
    assert.equal(
      hasInnerFailure({ status_code: 200, response_code: '00', status: 'success', data: { success: false } }),
      true,
    );
  });

  test('accepts the string and numeric spellings of false', () => {
    assert.equal(hasInnerFailure({ data: { success: 'false' } }), true);
    assert.equal(hasInnerFailure({ data: { success: 0 } }), true);
    assert.equal(hasInnerFailure({ data: { success: '0' } }), true);
  });

  test('looks inside a decrypted envelope too', () => {
    assert.equal(hasInnerFailure({ decrypted: { success: false } }), true);
  });

  test('is false for a genuine success', () => {
    assert.equal(hasInnerFailure({ data: { success: true, access_token: 'tok' } }), false);
    assert.equal(hasInnerFailure({ access_token: 'tok' }), false);
  });
});

describe('parseAirpayResponse', () => {
  test('reads a plain JSON response', () => {
    assert.deepEqual(parseAirpayResponse('{"status":200}', KEY).status, 200);
  });

  test('decrypts an encrypted response envelope', () => {
    const inner = { access_token: 'tok', expires_in: 900 };
    const body = JSON.stringify({ success: true, encdata: encrypt(JSON.stringify(inner), KEY) });

    assert.deepEqual(parseAirpayResponse(body, KEY).decrypted, inner);
  });

  test('rejects an unreadable body', () => {
    assert.throws(() => parseAirpayResponse('<html>502</html>', KEY), /unreadable/);
  });
});

describe('getAccessToken', () => {
  test('posts only merchant_id, encdata and checksum', async () => {
    const calls = stubFetch({ text: JSON.stringify({ access_token: 'tok', expires_in: 600 }) });

    await getAccessToken();

    assert.deepEqual(Object.keys(calls[0].body).sort(), ['checksum', 'encdata', 'merchant_id']);
  });

  test('sends the documented OAuth fields, encrypted', async () => {
    const calls = stubFetch({ text: JSON.stringify({ access_token: 'tok', expires_in: 600 }) });

    await getAccessToken();

    const sent = JSON.parse(decrypt(calls[0].body.encdata, KEY));

    assert.deepEqual(sent, {
      client_id: 'client-id',
      client_secret: 'client-secret',
      merchant_id: '123456',
      grant_type: 'client_credentials',
    });
    assert.equal(calls[0].url, 'https://kraken.airpay.co.in/airpay/pay/v4/api/oauth2/');
    assert.equal(calls[0].options.method, 'POST');
  });

  test('returns the token and the expiry Airpay reported', async () => {
    stubFetch({ text: JSON.stringify({ access_token: 'tok', expires_in: 900 }) });

    const result = await getAccessToken();

    assert.equal(result.accessToken, 'tok');
    // The returned expiry is used, not a hardcoded assumption.
    assert.equal(result.expiresIn, 900);
    assert.ok(result.expiresAt > Date.now());
  });

  test('finds the token when Airpay nests it', async () => {
    stubFetch({ text: JSON.stringify({ status: 200, data: { response: { access_token: 'tok', expires_in: 120 } } }) });

    const result = await getAccessToken();

    assert.equal(result.accessToken, 'tok');
    assert.equal(result.expiresIn, 120);
  });

  test('reads a token out of an encrypted response', async () => {
    stubFetch({
      text: JSON.stringify({ success: true, encdata: encrypt(JSON.stringify({ access_token: 'tok', expires_in: 300 }), KEY) }),
    });

    assert.equal((await getAccessToken()).accessToken, 'tok');
  });

  test('fails when the outer response says success but data.success is false', async () => {
    // The documented trap: status_code 200, response_code 00, status success,
    // while authentication actually failed.
    stubFetch({
      text: JSON.stringify({
        status_code: 200,
        response_code: '00',
        status: 'success',
        data: { success: false, message: 'Invalid credentials' },
      }),
    });

    await assert.rejects(getAccessToken(), /authentication failed/);
  });

  test('rejects an inner failure even when a token-like field is present', async () => {
    stubFetch({
      text: JSON.stringify({ status: 'success', data: { success: false, access_token: 'not-a-real-token' } }),
    });

    await assert.rejects(getAccessToken(), /authentication failed/);
  });

  test('fails when a 200 with success:true carries no token', async () => {
    // The trap this exists to avoid: treating the transport result as the
    // authentication result.
    stubFetch({ text: JSON.stringify({ success: true, status: 200, message: 'Invalid credentials' }) });

    await assert.rejects(getAccessToken(), /authentication failed/);
  });

  test('fails on an HTTP error', async () => {
    stubFetch({ ok: false, status: 401, text: 'Unauthorized' });

    await assert.rejects(getAccessToken(), /authentication failed/);
  });

  test('fails on an empty token', async () => {
    stubFetch({ text: JSON.stringify({ access_token: '   ' }) });

    await assert.rejects(getAccessToken(), /authentication failed/);
  });

  test('falls back to a short expiry when Airpay omits one', async () => {
    stubFetch({ text: JSON.stringify({ access_token: 'tok' }) });

    assert.equal((await getAccessToken()).expiresIn, 300);
  });

  test('never puts a credential in the error it raises', async () => {
    stubFetch({ text: JSON.stringify({ success: false, echo: 'client-secret' }) });

    const error = await getAccessToken().then(
      () => null,
      (caught) => caught,
    );

    const serialised = `${error.message} ${error.detail ?? ''} ${error.stack ?? ''}`;

    for (const secret of Object.values(ENV)) {
      if (secret === 'live') continue;
      assert.ok(!serialised.includes(secret), `error leaked ${secret}`);
    }
  });

  test('reports missing configuration without naming the value', async () => {
    delete process.env.AIRPAY_SECRET_KEY;

    const error = await getAccessToken().then(
      () => null,
      (caught) => caught,
    );

    assert.equal(error.isConfigError, true);
    assert.match(error.message, /AIRPAY_SECRET_KEY/);
  });
});

describe('upstream failure diagnostics', () => {
  test('sends a User-Agent, since WAFs 403 anonymous clients', async () => {
    const calls = stubFetch({ text: JSON.stringify({ access_token: 'tok', expires_in: 60 }) });

    await getAccessToken();

    assert.ok(calls[0].options.headers['User-Agent']);
  });

  test('captures the response body on a non-2xx so the cause is identifiable', async () => {
    stubFetch({ ok: false, status: 403, text: '<html>Access Denied: IP not whitelisted</html>' });

    const error = await getAccessToken().then(
      () => null,
      (caught) => caught,
    );

    assert.match(error.detail, /http 403/);
    assert.match(error.detail, /IP not whitelisted/);
  });

  test('scrubs credentials out of a body that echoes them back', async () => {
    stubFetch({ ok: false, status: 403, text: `denied for client-secret and api-key` });

    const error = await getAccessToken().then(
      () => null,
      (caught) => caught,
    );

    for (const secret of Object.values(ENV)) {
      if (secret === 'live') continue;
      assert.ok(!error.detail.includes(secret), `detail leaked ${secret}`);
    }

    assert.match(error.detail, /\[redacted\]/);
  });

  test('truncates a large body rather than logging all of it', async () => {
    stubFetch({ ok: false, status: 502, text: 'x'.repeat(50_000) });

    const error = await getAccessToken().then(
      () => null,
      (caught) => caught,
    );

    assert.ok(error.detail.length < 400);
  });
});

describe('request encoding', () => {
  test('posts the envelope form-encoded, not as JSON', async () => {
    const calls = stubFetch({ text: JSON.stringify({ access_token: 'tok', expires_in: 60 }) });

    await getAccessToken();

    // Airpay reads these as POST form fields; JSON produced
    // "403 Forbidden: Access is denied. Parameters are required."
    assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.ok(!calls[0].options.body.startsWith('{'));
    assert.match(calls[0].options.body, /^merchant_id=/);
  });

  test('the form body still carries all three envelope fields', async () => {
    const calls = stubFetch({ text: JSON.stringify({ access_token: 'tok' }) });

    await getAccessToken();

    assert.deepEqual(Object.keys(calls[0].body).sort(), ['checksum', 'encdata', 'merchant_id']);
  });

  test('encdata survives form encoding intact', async () => {
    const calls = stubFetch({ text: JSON.stringify({ access_token: 'tok' }) });

    await getAccessToken();

    // base64 contains + / = which must round-trip through the encoding.
    assert.deepEqual(JSON.parse(decrypt(calls[0].body.encdata, KEY)), {
      client_id: 'client-id',
      client_secret: 'client-secret',
      merchant_id: '123456',
      grant_type: 'client_credentials',
    });
  });
});
