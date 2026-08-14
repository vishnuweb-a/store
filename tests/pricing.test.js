/**
 * Server-side pricing: the browser is never trusted for the amount.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { formatInr, normalizeCustomer, normalizeItems, priceOrder } from '../api/_lib/pricing.js';

const SHIRT = {
  id: 1,
  title: 'Checked Casual Shirt',
  sku: 'SHIRT-1',
  price: 1500,
  discount_price: null,
  sizes: [
    { size: 'M', stock: 5 },
    { size: 'L', stock: 0 },
  ],
  stock: 0,
  track_quantity: true,
  active: true,
  image_url: 'https://res.cloudinary.com/demo/image/upload/shirt.jpg',
};

const UNSIZED = {
  id: 2,
  title: 'Gift Card',
  sku: 'GC-1',
  price: 500,
  discount_price: 400,
  sizes: [],
  stock: 3,
  track_quantity: true,
  active: true,
  image_url: null,
};

const load = (rows) => async (ids) => rows.filter((row) => ids.includes(String(row.id)));

const CUSTOMER = {
  fullName: 'Asha Menon',
  phone: '9876543210',
  address: '12 MG Road, Kochi, Kerala 682016',
  landmark: '',
};

describe('normalizeItems', () => {
  test('accepts a well-formed line', () => {
    assert.deepEqual(normalizeItems([{ product_id: '1', size: 'M', quantity: 2 }]), [
      { product_id: '1', size: 'M', quantity: 2 },
    ]);
  });

  test('rejects an empty cart', () => {
    assert.throws(() => normalizeItems([]), /cart is empty/);
  });

  test('rejects a non-numeric product id', () => {
    assert.throws(() => normalizeItems([{ product_id: '1; drop table', quantity: 1 }]), /could not recognise/);
  });

  test('rejects a zero, negative or fractional quantity', () => {
    for (const quantity of [0, -1, 1.5, '2x']) {
      assert.throws(() => normalizeItems([{ product_id: '1', quantity }]), /quantity/);
    }
  });

  test('ignores any price the client sends', () => {
    const [line] = normalizeItems([{ product_id: '1', size: 'M', quantity: 1, price: 1, amount: 1 }]);

    assert.deepEqual(Object.keys(line).sort(), ['product_id', 'quantity', 'size']);
  });
});

describe('priceOrder', () => {
  test('uses the Supabase price, not anything from the browser', async () => {
    const { totalInCents, items } = await priceOrder([{ product_id: '1', size: 'M', quantity: 1 }], {
      load: load([SHIRT]),
    });

    // The scenario from the brief: the browser says ₹10, Supabase says ₹1500.
    assert.equal(totalInCents, 150000);
    assert.equal(items[0].unit_price_formatted, '₹1500.00');
  });

  test('multiplies by quantity', async () => {
    const { totalInCents } = await priceOrder([{ product_id: '1', size: 'M', quantity: 3 }], {
      load: load([SHIRT]),
    });

    assert.equal(totalInCents, 450000);
  });

  test('prefers discount_price when present, matching the storefront', async () => {
    const { totalInCents } = await priceOrder([{ product_id: '2', size: null, quantity: 2 }], {
      load: load([UNSIZED]),
    });

    assert.equal(totalInCents, 80000);
  });

  test('sums multiple lines', async () => {
    const { totalInCents } = await priceOrder(
      [
        { product_id: '1', size: 'M', quantity: 1 },
        { product_id: '2', size: null, quantity: 1 },
      ],
      { load: load([SHIRT, UNSIZED]) },
    );

    assert.equal(totalInCents, 150000 + 40000);
  });

  test('produces the same line shape the COD order writes', async () => {
    const { items } = await priceOrder([{ product_id: '1', size: 'M', quantity: 2 }], {
      load: load([SHIRT]),
    });

    assert.deepEqual(items[0], {
      product_id: '1',
      variant_id: 'variant_1_M',
      title: 'Checked Casual Shirt',
      size: 'M',
      image: SHIRT.image_url,
      quantity: 2,
      unit_price_in_cents: 150000,
      unit_price_formatted: '₹1500.00',
      line_total_in_cents: 300000,
      line_total_formatted: '₹3000.00',
    });
  });

  test('rejects an unknown product', async () => {
    await assert.rejects(
      priceOrder([{ product_id: '99', size: 'M', quantity: 1 }], { load: load([SHIRT]) }),
      /no longer available/,
    );
  });

  test('rejects an inactive product', async () => {
    await assert.rejects(
      priceOrder([{ product_id: '1', size: 'M', quantity: 1 }], { load: load([{ ...SHIRT, active: false }]) }),
      /no longer available/,
    );
  });

  test('requires a size when the product has sizes', async () => {
    await assert.rejects(
      priceOrder([{ product_id: '1', size: null, quantity: 1 }], { load: load([SHIRT]) }),
      /choose a size/,
    );
  });

  test('rejects a size the product does not offer', async () => {
    await assert.rejects(
      priceOrder([{ product_id: '1', size: 'XXL', quantity: 1 }], { load: load([SHIRT]) }),
      /not available/,
    );
  });

  test('rejects an out-of-stock size', async () => {
    await assert.rejects(
      priceOrder([{ product_id: '1', size: 'L', quantity: 1 }], { load: load([SHIRT]) }),
      /out of stock/,
    );
  });

  test('rejects more than the available stock', async () => {
    await assert.rejects(
      priceOrder([{ product_id: '1', size: 'M', quantity: 6 }], { load: load([SHIRT]) }),
      /Only 5 left/,
    );
  });

  test('merges duplicate lines before checking stock', async () => {
    // Split across two lines, 6 units total exceeds the 5 in stock.
    await assert.rejects(
      priceOrder(
        [
          { product_id: '1', size: 'M', quantity: 3 },
          { product_id: '1', size: 'M', quantity: 3 },
        ],
        { load: load([SHIRT]) },
      ),
      /Only 5 left/,
    );
  });

  test('allows any quantity when the product does not track stock', async () => {
    const { totalInCents } = await priceOrder([{ product_id: '2', size: null, quantity: 10 }], {
      load: load([{ ...UNSIZED, track_quantity: false, stock: 0 }]),
    });

    assert.equal(totalInCents, 400000);
  });

  test('rejects a zero-priced product rather than sending ₹0 to Airpay', async () => {
    await assert.rejects(
      priceOrder([{ product_id: '2', size: null, quantity: 1 }], {
        load: load([{ ...UNSIZED, price: 0, discount_price: 0 }]),
      }),
      /not purchasable/,
    );
  });
});

describe('normalizeCustomer', () => {
  test('accepts valid details', () => {
    assert.deepEqual(normalizeCustomer(CUSTOMER), {
      fullName: 'Asha Menon',
      phone: '9876543210',
      address: '12 MG Road, Kochi, Kerala 682016',
      landmark: null,
    });
  });

  test('applies the same rules the checkout form enforces', () => {
    assert.throws(() => normalizeCustomer({ ...CUSTOMER, fullName: 'Jo' }), /full name/);
    assert.throws(() => normalizeCustomer({ ...CUSTOMER, phone: '12345' }), /10-digit/);
    assert.throws(() => normalizeCustomer({ ...CUSTOMER, address: '  ' }), /address/);
  });

  test('strips separators from the phone number', () => {
    assert.equal(normalizeCustomer({ ...CUSTOMER, phone: '98765-43210' }).phone, '9876543210');
  });

  test('rejects a number that is 10 digits only after a country code', () => {
    assert.throws(() => normalizeCustomer({ ...CUSTOMER, phone: '+91 98765 43210' }), /10-digit/);
  });
});

describe('formatInr', () => {
  test('matches the storefront currency template', () => {
    assert.equal(formatInr(150000), '₹1500.00');
    assert.equal(formatInr(0), '₹0.00');
  });
});

describe('carts saved before the Supabase migration', () => {
  // The cart storage key never changed when the catalogue moved to Supabase, so
  // a browser can still hold lines keyed by the old catalogue's opaque ids.
  const LEGACY_ID = 'prod_01HQ2X8ZK3';

  test('throws with the offending index so the checkout can name the item', () => {
    try {
      normalizeItems([
        { product_id: '1', size: 'M', quantity: 1 },
        { product_id: LEGACY_ID, size: 'M', quantity: 1 },
      ]);
      assert.fail('expected a validation error');
    } catch (error) {
      assert.equal(error.isValidationError, true);
      assert.deepEqual(error.invalidIndexes, [1]);
      assert.match(error.message, /could not recognise/);
    }
  });

  test('reports every unrecognised line, not just the first', () => {
    try {
      normalizeItems([
        { product_id: LEGACY_ID, quantity: 1 },
        { product_id: '1', size: 'M', quantity: 1 },
        { product_id: 'prod_other', quantity: 1 },
      ]);
      assert.fail('expected a validation error');
    } catch (error) {
      assert.deepEqual(error.invalidIndexes, [0, 2]);
    }
  });

  test('an entirely stale cart reports every line', () => {
    try {
      normalizeItems([{ product_id: LEGACY_ID, quantity: 1 }]);
      assert.fail('expected a validation error');
    } catch (error) {
      assert.match(error.message, /could not recognise/);
      assert.deepEqual(error.invalidIndexes, [0]);
    }
  });

  test('a valid cart still passes untouched', () => {
    assert.deepEqual(normalizeItems([{ product_id: '1', size: 'M', quantity: 2 }]), [
      { product_id: '1', size: 'M', quantity: 2 },
    ]);
  });

  test('quantity validation still runs on recognised lines', () => {
    assert.throws(() => normalizeItems([{ product_id: '1', quantity: 0 }]), /quantity/);
  });
});
