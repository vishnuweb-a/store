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
