-- Persist one Data Quality scan in one PostgreSQL transaction.
-- Candidate discovery stays in the application; this function owns only the
-- race-safe, idempotent inbox lifecycle write.
BEGIN;

CREATE OR REPLACE FUNCTION public.upsert_data_quality_issues(
  p_candidates jsonb,
  p_seen_at timestamptz DEFAULT now()
)
RETURNS SETOF public.data_quality_issues
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_candidate jsonb;
  v_business_date text;
BEGIN
  IF p_seen_at IS NULL THEN
    RAISE EXCEPTION 'seen_at_required';
  END IF;

  IF jsonb_typeof(p_candidates) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'candidates_must_be_array';
  END IF;

  -- Validate every candidate before touching the table. Constraints remain
  -- the final guard, but this also rejects malformed data when the matching
  -- existing row is IGNORED and only last_seen would otherwise be updated.
  FOR v_candidate IN SELECT value FROM jsonb_array_elements(p_candidates)
  LOOP
    IF jsonb_typeof(v_candidate) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'candidate_must_be_object';
    END IF;
    IF nullif(btrim(v_candidate ->> 'issue_key'), '') IS NULL THEN
      RAISE EXCEPTION 'candidate_issue_key_required';
    END IF;
    IF nullif(btrim(v_candidate ->> 'category'), '') IS NULL THEN
      RAISE EXCEPTION 'candidate_category_required';
    END IF;
    IF (v_candidate ->> 'severity') NOT IN ('CRITICAL', 'ACTION_REQUIRED', 'ADVISORY') THEN
      RAISE EXCEPTION 'candidate_severity_invalid';
    END IF;

    v_business_date := v_candidate ->> 'business_date';
    IF v_business_date IS NULL OR v_business_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'candidate_business_date_invalid';
    END IF;
    PERFORM v_business_date::date;

    IF jsonb_typeof(v_candidate -> 'affected_refs') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'candidate_affected_refs_must_be_array';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_candidate -> 'affected_refs') AS ref
      WHERE jsonb_typeof(ref) IS DISTINCT FROM 'string'
    ) THEN
      RAISE EXCEPTION 'candidate_affected_refs_must_contain_strings';
    END IF;
    IF nullif(btrim(v_candidate ->> 'summary_th'), '') IS NULL THEN
      RAISE EXCEPTION 'candidate_summary_required';
    END IF;
    IF jsonb_typeof(v_candidate -> 'technical_context') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'candidate_technical_context_must_be_object';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_candidates) AS item(candidate)
    GROUP BY candidate ->> 'issue_key'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate_issue_key_in_batch';
  END IF;

  RETURN QUERY
  WITH input AS (
    SELECT *
    FROM jsonb_to_recordset(p_candidates) AS candidate(
      issue_key text,
      category text,
      severity text,
      business_date date,
      affected_refs jsonb,
      summary_th text,
      technical_context jsonb
    )
  )
  INSERT INTO public.data_quality_issues AS existing (
    issue_key, category, severity, business_date, affected_refs, summary_th,
    technical_context, status, first_seen, last_seen, resolved_at, resolved_by,
    resolution_note, created_at
  )
  SELECT
    input.issue_key, input.category, input.severity, input.business_date,
    input.affected_refs, input.summary_th, input.technical_context, 'OPEN',
    p_seen_at, p_seen_at, NULL, NULL, NULL, p_seen_at
  FROM input
  ON CONFLICT (issue_key) DO UPDATE SET
    category = CASE
      WHEN existing.status = 'OPEN' AND p_seen_at >= existing.last_seen THEN EXCLUDED.category
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN EXCLUDED.category
      ELSE existing.category
    END,
    severity = CASE
      WHEN existing.status = 'OPEN' AND p_seen_at >= existing.last_seen THEN EXCLUDED.severity
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN EXCLUDED.severity
      ELSE existing.severity
    END,
    business_date = CASE
      WHEN existing.status = 'OPEN' AND p_seen_at >= existing.last_seen THEN EXCLUDED.business_date
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN EXCLUDED.business_date
      ELSE existing.business_date
    END,
    affected_refs = CASE
      WHEN existing.status = 'OPEN' AND p_seen_at >= existing.last_seen THEN EXCLUDED.affected_refs
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN EXCLUDED.affected_refs
      ELSE existing.affected_refs
    END,
    summary_th = CASE
      WHEN existing.status = 'OPEN' AND p_seen_at >= existing.last_seen THEN EXCLUDED.summary_th
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN EXCLUDED.summary_th
      ELSE existing.summary_th
    END,
    technical_context = CASE
      WHEN existing.status = 'OPEN' AND p_seen_at >= existing.last_seen THEN EXCLUDED.technical_context
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN EXCLUDED.technical_context
      ELSE existing.technical_context
    END,
    status = CASE
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN 'OPEN'
      ELSE existing.status
    END,
    last_seen = greatest(existing.last_seen, p_seen_at),
    resolved_at = CASE
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN NULL
      ELSE existing.resolved_at
    END,
    resolved_by = CASE
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN NULL
      ELSE existing.resolved_by
    END,
    resolution_note = CASE
      WHEN existing.status = 'RESOLVED' AND p_seen_at > existing.resolved_at THEN NULL
      ELSE existing.resolution_note
    END
  RETURNING existing.*;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_data_quality_issues(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_data_quality_issues(jsonb, timestamptz)
  TO service_role;

COMMIT;
