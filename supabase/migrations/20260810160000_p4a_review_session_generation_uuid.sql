-- P4A bug fix: the validation review table's session generation must be a uuid.
--
-- 20260810090000 declared `session_generation bigint`. That was wrong. A pending
-- generation is a uuid everywhere else in this schema — pending_sessions,
-- pending_session_admission, pending_session_ingest, produce_session_notifications,
-- physical_inventory_sessions, purchase_capture_sessions and its ingests all use
-- uuid — and PendingSessionService mints it with crypto.randomUUID(). The review
-- table was the single outlier, so every review lookup failed with
--
--   invalid input syntax for type bigint: "<uuid>"
--
-- which meant the price-review path could never present or confirm. It affected
-- BOTH flows equally; the guided flow simply never reached the code, because
-- until plain-text round binding shipped there was no round to validate against.
--
-- The correction is to adopt the identity the rest of the schema already uses.
-- No mapping, no hash, no truncation, no numeric surrogate: the audited value is
-- the real generation or the table is not an audit of anything.
--
-- Safe because the table is empty. That is asserted, not assumed — with rows
-- present a bigint→uuid change would have no meaning-preserving USING clause,
-- so this migration refuses rather than inventing one.
BEGIN;

DO $$
DECLARE
  v_rows bigint;
  v_type text;
BEGIN
  IF to_regclass('public.produce_entry_validation_reviews') IS NULL THEN
    RAISE EXCEPTION 'P4A: produce_entry_validation_reviews is missing';
  END IF;

  SELECT count(*) INTO v_rows FROM public.produce_entry_validation_reviews;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION
      'P4A: refusing to retype session_generation while % review row(s) exist', v_rows;
  END IF;

  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'pending_sessions'
    AND column_name = 'session_generation';
  IF v_type IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION
      'P4A: pending_sessions.session_generation is %, not uuid — the target type is wrong', v_type;
  END IF;
END $$;

-- `> 0` has no uuid meaning. NOT NULL stays and remains the whole invariant.
ALTER TABLE public.produce_entry_validation_reviews
  DROP CONSTRAINT IF EXISTS produce_entry_validation_reviews_session_generation_check;

-- The USING clause is never evaluated (zero rows); it is written faithfully so
-- the statement would still be meaning-preserving if it ever ran.
ALTER TABLE public.produce_entry_validation_reviews
  ALTER COLUMN session_generation TYPE uuid
  USING session_generation::text::uuid;

COMMENT ON COLUMN public.produce_entry_validation_reviews.session_generation IS
  'The pending generation this exception set belongs to. Same uuid identity as '
  'pending_sessions.session_generation — an approval never outlives its generation.';

-- Both RPCs take the generation as a parameter, so both signatures change. They
-- are dropped and recreated inside this transaction rather than added as uuid
-- overloads: two same-named functions differing only in one parameter's type
-- would make a named-argument PostgREST call ambiguous.
DROP FUNCTION IF EXISTS public.record_produce_validation_review(
  text, bigint, uuid, text, date, text, text, jsonb, text, text
);
DROP FUNCTION IF EXISTS public.confirm_produce_validation_review(
  text, bigint, text, text, text
);

-- Record the exception set that was presented. Idempotent: the same digest
-- arriving twice (duplicate LINE delivery, a retried close) returns the
-- existing row untouched, including its confirmation state.
CREATE FUNCTION public.record_produce_validation_review(
  p_session_key             text,
  p_session_generation      uuid,
  p_accountability_round_id uuid,
  p_validation_digest       text,
  p_business_date           date,
  p_market_label            text,
  p_staff_label             text,
  p_exceptions              jsonb,
  p_line_user_id            text,
  p_line_event_id           text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.produce_entry_validation_reviews;
BEGIN
  INSERT INTO public.produce_entry_validation_reviews (
    session_key, session_generation, accountability_round_id, validation_digest,
    business_date, market_label, staff_label, exceptions,
    presented_by_line_user_id, presented_line_event_id
  )
  VALUES (
    p_session_key, p_session_generation, p_accountability_round_id, p_validation_digest,
    p_business_date, p_market_label, p_staff_label, p_exceptions,
    p_line_user_id, p_line_event_id
  )
  ON CONFLICT ON CONSTRAINT produce_entry_validation_reviews_identity DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row
    FROM public.produce_entry_validation_reviews
    WHERE session_key = p_session_key
      AND session_generation = p_session_generation
      AND validation_digest = p_validation_digest;
  END IF;

  -- presented_line_event_id lets the caller tell a genuine second press from a
  -- duplicate delivery of the very event that created the row.
  RETURN jsonb_build_object(
    'id', v_row.id,
    'confirmed', v_row.confirmed_at IS NOT NULL,
    'confirmed_at', v_row.confirmed_at,
    'presented_line_event_id', v_row.presented_line_event_id
  );
END;
$$;

-- Acknowledge a presented exception set. The digest is part of the lookup, so
-- a confirmation can only ever apply to the exact session generation and
-- exception set it was issued for: a stale press finds nothing and is refused.
CREATE FUNCTION public.confirm_produce_validation_review(
  p_session_key        text,
  p_session_generation uuid,
  p_validation_digest  text,
  p_line_user_id       text,
  p_line_event_id      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.produce_entry_validation_reviews;
BEGIN
  SELECT * INTO v_row
  FROM public.produce_entry_validation_reviews
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
    AND validation_digest = p_validation_digest
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_row.confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_confirmed',
      'id', v_row.id,
      'confirmed_by_line_user_id', v_row.confirmed_by_line_user_id
    );
  END IF;

  UPDATE public.produce_entry_validation_reviews
  SET confirmed_at              = now(),
      confirmed_by_line_user_id = p_line_user_id,
      confirmed_line_event_id   = p_line_event_id
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('status', 'confirmed', 'id', v_row.id);
END;
$$;

-- Production carries broad default ACLs, so REVOKE precedes every GRANT.
REVOKE ALL ON FUNCTION public.record_produce_validation_review(
  text, uuid, uuid, text, date, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_produce_validation_review(
  text, uuid, uuid, text, date, text, text, jsonb, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_produce_validation_review(
  text, uuid, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_produce_validation_review(
  text, uuid, text, text, text
) TO service_role;

COMMIT;
