/**
 * Cash on Delivery regression guard.
 *
 * COD is the pre-existing, production flow; this feature is only allowed to sit
 * alongside it. These are source-level assertions rather than behavioural ones
 * because the COD path runs entirely in the browser against Supabase — but they
 * do pin the exact properties that would break it: the request it writes, the
 * fact that it never touches the payment server, and the checkout defaulting to
 * COD with an unchanged call signature.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const ordersApi = read('../apps/web/src/api/OrdersApi.js');
const checkout = read('../apps/web/src/pages/CheckoutPage.jsx');
const successPage = read('../apps/web/src/pages/SuccessPage.jsx');

/** Extracts one exported function's source by brace matching. */
function extractFunction(source, name) {
  const start = source.indexOf(`export async function ${name}(`);

  assert.notEqual(start, -1, `${name} not found`);

  // Skip past the parameter list — these functions destructure their argument,
  // so the first `{` after the name belongs to the parameters, not the body.
  let depth = 0;
  let index = source.indexOf(') {', start) + 2;
  const bodyStart = index;

  while (index < source.length) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }

  return source.slice(bodyStart, index + 1);
}

describe('createCodOrder is unchanged', () => {
  const cod = extractFunction(ordersApi, 'createCodOrder');

  test('still writes directly to Supabase from the browser', () => {
    assert.match(cod, /supabase\s*\n?\s*\.from\('orders'\)/);
    assert.match(cod, /\.insert\(\{/);
    assert.match(cod, /\.select\(\)\s*\n?\s*\.single\(\)/);
  });

  test('still writes the same payment_method and status', () => {
    assert.match(cod, /payment_method: 'Cash on Delivery'/);
    assert.match(cod, /status: 'processing'/);
  });

  test('still computes the total from the cart in cents', () => {
    assert.match(cod, /total: totalInCents \/ 100/);
    assert.match(cod, /item\.variant\.sale_price_in_cents \?\? item\.variant\.price_in_cents/);
  });

  test('still caches the order locally for the confirmation page', () => {
    assert.match(cod, /saveOrder\(order\)/);
    assert.match(cod, /order_number: `FRV-\$\{String\(data\.id\)\.padStart\(5, '0'\)\}`/);
  });

  test('does not call the payment server', () => {
    assert.ok(!cod.includes('fetch('), 'COD must not make an HTTP request');
    assert.ok(!cod.includes('/api/payments'), 'COD must not touch the payment API');
    assert.ok(!/airpay/i.test(cod), 'COD must not reference Airpay');
  });

  test('is not reachable from the online payment helper', () => {
    const online = extractFunction(ordersApi, 'createOnlinePayment');

    assert.ok(!online.includes('createCodOrder'));
    assert.ok(!online.includes("from('orders')"), 'the browser must not create online orders');
  });

  test('the online helper sends no prices to the server', () => {
    const online = extractFunction(ordersApi, 'createOnlinePayment');
    const itemsBlock = online.slice(online.indexOf('const items ='), online.indexOf('const response'));

    for (const field of ['price', 'amount', 'total']) {
      assert.ok(!itemsBlock.includes(field), `online request must not send ${field}`);
    }
  });
});

describe('checkout still defaults to COD', () => {
  test('COD is the initial payment method', () => {
    assert.match(checkout, /useState\('cod'\)/);
  });

  test('the COD branch still calls createCodOrder with the same arguments', () => {
    assert.match(checkout, /await createCodOrder\(\{ customer: customerInfo, cartItems \}\)/);
  });

  test('the COD branch still clears the cart and navigates to /success with the order', () => {
    assert.match(checkout, /clearCart\(\);\s*\n\s*navigate\('\/success', \{ state: \{ order \}, replace: true \}\)/);
  });

  test('the online branch does not run for COD', () => {
    const onlineBranch = checkout.slice(checkout.indexOf("if (paymentMethod === 'online')"));

    assert.match(onlineBranch, /^if \(paymentMethod === 'online'\) \{/);
    assert.match(onlineBranch.slice(0, onlineBranch.indexOf('return;')), /createOnlinePayment/);
  });

  test('validation rules are unchanged', () => {
    assert.match(checkout, /!\/\^\\d\{10\}\$\/\.test\(customerInfo\.phone\)/);
    assert.match(checkout, /Name must be at least 3 characters\./);
    assert.match(checkout, /Delivery address is required\./);
  });
});

describe('confirmation page still handles COD as before', () => {
  test('a COD order is still read from navigation state or local storage', () => {
    assert.match(successPage, /location\.state\?\.order \|\| getLatestOrder\(\)/);
  });

  test('COD still clears the cart on arrival', () => {
    // The early return is scoped to an online payment; COD falls through to
    // clearCart() exactly as it did before.
    assert.match(successPage, /if \(paymentRef && paymentStatus !== 'paid'\) \{\s*\n\s*return;/);
  });

  test('the online status view is only used when Airpay returned the customer', () => {
    assert.match(successPage, /const paymentRef = searchParams\.get\('ref'\)/);
    assert.match(successPage, /paymentRef\s*\n?\s*\? ONLINE_STATUS_VIEWS/);
  });
});

describe('no secret reaches the browser bundle', () => {
  const webSources = [ordersApi, checkout, successPage].join('\n');

  test('no AIRPAY_* variable is referenced in client code', () => {
    assert.ok(!/AIRPAY_/.test(webSources));
  });

  test('no VITE_AIRPAY_* variable exists anywhere in client code', () => {
    assert.ok(!/VITE_AIRPAY/.test(webSources));
  });

  test('the client only ever talks to our own same-origin API', () => {
    const urls = [...webSources.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map((match) => match[1]);

    for (const url of urls) {
      assert.ok(url.startsWith('/api/'), `client fetched a non-API URL: ${url}`);
    }
  });
});
