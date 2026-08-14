/**
 * The Airpay Response/IPN endpoint: payload parsing, field extraction,
 * integrity checks, duplicate detection, and routing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
import {
  dedupeKeyFor,
  extractCallbackFields,
  extractOrderRef,
  isBrowserNavigation,
  unwrapEnvelope,
  verifyMerchantId,
  verifySecureHash,
} from '../api/_lib/callback-payload.js';
import { CALLBACK_PATH } from '../api/_lib/config.js';
import { encrypt, encryptionKey, sha256Hex } from '../api/_lib/crypto.js';
import { parseBody, redact } from '../api/_lib/http.js';

const MID = '366751';

/** A representative Airpay callback body. */
const CALLBACK = {
  merchant_id: MID,
  orderid: 'FRVABC12345',
  customvar: 'FRVABC12345',
  ap_transactionid: 'AP987654',
  amount: '1500.00',
  transaction_status: '200',
  transaction_payment_status: 'SUCCESS',
  message: 'Transaction Successful',
  customer_vpa: 'someone@upi',
};

describe('parseBody', () => {
  test('parses the form-encoded body Airpay posts', () => {
    const parsed = parseBody(
      'TRANSACTIONID=123&APTRANSACTIONID=AP987&AMOUNT=1500.00&TRANSACTIONSTATUS=200&CUSTOMVAR=FRVABC12345',
      'application/x-www-form-urlencoded',
    );

    assert.equal(parsed.CUSTOMVAR, 'FRVABC12345');
    assert.equal(parsed.TRANSACTIONSTATUS, '200');
  });

  test('parses a JSON body', () => {
    assert.deepEqual(parseBody('{"customvar":"FRVABC12345"}', 'application/json'), {
      customvar: 'FRVABC12345',
    });
  });

  test('sniffs the format when the content type is wrong', () => {
    assert.deepEqual(parseBody('{"a":"1"}', 'application/x-www-form-urlencoded'), { a: '1' });
  });

  test('never throws on malformed or hostile input', () => {
    for (const body of ['', '   ', '{not json', '%%%%', '[]', 'null', 'a'.repeat(10000)]) {
      assert.doesNotThrow(() => parseBody(body, 'application/json'));
      assert.equal(typeof parseBody(body, 'application/json'), 'object');
    }
  });

  test('decodes url-encoded values', () => {
    assert.equal(parseBody('name=Asha%20Menon', 'application/x-www-form-urlencoded').name, 'Asha Menon');
  });
});

describe('extractCallbackFields', () => {
  test('extracts every documented Airpay field', () => {
    const fields = extractCallbackFields(CALLBACK);

    assert.equal(fields.merchantId, MID);
    assert.equal(fields.orderRef, 'FRVABC12345');
    assert.equal(fields.transactionId, 'AP987654');
    assert.equal(fields.amount, '1500.00');
    assert.equal(fields.transactionStatus, '200');
    assert.equal(fields.paymentStatus, 'SUCCESS');
    assert.equal(fields.message, 'Transaction Successful');
    assert.equal(fields.customerVpa, 'someone@upi');
  });

  test('is case-insensitive about field names', () => {
    const fields = extractCallbackFields({
      MERCHANT_ID: MID,
      CUSTOMVAR: 'FRVABC12345',
      AP_TRANSACTIONID: 'AP1',
      TRANSACTION_STATUS: '200',
      AP_SECUREHASH: 'abc',
    });

    assert.equal(fields.merchantId, MID);
    assert.equal(fields.orderRef, 'FRVABC12345');
    assert.equal(fields.transactionId, 'AP1');
    assert.equal(fields.secureHash, 'abc');
  });

  test('returns nulls rather than throwing on an empty payload', () => {
    const fields = extractCallbackFields({});

    assert.equal(fields.merchantId, null);
    assert.equal(fields.orderRef, null);
    assert.equal(fields.secureHash, null);
  });
});

describe('extractOrderRef', () => {
  test('prefers the customvar we set', () => {
    assert.equal(extractOrderRef({ orderid: 'FRVOTHER1234', customvar: 'FRVABC12345' }), 'FRVABC12345');
  });

  test('falls back to orderid', () => {
    assert.equal(extractOrderRef({ ORDERID: 'FRVABC12345' }), 'FRVABC12345');
  });

  test('rejects anything outside the generated reference format', () => {
    // The value flows into a PostgREST filter, so the gate is a security control.
    for (const value of ['../../etc', "eq.1'--", 'short', 'lowercase12345', '', 'FRV*(){}', 'A'.repeat(200)]) {
      assert.equal(extractOrderRef({ customvar: value }), null);
    }
  });

  test('returns null for an absent or non-object payload', () => {
    assert.equal(extractOrderRef({}), null);
    assert.equal(extractOrderRef(null), null);
  });
});

describe('verifyMerchantId', () => {
  test('matches our own MID', () => {
    assert.equal(verifyMerchantId(extractCallbackFields(CALLBACK), MID), 'match');
  });

  test('flags a callback for a different merchant', () => {
    const fields = extractCallbackFields({ ...CALLBACK, merchant_id: '999999' });

    assert.equal(verifyMerchantId(fields, MID), 'mismatch');
  });

  test('reports absent when the callback omits the merchant id', () => {
    assert.equal(verifyMerchantId(extractCallbackFields({}), MID), 'absent');
  });
});

describe('verifySecureHash', () => {
  const SECRET = 'derived-private-key';

  /** Builds a payload carrying a hash computed the way the verifier expects. */
  const sign = (payload) => {
    const signed = Object.keys(payload)
      .filter((key) => !/securehash/i.test(key))
      .sort()
      .map((key) => String(payload[key] ?? ''))
      .join('');

    return { ...payload, ap_SecureHash: sha256Hex(`${signed}${SECRET}`) };
  };

  test('accepts a correctly signed callback', () => {
    assert.equal(verifySecureHash(sign(CALLBACK), SECRET), 'valid');
  });

  test('rejects a tampered amount', () => {
    const signed = sign(CALLBACK);

    assert.equal(verifySecureHash({ ...signed, amount: '1.00' }, SECRET), 'invalid');
  });

  test('rejects a forged hash', () => {
    assert.equal(verifySecureHash({ ...CALLBACK, ap_SecureHash: 'deadbeef' }, SECRET), 'invalid');
  });

  test('rejects a hash signed with the wrong secret', () => {
    assert.equal(verifySecureHash(sign(CALLBACK), 'a-different-secret'), 'invalid');
  });

  test('reports unavailable when no hash is present', () => {
    assert.equal(verifySecureHash(CALLBACK, SECRET), 'unavailable');
  });

  test('reports unavailable when no secret is configured', () => {
    assert.equal(verifySecureHash(sign(CALLBACK), ''), 'unavailable');
  });
});

describe('isBrowserNavigation', () => {
  test('detects a browser landing on the Response URL', () => {
    assert.equal(isBrowserNavigation({ headers: { 'sec-fetch-mode': 'navigate' } }), true);
    assert.equal(isBrowserNavigation({ headers: { 'sec-fetch-dest': 'document' } }), true);
    assert.equal(isBrowserNavigation({ headers: { accept: 'text/html,application/xhtml+xml' } }), true);
  });

  test('treats a server-to-server IPN as not a browser', () => {
    assert.equal(isBrowserNavigation({ headers: { accept: '*/*' } }), false);
    assert.equal(isBrowserNavigation({ headers: { accept: 'application/json' } }), false);
    assert.equal(isBrowserNavigation({ headers: {} }), false);
    assert.equal(isBrowserNavigation({}), false);
  });
});

describe('dedupeKeyFor', () => {
  test('is identical for a redelivered callback', () => {
    assert.equal(dedupeKeyFor('raw=1', CALLBACK), dedupeKeyFor('raw=1', CALLBACK));
  });

  test('ignores incidental body differences for the same event', () => {
    assert.equal(dedupeKeyFor('a=1&b=2', CALLBACK), dedupeKeyFor('b=2&a=1', { ...CALLBACK, extra: '3' }));
  });

  test('differs for a different order', () => {
    assert.notEqual(
      dedupeKeyFor('raw', CALLBACK),
      dedupeKeyFor('raw', { ...CALLBACK, customvar: 'FRVZZZ99999', orderid: 'FRVZZZ99999' }),
    );
  });

  test('differs for a different status on the same order', () => {
    assert.notEqual(dedupeKeyFor('raw', CALLBACK), dedupeKeyFor('raw', { ...CALLBACK, transaction_status: '400' }));
  });

  test('falls back to the raw body when nothing is recognisable', () => {
    assert.equal(dedupeKeyFor('mystery=1', {}), dedupeKeyFor('mystery=1', {}));
    assert.notEqual(dedupeKeyFor('mystery=1', {}), dedupeKeyFor('mystery=2', {}));
  });
});

describe('redact', () => {
  test('removes payment secrets before anything is logged or stored', () => {
    const redacted = redact({
      encdata: 'abc',
      checksum: 'def',
      privatekey: 'ghi',
      access_token: 'jkl',
      transaction_status: '200',
    });

    for (const key of ['encdata', 'checksum', 'privatekey', 'access_token']) {
      assert.equal(redacted[key], '[redacted]');
    }

    assert.equal(redacted.transaction_status, '200');
  });

  test('removes customer contact details', () => {
    const redacted = redact({ phone: '9876543210', email: 'a@b.c', customvar: 'FRVABC12345' });

    assert.equal(redacted.phone, '[redacted]');
    assert.equal(redacted.email, '[redacted]');
    assert.equal(redacted.customvar, 'FRVABC12345');
  });

  test('is case-insensitive', () => {
    assert.equal(redact({ ENCDATA: 'abc' }).ENCDATA, '[redacted]');
  });
});

describe('callback route and Vercel configuration', () => {
  const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../api/payments/callback.js', import.meta.url), 'utf8');

  test('the exact Airpay-registered path is exposed', () => {
    assert.equal(CALLBACK_PATH, '/callback/cpm/arp/collection');
  });

  test('that path is rewritten to the callback function', () => {
    const rewrite = vercelConfig.rewrites.find((entry) => entry.source === '/callback/cpm/arp/collection');

    assert.ok(rewrite, 'the Airpay callback path must be routed server-side');
    assert.equal(rewrite.destination, '/api/payments/callback');
  });

  test('the SPA catch-all cannot intercept it', () => {
    const callbackIndex = vercelConfig.rewrites.findIndex((entry) => entry.source === '/callback/cpm/arp/collection');
    const spaIndex = vercelConfig.rewrites.findIndex((entry) => entry.destination === '/index.html');

    assert.ok(callbackIndex > -1 && spaIndex > -1);
    assert.ok(callbackIndex < spaIndex, 'the callback rewrite must precede the SPA catch-all');
  });

  test('/api routes also precede the SPA catch-all', () => {
    const apiIndex = vercelConfig.rewrites.findIndex((entry) => entry.source.startsWith('/api/'));
    const spaIndex = vercelConfig.rewrites.findIndex((entry) => entry.destination === '/index.html');

    assert.ok(apiIndex > -1 && apiIndex < spaIndex);
  });

  test('the payment request sends the registered callback path as its return URL', () => {
    const create = readFileSync(new URL('../api/payments/create.js', import.meta.url), 'utf8');

    assert.match(create, /returnUrl: `\$\{siteOrigin\(req\)\}\$\{CALLBACK_PATH\}`/);
  });

  test('the handler serves both browser response and server IPN traffic', () => {
    assert.match(source, /isBrowserNavigation/);
    assert.match(source, /redirect\(res/);
  });

  test('settlement is triggered by reference alone, never by the body', () => {
    assert.match(source, /await settleOrder\(orderRef\)/);
    assert.ok(!/settleOrder\([^)]*payload/.test(source));
    assert.ok(!/settleOrder\([^)]*fields/.test(source));
  });
});

describe('secure-hash enforcement is opt-in', () => {
  const source = readFileSync(new URL('../api/payments/callback.js', import.meta.url), 'utf8');

  test('a hash mismatch does not block settlement by default', () => {
    // The construction is unverified and its secret is posted from the browser,
    // so blocking would strand genuine payments without buying any security.
    assert.match(source, /if \(ENFORCE_SECURE_HASH\) \{\s*\n\s*blocked = true;/);
    assert.match(source, /AIRPAY_ENFORCE_SECURE_HASH/);
  });

  test('enforcement defaults to off', () => {
    assert.match(source, /AIRPAY_ENFORCE_SECURE_HASH \|\| ''/);
  });

  test('a merchant-id mismatch blocks unconditionally', () => {
    const midBlock = source.slice(source.indexOf('mid_mismatch') - 300, source.indexOf('mid_mismatch') + 120);

    assert.match(midBlock, /blocked = true;/);
    assert.ok(!/ENFORCE_SECURE_HASH/.test(midBlock), 'the MID check must not be conditional');
  });

  test('a forged callback still cannot mark an order paid', () => {
    // The safety property does not depend on the hash at all: settlement takes
    // only the reference and re-verifies with Airpay.
    assert.match(source, /await settleOrder\(orderRef\)/);
    assert.ok(!/settleOrder\([^)]*(payload|fields)/.test(source));
  });
});

describe('order creation ordering', () => {
  const create = readFileSync(new URL('../api/payments/create.js', import.meta.url), 'utf8');

  test('authenticates with Airpay before writing a pending order', () => {
    // Otherwise an OAuth failure leaves an orphan `initiated` row that
    // reconciliation has to park in requires_review for a human.
    assert.ok(create.indexOf('getAccessToken()') < create.indexOf('createPendingOrder('));
  });

  test('still prices from Supabase before doing either', () => {
    assert.ok(create.indexOf('priceOrder(') < create.indexOf('getAccessToken()'));
  });
});

describe('a real Airpay IPN', () => {
  // Field names taken verbatim from a production IPN delivered to
  // /callback/cpm/arp/collection on 2026-08-14T14:21:03Z.
  const REAL_IPN = {
    TRANSACTIONPAYMENTSTATUS: 'SUCCESS',
    MERCID: '366751',
    CHARGE_TYPE: '1',
    TRANSACTIONID: 'FRVMFA1B2C3D4E5F6',
    APTRANSACTIONID: '250814000123456',
    TXN_MODE: 'UPI',
    CHMOD: 'upi',
    AMOUNT: '1500.00',
    CURRENCYCODE: '356',
    TRANSACTIONSTATUS: '200',
    MESSAGE: 'Transaction Successful',
    CUSTOMER: 'Asha Menon',
    CUSTOMERPHONE: '9876543210',
    CUSTOMEREMAIL: 'orders@frontiva.online',
    TRANSACTIONTYPE: 'SALE',
    RISK: 'GREEN',
    IPNID: '987654',
    CUSTOMVAR: 'FRVMFA1B2C3D4E5F6',
    TOKEN: 'tok',
    UID: 'uid',
    TRANSACTIONTIME: '2026-08-14 19:51:03',
    BILLEDAMOUNT: '1500.00',
    RRN: '523612345678',
    MERCHANT_NAME: 'FRONTIVA',
    CARDTYPE: 'UPI',
    CUSTOMERVPA: 'someone@upi',
    ap_SecureHash: 'abc123',
    CHECKOUT_TRANSACTION: '1',
  };

  test('every field we rely on is extracted from the real payload', () => {
    const fields = extractCallbackFields(REAL_IPN);

    assert.equal(fields.merchantId, '366751', 'MERCID');
    assert.equal(fields.orderRef, 'FRVMFA1B2C3D4E5F6', 'CUSTOMVAR');
    assert.equal(fields.amount, '1500.00', 'AMOUNT');
    assert.equal(fields.transactionStatus, '200', 'TRANSACTIONSTATUS');
    assert.equal(fields.paymentStatus, 'SUCCESS', 'TRANSACTIONPAYMENTSTATUS');
    assert.equal(fields.message, 'Transaction Successful', 'MESSAGE');
    assert.equal(fields.secureHash, 'abc123', 'ap_SecureHash');
    assert.equal(fields.customerVpa, 'someone@upi', 'CUSTOMERVPA');
  });

  test("uses Airpay's own id as the transaction id, not the merchant's", () => {
    // APTRANSACTIONID is Airpay's; TRANSACTIONID is ours.
    assert.equal(extractCallbackFields(REAL_IPN).transactionId, '250814000123456');
  });

  test('recovers the order reference from TRANSACTIONID when CUSTOMVAR is absent', () => {
    const { CUSTOMVAR, ...withoutCustomvar } = REAL_IPN;

    assert.equal(extractOrderRef(withoutCustomvar), 'FRVMFA1B2C3D4E5F6');
  });

  test("never mistakes Airpay's numeric transaction id for an order reference", () => {
    const { CUSTOMVAR, TRANSACTIONID, ...rest } = REAL_IPN;

    // APTRANSACTIONID is long and alphanumeric enough to have passed a looser
    // gate; the FRV prefix is what rules it out.
    assert.equal(extractOrderRef(rest), null);
  });

  test('the merchant id matches our configured MID', () => {
    assert.equal(verifyMerchantId(extractCallbackFields(REAL_IPN), MID), 'match');
  });

  test('the status classifies as a successful transaction', () => {
    assert.equal(extractCallbackFields(REAL_IPN).transactionStatus, '200');
  });

  test('a redelivery of the same IPN dedupes', () => {
    assert.equal(dedupeKeyFor('raw', REAL_IPN), dedupeKeyFor('raw', { ...REAL_IPN, IPNID: '999' }));
  });

  test('contact details are redacted before storage', () => {
    const stored = redact(REAL_IPN);

    // Airpay's unpunctuated spellings must be caught, not just customer_phone.
    assert.equal(stored.CUSTOMERPHONE, '[redacted]');
    assert.equal(stored.CUSTOMEREMAIL, '[redacted]');
    assert.equal(stored.CUSTOMERVPA, '[redacted]');
    assert.equal(stored.CUSTOMER, '[redacted]');

    // Audit value is retained.
    assert.equal(stored.TRANSACTIONSTATUS, '200');
    assert.equal(stored.AMOUNT, '1500.00');
    assert.equal(stored.APTRANSACTIONID, '250814000123456');
  });
});

describe('enveloped callback ({merchant_id, response})', () => {
  // Airpay sends this endpoint two shapes. This is the encrypted one, the same
  // envelope its API responses use, decoded with the project's existing
  // decrypt() — no new algorithm.
  const KEY = encryptionKey('testuser', 'testpass');

  const INNER = {
    MERCID: MID,
    TRANSACTIONID: 'FRVMFA1B2C3D4E5F6',
    APTRANSACTIONID: '250814000123456',
    AMOUNT: '2.00',
    TRANSACTIONSTATUS: '200',
    TRANSACTIONPAYMENTSTATUS: 'SUCCESS',
    MESSAGE: 'Transaction Successful',
    CUSTOMVAR: 'FRVMFA1B2C3D4E5F6',
    ap_SecureHash: 'abc123',
    CUSTOMERVPA: 'someone@upi',
  };

  const enveloped = (inner = INNER, key = KEY) => ({
    merchant_id: MID,
    response: encrypt(JSON.stringify(inner), key),
  });

  test('the raw envelope alone yields no order reference — the reported symptom', () => {
    const payload = enveloped();

    assert.equal(extractOrderRef(payload), null);
    assert.equal(extractCallbackFields(payload).transactionStatus, null);
  });

  test('unwrapping recovers every field', () => {
    const { payload, enveloped: wasEnveloped, unwrapped } = unwrapEnvelope(enveloped(), KEY);

    assert.equal(wasEnveloped, true);
    assert.equal(unwrapped, true);

    const fields = extractCallbackFields(payload);

    assert.equal(fields.orderRef, 'FRVMFA1B2C3D4E5F6');
    assert.equal(fields.transactionStatus, '200');
    assert.equal(fields.paymentStatus, 'SUCCESS');
    assert.equal(fields.amount, '2.00');
    assert.equal(fields.transactionId, '250814000123456');
    assert.equal(fields.secureHash, 'abc123');
    assert.equal(fields.customerVpa, 'someone@upi');
  });

  test('the outer merchant_id survives the merge', () => {
    const { payload } = unwrapEnvelope(enveloped(), KEY);

    assert.equal(extractCallbackFields(payload).merchantId, MID);
  });

  test('decodes a form-encoded inner payload too', () => {
    const inner = new URLSearchParams(INNER).toString();
    const payload = { merchant_id: MID, response: encrypt(inner, KEY) };

    const { unwrapped, payload: merged } = unwrapEnvelope(payload, KEY);

    assert.equal(unwrapped, true);
    assert.equal(extractOrderRef(merged), 'FRVMFA1B2C3D4E5F6');
  });

  test('a plaintext IPN passes straight through untouched', () => {
    const plain = { MERCID: MID, CUSTOMVAR: 'FRVMFA1B2C3D4E5F6', TRANSACTIONSTATUS: '200' };
    const result = unwrapEnvelope(plain, KEY);

    assert.equal(result.enveloped, false);
    assert.equal(result.unwrapped, false);
    assert.deepEqual(result.payload, plain);
  });

  test('a wrong key degrades gracefully rather than throwing', () => {
    const result = unwrapEnvelope(enveloped(), encryptionKey('other', 'creds'));

    assert.equal(result.enveloped, true);
    assert.equal(result.unwrapped, false);
    assert.ok(result.reason);
    // Original payload preserved, so forwarding is unaffected.
    assert.equal(result.payload.merchant_id, MID);
  });

  test('a missing key degrades gracefully', () => {
    const result = unwrapEnvelope(enveloped(), null);

    assert.equal(result.unwrapped, false);
    assert.match(result.reason, /no key/);
  });

  test('never throws on a malformed or hostile envelope', () => {
    for (const response of ['', 'x', 'not-encrypted-at-all', 'a'.repeat(500), '{}', null, undefined, 12345]) {
      assert.doesNotThrow(() => unwrapEnvelope({ merchant_id: MID, response }, KEY));
    }
  });

  test('never throws on a malformed payload object', () => {
    for (const payload of [{}, null, undefined, { response: {} }, { response: [] }]) {
      assert.doesNotThrow(() => unwrapEnvelope(payload, KEY));
    }
  });
});
