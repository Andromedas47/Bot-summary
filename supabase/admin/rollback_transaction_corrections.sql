-- Manual rollback for migration 0037. Review dependencies before running.
-- This removes correction audit history, so it must never be run automatically.
BEGIN;

DROP VIEW IF EXISTS public.effective_produce_transactions;
DROP FUNCTION IF EXISTS public.approve_transaction_correction(uuid, text);
DROP FUNCTION IF EXISTS public.reject_transaction_correction(uuid, text);
DROP FUNCTION IF EXISTS public.is_transaction_correction_approver();
DROP TABLE IF EXISTS public.transaction_corrections;

COMMIT;
