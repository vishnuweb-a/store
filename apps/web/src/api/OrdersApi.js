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
      // Sized items cart their size as the variant title.
      size: item.variant.title,
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

/**
 * Starts an online (Airpay) payment for the current cart.
 *
 * Only *what* is being bought is sent — ids, sizes and quantities. The server
 * prices the order from Supabase and creates the pending order, so nothing the
 * browser says about money is trusted. The response is an already-encrypted
 * form payload; submitPayment() below hands it to Airpay.
 *
 * @param {Object} params
 * @param {{fullName: string, phone: string, address: string, landmark: string}} params.customer
 * @param {Array} params.cartItems - Items from the cart context
 * @returns {Promise<{order_ref: string, action: string, fields: Record<string, string>}>}
 */
export async function createOnlinePayment({ customer, cartItems }) {
  if (!cartItems || cartItems.length === 0) {
    throw new Error('Cannot place an order with an empty cart.');
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
    body: JSON.stringify({ customer, items }),
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('We could not start the online payment. Please try again.');
  }

  if (!response.ok) {
    throw new Error(payload?.error || 'We could not start the online payment. Please try again.');
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
