/**
 * GET /api/payments/options
 *
 * Which online payment options the checkout may offer right now: the Airpay
 * merchant numbers that are both enabled and fully configured on the server,
 * and whether SabPaisa is switched on and configured.
 *
 * Numbers and a boolean only. No MID, credential or endpoint is returned, and
 * the checkout treats a failure here as "Airpay merchant 1 only", which is how
 * it behaved before the second account existed.
 */
import { checkoutMerchants, sabpaisaAvailable } from '../_lib/config.js';
import { frontivaPayinAvailable } from '../_lib/frontiva-payin.js';
import { allowMethods, json } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) {
    return;
  }

  json(res, 200, {
    merchants: checkoutMerchants(),
    sabpaisa: sabpaisaAvailable(),
    // Only named when on, so the response is unchanged while Frontiva PayIn is off.
    ...(frontivaPayinAvailable() ? { frontiva_payin: true } : {}),
  });
}
