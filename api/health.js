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
 * Readiness is decided by merchant 1 and the shared settings alone. Merchants 2
 * and 3 are reported alongside, but an unconfigured one is not a fault.
 */
import { getAccessToken } from './_lib/airpay.js';
import {
  CALLBACK_PATHS,
  MERCHANTS,
  SABPAISA_BASE_URL,
  callbackPathFor,
  checkoutMerchants,
  isMerchantConfigured,
  isSabpaisaConfigured,
  sabpaisaAvailable,
  sabpaisaBaseUrlOverridden,
  sabpaisaEnabled,
  sabpaisaEnvNames,
  sabpaisaReturnOrigin,
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

  // SabPaisa readiness, reported alongside and never part of `ok`: SabPaisa
  // being off or unconfigured is not an outage. Booleans and variable NAMES
  // only — no value, and no live call to SabPaisa (an enquiry would spend a
  // payment's poll budget).
  const sabpaisa = {
    configured: isSabpaisaConfigured(),
    enabled: sabpaisaEnabled(),
    offered_at_checkout: sabpaisaAvailable(),
    production: true,
    api_base_url: SABPAISA_BASE_URL,
    base_url_override_ignored: sabpaisaBaseUrlOverridden(),
    return_url: `${sabpaisaReturnOrigin()}/success?ref=<order_ref>`,
    env_names: sabpaisaEnvNames(),
  };

  if (!isCronAuthorized(req)) {
    json(res, ready ? 200 : 503, { ok: ready, configured, merchants, environment, sabpaisa });
    return;
  }

  // Each additional merchant's probe is reported on its own, as
  // oauth_merchant_<n>, and never decides the status: a fault on one account
  // must not make another look down.
  const probes = await Promise.all(
    MERCHANTS.filter((merchant) => merchant !== 1 && merchants[merchant].configured).map(async (merchant) => {
      try {
        const { expiresIn } = await getAccessToken(merchant);

        return [`oauth_merchant_${merchant}`, { ok: true, expires_in: expiresIn }];
      } catch (error) {
        logEvent('payment.health.oauth_failed', { merchant, kind: 'airpay', detail: error?.detail });
        return [`oauth_merchant_${merchant}`, { ok: false, reason: error?.detail || 'authentication failed' }];
      }
    }),
  );

  const oauthByMerchant = Object.fromEntries(probes);

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
      sabpaisa,
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
      sabpaisa,
    });
  }
}
