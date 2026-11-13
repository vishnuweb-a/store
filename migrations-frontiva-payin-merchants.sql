-- Frontiva PayIn multi-merchant: records which Frontiva PayIn account (slot) an
-- order was placed on. Run once in the Supabase SQL editor, AFTER
-- migrations-frontiva-payin.sql and BEFORE enabling FRONTIVA_PAYIN_ENABLED_2.
-- Idempotent and additive -- safe to re-run.
--
-- PayIn slots are their own namespace: slot 2 is a second Frontiva portal
-- account and has nothing to do with Airpay merchant 2 (orders.airpay_merchant).
--
-- Backwards compatible by construction:
--   * Nullable, no default: no existing row is rewritten, no backfill, no lock
--     beyond the brief ALTER.
--   * NULL means slot 1. Every PayIn order placed before slot 2 existed is
--     already correct, and slot 1 keeps writing NULL, so its insert is the same
--     one production runs today and does not depend on this column.
--   * Airpay, SabPaisa and COD rows never name the column and stay NULL.
--   * orders_payment_gateway_check is NOT changed: every PayIn slot keeps
--     payment_gateway = 'frontiva_payin'.
--
-- Until this has been run, a slot-2 payment cannot be started (the insert is
-- refused, the customer is asked to choose another option); slot 1 is unaffected.
--
-- Rollback: disable slot 2 (FRONTIVA_PAYIN_ENABLED_2=false). Do NOT drop the
-- column while any order carries a value: those orders would then be verified
-- against slot 1's account.

alter table public.orders add column if not exists frontiva_payin_merchant smallint;

-- Only PayIn orders may name a slot, and only slots >= 2 are ever written.
-- Dropped and re-added so the migration can be re-run.
alter table public.orders drop constraint if exists orders_frontiva_payin_merchant_check;
alter table public.orders
  add constraint orders_frontiva_payin_merchant_check
  check (
    frontiva_payin_merchant is null
    or (payment_gateway = 'frontiva_payin' and frontiva_payin_merchant between 2 and 99)
  );

-- PostgREST must see the new column before the code writes it.
notify pgrst, 'reload schema';

-- Verify:
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'orders' and column_name = 'frontiva_payin_merchant';
--   select conname from pg_constraint where conname = 'orders_frontiva_payin_merchant_check';
