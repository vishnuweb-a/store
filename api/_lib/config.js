/**
 * Server-side configuration for the Airpay online-payment feature.
 *
 * Everything here is read from the process environment at call time (never at
 * module load) so that a missing variable surfaces as a handled 503 on the one
 * endpoint that needs it, rather than crashing the whole function bundle.
 *
 * None of these values are ever sent to the browser.
 */

/** Airpay v4 OAuth2 token endpoint. */
export const AIRPAY_OAUTH_URL = 'https://kraken.airpay.co.in/airpay/pay/v4/api/oauth2/';

/** Airpay v4 hosted payment page. The access token is appended as ?token=. */
export const AIRPAY_PAY_URL = 'https://payments.airpay.co.in/pay/v4/';

/**
 * The public path Airpay is configured to call for MID 366751, as both the
 * Response (Success/Failed) URL and the IPN URL. vercel.json rewrites this
 * exact path onto api/payments/callback.js — the /api prefix is a Vercel
 * filesystem requirement, not a change of the public contract.
 */
export const CALLBACK_PATH = '/callback/cpm/arp/collection';

/**
 * NOTE ON kkchat.in
 *
 * Airpay callbacks for MID 366751 arrive at
 * `https://frontiva.online/callback/cpm/arp/collection` (CALLBACK_PATH above)
 * and are verified against Airpay's Order Confirmation API. Each one is also
 * relayed, as an auxiliary step that cannot affect settlement, to the client's
 * endpoint -- see DEFAULT_CLIENT_CALLBACK_URL in forward-callback.js.
 */

/** How long we wait on Airpay's own APIs. */
export const AIRPAY_TIMEOUT_MS = 15_000;

/** Upper bound on a single line's quantity, to bound server-side pricing. */
export const MAX_LINE_QUANTITY = 20;

/** Upper bound on distinct lines in one order. */
export const MAX_LINES = 50;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.isConfigError = true;
  }
}

function required(name) {
  const value = process.env[name];

  if (!value || !String(value).trim()) {
    // The name only — never the value, and never the set of names we *do* have.
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }

  return String(value).trim();
}

/**
 * Airpay merchant credentials. Throws ConfigError when anything is missing, so
 * callers can answer "payments are unavailable" without leaking which secret.
 *
 * @returns {{mid: string, clientId: string, secretKey: string, apiKey: string, username: string, password: string, env: string}}
 */
export function airpayConfig() {
  return {
    mid: required('AIRPAY_MID'),
    clientId: required('AIRPAY_CLIENT_ID'),
    secretKey: required('AIRPAY_SECRET_KEY'),
    apiKey: required('AIRPAY_API_KEY'),
    username: required('AIRPAY_USERNAME'),
    password: required('AIRPAY_PASSWORD'),
    env: (process.env.AIRPAY_ENV || 'live').trim().toLowerCase(),
  };
}

/**
 * Supabase credentials for server-side reads/writes. The service role is
 * preferred so pending orders can be written under a policy the browser does
 * not have; the anon key is accepted as a fallback because the current
 * prototype policies are open to it.
 *
 * @returns {{url: string, key: string, usingServiceRole: boolean}}
 */
export function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
  const serviceRole = (process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anon = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();
  const key = serviceRole || anon;

  if (!url) {
    throw new ConfigError('Missing required environment variable: SUPABASE_URL');
  }

  if (!key) {
    throw new ConfigError('Missing required environment variable: SUPABASE_SERVICE_ROLE');
  }

  return { url: url.replace(/\/+$/, ''), key, usingServiceRole: Boolean(serviceRole) };
}

/**
 * Canonical public origin, used to build the Airpay return URL and the
 * post-payment redirect. Falls back to the Vercel-provided host so preview
 * deployments still resolve to themselves.
 *
 * @param {import('node:http').IncomingMessage} [req]
 * @returns {string} Origin with no trailing slash
 */
export function siteOrigin(req) {
  const configured = (process.env.PUBLIC_SITE_ORIGIN || '').trim();

  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const vercelUrl = (process.env.VERCEL_URL || '').trim();

  if (vercelUrl) {
    return `https://${vercelUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }

  const host = req?.headers?.host;

  // Apex, matching the domain registered against MID 366751 in the Airpay
  // dashboard. Airpay validates the domain, so www would be a different origin.
  return host ? `https://${host}` : 'https://frontiva.online';
}

export { ConfigError };
