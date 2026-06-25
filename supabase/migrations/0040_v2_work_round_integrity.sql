-- V2 Work Round financial-integrity hardening.
--
-- This migration is additive except where legacy source/date uniqueness must be
-- narrowed to legacy rows only. It is safe for historical rows because every new
-- work_round_id column is nullable.

ALTER TABLE public.transfer_reconciliations
  ADD COLUMN IF NOT EXISTS work_round_id uuid REFERENCES public.work_rounds(id);

ALTER TABLE public.settlement_finalizations
  ADD COLUMN IF NOT EXISTS work_round_id uuid REFERENCES public.work_rounds(id);

ALTER TABLE public.slip_evidences
  ADD COLUMN IF NOT EXISTS work_round_id uuid REFERENCES public.work_rounds(id);

ALTER TABLE public.transfer_reconciliations
  DROP CONSTRAINT IF EXISTS transfer_reconciliations_source_id_business_date_key;

ALTER TABLE public.settlement_finalizations
  DROP CONSTRAINT IF EXISTS settlement_finalizations_source_id_business_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS transfer_reconciliations_legacy_source_date_key
  ON public.transfer_reconciliations (source_id, business_date)
  WHERE work_round_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transfer_reconciliations_work_round_key
  ON public.transfer_reconciliations (work_round_id);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_finalizations_legacy_source_date_key
  ON public.settlement_finalizations (source_id, business_date)
  WHERE work_round_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS settlement_finalizations_work_round_key
  ON public.settlement_finalizations (work_round_id);

CREATE INDEX IF NOT EXISTS slip_evidences_work_round_id_idx
  ON public.slip_evidences (work_round_id)
  WHERE work_round_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS settlement_drafts_active_work_round_key
  ON public.settlement_drafts (work_round_id)
  WHERE status IN ('pending', 'declared', 'submitted', 'variance_found', 'ready_for_review', 'needs_correction');

ALTER TABLE public.work_round_selections
  DROP CONSTRAINT IF EXISTS work_round_selections_intent_check;

ALTER TABLE public.work_round_selections
  ADD CONSTRAINT work_round_selections_intent_check
  CHECK (intent IN ('settlement', 'produce_attach', 'slip', 'manual_slip', 'close_round', 'close_round_confirm'));

DROP FUNCTION IF EXISTS public.claim_work_round_selection(uuid, text, text, integer);

CREATE OR REPLACE FUNCTION public.claim_work_round_selection(
  p_selection_id uuid,
  p_source_id text,
  p_line_user_id text,
  p_choice integer,
  p_allowed_statuses text[]
) RETURNS TABLE(
  id uuid,
  source_id text,
  line_user_id text,
  business_date date,
  intent text,
  candidates jsonb,
  payload jsonb,
  resolved_work_round_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_work_round_id uuid;
BEGIN
  IF p_line_user_id IS NULL OR btrim(p_line_user_id) = '' THEN
    RETURN;
  END IF;
  IF p_allowed_statuses IS NULL OR array_length(p_allowed_statuses, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT wr.id
  INTO   v_work_round_id
  FROM   public.work_round_selections s
  JOIN   public.work_rounds wr
    ON   wr.id = (s.candidates -> (p_choice - 1) ->> 'work_round_id')::uuid
   AND   wr.source_id = p_source_id
   AND   wr.business_date = s.business_date
   AND   wr.status = ANY (p_allowed_statuses)
  WHERE  s.id = p_selection_id
    AND  s.source_id = p_source_id
    AND  s.line_user_id = p_line_user_id
    AND  s.status = 'pending'
    AND  s.expires_at > now()
    AND  p_choice >= 1
    AND  p_choice <= jsonb_array_length(s.candidates)
  FOR UPDATE OF s, wr;

  IF v_work_round_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.work_round_selections s
  SET    status = 'resolved',
         resolved_work_round_id = v_work_round_id,
         resolved_at = now()
  WHERE  s.id = p_selection_id
    AND  s.status = 'pending'
  RETURNING s.id, s.source_id, s.line_user_id, s.business_date,
            s.intent, s.candidates, s.payload, s.resolved_work_round_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_work_round_selection(uuid, text, text, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_work_round_selection(uuid, text, text, integer, text[]) TO anon, authenticated, service_role;
