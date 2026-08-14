/**
 * Airpay v4 request crypto.
 *
 * All of this is defined by Airpay's integration spec — the derivations below
 * are deliberately literal so they can be diffed against the merchant's copy of
 * the spec. Nothing here reads the environment; callers pass credentials in.
 */
import crypto from 'node:crypto';

export const md5Hex = (value) => crypto.createHash('md5').update(String(value), 'utf8').digest('hex');

export const sha256Hex = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

/**
 * AES key for the encdata payload: the MD5 *hex string* of
 * `username~:~password`, used as 32 ASCII characters. It is NOT hex-decoded —
 * decoding it would yield a 16-byte key and AES-128, which Airpay rejects.
 *
 * @param {string} username - AIRPAY_USERNAME
 * @param {string} password - AIRPAY_PASSWORD
 * @returns {string} 32-character ASCII key
 */
export function encryptionKey(username, password) {
  return md5Hex(`${username}~:~${password}`);
}

/**
 * Airpay's `privatekey` field.
 *
 * @param {string} apiKey - AIRPAY_API_KEY
 * @param {string} username - AIRPAY_USERNAME
 * @param {string} password - AIRPAY_PASSWORD
 * @returns {string} SHA-256 hex digest
 */
export function privateKey(apiKey, username, password) {
  return sha256Hex(`${apiKey}@${username}:|:${password}`);
}

/**
 * Current date in IST as YYYY-MM-DD. Airpay's checksum is date-salted against
 * Asia/Kolkata regardless of where the server runs, so the zone is explicit —
 * a UTC server would otherwise produce yesterday's date for 5.5 hours a day.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function istDate(now = new Date()) {
  // en-CA renders ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Airpay checksum: field values concatenated in ascending key order, salted
 * with the IST date, hashed with SHA-256.
 *
 * @param {Record<string, string|number>} fields
 * @param {Date} [now]
 * @returns {string} SHA-256 hex digest
 */
export function checksum(fields, now = new Date()) {
  const concatenated = Object.keys(fields)
    .sort()
    .map((key) => {
      const value = fields[key];
      return value === null || value === undefined ? '' : String(value);
    })
    .join('');

  return sha256Hex(`${concatenated}${istDate(now)}`);
}

/**
 * Encrypts a payload for Airpay's `encdata` field.
 *
 * AES-256-CBC with PKCS#7 padding (Node's default). The IV is 16 hexadecimal
 * characters derived from 8 random bytes, used as 16 ASCII bytes, and is
 * prefixed to the base64 ciphertext so Airpay can recover it.
 *
 * @param {string} plaintext
 * @param {string} key - 32-character key from encryptionKey()
 * @param {Buffer} [ivBytes] - 8 raw bytes; injectable so tests are deterministic
 * @returns {string} `IV(16 hex chars) + base64(ciphertext)`
 */
export function encrypt(plaintext, key, ivBytes = crypto.randomBytes(8)) {
  const iv = Buffer.from(ivBytes).toString('hex');
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return `${iv}${ciphertext.toString('base64')}`;
}

/**
 * Inverse of encrypt(), used to read Airpay's encrypted responses.
 *
 * @param {string} encdata - `IV(16 chars) + base64(ciphertext)`
 * @param {string} key - 32-character key from encryptionKey()
 * @returns {string} Plaintext
 */
export function decrypt(encdata, key) {
  const value = String(encdata);

  if (value.length <= 16) {
    throw new Error('encdata is too short to contain an IV and a payload');
  }

  const iv = value.slice(0, 16);
  const ciphertext = Buffer.from(value.slice(16), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Constant-time string comparison, for bearer tokens and any other secret
 * compared against attacker-supplied input. Length is compared first through a
 * fixed-size digest so the comparison itself never short-circuits on length.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  // Hashing both sides yields equal-length buffers, which timingSafeEqual
  // requires, without leaking the length of the expected secret.
  const left = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();

  return crypto.timingSafeEqual(left, right);
}

/**
 * Unguessable merchant reference for one payment attempt. Used as the Airpay
 * order id and as the only handle the browser is given, so order status cannot
 * be enumerated by incrementing a numeric id.
 *
 * @returns {string}
 */
export function newOrderRef() {
  return `FRV${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}
