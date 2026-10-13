-- Dual Airpay: records which Airpay merchant account an online order was placed
-- on. Run once in the Supabase SQL editor. Idempotent and additive -- safe to
-- re-run, and safe to run before or after the code that uses it is deployed.
--
-- Backwards compatible by construction:
--   * The column is nullable with no default, so no existing row is rewritten
--     and the table is not locked for a backfill.
--   * NULL means merchant 1. Every order placed before the second account
--     existed is therefore already correct, with nothing to migrate.
--   * Merchant 1 orders keep writing NULL, so merchant 1 checkout is the same
--     insert it has always been and does not depend on this column existing.
--   * Cash on Delivery rows never name the column and stay NULL.
--
-- Only merchant 2 orders write a value (2). Until this has been run, a
-- merchant 2 payment cannot be started -- the insert is refused and the
-- customer is asked to choose another option -- and merchant 1 is unaffected.
--
-- Rollback: nothing to undo. The column can be left in place when checkout is
-- returned to merchant 1 only; do not drop it while any order carries a 2, or
-- those orders would be re-verified against the wrong account.

alter table public.orders add column if not exists airpay_merchant smallint;

-- Guards the column against anything other than the two known accounts.
-- Dropped and re-added so the migration can be re-run.
alter table public.orders drop constraint if exists orders_airpay_merchant_check;
alter table public.orders
  add constraint orders_airpay_merchant_check
  check (airpay_merchant is null or airpay_merchant in (1, 2));

-- PostgREST caches the table schema; without this the API keeps reporting that
-- the column does not exist until the cache refreshes on its own.
notify pgrst, 'reload schema';
