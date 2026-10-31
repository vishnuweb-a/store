-- Frontiva PayIn: lets an online order record that it was paid through the
-- Frontiva PayIn API, and stores that provider's metadata in its own table.
-- Run once in the Supabase SQL editor BEFORE FRONTIVA_PAYIN_ENABLED is set to
-- true. Requires migrations-sabpaisa.sql to have run first (it created
-- payment_gateway, gateway_txn_id, last_checked_at and enquiry_count, which
-- this gateway reuses). Idempotent and additive -- safe to re-run.
--
-- What it changes, and what it does not:
--   * orders_payment_gateway_check is widened to also accept 'frontiva_payin'.
--     Existing values (NULL = Airpay, 'airpay', 'sabpaisa') keep their meaning;
--     no existing row is read back, rewritten or backfilled.
--   * One new table, frontiva_payin_transactions, with RLS on and no policy:
--     only the service role (the serverless functions) can reach it.
--   * No secret (password, access token, client secret) and no customer email
--     is stored anywhere.
--
-- Rollback: set FRONTIVA_PAYIN_ENABLED=false. Leave the table and constraint
-- in place; do not narrow the constraint while any order carries
-- 'frontiva_payin', or that statement will fail (by design).

begin;

alter table public.orders drop constraint if exists orders_payment_gateway_check;
alter table public.orders
  add constraint orders_payment_gateway_check
  check (payment_gateway is null or payment_gateway in ('airpay', 'sabpaisa', 'frontiva_payin'));

create table if not exists public.frontiva_payin_transactions (
  id bigint generated always as identity primary key,
  -- orders.order_ref, also the PayIn merchantReference. Written before the
  -- order row (the attempt is claimed first), so not a foreign key.
  order_ref text not null,
  -- Browser-generated per checkout attempt. Unique: one attempt can never
  -- produce a second order or a second PayIn.
  checkout_attempt_id uuid not null,
  portal_request_id text,
  portal_merchant_id text,
  -- requested | created | created_not_launched | rejected | auth_failed |
  -- ambiguous | not_created
  create_state text not null default 'requested',
  -- Last status the portal reported (COMPLETED / PENDING / PROCESSING / FAILED / ...).
  provider_status text,
  amount_in_paise bigint not null check (amount_in_paise > 0),
  payment_mode text not null,
  provider_utr text,
  -- Sanitised reason of the last failed check; never a provider body.
  last_error text,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists frontiva_payin_transactions_attempt_key
  on public.frontiva_payin_transactions (checkout_attempt_id);
create unique index if not exists frontiva_payin_transactions_order_ref_key
  on public.frontiva_payin_transactions (order_ref);
create unique index if not exists frontiva_payin_transactions_portal_request_key
  on public.frontiva_payin_transactions (portal_request_id)
  where portal_request_id is not null;

-- The validated upi://pay intent the customer's QR encodes, stored verbatim so a
-- refreshed payment page restores the same QR instead of creating a second
-- PayIn. A payment request to our own payee, not a credential. Added after the
-- first version of this file, hence a separate idempotent statement.
alter table public.frontiva_payin_transactions add column if not exists upi_intent text;

alter table public.frontiva_payin_transactions enable row level security;

commit;

-- Supports the PayIn reconciliation sweep. Partial: costs nothing for other rows.
create index if not exists orders_frontiva_payin_open_idx
  on public.orders (last_checked_at nulls first)
  where payment_gateway = 'frontiva_payin';

notify pgrst, 'reload schema';
