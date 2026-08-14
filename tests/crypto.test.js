/**
 * Airpay crypto: key derivation, AES round trip, checksum, IST date handling.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { describe } from 'node:test';
import {
  checksum,
  decrypt,
  encrypt,
  encryptionKey,
  istDate,
  md5Hex,
  newOrderRef,
  privateKey,
  sha256Hex,
} from '../api/_lib/crypto.js';

const USERNAME = 'testuser';
const PASSWORD = 'testpass';
const API_KEY = 'testapikey';

describe('encryptionKey', () => {
  test('is the MD5 hex of username~:~password', () => {
    assert.equal(encryptionKey(USERNAME, PASSWORD), md5Hex('testuser~:~testpass'));
  });

  test('is 32 ASCII characters, so AES-256 is selected', () => {
    const key = encryptionKey(USERNAME, PASSWORD);

    assert.equal(key.length, 32);
    assert.equal(Buffer.from(key, 'utf8').length, 32);
    assert.match(key, /^[0-9a-f]{32}$/);
  });
});

describe('privateKey', () => {
  test('is sha256(apiKey@username:|:password)', () => {
    assert.equal(
      privateKey(API_KEY, USERNAME, PASSWORD),
      sha256Hex('testapikey@testuser:|:testpass'),
    );
  });
});

describe('encrypt / decrypt', () => {
  const key = encryptionKey(USERNAME, PASSWORD);

  test('round trips a JSON payload', () => {
    const payload = JSON.stringify({ orderid: 'FRV123', amount: '1500.00' });

    assert.equal(decrypt(encrypt(payload, key), key), payload);
  });

  test('prefixes 16 hex IV characters to base64 ciphertext', () => {
    const encdata = encrypt('hello', key, Buffer.from('0011223344556677', 'hex'));

    assert.equal(encdata.slice(0, 16), '0011223344556677');
    assert.doesNotThrow(() => Buffer.from(encdata.slice(16), 'base64'));
  });

  test('uses AES-256-CBC with PKCS#7 padding', () => {
    const iv = Buffer.from('0011223344556677', 'hex');
    const encdata = encrypt('hello', key, iv);

    // Independent reference implementation.
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv.toString('hex'), 'utf8'));
    cipher.setAutoPadding(true);
    const expected = Buffer.concat([cipher.update('hello', 'utf8'), cipher.final()]).toString('base64');

    assert.equal(encdata.slice(16), expected);
  });

  test('produces a different IV on every call', () => {
    assert.notEqual(encrypt('hello', key).slice(0, 16), encrypt('hello', key).slice(0, 16));
  });

  test('rejects data too short to contain an IV', () => {
    assert.throws(() => decrypt('abc', key), /too short/);
  });
});

describe('istDate', () => {
  test('formats as YYYY-MM-DD', () => {
    assert.match(istDate(new Date('2026-08-14T12:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('uses Asia/Kolkata, not the server zone', () => {
    // 20:00 UTC on the 13th is already 01:30 on the 14th in IST.
    assert.equal(istDate(new Date('2026-08-13T20:00:00Z')), '2026-08-14');
  });

  test('does not roll over early', () => {
    // 18:00 UTC is 23:30 IST — still the 13th.
    assert.equal(istDate(new Date('2026-08-13T18:00:00Z')), '2026-08-13');
  });
});

describe('checksum', () => {
  const now = new Date('2026-08-14T06:00:00Z');

  test('concatenates values in ascending key order, salted with the IST date', () => {
    const value = checksum({ b: '2', a: '1', c: '3' }, now);

    assert.equal(value, sha256Hex(`1232026-08-14`));
  });

  test('is independent of the order keys were declared in', () => {
    assert.equal(
      checksum({ zebra: 'z', alpha: 'a' }, now),
      checksum({ alpha: 'a', zebra: 'z' }, now),
    );
  });

  test('changes when any value changes', () => {
    assert.notEqual(checksum({ a: '1' }, now), checksum({ a: '2' }, now));
  });

  test('treats null and undefined as empty strings', () => {
    assert.equal(checksum({ a: null, b: '1' }, now), sha256Hex('12026-08-14'));
  });
});

describe('newOrderRef', () => {
  test('matches the reference format the callback parser accepts', () => {
    assert.match(newOrderRef(), /^[A-Z0-9]{8,64}$/);
  });

  test('is unique across calls', () => {
    const refs = new Set(Array.from({ length: 500 }, () => newOrderRef()));

    assert.equal(refs.size, 500);
  });
});
