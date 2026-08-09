-- P2E CONTRACT: remove tuple-only writer compatibility.
-- Apply only after the compatible P2E app SHA is deployed and verified.
-- Until then, leave this migration unapplied; EXPAND is a safe steady state.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.accountability_rounds') IS NULL
     OR to_regprocedure(
       'public.guard_p2e_bound_financial_write_during_expand()'
     ) IS NULL
     OR to_regprocedure(
       'public.finalize_white_sheet_cash_entry(text,text,date,uuid,text)'
     ) IS NULL
     OR to_regprocedure(
       'public.reopen_white_sheet_cash_entry(text,text,date,uuid,text,text)'
     ) IS NULL
     OR (
       SELECT count(*) FROM pg_trigger
       WHERE tgname IN (
         'p2e_expand_guard_settlement_entries',
         'p2e_expand_guard_settlement_finalizations',
         'p2e_expand_guard_transfer_reconciliations',
         'p2e_expand_guard_white_sheet_cash_entries'
       ) AND NOT tgisinternal
     ) <> 4 THEN
    RAISE EXCEPTION 'P2E CONTRACT: EXPAND or compatible lifecycle RPCs are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settlement_entries_round_identity_key'
      AND conrelid = 'public.settlement_entries'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settlement_finalizations_round_identity_key'
      AND conrelid = 'public.settlement_finalizations'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transfer_reconciliations_round_identity_key'
      AND conrelid = 'public.transfer_reconciliations'::regclass
  ) OR to_regclass(
    'public.digital_white_sheet_cash_entries_legacy_identity_uidx'
  ) IS NULL OR to_regclass(
    'public.digital_white_sheet_cash_entries_accountability_round_uidx'
  ) IS NULL THEN
    RAISE EXCEPTION 'P2E CONTRACT: round-aware unique keys are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settlement_entries_settlement_date_settlement_time_staff_na_key'
      AND conrelid = 'public.settlement_entries'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transfer_reconciliations_source_date_key'
      AND conrelid = 'public.transfer_reconciliations'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'digital_white_sheet_cash_entries_identity_key'
      AND conrelid = 'public.digital_white_sheet_cash_entries'::regclass
  ) OR (
    to_regclass('public.settlement_finalizations_legacy_source_date_key') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'settlement_finalizations_source_id_business_date_key'
        AND conrelid = 'public.settlement_finalizations'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'P2E CONTRACT: legacy compatibility keys are not intact';
  END IF;
END;
$$;

DROP TRIGGER p2e_expand_guard_settlement_entries ON public.settlement_entries;
DROP TRIGGER p2e_expand_guard_settlement_finalizations ON public.settlement_finalizations;
DROP TRIGGER p2e_expand_guard_transfer_reconciliations ON public.transfer_reconciliations;
DROP TRIGGER p2e_expand_guard_white_sheet_cash_entries ON public.digital_white_sheet_cash_entries;
DROP FUNCTION public.guard_p2e_bound_financial_write_during_expand();

ALTER TABLE public.settlement_entries
  DROP CONSTRAINT settlement_entries_settlement_date_settlement_time_staff_na_key;
ALTER TABLE public.settlement_finalizations
  DROP CONSTRAINT IF EXISTS settlement_finalizations_source_id_business_date_key;
DROP INDEX IF EXISTS public.settlement_finalizations_legacy_source_date_key;
ALTER TABLE public.transfer_reconciliations
  DROP CONSTRAINT transfer_reconciliations_source_date_key;
ALTER TABLE public.digital_white_sheet_cash_entries
  DROP CONSTRAINT digital_white_sheet_cash_entries_identity_key;

-- Old deployed app uses these tuple-only overloads. Dropping them makes an
-- accidental post-CONTRACT rollback fail closed instead of touching many rounds.
DROP FUNCTION public.finalize_white_sheet_cash_entry(text, text, date, text);
DROP FUNCTION public.reopen_white_sheet_cash_entry(text, text, date, text, text);

COMMIT;
