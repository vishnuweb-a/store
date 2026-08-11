import { supabase } from '@/lib/supabase';

// Supabase stores prices as decimal currency; the UI layer works in cents.
const CURRENCY_INFO = {
  code: "INR",
  symbol: "₹",
  template: "₹$1",
  decimal_digits: 2,
};

const toCents = (amount) =>
  amount === null || amount === undefined ? null : Math.round(Number(amount) * 100);

export const formatCurrency = (priceInCents, currencyInfo) => {
  if (!currencyInfo || priceInCents === null || priceInCents === undefined) {
    return "";
  }

  const { code, symbol, template, decimal_digits } = currencyInfo;
  const currencyDisplay = symbol || code || "€";
  const digits = Number.isInteger(decimal_digits) ? decimal_digits : 2;
  const amount = (priceInCents / Math.pow(10, digits)).toFixed(digits);

  if (template) {
    return template.replace("$1", amount);
  }

  return `${currencyDisplay}${amount}`;
};

/**
 * Storefront collections, keyed by the products.category slug. The ids match the
 * /shop?category=<slug> links the home page already renders.
 */
const COLLECTIONS = [
  { id: "mens", title: "Men's Wear" },
  { id: "womens", title: "Women's Wear" },
];

/**
 * Normalized size entry stored in the products.sizes JSON column.
 * @typedef {Object} ProductSize
 * @property {string} size - Size label (e.g. "M", "XL")
 * @property {number} stock - Units available for that size
 */

const extractSizes = (sizes) => {
  if (!Array.isArray(sizes)) {
    return [];
  }

  return sizes
    .filter((entry) => entry && entry.size)
    .map((entry) => ({
      size: String(entry.size),
      stock: Number.isFinite(Number(entry.stock)) ? Number(entry.stock) : 0,
    }));
};

/**
 * Maps a Supabase products row onto the product shape the storefront already
 * renders, so existing pages and components stay untouched.
 *
 * @param {Object} row - Row from public.products
 * @returns {Object} Normalized product
 */
const mapProduct = (row) => {
  const price_in_cents = toCents(row.price) ?? 0;
  const sale_price_in_cents = toCents(row.discount_price);
  const sizes = extractSizes(row.sizes);
  const collection = COLLECTIONS.find((entry) => entry.id === row.category);

  // Sized products track stock per size; unsized ones use the row-level stock.
  const totalSizeStock = sizes.reduce((total, entry) => total + entry.stock, 0);
  const stock = sizes.length > 0 ? totalSizeStock : Number(row.stock) || 0;
  const inStock = !row.track_quantity || stock > 0;

  const variant = {
    id: `variant_${row.id}`,
    title: row.sku || row.title,
    image_url: row.image_url || null,
    sku: row.sku || null,
    price_in_cents,
    sale_price_in_cents,
    currency: CURRENCY_INFO.code,
    currency_info: CURRENCY_INFO,
    price_formatted: formatCurrency(price_in_cents, CURRENCY_INFO),
    sale_price_formatted: formatCurrency(sale_price_in_cents, CURRENCY_INFO),
    manage_inventory: Boolean(row.track_quantity),
    weight: row.weight ?? null,
    options: [],
    inventory_quantity: stock,
  };

  return {
    id: String(row.id),
    title: row.title,
    subtitle: row.subtitle,
    ribbon_text: row.ribbon,
    description: row.description || "",
    image: row.image_url || null,
    price_in_cents: sale_price_in_cents ?? price_in_cents,
    currency: CURRENCY_INFO.code,
    purchasable: Boolean(row.active) && inStock,
    order: 0,
    site_product_selection: null,
    sizes,
    images: [{ url: row.image_url || "", order: 0, type: "image" }],
    options: [],
    variants: [variant],
    collections: collection
      ? [{ collection_id: collection.id, title: collection.title }]
      : [],
    additional_info: [],
    type: { value: "" },
    custom_fields: [],
    related_products: [],
    updated_at: row.created_at,
    created_at: row.created_at,
  };
};

/**
 * Lists active products from Supabase.
 *
 * @param {Object} [params]
 * @param {string|number} [params.limit] - Maximum products to return
 * @param {string} [params.order] - "ASC" or "DESC" (default DESC by created_at)
 * @param {string} [params.sort_by] - Column to sort by (default created_at)
 * @returns {Promise<{count: number, offset: number, limit: number, products: Object[]}>}
 */
export async function getProducts({ limit, offset, order, sort_by } = {}) {
  let query = supabase
    .from("products")
    .select("*", { count: "exact" })
    .eq("active", true)
    .order(sort_by || "created_at", { ascending: String(order).toUpperCase() === "ASC" });

  if (limit) {
    const start = Number(offset) || 0;
    query = query.range(start, start + Number(limit) - 1);
  }

  const { data, error, count } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return {
    count: count ?? (data || []).length,
    offset: Number(offset) || 0,
    limit: Number(limit) || (data || []).length,
    products: (data || []).map(mapProduct),
  };
}

/**
 * Retrieves a single product by id.
 *
 * @param {string} id - products.id
 * @returns {Promise<Object>} Normalized product
 */
export async function getProduct(id) {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Product not found");
  }

  return mapProduct(data);
}

/**
 * Reads current stock for the given products so the storefront can gate
 * add-to-cart on live inventory.
 *
 * @param {Object} params
 * @param {string[]} params.product_ids - products.id values
 * @returns {Promise<{variants: Array<{id: string, inventory_quantity: number}>}>}
 */
export async function getProductQuantities({ product_ids }) {
  if (!product_ids || product_ids.length === 0) {
    return { variants: [] };
  }

  const { data, error } = await supabase
    .from("products")
    .select("id, stock, sizes, track_quantity")
    .in("id", product_ids);

  if (error) {
    throw new Error(error.message);
  }

  return {
    variants: (data || []).map((row) => {
      const sizes = extractSizes(row.sizes);
      const stock =
        sizes.length > 0
          ? sizes.reduce((total, entry) => total + entry.stock, 0)
          : Number(row.stock) || 0;

      return { id: `variant_${row.id}`, inventory_quantity: stock };
    }),
  };
}

/**
 * Lists the collections that actually have active products behind them, so the
 * shop page never renders a filter that would come back empty. The shop page
 * falls back to showing every product when this list is empty.
 *
 * @returns {Promise<{categories: Object[], count: number}>}
 */
export async function getCategories() {
  const { data, error } = await supabase
    .from("products")
    .select("category")
    .eq("active", true)
    .not("category", "is", null);

  if (error) {
    throw new Error(error.message);
  }

  const present = new Set((data || []).map((row) => row.category));
  const categories = COLLECTIONS.filter((collection) => present.has(collection.id));

  return { categories, count: categories.length };
}
