/**
 * Authoritative, server-side pricing.
 *
 * The browser sends only *what* is being bought (product id, size, quantity).
 * Every price comes from public.products here, so a tampered cart cannot change
 * the amount sent to Airpay.
 *
 * The line shape produced by priceOrder() intentionally matches the one
 * createCodOrder() writes in apps/web/src/api/OrdersApi.js, so the existing
 * confirmation page and admin table render online orders with no changes.
 */
import { MAX_LINES, MAX_LINE_QUANTITY } from './config.js';
import { select } from './supabase.js';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.isValidationError = true;
  }
}

/** Mirror of formatCurrency() in apps/web/src/api/EcommerceApi.js for INR. */
export function formatInr(priceInCents) {
  return `₹${(priceInCents / 100).toFixed(2)}`;
}

const toCents = (amount) => Math.round(Number(amount) * 100);

/**
 * Normalises the cart lines a client posted. Rejects anything malformed before
 * a database round trip happens.
 *
 * @param {unknown} rawItems
 * @returns {Array<{product_id: string, size: string|null, quantity: number}>}
 */
export function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ValidationError('Your cart is empty.');
  }

  if (rawItems.length > MAX_LINES) {
    throw new ValidationError('Too many items in one order.');
  }

  return rawItems.map((item) => {
    const productId = String(item?.product_id ?? '').trim();

    if (!/^\d+$/.test(productId)) {
      throw new ValidationError('Your cart contains an item we could not recognise.');
    }

    const quantity = Number(item?.quantity);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
      throw new ValidationError('Please choose a quantity between 1 and ' + MAX_LINE_QUANTITY + '.');
    }

    const size = item?.size === null || item?.size === undefined ? null : String(item.size).trim() || null;

    return { product_id: productId, size, quantity };
  });
}

/**
 * Reads the authoritative product rows for a set of ids.
 *
 * @param {string[]} ids
 * @returns {Promise<Object[]>}
 */
export function loadProducts(ids) {
  return select(
    'products',
    `select=id,title,sku,price,discount_price,sizes,stock,track_quantity,active,image_url&id=in.(${ids.join(',')})`,
  );
}

/**
 * Validates the requested lines against Supabase and computes the total.
 *
 * @param {Array<{product_id: string, size: string|null, quantity: number}>} items
 * @param {{load?: (ids: string[]) => Promise<Object[]>}} [deps] - Injectable read, for tests
 * @returns {Promise<{items: Object[], totalInCents: number}>}
 */
export async function priceOrder(items, deps = {}) {
  const load = deps.load || loadProducts;
  const ids = [...new Set(items.map((item) => item.product_id))];
  const rows = await load(ids);

  const byId = new Map(rows.map((row) => [String(row.id), row]));

  // Collapse duplicate lines first so per-size stock is checked against the
  // full requested quantity, not each half of a split line.
  const merged = new Map();

  for (const item of items) {
    const key = `${item.product_id}::${item.size ?? ''}`;
    const existing = merged.get(key);

    if (existing) {
      existing.quantity += item.quantity;
    } else {
      merged.set(key, { ...item });
    }
  }

  const priced = [];

  for (const item of merged.values()) {
    const row = byId.get(item.product_id);

    if (!row) {
      throw new ValidationError('One of the items in your cart is no longer available.');
    }

    if (!row.active) {
      throw new ValidationError(`"${row.title}" is no longer available.`);
    }

    if (item.quantity > MAX_LINE_QUANTITY) {
      throw new ValidationError(`You can order at most ${MAX_LINE_QUANTITY} of "${row.title}".`);
    }

    const sizes = Array.isArray(row.sizes)
      ? row.sizes.filter((entry) => entry && entry.size).map((entry) => ({
          size: String(entry.size),
          stock: Number.isFinite(Number(entry.stock)) ? Number(entry.stock) : 0,
        }))
      : [];

    let variantLabel;
    let available;

    if (sizes.length > 0) {
      if (!item.size) {
        throw new ValidationError(`Please choose a size for "${row.title}".`);
      }

      const entry = sizes.find((candidate) => candidate.size === item.size);

      if (!entry) {
        throw new ValidationError(`Size ${item.size} is not available for "${row.title}".`);
      }

      variantLabel = entry.size;
      // Sized products always track stock per size, matching the product page.
      available = entry.stock;
    } else {
      variantLabel = row.sku || row.title;
      available = row.track_quantity ? Number(row.stock) || 0 : Infinity;
    }

    if (item.quantity > available) {
      throw new ValidationError(
        available > 0
          ? `Only ${available} left of "${row.title}"${item.size ? ` (${item.size})` : ''}.`
          : `"${row.title}"${item.size ? ` (${item.size})` : ''} is out of stock.`,
      );
    }

    // Same precedence the storefront uses: discount_price wins when present.
    const listPrice = toCents(row.price);
    const salePrice = row.discount_price === null || row.discount_price === undefined ? null : toCents(row.discount_price);
    const unitPriceInCents = salePrice ?? listPrice;

    if (!Number.isFinite(unitPriceInCents) || unitPriceInCents <= 0) {
      throw new ValidationError(`"${row.title}" is not purchasable right now.`);
    }

    const lineTotalInCents = unitPriceInCents * item.quantity;

    priced.push({
      product_id: String(row.id),
      variant_id: sizes.length > 0 ? `variant_${row.id}_${variantLabel}` : `variant_${row.id}`,
      title: row.title,
      size: variantLabel,
      image: row.image_url || null,
      quantity: item.quantity,
      unit_price_in_cents: unitPriceInCents,
      unit_price_formatted: formatInr(unitPriceInCents),
      line_total_in_cents: lineTotalInCents,
      line_total_formatted: formatInr(lineTotalInCents),
    });
  }

  const totalInCents = priced.reduce((total, line) => total + line.line_total_in_cents, 0);

  if (totalInCents <= 0) {
    throw new ValidationError('Your order total must be greater than zero.');
  }

  return { items: priced, totalInCents };
}

/**
 * Validates the delivery details. Deliberately the same rules the existing
 * checkout form enforces, so an online order can never be weaker than a COD one.
 *
 * @param {Record<string, unknown>} raw
 * @returns {{fullName: string, phone: string, address: string, landmark: string|null}}
 */
export function normalizeCustomer(raw) {
  const fullName = String(raw?.fullName ?? '').trim();
  const phone = String(raw?.phone ?? '').replace(/\D/g, '');
  const address = String(raw?.address ?? '').trim();
  const landmark = String(raw?.landmark ?? '').trim();

  if (fullName.length < 3) {
    throw new ValidationError('Please enter your full name.');
  }

  if (!/^\d{10}$/.test(phone)) {
    throw new ValidationError('Enter a valid 10-digit phone number.');
  }

  if (!address) {
    throw new ValidationError('Delivery address is required.');
  }

  return {
    fullName: fullName.slice(0, 200),
    phone,
    address: address.slice(0, 1000),
    landmark: landmark ? landmark.slice(0, 200) : null,
  };
}

export { ValidationError };
