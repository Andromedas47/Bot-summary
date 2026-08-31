-- Stale close-validation race + recoverable post-boundary validation hold.
--
-- PRODUCTION EVIDENCE (2026-08-30)
-- -------------------------------
-- An operator sent many Produce item messages and then `จบรายการเบิก`. The
-- close was admitted at 06:13:30.544Z, but legitimate item admissions whose
-- LINE timestamps were BEFORE the close kept committing until 06:13:36.980Z.
-- The session ended:
--
--   finalization_status = failed_closed
--   terminalized        = true
--   finalization_error  = { reason: validation_failed,
--                           validation_errors: ["entry validation review was
--                           never confirmed"] }
--
-- Two independent defects produced that outcome.
--
-- 1. The plain-text close gate validates a SNAPSHOT of the session, and the
--    close boundary is stamped by a LATER, SEPARATE append_pending_session
--    call. Between the two, a concurrent pre-close ingest can change
--    ingest_revision. Generation pinning does not catch this: the generation
--    is unchanged, only the document grew. The boundary was therefore stamped
--    against a document the gate never saw.
--
-- 2. When the finalizer later re-ran the entry gate on the REAL (grown)
--    document, the new content required review. Nothing had ever presented
--    that review to the operator, so the finalizer treated it as an
--    unconfirmed review and terminalized the session as failed_closed. A
--    confirmable review became a silent terminal failure, and the operator's
--    accepted content was stranded.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   1. A 9-arg append_pending_session overload that pins ingest_revision
--      atomically on FIRST close, under the row lock. It is a thin wrapper:
--      it takes the lock, compares the revision, then delegates to the
--      existing 8-arg function. The 8-arg body is NOT duplicated, so
--      out-of-order admission, duplicate-event reservation, deferred-event
--      handling and every later change to it stay authoritative and can never
--      drift from a copy. The nested FOR UPDATE inside the 8-arg is a no-op:
--      the same transaction already holds the row lock.
--   2. Refuses to record or confirm a validation review against a terminalized
--      generation, so a stale close can never grow a review nobody can act on
--      and an old generation can never authorize a new one.
--   3. hold/resume RPCs so a late pre-close LINE event that introduces
--      review_required AFTER the boundary parks finalization instead of
--      terminalizing, and a distinct later confirmation can resume it.
--
-- WHAT IT DELIBERATELY DOES NOT CHANGE
-- ------------------------------------
-- Out-of-order admission is untouched: an event whose line_timestamp_ms is at
-- or before an existing close_event_timestamp_ms is still admitted, and a
-- post-close timestamp is still rejected. The repeated-close status path is
-- untouched, so the revision pin is FIRST-CLOSE ONLY — a genuine second close
-- after the boundary must still work even though late admission has moved the
-- revision.
--
-- INTERACTION WITH 20260829090000 (#108 inactivity lifecycle)
-- ----------------------------------------------------------
-- A held session has close_event_timestamp_ms IS NOT NULL. Both inactivity
-- sweeps require close_event_timestamp_ms IS NULL, so neither can claim a held
-- session and neither can auto-finalize or expire one. recover_stranded_plain_
-- text_closes additionally requires close_refused_at IS NOT NULL and is
-- likewise excluded. A hold is therefore parked for the operator, not for a
-- sweep.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION '20260831120000: public.pending_sessions is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions'
      AND column_name = 'ingest_revision'
  ) THEN
    RAISE EXCEPTION '20260831120000: pending_sessions.ingest_revision is missing; apply 0032 first';
  END IF;
  IF to_regclass('public.produce_entry_validation_reviews') IS NULL THEN
    RAISE EXCEPTION '20260831120000: produce_entry_validation_reviews is missing; apply P4A first';
  END IF;
  -- to_regprocedure resolves the exact overload by signature, without
  -- depending on how pg_get_function_identity_arguments happens to render it.
  IF to_regprocedure(
       'public.append_pending_session(text,text,text,text,bigint,boolean,uuid,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION
      '20260831120000: the 8-arg append_pending_session this wrapper delegates to is missing';
  END IF;
END;
$preflight$;

-- ── 1) Revision-pinned first close ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.append_pending_session(
  p_session_key                  text,
  p_new_text                     text,
  p_reply_token                  text,
  p_line_event_id                text,
  p_line_timestamp_ms            bigint,
  p_mark_close                   boolean,
  p_expected_session_generation  uuid,
  p_expected_item_count          integer,
  p_expected_ingest_revision     integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
BEGIN
  -- Same lock the 8-arg takes. Holding it here is what makes the comparison
  -- below and the mutation inside the delegate a single atomic decision: no
  -- concurrent append can move ingest_revision between them.
  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  -- FIRST close only. A repeated close is a status request and must keep
  -- working after legitimate late pre-close admission has moved the revision;
  -- guarding it here would break the second-close status path.
  --
  -- Generation and terminalized state are deliberately NOT re-checked here.
  -- The delegate owns those decisions and their exact refusal reasons; adding
  -- a second copy would let the two disagree.
  IF p_mark_close
     AND v_row.close_event_timestamp_ms IS NULL
     AND p_expected_ingest_revision IS NOT NULL
     AND v_row.ingest_revision IS DISTINCT FROM p_expected_ingest_revision THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'reason', 'stale_validation_snapshot',
      'expected_revision', p_expected_ingest_revision,
      'current_revision', v_row.ingest_revision,
      'session', to_jsonb(v_row)
    );
  END IF;

  RETURN public.append_pending_session(
    p_session_key,
    p_new_text,
    p_reply_token,
    p_line_event_id,
    p_line_timestamp_ms,
    p_mark_close,
    p_expected_session_generation,
    p_expected_item_count
  );
END;
$fn$;

COMMENT ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer, integer
) IS
  'append_pending_session with an ingest_revision pin on the FIRST close. Takes '
  'the row lock, refuses with stale_validation_snapshot when the document moved '
  'since the entry gate validated it, then delegates to the 8-arg overload, '
  'which remains the single authoritative implementation.';

REVOKE ALL ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer, integer
) TO service_role;

-- ── 2) A terminalized generation grows no reviews ────────────────────────────

CREATE OR REPLACE FUNCTION public.record_produce_validation_review(
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
  v_row         public.produce_entry_validation_reviews;
  v_terminalized boolean;
BEGIN
  -- A stale close arriving after the session already failed closed must not
  -- mint a review the operator can never act on. Absence of the pending row is
  -- not treated as terminal: reviews are also recorded for generations this
  -- lookup cannot see, and refusing those would be a behaviour change.
  SELECT terminalized INTO v_terminalized
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;

  IF v_terminalized THEN
    RETURN jsonb_build_object('status', 'terminalized', 'confirmed', false);
  END IF;

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

CREATE OR REPLACE FUNCTION public.confirm_produce_validation_review(
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
  v_row          public.produce_entry_validation_reviews;
  v_terminalized boolean;
BEGIN
  SELECT terminalized INTO v_terminalized
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;

  IF v_terminalized THEN
    RETURN jsonb_build_object('status', 'terminalized');
  END IF;

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

  -- A confirmation must never be the very event that presented the set. That
  -- is what makes a duplicate delivery of the presenting event a no-op instead
  -- of a self-confirmation.
  IF p_line_event_id IS NOT NULL
     AND v_row.presented_line_event_id IS NOT DISTINCT FROM p_line_event_id THEN
    RETURN jsonb_build_object('status', 'not_found');
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

-- ── 3) Recoverable post-boundary validation hold ─────────────────────────────
--
-- next_attempt_at = NULL parks the finalizer sweep; resume re-schedules it.
-- Close fields, ingest_revision, terminalized and every evidence column are
-- left untouched, so nothing the operator sent is lost or rewritten.

CREATE OR REPLACE FUNCTION public.hold_pending_validation_review(
  p_session_key                 text,
  p_expected_session_generation uuid,
  p_expected_ingest_revision    integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  IF v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'terminalized');
  END IF;

  IF v_row.close_event_timestamp_ms IS NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_closing');
  END IF;

  IF p_expected_ingest_revision IS NOT NULL
     AND v_row.ingest_revision IS DISTINCT FROM p_expected_ingest_revision THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'reason', 'stale_validation_snapshot',
      'current_revision', v_row.ingest_revision
    );
  END IF;

  -- updated_at is deliberately NOT bumped: it is the operator-activity clock
  -- that 20260829090000's sweeps read, and parking a row is not operator
  -- activity. A held row is excluded from those sweeps by its close boundary
  -- regardless, so this only keeps the clock honest.
  UPDATE public.pending_sessions ps
  SET next_attempt_at = NULL
  WHERE ps.session_key = p_session_key
    AND ps.session_generation = p_expected_session_generation
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('accepted', true, 'reason', 'held', 'session', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_pending_close_finalization(
  p_session_key                 text,
  p_expected_session_generation uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  IF v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'terminalized');
  END IF;

  IF v_row.close_event_timestamp_ms IS NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_closing');
  END IF;

  -- finalization_started_at / finalize_hold_until are NOT cleared here: the
  -- finalizer's exactly-once claim (0050) stays the only thing that decides
  -- whether a generation may be finalized.
  UPDATE public.pending_sessions ps
  SET next_attempt_at = v_now
  WHERE ps.session_key = p_session_key
    AND ps.session_generation = p_expected_session_generation
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'accepted', true,
    'reason', 'resumed',
    'next_attempt_at', v_row.next_attempt_at,
    'session', to_jsonb(v_row)
  );
END;
$$;

COMMENT ON FUNCTION public.hold_pending_validation_review(text, uuid, integer) IS
  'Parks finalization for a closed, non-terminal generation whose authoritative '
  'document grew after the close boundary and now needs a review the operator has '
  'not seen. Sets next_attempt_at = NULL only. Never terminalizes, never bumps '
  'updated_at, never touches close fields or evidence.';

COMMENT ON FUNCTION public.resume_pending_close_finalization(text, uuid) IS
  'Re-schedules finalization for a held generation once its review is confirmed. '
  'Does not clear the 0050 finalization claim, so exactly-once still holds.';

REVOKE ALL ON FUNCTION public.hold_pending_validation_review(text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_pending_validation_review(text, uuid, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.resume_pending_close_finalization(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_pending_close_finalization(text, uuid)
  TO service_role;

COMMIT;
