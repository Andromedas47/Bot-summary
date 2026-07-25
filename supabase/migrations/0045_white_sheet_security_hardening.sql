-- White Sheet Production hardening (local + future apply).
--
-- 1) Enable RLS on new financial/audit tables (service_role bypasses RLS;
--    no anon/authenticated policies — same posture as digital_white_sheet_cash_entries).
-- 2) Restrict financial mutation RPCs to service_role only.
-- 3) Atomic finalize/reopen RPCs (state mutation + lifecycle audit in one txn).
-- 4) CHECK that finalized_at / finalized_by are both null or both non-null.
--
-- Migration 0044 remains reserved for Production schema/history reconciliation.
-- Do not invent 0044 here.

-- ── Goal 1: RLS on new financial/audit tables ───────────────────────────────

ALTER TABLE public.central_selling_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_selling_price_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slip_check_reference_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.white_sheet_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- No policies: only the service-role server client (which bypasses RLS)
-- reads/writes these tables.

-- ── Goal 5: finalized_at / finalized_by pair integrity ───────────────────────
-- Safe on a fresh/local chain that has never received inconsistent Production
-- rows. Refuse to proceed if any inconsistent pair already exists.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.digital_white_sheet_cash_entries
    WHERE (finalized_at IS NULL) IS DISTINCT FROM (finalized_by IS NULL)
  ) THEN
    RAISE EXCEPTION
      'digital_white_sheet_cash_entries has inconsistent finalized_at/finalized_by pairs; refusing CHECK without repair';
  END IF;
END $$;

ALTER TABLE public.digital_white_sheet_cash_entries
  ADD CONSTRAINT digital_white_sheet_cash_entries_finalized_pair_chk
  CHECK ((finalized_at IS NULL) = (finalized_by IS NULL));

-- ── Goal 3: atomic finalize / reopen lifecycle RPCs ─────────────────────────

CREATE OR REPLACE FUNCTION public.finalize_white_sheet_cash_entry(
  p_source_id               text,
  p_market_label_normalized text,
  p_business_date           date,
  p_actor                   text
) RETURNS public.digital_white_sheet_cash_entries
LANGUAGE plpgsql
AS $$
DECLARE
  v_row public.digital_white_sheet_cash_entries;
  v_actor text;
BEGIN
  IF p_source_id IS NULL OR btrim(p_source_id) = '' THEN
    RAISE EXCEPTION 'source_id must not be empty';
  END IF;
  IF p_market_label_normalized IS NULL OR btrim(p_market_label_normalized) = '' THEN
    RAISE EXCEPTION 'market_label_normalized must not be empty';
  END IF;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date is required';
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;

  v_actor := btrim(p_actor);

  UPDATE public.digital_white_sheet_cash_entries
  SET finalized_at = now(),
      finalized_by = v_actor
  WHERE source_id = p_source_id
    AND market_label_normalized = p_market_label_normalized
    AND business_date = p_business_date
    AND finalized_at IS NULL
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'no SUBMITTED White Sheet entry found for this identity, or it is already finalized';
  END IF;

  INSERT INTO public.white_sheet_lifecycle_events (
    source_id,
    market_label_normalized,
    business_date,
    event,
    actor
  ) VALUES (
    v_row.source_id,
    v_row.market_label_normalized,
    v_row.business_date,
    'finalized',
    v_actor
  );

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.finalize_white_sheet_cash_entry(text, text, date, text) IS
  'Atomically transitions a SUBMITTED White Sheet cash entry to FINALIZED and '
  'inserts a white_sheet_lifecycle_events audit row in the same transaction. '
  'If the audit INSERT fails, the finalize UPDATE rolls back.';

CREATE OR REPLACE FUNCTION public.reopen_white_sheet_cash_entry(
  p_source_id               text,
  p_market_label_normalized text,
  p_business_date           date,
  p_actor                   text,
  p_reason                  text
) RETURNS public.digital_white_sheet_cash_entries
LANGUAGE plpgsql
AS $$
DECLARE
  v_row    public.digital_white_sheet_cash_entries;
  v_actor  text;
  v_reason text;
BEGIN
  IF p_source_id IS NULL OR btrim(p_source_id) = '' THEN
    RAISE EXCEPTION 'source_id must not be empty';
  END IF;
  IF p_market_label_normalized IS NULL OR btrim(p_market_label_normalized) = '' THEN
    RAISE EXCEPTION 'market_label_normalized must not be empty';
  END IF;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date is required';
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reason is required to reopen a finalized entry';
  END IF;

  v_actor := btrim(p_actor);
  v_reason := btrim(p_reason);

  UPDATE public.digital_white_sheet_cash_entries
  SET finalized_at = NULL,
      finalized_by = NULL
  WHERE source_id = p_source_id
    AND market_label_normalized = p_market_label_normalized
    AND business_date = p_business_date
    AND finalized_at IS NOT NULL
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no FINALIZED White Sheet entry found for this identity';
  END IF;

  INSERT INTO public.white_sheet_lifecycle_events (
    source_id,
    market_label_normalized,
    business_date,
    event,
    actor,
    reason
  ) VALUES (
    v_row.source_id,
    v_row.market_label_normalized,
    v_row.business_date,
    'reopened',
    v_actor,
    v_reason
  );

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.reopen_white_sheet_cash_entry(text, text, date, text, text) IS
  'Atomically reopens a FINALIZED White Sheet cash entry (clears finalized_at/by) '
  'and inserts a reopened audit row with a non-empty reason in the same transaction. '
  'If the audit INSERT fails, the reopen UPDATE rolls back.';

-- ── Goal 2: restrict financial + lifecycle mutation RPCs to service_role ────

REVOKE ALL ON FUNCTION public.set_central_selling_price(
  text, text, date, integer, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_central_selling_price(
  text, text, date, integer, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_central_selling_price(
  text, text, date, integer, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.seed_central_selling_price(
  text, text, date, integer, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_central_selling_price(
  text, text, date, integer, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_central_selling_price(
  text, text, date, integer, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_white_sheet_cash_entry(
  text, text, date, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_white_sheet_cash_entry(
  text, text, date, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_white_sheet_cash_entry(
  text, text, date, text
) TO service_role;

REVOKE ALL ON FUNCTION public.reopen_white_sheet_cash_entry(
  text, text, date, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_white_sheet_cash_entry(
  text, text, date, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_white_sheet_cash_entry(
  text, text, date, text, text
) TO service_role;
