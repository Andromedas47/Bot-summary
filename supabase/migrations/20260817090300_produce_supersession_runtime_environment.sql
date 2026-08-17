-- P1-A supersession was not runtime-environment scoped.
--
-- 20260817090000/090100/090200 are Production history and are NOT modified
-- here. This is forward-only.
--
-- Preview, Production and development share ONE Supabase project. The
-- supersession sweep selected pending candidates by source_id and
-- terminalized = false with no environment boundary, so a Preview success could
-- prove and terminalize a Production operator's live pending generation — and
-- the reverse. Every other worker in this codebase already respects the 0061
-- ownership contract:
--
--   production   owns runtime_environment = 'production' OR IS NULL (legacy)
--   preview      owns runtime_environment = 'preview'
--   development  owns runtime_environment = 'development'
--
-- NULL is the Production legacy exception ONLY. It is never a wildcard for
-- preview or development, and no environment is a wildcard for another.
--
-- Defense in depth, as everywhere else here: the application filters candidates
-- by environment, and this function re-checks it while holding the row lock. A
-- pre-query filter alone would be a TOCTOU hole of exactly the kind the
-- p_expected_updated_at snapshot check closed for content.
--
-- The already-deployed 5-argument `supersede_pending_generation` is redefined to
-- fail closed. A build that still knows only that signature — a stale Preview,
-- say — can then supersede nothing at all, rather than superseding across
-- environments. The new 6-argument form takes p_runtime_environment as a
-- REQUIRED parameter, with no default, so PostgREST dispatch between the two
-- signatures stays unambiguous.
--
-- Rollout: schema first. With this applied and no application change,
-- supersession simply stops happening (the deployed build calls the 5-argument
-- form and gets runtime_environment_required) until the build that passes an
-- environment ships. Nothing is written in the meantime and nothing is lost —
-- an unsuperseded pending stays exactly where it is.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.supersede_pending_generation(text,uuid,uuid,jsonb,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'supersede_pending_generation is missing (20260817090200 is not applied)';
  END IF;
  IF to_regprocedure('public.retire_empty_round_of_generation(text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'retire_empty_round_of_generation is missing (20260817090200 is not applied)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions'
      AND column_name = 'runtime_environment'
  ) THEN
    RAISE EXCEPTION 'pending_sessions.runtime_environment is missing (migration 0061 is not applied)';
  END IF;
END;
$preflight$;


CREATE OR REPLACE FUNCTION public.supersede_pending_generation(
  p_session_key         text,
  p_session_generation  uuid,
  p_superseded_by       uuid,
  p_evidence            jsonb DEFAULT '{}'::jsonb,
  p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $five$
  -- Deliberately inert. This signature shipped to Production without an
  -- environment boundary, and a deployment that still calls it cannot say which
  -- environment owns the row it names. Superseding nothing is the only safe
  -- answer; the 6-argument form below is the live path.
  SELECT jsonb_build_object('superseded', false, 'reason', 'runtime_environment_required');
$five$;

COMMENT ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz) IS
  'SUPERSEDED AND INERT. Retained only so an already-deployed build calling the '
  '5-argument signature fails closed instead of superseding across runtime '
  'environments. Always returns runtime_environment_required and writes nothing. '
  'Use the 6-argument form.';

CREATE OR REPLACE FUNCTION public.supersede_pending_generation(
  p_session_key         text,
  p_session_generation  uuid,
  p_superseded_by       uuid,
  p_evidence            jsonb,
  p_expected_updated_at timestamptz,
  p_runtime_environment text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $six$
DECLARE
  v_row     public.pending_sessions%ROWTYPE;
  v_outcome text;
  v_env     text := btrim(COALESCE(p_runtime_environment, ''));
BEGIN
  IF p_session_key IS NULL OR btrim(p_session_key) = ''
     OR p_session_generation IS NULL
     OR p_superseded_by IS NULL THEN
    RAISE EXCEPTION 'supersession requires a session key, generation and successor';
  END IF;

  -- An unrecognised environment is refused rather than guessed. Nothing here
  -- derives the environment from the row, the source or a deployment URL.
  IF v_env NOT IN ('production', 'preview', 'development') THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'invalid_runtime_environment');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.produce_sessions
    WHERE id = p_superseded_by AND voided_at IS NULL
  ) THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'successor_not_found');
  END IF;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'not_found');
  END IF;
  IF v_row.session_generation IS DISTINCT FROM p_session_generation THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'generation_conflict');
  END IF;
  IF v_row.terminalized THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'already_terminal');
  END IF;
  IF v_row.close_requested_at IS NOT NULL AND v_row.finalization_status = 'processing' THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'finalization_in_progress');
  END IF;

  -- Ownership, re-checked HERE under the row lock rather than trusted from the
  -- caller's SELECT. The 0061 contract: Production alone inherits legacy NULL
  -- rows; every other environment must match exactly, and NULL is never "mine".
  --
  -- Written with IS NOT DISTINCT FROM rather than `=`. runtime_environment is
  -- nullable, and `NULL = 'preview'` is NULL, not false — `IF NOT (… NULL …)`
  -- is then not true, the branch is skipped, and a legacy Production row gets
  -- superseded by a Preview worker. Three-valued logic must not decide
  -- ownership; every comparison here is total.
  IF NOT (
    CASE
      WHEN v_env = 'production'
        THEN v_row.runtime_environment IS NOT DISTINCT FROM 'production'
             OR v_row.runtime_environment IS NULL
      ELSE v_row.runtime_environment IS NOT DISTINCT FROM v_env
    END
  ) THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'environment_mismatch');
  END IF;

  IF p_expected_updated_at IS NULL THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'expected_updated_at_required');
  END IF;
  IF v_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    -- No automatic retry: the old proof is void, and a fresh sweep must read
    -- and prove the new content on its own terms.
    RETURN jsonb_build_object('superseded', false, 'reason', 'candidate_changed');
  END IF;

  UPDATE public.pending_sessions
  SET terminalized = true,
      next_attempt_at = NULL,
      finalized_at = clock_timestamp(),
      finalization_status = 'failed_closed',
      finalization_error =
        COALESCE(p_evidence, '{}'::jsonb)
        || jsonb_build_object(
             'reason', 'superseded',
             'superseded_by_produce_session_id', p_superseded_by,
             'superseded_at', clock_timestamp()
           )
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;

  v_outcome := public.retire_empty_round_of_generation(
    p_session_key, p_session_generation, 'superseded'
  );

  RETURN jsonb_build_object(
    'superseded', true,
    'accountability_round_id', v_row.accountability_round_id,
    'round_outcome', v_outcome
  );
END;
$six$;

COMMENT ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz, text) IS
  'Terminalizes ONE pending generation the caller has already proven replaced by a live produce session. p_runtime_environment is REQUIRED and is re-checked under the row lock against the 0061 ownership contract, so no environment can terminalize another environment''s row; legacy NULL belongs to production only. p_expected_updated_at is the snapshot the proof was made against — a different value answers candidate_changed and writes nothing. Preserves accumulated_text, generation identity, timestamps and review artefacts; deletes nothing.';

REVOKE ALL ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz, text)
  TO service_role;

COMMIT;
