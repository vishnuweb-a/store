/**
 * GET /api/payments/options
 *
 * Which Airpay payment options the checkout may offer right now: the merchant
 * numbers that are both enabled and fully configured on the server.
 *
 * Numbers only. No MID, credential or endpoint is returned, and the checkout
 * treats a failure here as "merchant 1 only", which is how it behaved before
 * the second account existed.
 */
import { checkoutMerchants } from '../_lib/config.js';
import { allowMethods, json } from '../_lib/http.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) {
    return;
  }

  json(res, 200, { merchants: checkoutMerchants() });
}
