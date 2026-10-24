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
 * The callback path required for the multi-merchant setup. Served by the same
 * handler as CALLBACK_PATH; the older path stays live as an alias because it is
 * what merchant 1's Airpay dashboard has registered today. Merchants 2 and 3
 * both register this one path: which merchant a delivery belongs to is never
 * read from the path, only from the envelope key, the stated MID and the order.
 */
export const CALLBACK_PATH_FRONTIVA = '/callback/cpm/arp_frontiva/collection';

/** Every public path that reaches the callback handler. */
export const CALLBACK_PATHS = [CALLBACK_PATH, CALLBACK_PATH_FRONTIVA];

/**
 * The Airpay merchant accounts. Merchant 1 is the original account and keeps
 * the original, unsuffixed variable names; merchants 2 and 3 read the same six
 * roles from the `_2` and `_3` names. There is no "active merchant": every
 * operation is handed the merchant it is for.
 */
export const MERCHANTS = [1, 2, 3];

const MERCHANT_ENV_SUFFIX = { 1: '', 2: '_2', 3: '_3' };

/**
 * The return URL each merchant sends by default. Merchant 1 keeps the path its
 * dashboard already registers, so deploying this code changes nothing for it.
 */
const DEFAULT_CALLBACK_PATH = { 1: CALLBACK_PATH, 2: CALLBACK_PATH_FRONTIVA, 3: CALLBACK_PATH_FRONTIVA };

/**
 * NOTE ON kkchat.in
 *
 * Airpay callbacks arrive at one of CALLBACK_PATHS above, whichever the MID's
 * dashboard registers, and are verified against Airpay's Order Confirmation
 * API using the credentials of the merchant the order belongs to. Each one is also
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
 * Normalises a merchant selection. Exactly 1, 2 and 3 (or their string forms,
 * as a JSON body or a database column may deliver them) are accepted;
 * everything else — including null — is null, so callers decide what absence
 * means.
 *
 * @param {unknown} value
 * @returns {1|2|3|null}
 */
export function parseMerchant(value) {
  for (const merchant of MERCHANTS) {
    if (value === merchant || value === String(merchant)) {
      return merchant;
    }
  }

  return null;
}

/**
 * Credentials for one Airpay merchant. Throws ConfigError when anything is
 * missing, so callers can answer "payments are unavailable" without leaking
 * which secret.
 *
 * Only the named merchant's variables are read. A missing merchant-2 or
 * merchant-3 value is an error for that merchant — it never falls back to
 * another merchant's.
 *
 * @param {1|2|3} merchant
 * @returns {{merchant: 1|2|3, mid: string, clientId: string, secretKey: string, apiKey: string, username: string, password: string, env: string}}
 */
export function loadAirpayConfig(merchant) {
  const id = parseMerchant(merchant);

  if (!id) {
    throw new ConfigError('Unknown Airpay merchant');
  }

  const suffix = MERCHANT_ENV_SUFFIX[id];

  return {
    merchant: id,
    mid: required(`AIRPAY_MID${suffix}`),
    clientId: required(`AIRPAY_CLIENT_ID${suffix}`),
    secretKey: required(`AIRPAY_SECRET_KEY${suffix}`),
    apiKey: required(`AIRPAY_API_KEY${suffix}`),
    username: required(`AIRPAY_USERNAME${suffix}`),
    password: required(`AIRPAY_PASSWORD${suffix}`),
    env: (process.env.AIRPAY_ENV || 'live').trim().toLowerCase(),
  };
}

/**
 * Whether every credential for a merchant is present.
 *
 * @param {1|2|3} merchant
 * @returns {boolean}
 */
export function isMerchantConfigured(merchant) {
  try {
    loadAirpayConfig(merchant);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every merchant whose credentials are fully present, with its config. Used to
 * recognise inbound callbacks, which must keep working for a merchant that has
 * been switched off at checkout but still has payments in flight.
 *
 * @returns {ReturnType<typeof loadAirpayConfig>[]}
 */
export function configuredMerchants() {
  const configs = [];

  for (const merchant of MERCHANTS) {
    try {
      configs.push(loadAirpayConfig(merchant));
    } catch {
      // Not configured; simply not a candidate.
    }
  }

  return configs;
}

/**
 * Merchants a NEW payment may be started on: AIRPAY_ENABLED_MERCHANTS (default
 * all) narrowed to those actually configured. This is the checkout switch —
 * setting it to `1,2` stops new merchant 3 payments without touching
 * verification of orders already placed on merchant 3.
 *
 * @returns {(1|2|3)[]}
 */
export function checkoutMerchants() {
  const listed = String(process.env.AIRPAY_ENABLED_MERCHANTS || '')
    .split(',')
    .map((entry) => parseMerchant(entry.trim()))
    .filter(Boolean);

  // An unset or unreadable value means "all", never "none": a typo here must
  // not be able to switch off the merchant that is live today.
  const enabled = listed.length > 0 ? listed : MERCHANTS;

  return MERCHANTS.filter((merchant) => enabled.includes(merchant) && isMerchantConfigured(merchant));
}

/**
 * The public callback path a merchant's payment request names as its return
 * URL. It must equal what that MID's Airpay dashboard registers, so it is
 * configurable per merchant — but only between the paths this deployment
 * actually serves.
 *
 * @param {1|2|3} merchant
 * @returns {string}
 */
export function callbackPathFor(merchant) {
  const id = parseMerchant(merchant) || 1;
  const configured = String(process.env[`AIRPAY_CALLBACK_PATH${MERCHANT_ENV_SUFFIX[id]}`] || '').trim();

  return CALLBACK_PATHS.includes(configured) ? configured : DEFAULT_CALLBACK_PATH[id];
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

/**
 * SabPaisa PG 3.0 production API. Fixed, not configurable: there is no
 * environment switch to a staging host, and a SABPAISA_BASE_URL that names
 * anything else is ignored rather than followed (see sabpaisaBaseUrlOverridden).
 */
export const SABPAISA_BASE_URL = 'https://merchant-api.sabpaisa.in';

/** How long we wait on SabPaisa's APIs. Well inside the functions' 60s budget. */
export const SABPAISA_TIMEOUT_MS = 20_000;

/** The value orders.payment_gateway carries for a SabPaisa payment. */
export const SABPAISA_GATEWAY = 'sabpaisa';

/**
 * Each SabPaisa role, by every variable name it may be configured under. The
 * canonical SABPAISA_* name wins; the SUBPAISA_* spelling is what the
 * deployment's environment was first set up with, and MERCHANT_ID is the
 * unprefixed name the merchant ID was supplied under. No role ever falls back
 * to a different role's variable.
 */
const SABPAISA_ENV_NAMES = {
  apiKey: ['SABPAISA_API_KEY', 'SUBPAISA_API_KEY'],
  secretKey: ['SABPAISA_SECRET_KEY', 'SUBPAISA_SECRET_KEY'],
  merchantId: ['SABPAISA_MERCHANT_ID', 'SUBPAISA_MERCHANT_ID', 'MERCHANT_ID'],
  clientCode: ['SABPAISA_CLIENT_CODE', 'SUBPAISA_CLIENT_CODE'],
};

function firstPresent(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();

    if (value) {
      return { name, value };
    }
  }

  return null;
}

/**
 * Which variable name each SabPaisa role was read from, or null when none is
 * set. Names only — for the health report.
 *
 * @returns {Record<string, string|null>}
 */
export function sabpaisaEnvNames() {
  return Object.fromEntries(
    Object.entries(SABPAISA_ENV_NAMES).map(([role, names]) => [role, firstPresent(names)?.name ?? null]),
  );
}

/**
 * SabPaisa credentials. Throws ConfigError when anything is missing, or when
 * the API key is a sandbox key, so a staging credential can never be used
 * against production by accident.
 *
 * Deliberately independent of SABPAISA_ENABLED: the flag only gates NEW
 * payments, and orders already started must stay verifiable after it is
 * switched off.
 *
 * @returns {{apiKey: string, secretKey: string, merchantId: string, clientCode: string, baseUrl: string}}
 */
export function loadSabpaisaConfig() {
  const config = {};

  for (const [role, names] of Object.entries(SABPAISA_ENV_NAMES)) {
    const found = firstPresent(names);

    if (!found) {
      throw new ConfigError(`Missing required environment variable: ${names[0]}`);
    }

    config[role] = found.value;
  }

  if (/^sk_test_/i.test(config.apiKey)) {
    throw new ConfigError('SABPAISA_API_KEY is a sandbox key');
  }

  return { ...config, baseUrl: SABPAISA_BASE_URL };
}

/** @returns {boolean} */
export function isSabpaisaConfigured() {
  try {
    loadSabpaisaConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * The checkout switch. Only an explicit `true` enables new SabPaisa payments;
 * unset, empty or anything else is off.
 *
 * @returns {boolean}
 */
export function sabpaisaEnabled() {
  return String(process.env.SABPAISA_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * True when SABPAISA_BASE_URL is set to something other than the production
 * API. The value is never used either way; this only lets the health report
 * flag a stale staging setting.
 *
 * @returns {boolean}
 */
export function sabpaisaBaseUrlOverridden() {
  const configured = String(process.env.SABPAISA_BASE_URL || '').trim().replace(/\/+$/, '');
  return Boolean(configured) && configured !== SABPAISA_BASE_URL;
}

/**
 * The email SabPaisa receives as customerEmail. The storefront does not collect
 * a customer email, so this is a merchant-owned mailbox — the same convention
 * the Airpay integration already uses (AIRPAY_FALLBACK_BUYER_EMAIL).
 *
 * @returns {string}
 */
export function sabpaisaBuyerEmail() {
  return String(
    process.env.SABPAISA_BUYER_EMAIL || process.env.AIRPAY_FALLBACK_BUYER_EMAIL || 'orders@frontiva.online',
  ).trim();
}

/**
 * Origin of the SabPaisa returnUrl (`<origin>/success?ref=...`). Must match the
 * return URL approved on the SabPaisa account, so it is independent of
 * PUBLIC_SITE_ORIGIN, which the Airpay MIDs depend on. HTTPS only.
 *
 * @returns {string} Origin with no trailing slash
 */
export function sabpaisaReturnOrigin() {
  const configured = String(process.env.SABPAISA_RETURN_ORIGIN || '').trim().replace(/\/+$/, '');

  return /^https:\/\/[a-z0-9.-]+$/i.test(configured) ? configured : 'https://frontiva.online';
}

/**
 * Whether checkout may START a SabPaisa payment: switched on and fully
 * configured. Never tied to AIRPAY_ENABLED_MERCHANTS.
 *
 * @returns {boolean}
 */
export function sabpaisaAvailable() {
  return sabpaisaEnabled() && isSabpaisaConfigured();
}

export { ConfigError };
