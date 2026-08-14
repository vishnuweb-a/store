-- FRONTIVA prototype schema. Run once in the Supabase SQL editor.
-- Prototype only: no auth, so both tables are open to the anon key.

create table if not exists public.products (
  id bigint generated always as identity primary key,
  title text not null,
  subtitle text,
  description text,
  ribbon text,
  price numeric(10, 2) not null default 0,
  discount_price numeric(10, 2),
  sku text,
  weight numeric(10, 2),
  track_quantity boolean not null default false,
  stock integer not null default 0,
  sizes jsonb not null default '[]'::jsonb,
  image_url text,
  cloudinary_public_id text,
  -- Storefront collection slug, matching the /shop?category=<slug> links on the
  -- home page ('mens', 'womens'). Null means the product is uncategorised and
  -- only shows under "All Products".
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Added after the first release, so existing databases need the column too.
alter table public.products add column if not exists category text;

create index if not exists products_category_idx on public.products (category);

-- Backfill: every product that predates the column is part of the original
-- men's shirt catalogue. Scoped to null so it never touches categorised rows.
update public.products set category = 'mens' where category is null;

create table if not exists public.orders (
  id bigint generated always as identity primary key,
  customer_name text not null,
  phone text not null,
  address text not null,
  landmark text,
  payment_method text not null default 'Cash on Delivery',
  status text not null default 'processing',
  total numeric(10, 2) not null default 0,
  -- Line items (title, size, quantity, price) for the confirmation page.
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.products enable row level security;
alter table public.orders enable row level security;

drop policy if exists "prototype products access" on public.products;
create policy "prototype products access" on public.products
  for all using (true) with check (true);

drop policy if exists "prototype orders access" on public.orders;
create policy "prototype orders access" on public.orders
  for all using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Online payment (Airpay). Added after the COD release.
--
-- Backwards compatible by construction: every column below is nullable with no
-- default, so existing rows are untouched and the Cash on Delivery insert in
-- apps/web/src/api/OrdersApi.js keeps working without naming any of them.
--
-- Cash on Delivery keeps payment_method = 'Cash on Delivery' and
-- status = 'processing', with payment_status left null.
--
-- Online orders use payment_method = 'Online Payment' and move through:
--   initiated -> processing -> paid | failed | requires_review
-- `payment_status` is authoritative; `status` is mirrored from it so the
-- existing admin table keeps rendering a meaningful value.
-- ---------------------------------------------------------------------------

-- Unguessable merchant reference for one payment attempt. Doubles as the Airpay
-- order id, and is the only handle the browser is given, so orders cannot be
-- enumerated by numeric id.
alter table public.orders add column if not exists order_ref text;

-- Authoritative online payment state. Null for Cash on Delivery.
alter table public.orders add column if not exists payment_status text;

-- Airpay's own transaction identifier, recorded at verification time.
alter table public.orders add column if not exists airpay_transaction_id text;

-- When Airpay's Order Confirmation API was successfully consulted.
alter table public.orders add column if not exists verified_at timestamptz;

-- When the payment was confirmed paid.
alter table public.orders add column if not exists paid_at timestamptz;

-- Last write by the payment server. Existing rows stay null.
alter table public.orders add column if not exists updated_at timestamptz;

-- Unique rather than a primary key so Cash on Delivery rows, which have no
-- order_ref, are unaffected: Postgres allows unlimited nulls in a unique index.
create unique index if not exists orders_order_ref_key on public.orders (order_ref);

-- Supports the reconciliation sweep for unresolved online payments.
create index if not exists orders_payment_status_idx
  on public.orders (payment_status, created_at)
  where payment_status is not null;

-- Callback audit trail and duplicate suppression. One row per distinct Airpay
-- IPN delivery; the unique dedupe_key turns a redelivery into a no-op insert.
create table if not exists public.payment_events (
  id bigint generated always as identity primary key,
  order_ref text,
  dedupe_key text not null,
  -- Redacted callback fields only -- see redact() in api/_lib/http.js.
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists payment_events_dedupe_key on public.payment_events (dedupe_key);
create index if not exists payment_events_order_ref_idx on public.payment_events (order_ref);

-- RLS on with no policy: the anon key used by the browser cannot read or write
-- payment events at all. Only the service role, used exclusively by the
-- serverless functions, reaches this table.
alter table public.payment_events enable row level security;
