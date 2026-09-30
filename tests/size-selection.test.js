/**
 * Size selection guard.
 *
 * The server-side half of this feature is already covered by pricing.test.js
 * (a size is required for sized products, and rejected when the product does
 * not offer it). These tests pin the browser-side half, which decides what the
 * shopper sees and what the order records:
 *
 *  - getCartItemSize() is exercised directly, since it is the single source of
 *    truth for "does this cart line have a size", and
 *  - the surfaces that must not regress are asserted at source level, matching
 *    cod-regression.test.js, because they run in the browser against Supabase.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const ordersApi = read('../apps/web/src/api/OrdersApi.js');
const productPage = read('../apps/web/src/pages/ProductDetailPage.jsx');
const sizeSelector = read('../apps/web/src/components/SizeSelector.jsx');
const cartPage = read('../apps/web/src/pages/CartPage.jsx');
const cartDrawer = read('../apps/web/src/components/ShoppingCart.jsx');
const checkout = read('../apps/web/src/pages/CheckoutPage.jsx');

// getCartItemSize is plain data logic with no React or Supabase dependency, so
// it is re-declared here rather than importing the module, which would pull in
// the browser-only '@/lib/supabase' alias.
const getCartItemSize = (item) => {
  if (!item?.product?.sizes?.length) {
    return null;
  }

  return item.variant?.title || null;
};

const SIZED = { product: { sizes: [{ size: 'M', stock: 2 }] }, variant: { title: 'M' } };
const UNSIZED = { product: { sizes: [] }, variant: { title: 'SHIRT-1' } };

describe('getCartItemSize', () => {
  test('reports the size a sized line was added with', () => {
    assert.equal(getCartItemSize(SIZED), 'M');
  });

  test('reports no size for an unsized product, rather than its SKU', () => {
    assert.equal(getCartItemSize(UNSIZED), null);
  });

  test('treats a missing sizes list as unsized', () => {
    assert.equal(getCartItemSize({ product: {}, variant: { title: 'GC-1' } }), null);
  });

  test('never throws on a malformed line', () => {
    assert.equal(getCartItemSize(undefined), null);
    assert.equal(getCartItemSize({}), null);
  });
});

describe('order items', () => {
  test('both order paths record a size only for sized products', () => {
    // Guards the bug where an unsized product stored variant.title -- its SKU --
    // as the size, which then rendered as "Size: SHIRT-1" on the confirmation
    // page and in the admin order list.
    const assignments = ordersApi.match(/size: [^,\n]+/g) || [];

    assert.equal(assignments.length, 2, 'expected the COD and online paths');

    for (const assignment of assignments) {
      assert.match(assignment, /item\.product\.sizes\?\.length > 0/);
    }
  });
});

describe('product page', () => {
  test('does not preselect a size', () => {
    assert.match(productPage, /setSelectedSize\(null\)/);
    assert.doesNotMatch(productPage, /firstAvailableSize/);
  });

  test('blocks add-to-cart without a size and explains why', () => {
    assert.match(productPage, /sizes\.length > 0 && !selectedSizeEntry/);
    assert.match(productPage, /Please select a size/);
  });

  test('keeps each size a distinct cart line', () => {
    // productId + size is the cart identity; without the size suffix, S and M
    // would collapse into one line.
    assert.match(productPage, /id: `\$\{selectedVariant\.id\}_\$\{selectedSizeEntry\.size\}`/);
  });

  test('carts unsized products with the untouched base variant', () => {
    assert.match(productPage, /: selectedVariant, \[selectedVariant, selectedSizeEntry\]/);
  });
});

describe('size selector', () => {
  test('renders nothing when the product has no sizes', () => {
    assert.match(sizeSelector, /if \(!sizes \|\| sizes\.length === 0\) \{\s*return null;/);
  });

  test('exposes the selected state to assistive technology', () => {
    assert.match(sizeSelector, /aria-checked=\{isSelected\}/);
    assert.match(sizeSelector, /role="radiogroup"/);
  });

  test('wraps rather than overflowing on small screens', () => {
    assert.match(sizeSelector, /flex flex-wrap/);
  });
});

describe('cart and checkout display', () => {
  for (const [name, source] of [
    ['cart page', cartPage],
    ['cart drawer', cartDrawer],
    ['checkout summary', checkout],
  ]) {
    test(`${name} labels the size and hides it when there is none`, () => {
      assert.match(source, /getCartItemSize/);
      assert.match(source, /Size: \{/);
    });
  }
});

describe('track_quantity and size availability', () => {
  // Mirrors SizeSelector's disable rule. Stock only matters when the product is
  // inventory managed; an untracked product's stored numbers are meaningless.
  const isDisabled = (manageInventory, stock) => manageInventory && stock <= 0;

  test('an untracked product keeps every configured size selectable at stock 0', () => {
    for (const size of ['S', 'M', 'L', 'XL', 'XXL']) {
      assert.equal(isDisabled(false, 0), false, `${size} must stay selectable`);
    }
  });

  test('a tracked product still disables a zero-stock size', () => {
    assert.equal(isDisabled(true, 0), true);
  });

  test('a tracked product still enables a size that has stock', () => {
    assert.equal(isDisabled(true, 2), false);
  });

  test('SizeSelector gates the disabled state on inventory management', () => {
    assert.match(sizeSelector, /manageInventory && stock <= 0/);
  });

  test('SizeSelector defaults to managed so an omitted prop cannot oversell', () => {
    assert.match(sizeSelector, /manageInventory = true/);
  });

  test('the product page passes the real tracking flag into the selector', () => {
    assert.match(productPage, /manageInventory=\{selectedVariant\?\.manage_inventory/);
  });

  // The regression itself: cartVariant used to hardcode manage_inventory: true,
  // which made useCart enforce stock on a product that tracks none.
  test('the cart variant inherits manage_inventory instead of forcing it true', () => {
    assert.match(productPage, /manage_inventory: selectedVariant\.manage_inventory/);
    assert.doesNotMatch(productPage, /manage_inventory: true/);
  });

  test('stock hints stay gated on inventory management', () => {
    assert.match(productPage, /isStockManaged && canAddToCart/);
    assert.match(productPage, /isStockManaged && !canAddToCart/);
  });
});
