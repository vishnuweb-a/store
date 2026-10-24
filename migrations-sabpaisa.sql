-- SabPaisa PG 3.0: lets an online order record that it was paid through
-- SabPaisa, and keeps the bookkeeping its callback-less verification needs.
-- Run once in the Supabase SQL editor BEFORE SABPAISA_ENABLED is set to true.
-- Idempotent and additive -- safe to re-run.
--
-- What it changes, and what it does not:
--   * Five nullable columns, no defaults. No existing row is read back,
--     rewritten, backfilled or deleted, and the table is not rewritten.
--   * payment_gateway NULL means Airpay -- every order that exists today, and
--     every Airpay order placed after this, because the Airpay insert does not
--     name the column. Only SabPaisa orders write 'sabpaisa'. airpay_merchant
--     and its NULL-means-merchant-1 convention are untouched.
--   * Cash on Delivery rows never name any of these columns and stay NULL.
--   * RLS policies are not changed.
--
-- Until this has run, a SabPaisa payment cannot start (the insert is refused,
-- no order is written, the customer is asked to choose another option), and
-- reconciliation keeps using its original Airpay query. Airpay and COD are
-- unaffected either way.
--
-- Rollback: nothing to undo. Disable with SABPAISA_ENABLED=false and leave the
-- columns in place; do not drop them while any order carries 'sabpaisa', or
-- those orders would be re-verified as Airpay orders.

begin;

-- Which gateway took the payment. NULL = Airpay (see above).
alter table public.orders add column if not exists payment_gateway text;

alter table public.orders drop constraint if exists orders_payment_gateway_check;
alter table public.orders
  add constraint orders_payment_gateway_check
  check (payment_gateway is null or payment_gateway in ('airpay', 'sabpaisa'));

-- SabPaisa's paymentId for the checkout session. Diagnostic only.
alter table public.orders add column if not exists gateway_payment_id text;

-- SabPaisa's txnId, recorded when Transaction Enquiry is consulted.
alter table public.orders add column if not exists gateway_txn_id text;

-- When Transaction Enquiry was last asked about this order. Throttles repeat
-- enquiries from page refreshes and reconciliation.
alter table public.orders add column if not exists last_checked_at timestamptz;

-- Enquiries spent on this order. SabPaisa allows 100 status polls per payment;
-- the automatic paths stop at 60 and leave the rest for an operator.
alter table public.orders add column if not exists enquiry_count integer;

alter table public.orders drop constraint if exists orders_enquiry_count_check;
alter table public.orders
  add constraint orders_enquiry_count_check
  check (enquiry_count is null or enquiry_count >= 0);

commit;

-- Supports the SabPaisa reconciliation sweep. Partial, so it costs nothing for
-- Airpay and COD rows.
create index if not exists orders_sabpaisa_open_idx
  on public.orders (last_checked_at nulls first)
  where payment_gateway = 'sabpaisa';

-- PostgREST caches the table schema; reload so the API sees the change now.
notify pgrst, 'reload schema';
