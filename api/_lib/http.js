/**
 * Request/response helpers shared by the payment endpoints, plus the logging
 * rules the payment code follows.
 */
import { timingSafeEqual } from './crypto.js';

/** Body fields that must never reach a log line or an API response. */
const SENSITIVE_KEYS = new Set([
  'encdata',
  'checksum',
  'privatekey',
  'private_key',
  'client_secret',
  'secret_key',
  'password',
  'access_token',
  'token',
  'card',
  'cardnumber',
  'card_number',
  'cvv',
  'customer_phone',
  'customer_email',
  'phone',
  'email',
]);

/**
 * Reads the raw request body. Vercel pre-parses bodies for known content types,
 * so `req.body` is honoured when present and the stream is drained otherwise.
 *
 * @param {import('node:http').IncomingMessage & {body?: unknown}} req
 * @param {number} [limitBytes]
 * @returns {Promise<string>}
 */
export async function readRawBody(req, limitBytes = 1_000_000) {
  if (typeof req.body === 'string') {
    return req.body;
  }

  if (req.body && typeof req.body === 'object') {
    // Already parsed upstream; re-serialising keeps one code path downstream.
    return JSON.stringify(req.body);
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > limitBytes) {
      throw new Error('Request body too large');
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parses a body as JSON or as application/x-www-form-urlencoded, whichever the
 * content matches. Airpay posts form-encoded callbacks; the storefront posts
 * JSON. Never throws — an unparseable body yields an empty object.
 *
 * @param {string} raw
 * @param {string} [contentType]
 * @returns {Record<string, string>}
 */
export function parseBody(raw, contentType = '') {
  const body = String(raw || '').trim();

  if (!body) {
    return {};
  }

  const type = String(contentType).toLowerCase();

  if (type.includes('json') || body.startsWith('{') || body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // Fall through to form parsing — a mislabelled body is still worth a try.
    }
  }

  try {
    return Object.fromEntries(new URLSearchParams(body));
  } catch {
    return {};
  }
}

/**
 * Redacts sensitive values so a payload can be logged or persisted for audit.
 *
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
export function redact(payload) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase()) ? '[redacted]' : value,
    ]),
  );
}

/**
 * Scrubs any configured credential value out of free text, so an upstream error
 * body can be logged without risking echoing a secret back into the logs.
 *
 * @param {string} text
 * @param {number} [limit] - Truncate to this many characters
 * @returns {string}
 */
export function scrubSecrets(text, limit = 300) {
  let output = String(text || '').slice(0, limit);

  const secrets = [
    process.env.AIRPAY_SECRET_KEY,
    process.env.AIRPAY_API_KEY,
    process.env.AIRPAY_PASSWORD,
    process.env.AIRPAY_USERNAME,
    process.env.AIRPAY_CLIENT_ID,
    process.env.SUPABASE_SERVICE_ROLE,
    process.env.CRON_SECRET,
  ].filter((value) => value && String(value).length >= 4);

  for (const secret of secrets) {
    output = output.split(String(secret)).join('[redacted]');
  }

  return output;
}

/**
 * Structured server-side log. Callers pass already-safe fields; anything that
 * looks sensitive is redacted again here as a backstop.
 *
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
export function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...redact(fields) }));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} location
 */
export function redirect(res, location) {
  // 303 so a POST return from Airpay becomes a GET of the storefront page.
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * Rejects anything but the listed methods.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} methods
 * @returns {boolean} true when the request may proceed
 */
export function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) {
    return true;
  }

  res.setHeader('Allow', methods.join(', '));
  json(res, 405, { error: 'Method not allowed' });

  return false;
}

/**
 * Authorises a machine caller (Vercel Cron, or an operator running the health
 * probe) against CRON_SECRET.
 *
 * Accepts `Authorization: Bearer <secret>`. The comparison is constant time,
 * and an unset CRON_SECRET denies rather than allows.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isCronAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();

  if (!secret) {
    return false;
  }

  const header = String(req.headers?.authorization || '');

  if (!header.startsWith('Bearer ')) {
    return false;
  }

  return timingSafeEqual(header.slice(7), secret);
}

/**
 * fetch() with a hard timeout, so a hung upstream cannot pin a function open
 * for its whole execution budget.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
