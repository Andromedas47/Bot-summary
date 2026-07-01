-- Release B: deferred close and completeness protection for produce sessions.
--
-- This migration assumes the generation-scoped pending-session ingest/admission
-- baseline described by 0031 is already present. It does not reconcile older,
-- unrelated migration history and it does not create a cron job.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS terminalized            boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS next_attempt_at         timestamptz,
  ADD COLUMN IF NOT EXISTS close_deadline_at       timestamptz,
  ADD COLUMN IF NOT EXISTS close_session_generation uuid,
  ADD COLUMN IF NOT EXISTS expected_item_count     integer,
  ADD COLUMN IF NOT EXISTS ingest_revision         integer     NOT NULL DEFAULT 0;

-- A close that was already pending when this migration arrived keeps its
-- original LINE boundary and close_requested_at. Fill only Release-B control
-- fields so it becomes sweepable instead of being stranded.
UPDATE public.pending_sessions
SET
  close_session_generation = COALESCE(close_session_generation, session_generation),
  close_deadline_at = COALESCE(
    close_deadline_at,
    close_requested_at + interval '30 seconds',
    now() + interval '30 seconds'
  ),
  next_attempt_at = COALESCE(next_attempt_at, now())
WHERE close_event_timestamp_ms IS NOT NULL
  AND terminalized = false;

CREATE INDEX IF NOT EXISTS pending_sessions_due_idx
  ON public.pending_sessions (next_attempt_at)
  WHERE terminalized = false AND next_attempt_at IS NOT NULL;

-- New Release-B overload. Older overloads stay available during rollout.
-- Admission and ingest are written only after every close-boundary check passes,
-- so a rejected event leaves no row in either generation ledger.
CREATE FUNCTION public.append_pending_session(
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
LANGUAGE plpgsql
AS $$
DECLARE
  v_row         public.pending_sessions%ROWTYPE;
  v_was_closing boolean;
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

  -- A repeated close is a status request. The first boundary, expected count,
  -- quiet window and hard deadline remain immutable.
  IF v_was_closing AND p_mark_close THEN
    RETURN jsonb_build_object(
      'accepted', true, 'reason', 'close_already_requested', 'session', to_jsonb(v_row)
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

  IF p_line_event_id IS NOT NULL AND p_line_timestamp_ms IS NOT NULL THEN
    INSERT INTO public.pending_session_admission (
      session_key, session_generation, line_event_id, line_timestamp_ms
    )
    VALUES (
      p_session_key, v_row.session_generation, p_line_event_id, p_line_timestamp_ms
    )
    ON CONFLICT (session_generation, line_event_id) DO NOTHING;

    INSERT INTO public.pending_session_ingest (
      session_key, session_generation, line_event_id, line_timestamp_ms, raw_text
    )
    VALUES (
      p_session_key, v_row.session_generation, p_line_event_id, p_line_timestamp_ms, p_new_text
    )
    ON CONFLICT (session_generation, line_event_id) DO UPDATE SET
      raw_text = EXCLUDED.raw_text,
      line_timestamp_ms = EXCLUDED.line_timestamp_ms;
  END IF;

  RETURN jsonb_build_object(
    'accepted', true,
    'reason', CASE WHEN p_mark_close THEN 'first_close' ELSE 'appended' END,
    'session', to_jsonb(v_row)
  );
END;
$$;

-- Sole Release-B finalization authority. One RPC invocation is one PostgreSQL
-- transaction: row lock/claim, snapshot validation, completeness validation,
-- dedup, produce session, all items, raw-message processing, and the terminal
-- pending-generation transition either all commit or all roll back.
CREATE FUNCTION public.try_finalize_pending_generation(
  p_session_key             text,
  p_expected_generation     uuid,
  p_expected_line_user_id   text,
  p_snapshot_revision       integer,
  p_session_hash            text,
  p_raw_text                text,
  p_session                 jsonb,
  p_items                   jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_row              public.pending_sessions%ROWTYPE;
  v_missing          integer[];
  v_validation       jsonb;
  v_session_id       uuid;
  v_imported_id      uuid;
  v_inserted_items   integer;
  v_item_count       integer;
  v_raw_message_id   uuid;
BEGIN
  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_row.session_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'generation_conflict');
  END IF;

  IF v_row.line_user_id IS DISTINCT FROM p_expected_line_user_id THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'sender_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'already_terminalized');
  END IF;

  IF v_row.close_event_timestamp_ms IS NULL
     OR v_row.close_requested_at IS NULL
     OR v_row.close_deadline_at IS NULL
     OR v_row.close_session_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'not_closing');
  END IF;

  IF now() < v_row.next_attempt_at AND now() < v_row.close_deadline_at THEN
    RETURN jsonb_build_object(
      'status', 'pending',
      'reason', 'quiet_window',
      'next_attempt_at', v_row.next_attempt_at
    );
  END IF;

  IF v_row.ingest_revision IS DISTINCT FROM p_snapshot_revision THEN
    RETURN jsonb_build_object(
      'status', 'stale_snapshot',
      'current_revision', v_row.ingest_revision
    );
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    v_validation := jsonb_build_array('items payload is not an array');
    v_item_count := 0;
  ELSE
    v_item_count := jsonb_array_length(p_items);
    v_validation := COALESCE(p_session->'validation_errors', '[]'::jsonb);
  END IF;

  IF jsonb_typeof(v_validation) IS DISTINCT FROM 'array' THEN
    v_validation := jsonb_build_array('validation_errors payload is not an array');
  END IF;

  IF v_item_count = 0 THEN
    v_validation := v_validation || jsonb_build_array('session has no items');
  END IF;

  IF COALESCE(btrim(p_session->>'staff_name'), '') = '' THEN
    v_validation := v_validation || jsonb_build_array('staff_name is required');
  END IF;

  IF jsonb_typeof(p_items) = 'array' THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_items) AS item
      WHERE CASE
        WHEN COALESCE(item->>'item_number', '') !~ '^[0-9]+$' THEN true
        WHEN COALESCE(btrim(item->>'product_name'), '') = '' THEN true
        WHEN COALESCE(item->>'price_per_unit', '') !~ '^[0-9]+([.][0-9]+)?$' THEN true
        WHEN COALESCE(item->>'quantity', '') !~ '^[0-9]+([.][0-9]+)?$' THEN true
        WHEN (item->>'quantity')::numeric <= 0 THEN true
        WHEN COALESCE(btrim(item->>'unit'), '') = '' THEN true
        WHEN COALESCE(btrim(item->>'transaction_type'), '') = '' THEN true
        ELSE false
      END
    ) THEN
      v_validation := v_validation || jsonb_build_array('one or more items are invalid');
    END IF;
  END IF;

  IF v_row.expected_item_count IS NOT NULL THEN
    IF jsonb_typeof(p_items) = 'array' THEN
      SELECT array_agg(n ORDER BY n) INTO v_missing
      FROM generate_series(1, v_row.expected_item_count) AS n
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS item
        WHERE COALESCE(item->>'item_number', '') ~ '^[0-9]+$'
          AND (item->>'item_number')::integer = n
      );
    ELSE
      SELECT array_agg(n ORDER BY n) INTO v_missing
      FROM generate_series(1, v_row.expected_item_count) AS n;
    END IF;
  END IF;

  IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
    IF now() < v_row.close_deadline_at THEN
      UPDATE public.pending_sessions
      SET next_attempt_at = close_deadline_at
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'pending', 'reason', 'missing_items', 'missing', to_jsonb(v_missing)
      );
    END IF;

    UPDATE public.pending_sessions
    SET terminalized = true, next_attempt_at = NULL
    WHERE session_key = p_session_key
      AND session_generation = p_expected_generation;

    RETURN jsonb_build_object(
      'status', 'failed_closed', 'reason', 'missing_items', 'missing', to_jsonb(v_missing)
    );
  END IF;

  IF jsonb_array_length(v_validation) > 0 THEN
    UPDATE public.pending_sessions
    SET terminalized = true, next_attempt_at = NULL
    WHERE session_key = p_session_key
      AND session_generation = p_expected_generation;

    RETURN jsonb_build_object(
      'status', 'failed_closed', 'reason', 'validation_failed',
      'validation_errors', v_validation
    );
  END IF;

  IF COALESCE(btrim(p_session_hash), '') = '' THEN
    RAISE EXCEPTION 'session_hash is required';
  END IF;

  v_raw_message_id := NULLIF(p_session->>'raw_message_id', '')::uuid;
  IF v_raw_message_id IS NULL THEN
    RAISE EXCEPTION 'raw_message_id is required';
  END IF;

  INSERT INTO public.imported_sessions (
    session_hash, transaction_date, staff_name, market_name,
    transaction_type, raw_text
  )
  VALUES (
    p_session_hash,
    NULLIF(p_session->>'session_date', '')::date,
    p_session->>'staff_name',
    COALESCE(p_session->>'session_title', ''),
    COALESCE(p_session->>'transaction_types', ''),
    p_raw_text
  )
  ON CONFLICT (session_hash) DO NOTHING
  RETURNING id INTO v_imported_id;

  IF v_imported_id IS NULL THEN
    UPDATE public.pending_sessions
    SET terminalized = true, next_attempt_at = NULL
    WHERE session_key = p_session_key
      AND session_generation = p_expected_generation;

    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  INSERT INTO public.produce_sessions (
    raw_message_id, line_user_id, staff_name, sender_name,
    transaction_time, session_date, session_title, total_items, parser_errors
  )
  VALUES (
    v_raw_message_id,
    p_expected_line_user_id,
    p_session->>'staff_name',
    NULLIF(p_session->>'sender_name', ''),
    NULLIF(p_session->>'transaction_time', ''),
    NULLIF(p_session->>'session_date', '')::date,
    NULLIF(p_session->>'session_title', ''),
    v_item_count,
    NULL
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.produce_items (
    session_id, item_number, product_name, price_per_unit,
    quantity, unit, section, transaction_type, item_hash
  )
  SELECT
    v_session_id,
    (item->>'item_number')::integer,
    item->>'product_name',
    (item->>'price_per_unit')::numeric,
    (item->>'quantity')::numeric,
    item->>'unit',
    COALESCE(item->>'section', 'main'),
    item->>'transaction_type',
    NULLIF(item->>'item_hash', '')
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_inserted_items = ROW_COUNT;
  IF v_inserted_items IS DISTINCT FROM v_item_count THEN
    RAISE EXCEPTION
      'produce item insert count mismatch: expected %, inserted %',
      v_item_count, v_inserted_items;
  END IF;

  UPDATE public.raw_messages
  SET is_processed = true, processed_at = now()
  WHERE id = v_raw_message_id;

  UPDATE public.pending_sessions
  SET terminalized = true, next_attempt_at = NULL
  WHERE session_key = p_session_key
    AND session_generation = p_expected_generation;

  RETURN jsonb_build_object('status', 'finalized', 'session_id', v_session_id);
END;
$$;

REVOKE ALL ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_pending_session(
  text, text, text, text, bigint, boolean, uuid, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb
) TO service_role;
