-- Third Airpay merchant: allows orders.airpay_merchant = 3. Run once in the
-- Supabase SQL editor BEFORE merchant 3 is offered at checkout. Idempotent and
-- additive -- safe to re-run.
--
-- What it changes, and what it does not:
--   * Only the check constraint is widened, from (1, 2) to (1, 2, 3). No row is
--     read back, rewritten or deleted; every existing value (NULL, 1, 2) is
--     still allowed, so re-adding the constraint cannot fail on existing data.
--   * NULL still means merchant 1, and historical merchant 2 rows stay 2.
--   * The column is created if migrations-airpay-merchant.sql was never run, so
--     this file stands on its own.
--   * Drop and re-add run in one transaction, so the column is never left
--     without a constraint, even for a moment.
--
-- Until this has run, a merchant 3 payment cannot start: the insert is refused,
-- no order is written, and the customer is asked to choose another option.
-- Merchants 1 and 2 are unaffected either way.
--
-- Rollback: nothing to undo. Do not narrow the constraint back to (1, 2) while
-- any order carries a 3 -- the statement would fail, and dropping those rows
-- would lose payments still to be reconciled against merchant 3.

begin;

alter table public.orders add column if not exists airpay_merchant smallint;

alter table public.orders drop constraint if exists orders_airpay_merchant_check;
alter table public.orders
  add constraint orders_airpay_merchant_check
  check (airpay_merchant is null or airpay_merchant in (1, 2, 3));

commit;

-- PostgREST caches the table schema; reload so the API sees the change now.
notify pgrst, 'reload schema';
