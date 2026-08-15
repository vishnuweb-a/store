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
 * @param {Record<string, unknown>} params.payload - The received callback fields
 * @param {string} [params.raw] - Original body, used only to report byte length
 * @param {string|null} [params.orderRef] - For logging only
 * @param {Record<string, unknown>} [params.incomingHeaders] - To detect a loop
 * @returns {Promise<{forwarded: boolean, status: number|null, reason?: string}>}
 */
export async function forwardCallback({ payload, raw = '', orderRef = null, incomingHeaders = {} }) {
  if (incomingHeaders?.[LOOP_GUARD_HEADER]) {
    // This delivery came from our own relay. Do not forward it again.
    logEvent('airpay.callback.forward.skipped', { order_ref: orderRef, reason: 'loop guard' });
    return { forwarded: false, status: null, reason: 'loop guard' };
  }

  const url = clientCallbackUrl();
  const bytes = String(raw ?? '').length;
  const startedAt = Date.now();

  // Hostname only — never the full URL with any path or query it might carry.
  let destination;

  try {
    destination = new global.URL(url).hostname;
  } catch {
    destination = 'invalid-url';
  }

  const fieldCount = payload && typeof payload === 'object' ? Object.keys(payload).length : 0;

  logEvent('airpay.callback.forward.start', {
    destination,
    order_ref: orderRef,
    bytes,
    // Field count, never field values.
    fields: fieldCount,
  });

  if (fieldCount === 0 && bytes > 0) {
    // A body arrived but parsed to nothing, so the JSON object would be empty.
    // There is deliberately no fallback to another encoding — the client
    // accepts JSON only — but this must never fail silently, because the
    // client would receive {} and lose the whole callback.
    logEvent('airpay.callback.forward.empty_payload', { destination, order_ref: orderRef, bytes });
  }

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          // JSON only, per the client's integration requirement. Airpay
          // delivers the callback form-encoded, so it is re-encoded here rather
          // than mirrored.
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Frontiva/1.0 (+https://frontiva.online)',
          [LOOP_GUARD_HEADER]: '1',
        },
        // A JSON object, not a string: the same shape as the auth request
        // envelope ({merchant_id, encdata, checksum}), so an enveloped callback
        // arrives as {"merchant_id": "...", "response": "..."}.
        //
        // The fields are Airpay's own, passed through untouched: no key is
        // renamed, no value is re-encrypted or re-typed, nothing is added or
        // dropped. Only the transport encoding changes.
        body: JSON.stringify(payload ?? {}),
      },
      FORWARD_TIMEOUT_MS,
    );

    const elapsedMs = Date.now() - startedAt;

    if (response.ok) {
      logEvent('airpay.callback.forward.success', {
        destination,
        status: response.status,
        bytes,
        elapsed_ms: elapsedMs,
        order_ref: orderRef,
      });

      return { forwarded: true, status: response.status };
    }

    // A non-2xx from the client endpoint is their problem to investigate, not a
    // reason for anything here to fail.
    logEvent('airpay.callback.forward.failure', {
      destination,
      status: response.status,
      bytes,
      elapsed_ms: elapsedMs,
      order_ref: orderRef,
      error: 'non-2xx',
    });

    return { forwarded: false, status: response.status, reason: 'non-2xx' };
  } catch (error) {
    logEvent('airpay.callback.forward.failure', {
      destination,
      status: null,
      bytes,
      elapsed_ms: Date.now() - startedAt,
      order_ref: orderRef,
      error: error?.name === 'AbortError' ? 'timeout' : 'network',
    });

    return {
      forwarded: false,
      status: null,
      reason: error?.name === 'AbortError' ? 'timeout' : 'network',
    };
  }
}
