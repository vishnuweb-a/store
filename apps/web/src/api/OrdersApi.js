import { formatCurrency, getProductQuantities } from '@/api/EcommerceApi';

const ORDERS_STORAGE_KEY = 'e-commerce-orders';
const MAX_STORED_ORDERS = 20;

// Optional backend endpoint for order submission (e.g. a serverless function
// or store management webhook). Configured via environment, never hardcoded.
const ORDERS_ENDPOINT = import.meta.env.VITE_ORDERS_ENDPOINT || '';

const generateOrderNumber = () => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FRV-${timestamp}${random}`;
};

/**
 * Re-checks live inventory via the Hostinger Ecommerce API for every cart
 * variant that manages stock, so a COD order can't be confirmed for items
 * that sold out after they were added to the cart.
 *
 * @param {Array} cartItems - Items from the cart context
 * @throws {Error} When any managed-stock variant has insufficient inventory
 */
export async function verifyStock(cartItems) {
  const managedItems = cartItems.filter((item) => item.variant.manage_inventory);

  if (managedItems.length === 0) {
    return;
  }

  const productIds = [...new Set(managedItems.map((item) => item.product.id))];

  let variants;
  try {
    ({ variants } = await getProductQuantities({
      fields: 'inventory_quantity',
      product_ids: productIds,
    }));
  } catch (error) {
    // Inventory read failed — don't block the order on a transient API error;
    // stock is reconciled by the store owner when fulfilling COD orders.
    return;
  }

  const quantityByVariantId = new Map(
    (variants || []).map((variant) => [variant.id, variant.inventory_quantity]),
  );

  const outOfStock = managedItems.filter((item) => {
    const available = quantityByVariantId.get(item.variant.id);
    return Number.isFinite(available) && item.quantity > available;
  });

  if (outOfStock.length > 0) {
    const titles = outOfStock.map((item) => item.product.title).join(', ');
    throw new Error(`Not enough stock for: ${titles}. Please adjust your cart.`);
  }
}

/**
 * Creates a Cash on Delivery order from the current cart.
 *
 * The order is persisted locally (order history for the confirmation page)
 * and, when VITE_ORDERS_ENDPOINT is configured, submitted to the store
 * backend so it appears in order management.
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

  await verifyStock(cartItems);

  const currencyInfo = cartItems[0].variant.currency_info;

  const items = cartItems.map((item) => {
    const unitPriceInCents = item.variant.sale_price_in_cents ?? item.variant.price_in_cents;
    const lineTotalInCents = unitPriceInCents * item.quantity;

    return {
      product_id: item.product.id,
      variant_id: item.variant.id,
      title: item.product.title,
      variant_title: item.variant.title,
      image: item.product.image,
      quantity: item.quantity,
      unit_price_in_cents: unitPriceInCents,
      unit_price_formatted: formatCurrency(unitPriceInCents, currencyInfo),
      line_total_in_cents: lineTotalInCents,
      line_total_formatted: formatCurrency(lineTotalInCents, currencyInfo),
    };
  });

  const totalInCents = items.reduce((total, item) => total + item.line_total_in_cents, 0);

  const order = {
    order_number: generateOrderNumber(),
    created_at: new Date().toISOString(),
    status: 'processing',
    payment_method: 'Cash on Delivery',
    customer: {
      full_name: customer.fullName.trim(),
      phone: customer.phone.trim(),
      address: customer.address.trim(),
      landmark: customer.landmark.trim(),
    },
    items,
    total_in_cents: totalInCents,
    total_formatted: formatCurrency(totalInCents, currencyInfo),
  };

  if (ORDERS_ENDPOINT) {
    const response = await fetch(ORDERS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(order),
    });

    if (!response.ok) {
      throw new Error(`Order submission failed: HTTP ${response.status}`);
    }
  }

  saveOrder(order);

  return order;
}

function saveOrder(order) {
  try {
    const orders = getOrders();
    orders.unshift(order);
    localStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(orders.slice(0, MAX_STORED_ORDERS)));
  } catch (error) {
    // Storage unavailable (private mode / quota) — the confirmation page
    // still receives the order via navigation state.
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
