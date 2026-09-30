-- Product size selection. Run once in the Supabase SQL editor.
--
-- Additive and idempotent by construction: it only ever ADDs a column with a
-- default, so existing product and order rows are untouched and every existing
-- query keeps working. Nothing is dropped, renamed, truncated or backfilled
-- with real data.
--
-- Why this exists even though supabase-schema.sql already lists products.sizes:
-- that column appears only inside the `create table if not exists` block, which
-- is a no-op on a database created before the column was introduced. Any such
-- database is missing products.sizes entirely. This migration is the guarded
-- equivalent of the `add column if not exists category` line directly below it.
--
-- Sizes are stored as a JSON array of {size, stock} objects rather than text[],
-- because the storefront and the pricing server already read per-size stock
-- from that shape:
--
--   [{"size": "S", "stock": 4}, {"size": "M", "stock": 2}]
--
-- An empty array is the backward-compatible default and means "unsized": no
-- size selector is rendered, and the product uses the row-level products.stock
-- exactly as it does today.

alter table public.products
  add column if not exists sizes jsonb not null default '[]'::jsonb;

-- Guard against a null slipping in from an older row or a manual insert, so the
-- storefront and pricing server can both treat sizes as always-an-array.
update public.products set sizes = '[]'::jsonb where sizes is null;

-- Order line items already carry their size inside the existing orders.items
-- JSON column (see createCodOrder in apps/web/src/api/OrdersApi.js and
-- priceOrder in api/_lib/pricing.js), which is why there is no order_items
-- table to alter and no size column to add to orders. Historical orders simply
-- have no "size" key on their line objects, and every surface that renders a
-- size already guards on its presence, so they keep rendering correctly.

-- PostgREST caches the table schema and would otherwise keep reporting
-- "Could not find the 'sizes' column of 'products' in the schema cache".
notify pgrst, 'reload schema';
