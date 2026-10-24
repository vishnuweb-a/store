import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/api/EcommerceApi';

const ORDERS_STORAGE_KEY = 'e-commerce-orders';
const MAX_STORED_ORDERS = 20;

/**
 * Creates a Cash on Delivery order in Supabase from the current cart.
 * The order is also cached locally so the confirmation page survives a reload.
 *
 * @param {Object} params
 * @param {{fullName: string, phone: string, address: string, landmark: string}} params.customer
 * @param {Array} params.cartItems - Items from the cart context
 * @returns {Promise<Object>} The created order
 */
export async function createCodOrder({ customer, cartItems }) {
  if (!cartItems || cartItems.length === 0) {
    throw new Error('Cannot place an order with an empty cart.');
  }

  const currencyInfo = cartItems[0].variant.currency_info;

  const items = cartItems.map((item) => {
    const unitPriceInCents = item.variant.sale_price_in_cents ?? item.variant.price_in_cents;
    const lineTotalInCents = unitPriceInCents * item.quantity;

    return {
      product_id: item.product.id,
      variant_id: item.variant.id,
      title: item.product.title,
      // Sized products cart each size as its own variant, so variant.title is
      // the size. Unsized products carry no size, and must not fall back to
      // variant.title there -- that is the SKU, which would read as a size on
      // the confirmation page and in the admin table.
      size: item.product.sizes?.length > 0 ? item.variant.title : null,
      image: item.product.image,
      quantity: item.quantity,
      unit_price_in_cents: unitPriceInCents,
      unit_price_formatted: formatCurrency(unitPriceInCents, currencyInfo),
      line_total_in_cents: lineTotalInCents,
      line_total_formatted: formatCurrency(lineTotalInCents, currencyInfo),
    };
  });

  const totalInCents = items.reduce((total, item) => total + item.line_total_in_cents, 0);

  const { data, error } = await supabase
    .from('orders')
    .insert({
      customer_name: customer.fullName.trim(),
      phone: customer.phone.trim(),
      address: customer.address.trim(),
      landmark: customer.landmark.trim() || null,
      payment_method: 'Cash on Delivery',
      status: 'processing',
      total: totalInCents / 100,
      items,
    })
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  const order = {
    id: data.id,
    order_number: `FRV-${String(data.id).padStart(5, '0')}`,
    created_at: data.created_at,
    status: data.status,
    payment_method: data.payment_method,
    customer: {
      full_name: data.customer_name,
      phone: data.phone,
      address: data.address,
      landmark: data.landmark || '',
    },
    items,
    total_in_cents: totalInCents,
    total_formatted: formatCurrency(totalInCents, currencyInfo),
  };

  saveOrder(order);

  return order;
}

/** The online payment gateways a customer can be offered, by number. */
export const PAYMENT_GATEWAYS = [1, 2, 3];

/** The id the SabPaisa option is known by in the gateway list. */
export const SABPAISA_GATEWAY = 'sabpaisa';

/**
 * Asks the server which online payment gateways are available right now.
 *
 * The answer is the Airpay gateway numbers, followed by 'sabpaisa' when the
 * server offers SabPaisa. If it cannot be read, gateway 1 alone is assumed —
 * the single online option the checkout has always had — so a failure here
 * never takes online payment away. SabPaisa is only ever added on an explicit
 * `sabpaisa: true`.
 *
 * @returns {Promise<Array<number|'sabpaisa'>>}
 */
export async function getPaymentGateways() {
  try {
    const response = await fetch('/api/payments/options');
    const payload = await response.json();
    const gateways = PAYMENT_GATEWAYS.filter((gateway) => payload?.merchants?.includes(gateway));
    const airpay = response.ok && gateways.length > 0 ? gateways : [1];

    return response.ok && payload?.sabpaisa === true ? [...airpay, SABPAISA_GATEWAY] : airpay;
  } catch (error) {
    return [1];
  }
}

/**
 * Starts an online (Airpay) payment for the current cart.
 *
 * Only *what* is being bought is sent — ids, sizes and quantities — plus which
 * gateway the customer chose, as a number. The server prices the order from
 * Supabase and creates the pending order, so nothing the browser says about
 * money is trusted. The response is an already-encrypted form payload;
 * submitPayment() below hands it to Airpay.
 *
 * @param {Object} params
 * @param {{fullName: string, phone: string, address: string, landmark: string}} params.customer
 * @param {Array} params.cartItems - Items from the cart context
 * @param {number} [params.merchant] - Chosen gateway, 1, 2 or 3
 * @returns {Promise<{order_ref: string, action: string, fields: Record<string, string>}>}
 */
export async function createOnlinePayment({ customer, cartItems, merchant = 1 }) {
  if (!cartItems || cartItems.length === 0) {
    throw new Error('Cannot place an order with an empty cart.');
  }

  if (!PAYMENT_GATEWAYS.includes(merchant)) {
    throw new Error('Please choose a payment gateway.');
  }

  const items = cartItems.map((item) => ({
    product_id: item.product.id,
    // Sized products cart each size as its own variant, so variant.title is the
    // size. Unsized products have no size to send.
    size: item.product.sizes?.length > 0 ? item.variant.title : null,
    quantity: item.quantity,
  }));

  const response = await fetch('/api/payments/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer, items, merchant }),
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('We could not start the online payment. Please try again.');
  }

  if (!response.ok) {
    const error = new Error(payload?.error || 'We could not start the online payment. Please try again.');

    // Positions of cart lines the server could not recognise, so the checkout
    // can name them and offer to remove them.
    if (Array.isArray(payload?.invalid_items)) {
      error.invalidItems = payload.invalid_items
        .map((index) => cartItems[index])
        .filter(Boolean);
    }

    throw error;
  }

  return payload;
}

/**
 * Hands the customer to Airpay's hosted payment page by POSTing the encrypted
 * fields the server produced. A form POST rather than a redirect because the
 * payload is larger than a URL should carry.
 *
 * @param {{action: string, fields: Record<string, string>}} payment
 */
export function submitPayment(payment) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = payment.action;
  form.style.display = 'none';

  Object.entries(payment.fields || {}).forEach(([name, value]) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });

  document.body.appendChild(form);
  form.submit();
}

/**
 * Starts a SabPaisa payment for the current cart. Same request shape as
 * createOnlinePayment() minus the merchant: the server prices the order,
 * creates the pending order and the SabPaisa session, and answers with the
 * hosted-checkout URL to send the customer to.
 *
 * @param {Object} params
 * @param {{fullName: string, phone: string, address: string, landmark: string}} params.customer
 * @param {Array} params.cartItems - Items from the cart context
 * @returns {Promise<{order_ref: string, redirect_url: string}>}
 */
export async function createSabpaisaPayment({ customer, cartItems }) {
  if (!cartItems || cartItems.length === 0) {
    throw new Error('Cannot place an order with an empty cart.');
  }

  const items = cartItems.map((item) => ({
    product_id: item.product.id,
    size: item.product.sizes?.length > 0 ? item.variant.title : null,
    quantity: item.quantity,
  }));

  const response = await fetch('/api/payments/sabpaisa/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer, items }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload) {
    const error = new Error(payload?.error || 'We could not start the SabPaisa payment. Please try again.');

    if (Array.isArray(payload?.invalid_items)) {
      error.invalidItems = payload.invalid_items.map((index) => cartItems[index]).filter(Boolean);
    }

    throw error;
  }

  if (!isSabpaisaCheckoutUrl(payload.redirect_url)) {
    throw new Error('We could not start the SabPaisa payment. Please choose another payment option.');
  }

  return payload;
}

/**
 * Whether a URL is an HTTPS SabPaisa page. The server has already checked the
 * provider's answer; this keeps the browser from following anything else.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isSabpaisaCheckoutUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return url.protocol === 'https:' && (host === 'sabpaisa.in' || host.endsWith('.sabpaisa.in'));
  } catch (error) {
    return false;
  }
}

/**
 * Sends the customer to SabPaisa's hosted checkout. A plain navigation: the
 * URL already carries the session's clientSecret, which SabPaisa requires, so
 * it is never logged or stored here.
 *
 * @param {{redirect_url: string}} payment
 */
export function redirectToSabpaisa(payment) {
  window.location.assign(payment.redirect_url);
}

/**
 * Reads the status of an online order after Airpay returns the customer.
 * The status comes from the server, which verifies it with Airpay directly —
 * never from the redirect's query string.
 *
 * @param {string} orderRef
 * @returns {Promise<Object>} The order, shaped like createCodOrder's result
 */
export async function getOnlineOrder(orderRef) {
  const response = await fetch(`/api/payments/status?ref=${encodeURIComponent(orderRef)}`);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error || 'We could not load your order.');
  }

  return payload.order;
}

function saveOrder(order) {
  try {
    const orders = getOrders();
    orders.unshift(order);
    localStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(orders.slice(0, MAX_STORED_ORDERS)));
  } catch (error) {
    // Storage unavailable (private mode / quota) — the confirmation page still
    // receives the order via navigation state.
  }
}

export function getOrders() {
  try {
    const stored = localStorage.getItem(ORDERS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    return [];
  }
}

export function getLatestOrder() {
  return getOrders()[0] || null;
}

/**
 * Lists all orders for the admin panel.
 *
 * @returns {Promise<Object[]>} Rows from public.orders, newest first
 */
export async function listOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}
