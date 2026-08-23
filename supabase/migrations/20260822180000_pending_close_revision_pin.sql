-- P1 2026-08-22: stale close-validation race + recoverable post-boundary review.
--
-- Close-gate validation and close-boundary mutation were separate operations.
-- A concurrent pre-close ingest could change ingest_revision after the gate
-- snapshot and still let append_pending_session stamp close_event_timestamp_ms
-- on the stale document. Generation pinning alone does not catch that.
--
-- This migration:
--   1. Adds a 9-arg append_pending_session overload that pins ingest_revision
--      atomically on FIRST close, under the same FOR UPDATE lock.
--   2. Wraps the existing 8-arg overload so positional SQL callers stay valid.
--   3. Refuses to record/confirm a validation review against a terminalized
--      generation (the second-close UX bug after failed_closed).
--   4. Adds hold/resume RPCs so a late pre-close LINE event that introduces
--      review_required after the boundary can wait for a distinct confirmation
--      instead of terminalizing as failed_closed.
--
-- Out-of-order admission (line_timestamp_ms <= close_event_timestamp_ms after
-- the boundary exists) is unchanged. Post-close timestamps still reject.

-- ── 1) Revision-pinned close mutation ────────────────────────────────────────

CREATE FUNCTION public.append_pending_session(
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
AS $$
DECLARE
  v_row                public.pending_sessions%ROWTYPE;
  v_was_closing        boolean;
  v_admission_inserted integer;
  v_ingest_inserted    integer;
BEGIN
  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  IF p_expected_session_generation IS NULL
     OR v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object(
      'accepted', false, 'reason', 'terminalized', 'session', to_jsonb(v_row)
    );
  END IF;

  v_was_closing := v_row.close_event_timestamp_ms IS NOT NULL;

  IF v_was_closing
     AND v_row.close_session_generation IS DISTINCT FROM v_row.session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'close_generation_conflict');
  END IF;

  -- The row lock serializes append attempts for this generation. Detect a
  -- previously reserved event before close-status handling or any pending-row
  -- mutation so redelivery is a true no-op.
  IF p_line_event_id IS NOT NULL
     AND p_line_timestamp_ms IS NOT NULL
     AND (
       EXISTS (
         SELECT 1
         FROM public.pending_session_admission
         WHERE session_generation = v_row.session_generation
           AND line_event_id = p_line_event_id
       )
       OR EXISTS (
         SELECT 1
         FROM public.pending_session_ingest
         WHERE session_generation = v_row.session_generation
           AND line_event_id = p_line_event_id
       )
     ) THEN
    RETURN jsonb_build_object(
      'accepted', true, 'reason', 'duplicate_event', 'session', to_jsonb(v_row)
    );
  END IF;

  -- A repeated close is a status request. The first boundary, expected count,
  -- quiet window and hard deadline remain immutable. Distinct second closes
  -- after the boundary must take this path even when ingest_revision has moved
  -- (late pre-close admission), so the revision pin below is first-close only.
  IF v_was_closing AND p_mark_close THEN
    RETURN jsonb_build_object(
      'accepted', true, 'reason', 'close_already_requested', 'session', to_jsonb(v_row)
    );
  END IF;

  -- First close must mutate against the exact ingest_revision the entry gate
  -- validated. Checked under FOR UPDATE, before admission or close fields.
  IF p_mark_close
     AND NOT v_was_closing
     AND p_expected_ingest_revision IS NOT NULL
     AND v_row.ingest_revision IS DISTINCT FROM p_expected_ingest_revision THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'reason', 'stale_validation_snapshot',
      'current_revision', v_row.ingest_revision,
      'session', to_jsonb(v_row)
    );
  END IF;

  IF v_was_closing AND now() >= v_row.close_deadline_at THEN
    RETURN jsonb_build_object(
      'accepted', false, 'reason', 'deadline_elapsed', 'session', to_jsonb(v_row)
    );
  END IF;

  IF v_was_closing
     AND p_line_timestamp_ms > v_row.close_event_timestamp_ms THEN
    RETURN jsonb_build_object(
      'accepted', false, 'reason', 'after_close_boundary', 'session', to_jsonb(v_row)
    );
  END IF;

  IF p_mark_close
     AND p_expected_item_count IS NOT NULL
     AND p_expected_item_count < 1 THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'invalid_expected_item_count');
  END IF;

  IF p_line_event_id IS NOT NULL AND p_line_timestamp_ms IS NOT NULL THEN
    INSERT INTO public.pending_session_admission (
      session_key, session_generation, line_event_id, line_timestamp_ms
    )
    VALUES (
      p_session_key, v_row.session_generation, p_line_event_id, p_line_timestamp_ms
    )
    ON CONFLICT (session_generation, line_event_id) DO NOTHING;

    GET DIAGNOSTICS v_admission_inserted = ROW_COUNT;
    IF v_admission_inserted = 0 THEN
      RETURN jsonb_build_object(
        'accepted', true, 'reason', 'duplicate_event', 'session', to_jsonb(v_row)
      );
    END IF;

    INSERT INTO public.pending_session_ingest (
      session_key, session_generation, line_event_id, line_timestamp_ms, raw_text
    )
    VALUES (
      p_session_key, v_row.session_generation, p_line_event_id, p_line_timestamp_ms, p_new_text
    )
    ON CONFLICT (session_generation, line_event_id) DO NOTHING;

    GET DIAGNOSTICS v_ingest_inserted = ROW_COUNT;
    IF v_ingest_inserted = 0 THEN
      DELETE FROM public.pending_session_admission
      WHERE session_generation = v_row.session_generation
        AND line_event_id = p_line_event_id;

      RETURN jsonb_build_object(
        'accepted', true, 'reason', 'duplicate_event', 'session', to_jsonb(v_row)
      );
    END IF;
  END IF;

  UPDATE public.pending_sessions
  SET
    accumulated_text          = accumulated_text || E'\n' || p_new_text,
    latest_reply_token        = p_reply_token,
    updated_at                = now(),
    close_event_timestamp_ms  = CASE
      WHEN p_mark_close THEN p_line_timestamp_ms ELSE close_event_timestamp_ms
    END,
    close_requested_at        = CASE
      WHEN p_mark_close THEN now() ELSE close_requested_at
    END,
    close_line_event_id       = CASE
      WHEN p_mark_close THEN p_line_event_id ELSE close_line_event_id
    END,
    close_session_generation  = CASE
      WHEN p_mark_close THEN session_generation ELSE close_session_generation
    END,
    close_deadline_at         = CASE
      WHEN p_mark_close THEN now() + interval '30 seconds' ELSE close_deadline_at
    END,
    expected_item_count       = CASE
      WHEN p_mark_close THEN p_expected_item_count ELSE expected_item_count
    END,
    next_attempt_at           = CASE
      WHEN p_mark_close THEN now() + interval '8 seconds'
      WHEN v_was_closing THEN LEAST(now() + interval '8 seconds', close_deadline_at)
      ELSE next_attempt_at
    END,
    ingest_revision           = ingest_revision + 1
  WHERE session_key = p_session_key
    AND session_generation = p_expected_session_generation
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  RETURN jsonb_build_object(
    'accepted', true,
    'reason', CASE WHEN p_mark_close THEN 'first_close' ELSE 'appended' END,
    'session', to_jsonb(v_row)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.append_pending_session(
  p_session_key                  text,
  p_new_text                     text,
  p_reply_token                  text,
  p_line_event_id                text,
  p_line_timestamp_ms            bigint,
  p_mark_close                   boolean,
  p_expected_session_generation  uuid,
  p_expected_item_count          integer
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.append_pending_session(
    p_session_key,
    p_new_text,
    p_reply_token,
    p_line_event_id,
    p_line_timestamp_ms,
    p_mark_close,
    p_expected_session_generation,
    p_expected_item_count,
    NULL::integer
  );
$$;

REVOKE ALL ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer, integer
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer
) TO service_role;

-- ── 2) Terminalized generations must not grow useless reviews ────────────────

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
  v_row public.produce_entry_validation_reviews;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pending_sessions
    WHERE session_key = p_session_key
      AND session_generation = p_session_generation
      AND terminalized
  ) THEN
    RETURN jsonb_build_object(
      'recorded', false,
      'reason', 'terminalized',
      'confirmed', false,
      'presented_line_event_id', p_line_event_id
    );
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

  RETURN jsonb_build_object(
    'id', v_row.id,
    'recorded', true,
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
  v_row public.produce_entry_validation_reviews;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pending_sessions
    WHERE session_key = p_session_key
      AND session_generation = p_session_generation
      AND terminalized
  ) THEN
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

  UPDATE public.produce_entry_validation_reviews
  SET confirmed_at              = now(),
      confirmed_by_line_user_id = p_line_user_id,
      confirmed_line_event_id   = p_line_event_id
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('status', 'confirmed', 'id', v_row.id);
END;
$$;

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

-- ── 3) Recoverable post-boundary validation hold ─────────────────────────────
--
-- A late pre-close LINE event can change the authoritative document AFTER the
-- immutable close boundary. Confirmable review_required must not failed_close.
-- next_attempt_at = NULL parks the sweep; resume re-schedules finalization.
-- Close fields, ingest_revision, and terminalized are not touched.

CREATE FUNCTION public.hold_pending_validation_review(
  p_session_key                 text,
  p_expected_session_generation uuid,
  p_expected_ingest_revision    integer
)
RETURNS jsonb
LANGUAGE plpgsql
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

  IF v_row.ingest_revision IS DISTINCT FROM p_expected_ingest_revision THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'reason', 'stale_validation_snapshot',
      'current_revision', v_row.ingest_revision
    );
  END IF;

  UPDATE public.pending_sessions
  SET next_attempt_at = NULL,
      updated_at = now()
  WHERE session_key = p_session_key
    AND session_generation = p_expected_session_generation
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'accepted', true,
    'reason', 'held',
    'session', to_jsonb(v_row)
  );
END;
$$;

CREATE FUNCTION public.resume_pending_close_finalization(
  p_session_key                 text,
  p_expected_session_generation uuid
)
RETURNS jsonb
LANGUAGE plpgsql
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

  UPDATE public.pending_sessions
  SET next_attempt_at = v_now,
      updated_at = v_now
  WHERE session_key = p_session_key
    AND session_generation = p_expected_session_generation
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'accepted', true,
    'reason', 'resumed',
    'next_attempt_at', v_row.next_attempt_at,
    'session', to_jsonb(v_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hold_pending_validation_review(text, uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hold_pending_validation_review(text, uuid, integer)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_pending_validation_review(text, uuid, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.resume_pending_close_finalization(text, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resume_pending_close_finalization(text, uuid)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_pending_close_finalization(text, uuid)
  TO service_role;
