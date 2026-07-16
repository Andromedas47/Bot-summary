-- Manual rollback for migration 0037. Review dependencies before running.
-- This removes correction audit history, so it must never be run automatically.
BEGIN;

DROP VIEW IF EXISTS public.effective_produce_transactions;
DROP FUNCTION IF EXISTS public.request_transaction_correction(uuid, text, text, jsonb, uuid, text, text);
DROP FUNCTION IF EXISTS public.approve_transaction_correction(uuid, text);
DROP FUNCTION IF EXISTS public.reject_transaction_correction(uuid, text);
DROP FUNCTION IF EXISTS public.build_trusted_raw_transaction_snapshot(uuid);
DROP FUNCTION IF EXISTS public.is_transaction_correction_approver();
DROP TABLE IF EXISTS public.transaction_corrections;
DROP FUNCTION IF EXISTS public.enforce_transaction_correction_immutability();
DROP FUNCTION IF EXISTS public.prevent_transaction_correction_delete();
DROP FUNCTION IF EXISTS public.build_transaction_correction_after_snapshot(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.canonicalize_transaction_correction_changes(jsonb);
DROP FUNCTION IF EXISTS public.is_valid_transaction_correction_after_snapshot(jsonb);
DROP FUNCTION IF EXISTS public.is_valid_transaction_correction_snapshot(jsonb);
DROP FUNCTION IF EXISTS public.safe_transaction_correction_numeric(jsonb, text);

COMMIT;
