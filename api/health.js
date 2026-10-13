/**
 * GET /api/health
 *
 * Configuration health check. Reports only whether each required server-side
 * variable is PRESENT — never a value, and never a partial value.
 *
 * With `Authorization: Bearer $CRON_SECRET` it additionally performs a live
 * Airpay OAuth2 round trip for each configured merchant, which verifies the
 * credentials, key derivation, encryption and checksum without creating a
 * transaction or moving any money.
 *
 * Readiness is decided by merchant 1 and the shared settings alone. Merchant 2
 * is reported alongside, but an unconfigured merchant 2 is not a fault.
 */
import { getAccessToken } from './_lib/airpay.js';
import {
  CALLBACK_PATHS,
  MERCHANTS,
  callbackPathFor,
  checkoutMerchants,
  isMerchantConfigured,
  siteOrigin,
} from './_lib/config.js';
import { allowMethods, isCronAuthorized, json, logEvent } from './_lib/http.js';

export const config = { maxDuration: 60 };

const present = (name) => Boolean(String(process.env[name] || '').trim());

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) {
    return;
  }

  // Booleans only. Every one of these names maps to a secret except the two
  // non-secret values echoed explicitly below.
  const configured = {
    AIRPAY_MID: present('AIRPAY_MID'),
    AIRPAY_CLIENT_ID: present('AIRPAY_CLIENT_ID'),
    AIRPAY_SECRET_KEY: present('AIRPAY_SECRET_KEY'),
    AIRPAY_API_KEY: present('AIRPAY_API_KEY'),
    AIRPAY_USERNAME: present('AIRPAY_USERNAME'),
    AIRPAY_PASSWORD: present('AIRPAY_PASSWORD'),
    SUPABASE_URL: present('SUPABASE_URL') || present('VITE_SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE: present('SUPABASE_SERVICE_ROLE'),
    PUBLIC_SITE_ORIGIN: present('PUBLIC_SITE_ORIGIN'),
    CRON_SECRET: present('CRON_SECRET'),
  };

  const ready = Object.values(configured).every(Boolean);
  const offered = checkoutMerchants();

  // Per merchant: whether its credentials are complete, whether checkout
  // offers it, and the return URL its payment requests name — which is the URL
  // that MID's Airpay dashboard must have registered.
  const merchants = Object.fromEntries(
    MERCHANTS.map((merchant) => [
      merchant,
      {
        configured: isMerchantConfigured(merchant),
        offered_at_checkout: offered.includes(merchant),
        callback_url: `${siteOrigin(req)}${callbackPathFor(merchant)}`,
      },
    ]),
  );

  // Non-secret operational facts, useful for confirming the deployment matches
  // the Airpay dashboard registration.
  //
  // The git fields answer "is the code I just pushed actually live?" without
  // needing Vercel dashboard access. Vercel injects these at build time; they
  // are public repository metadata, not secrets. Verifying a deploy by
  // behaviour has repeatedly been guesswork without them.
  const environment = {
    airpay_env: (process.env.AIRPAY_ENV || '').trim() || null,
    site_origin: siteOrigin(req),
    callback_url: `${siteOrigin(req)}${callbackPathFor(1)}`,
    callback_urls_served: CALLBACK_PATHS.map((path) => `${siteOrigin(req)}${path}`),
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').trim().slice(0, 7) || null,
    branch: (process.env.VERCEL_GIT_COMMIT_REF || '').trim() || null,
    vercel_env: (process.env.VERCEL_ENV || '').trim() || null,
  };

  if (!isCronAuthorized(req)) {
    json(res, ready ? 200 : 503, { ok: ready, configured, merchants, environment });
    return;
  }

  // Merchant 2's probe is reported on its own and never decides the status:
  // a fault on the second account must not make the first look down.
  let oauth2;

  if (merchants[2].configured) {
    try {
      const { expiresIn } = await getAccessToken(2);

      oauth2 = { ok: true, expires_in: expiresIn };
    } catch (error) {
      logEvent('payment.health.oauth_failed', { merchant: 2, kind: 'airpay', detail: error?.detail });
      oauth2 = { ok: false, reason: error?.detail || 'authentication failed' };
    }
  }

  const oauthByMerchant = oauth2 ? { oauth_merchant_2: oauth2 } : {};

  try {
    const { expiresIn } = await getAccessToken(1);

    logEvent('payment.health.oauth_ok', { expires_in: expiresIn });
    json(res, 200, {
      ok: true,
      configured,
      merchants,
      environment,
      oauth: { ok: true, expires_in: expiresIn },
      ...oauthByMerchant,
    });
  } catch (error) {
    logEvent('payment.health.oauth_failed', {
      kind: error?.isConfigError ? 'config' : 'airpay',
      detail: error?.detail,
    });

    json(res, 503, {
      ok: false,
      configured,
      merchants,
      environment,
      // A reason, never a credential.
      oauth: { ok: false, reason: error?.detail || 'authentication failed' },
      ...oauthByMerchant,
    });
  }
}
