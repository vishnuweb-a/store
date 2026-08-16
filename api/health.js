/**
 * GET /api/health
 *
 * Configuration health check. Reports only whether each required server-side
 * variable is PRESENT — never a value, and never a partial value.
 *
 * With `Authorization: Bearer $CRON_SECRET` it additionally performs a live
 * Airpay OAuth2 round trip, which verifies the credentials, key derivation,
 * encryption and checksum without creating a transaction or moving any money.
 */
import { getAccessToken } from './_lib/airpay.js';
import { CALLBACK_PATH, siteOrigin } from './_lib/config.js';
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
    callback_url: `${siteOrigin(req)}${CALLBACK_PATH}`,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').trim().slice(0, 7) || null,
    branch: (process.env.VERCEL_GIT_COMMIT_REF || '').trim() || null,
    vercel_env: (process.env.VERCEL_ENV || '').trim() || null,
  };

  if (!isCronAuthorized(req)) {
    json(res, ready ? 200 : 503, { ok: ready, configured, environment });
    return;
  }

  try {
    const { expiresIn } = await getAccessToken();

    logEvent('payment.health.oauth_ok', { expires_in: expiresIn });
    json(res, 200, { ok: true, configured, environment, oauth: { ok: true, expires_in: expiresIn } });
  } catch (error) {
    logEvent('payment.health.oauth_failed', {
      kind: error?.isConfigError ? 'config' : 'airpay',
      detail: error?.detail,
    });

    json(res, 503, {
      ok: false,
      configured,
      environment,
      // A reason, never a credential.
      oauth: { ok: false, reason: error?.detail || 'authentication failed' },
    });
  }
}
