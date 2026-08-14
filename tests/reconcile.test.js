/**
 * Reconciliation endpoint authentication, and the constant-time comparison
 * behind it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach, describe } from 'node:test';
import { timingSafeEqual } from '../api/_lib/crypto.js';
import { isCronAuthorized } from '../api/_lib/http.js';

const SECRET = 'a96c988a08469266c51b26042d812deda51a42bf9e3465933cfa871907432f39';

let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.env = originalEnv;
});

const request = (authorization) => ({ headers: authorization ? { authorization } : {} });

describe('timingSafeEqual', () => {
  test('is true for identical strings', () => {
    assert.equal(timingSafeEqual(SECRET, SECRET), true);
  });

  test('is false for different strings', () => {
    assert.equal(timingSafeEqual(SECRET, `${SECRET}x`), false);
    assert.equal(timingSafeEqual(SECRET, ''), false);
  });

  test('does not throw on mismatched lengths', () => {
    // A raw crypto.timingSafeEqual would throw here; the digest wrapper must not.
    assert.doesNotThrow(() => timingSafeEqual('a', 'a much longer value'));
    assert.equal(timingSafeEqual('a', 'a much longer value'), false);
  });

  test('handles null and undefined without throwing', () => {
    assert.equal(timingSafeEqual(null, undefined), true);
    assert.equal(timingSafeEqual(null, SECRET), false);
  });
});

describe('isCronAuthorized', () => {
  test('accepts the correct bearer token', () => {
    process.env.CRON_SECRET = SECRET;

    assert.equal(isCronAuthorized(request(`Bearer ${SECRET}`)), true);
  });

  test('rejects a wrong token', () => {
    process.env.CRON_SECRET = SECRET;

    assert.equal(isCronAuthorized(request('Bearer wrong')), false);
    assert.equal(isCronAuthorized(request(`Bearer ${SECRET.slice(0, -1)}`)), false);
  });

  test('rejects a missing header', () => {
    process.env.CRON_SECRET = SECRET;

    assert.equal(isCronAuthorized(request()), false);
    assert.equal(isCronAuthorized(request(SECRET)), false);
  });

  test('rejects other schemes', () => {
    process.env.CRON_SECRET = SECRET;

    assert.equal(isCronAuthorized(request(`Basic ${SECRET}`)), false);
  });

  test('denies when CRON_SECRET is unset — fails closed', () => {
    delete process.env.CRON_SECRET;

    assert.equal(isCronAuthorized(request('Bearer anything')), false);
    assert.equal(isCronAuthorized(request('Bearer ')), false);
  });

  test('denies when CRON_SECRET is blank', () => {
    process.env.CRON_SECRET = '   ';

    assert.equal(isCronAuthorized(request('Bearer    ')), false);
  });
});

describe('reconcile endpoint', () => {
  const source = readFileSync(new URL('../api/payments/reconcile.js', import.meta.url), 'utf8');

  test('authenticates before doing any work', () => {
    const authIndex = source.indexOf('isCronAuthorized');
    const workIndex = source.indexOf('listUnresolvedOrders');

    assert.ok(authIndex > -1, 'reconcile must authenticate');
    assert.ok(authIndex < workIndex, 'authentication must precede the database read');
  });

  test('takes no input from the request', () => {
    // The order set comes from the database only — no body, no query string.
    assert.ok(!source.includes('readRawBody'));
    assert.ok(!source.includes('parseBody'));
    assert.ok(!source.includes('searchParams'));
  });

  test('settles through the shared idempotent path', () => {
    assert.match(source, /await settleOrder\(order\.order_ref\)/);
  });

  test('bounds the batch it processes', () => {
    assert.match(source, /limit: BATCH_LIMIT/);
  });
});
