-- 0058: Restore plain UNIQUE(source_id, business_date) on transfer_reconciliations.
--
-- Current application identity for a reconciliation snapshot is
-- (source_id, business_date). reconcile() upserts with
-- onConflict: "source_id,business_date" and never writes work_round_id.
--
-- Production drift from an abandoned work-round branch replaced the original
-- plain unique with a partial unique index:
--   UNIQUE (source_id, business_date) WHERE work_round_id IS NULL
-- named transfer_reconciliations_legacy_source_date_key.
-- PostgREST/Supabase cannot infer that partial index from the conflict target,
-- so settlement submit fails before settlement_entries persistence.
--
-- This migration restores a plain UNIQUE constraint so the existing upsert
-- works again. Work-round scaffolding (column, FK, UNIQUE(work_round_id)) and
-- all historical rows are intentionally preserved — do not revive work-round
-- identity in application code.

DO $$
DECLARE
  v_dup_groups integer;
BEGIN
  SELECT count(*)::integer
  INTO v_dup_groups
  FROM (
    SELECT 1
    FROM public.transfer_reconciliations
    GROUP BY source_id, business_date
    HAVING count(*) > 1
  ) d;

  IF v_dup_groups > 0 THEN
    RAISE EXCEPTION
      '0058: refusing to add UNIQUE(source_id, business_date): found % duplicate source/date group(s). Resolve manually; do not auto-merge.',
      v_dup_groups;
  END IF;
END
$$;

-- Obsolete Production-only partial index. No-op when absent (fresh/repo DBs).
DROP INDEX IF EXISTS public.transfer_reconciliations_legacy_source_date_key;

-- Add the plain unique only when no equivalent unique constraint already
-- exists (e.g. the original 0027 UNIQUE still present on a fresh migrate).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.transfer_reconciliations'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY u.ord)
        FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = u.attnum
      ) = ARRAY['source_id', 'business_date']::text[]
  ) THEN
    ALTER TABLE public.transfer_reconciliations
      ADD CONSTRAINT transfer_reconciliations_source_date_key
      UNIQUE (source_id, business_date);
  END IF;
END
$$;
