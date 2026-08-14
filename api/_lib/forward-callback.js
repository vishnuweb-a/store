/**
 * Auxiliary relay of the Airpay callback to the client's existing endpoint.
 *
 * This is SECONDARY functionality. Frontiva's own Airpay processing —
 * deduplication, integrity checks, Order Confirmation, settlement — is entirely
 * independent of it and is not aware it exists. Nothing here can influence
 * whether an order is settled, and nothing here can fail the callback response.
 *
 * The contract is deliberately narrow: forward the bytes Airpay sent us, once,
 * to one fixed destination, and never throw.
 */
import { fetchWithTimeout, logEvent } from './http.js';

/**
 * The client's existing endpoint. A server-side constant with an optional
 * server-only override; there is deliberately no VITE_ variable, so this URL
 * never reaches the browser bundle.
 */
const DEFAULT_CLIENT_CALLBACK_URL = 'https://kkchat.in/callback/cpm/arp/collection';

export const clientCallbackUrl = () =>
  (process.env.KKCHAT_CALLBACK_URL || DEFAULT_CLIENT_CALLBACK_URL).trim();

/** Bounded so a slow client endpoint cannot hold the Airpay callback open. */
export const FORWARD_TIMEOUT_MS = 4000;

/**
 * Marks our own outbound request, so a delivery that originated from this relay
 * is never relayed again. Guards against a forwarding loop.
 */
export const LOOP_GUARD_HEADER = 'x-frontiva-forwarded';

/**
 * Forwards one received Airpay callback to the client's endpoint.
 *
 * Never rejects and never throws — every outcome is reported as a value, so the
 * caller can await it without any possibility of disturbing settlement.
 *
 * Exactly one attempt is made. There is no retry: Airpay redelivers unacked
 * IPNs on its own schedule, and retrying here would multiply that traffic.
 *
 * @param {Object} params
 * @param {string} params.raw - The original request body, forwarded verbatim
 * @param {string} [params.contentType] - The incoming Content-Type, mirrored
 * @param {string|null} [params.orderRef] - For logging only
 * @param {Record<string, unknown>} [params.incomingHeaders] - To detect a loop
 * @returns {Promise<{forwarded: boolean, status: number|null, reason?: string}>}
 */
export async function forwardCallback({ raw, contentType, orderRef = null, incomingHeaders = {} }) {
  if (incomingHeaders?.[LOOP_GUARD_HEADER]) {
    // This delivery came from our own relay. Do not forward it again.
    logEvent('airpay.callback.forward.skipped', { order_ref: orderRef, reason: 'loop guard' });
    return { forwarded: false, status: null, reason: 'loop guard' };
  }

  const url = clientCallbackUrl();
  const startedAt = Date.now();

  logEvent('airpay.callback.forward.start', { order_ref: orderRef, bytes: String(raw || '').length });

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          // Mirror what Airpay sent, so the client receives the payload in the
          // encoding it already expects. Real Airpay IPNs are form-encoded; a
          // JSON callback is relayed as JSON.
          'Content-Type': contentType || 'application/x-www-form-urlencoded',
          Accept: '*/*',
          'User-Agent': 'Frontiva/1.0 (+https://frontiva.online)',
          [LOOP_GUARD_HEADER]: '1',
        },
        // Verbatim. Not re-encrypted, not re-serialised, no fields added,
        // renamed, dropped or transformed.
        body: String(raw ?? ''),
      },
      FORWARD_TIMEOUT_MS,
    );

    const elapsedMs = Date.now() - startedAt;

    if (response.ok) {
      logEvent('airpay.callback.forward.success', {
        order_ref: orderRef,
        status: response.status,
        elapsed_ms: elapsedMs,
      });

      return { forwarded: true, status: response.status };
    }

    // A non-2xx from the client endpoint is their problem to investigate, not a
    // reason for anything here to fail.
    logEvent('airpay.callback.forward.failure', {
      order_ref: orderRef,
      status: response.status,
      elapsed_ms: elapsedMs,
    });

    return { forwarded: false, status: response.status, reason: 'non-2xx' };
  } catch (error) {
    logEvent('airpay.callback.forward.failure', {
      order_ref: orderRef,
      status: null,
      elapsed_ms: Date.now() - startedAt,
      reason: error?.name === 'AbortError' ? 'timeout' : 'network',
    });

    return {
      forwarded: false,
      status: null,
      reason: error?.name === 'AbortError' ? 'timeout' : 'network',
    };
  }
}
