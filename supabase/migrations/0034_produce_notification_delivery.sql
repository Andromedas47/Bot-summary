-- Durable, retryable LINE delivery for finalized produce sessions.
--
-- This migration is additive and keeps the existing Release A/B identity,
-- generation, revision, deduplication, quiet-window, and deadline guards.
-- The finalization RPC retains its signature and remains the sole accounting
-- authority. It now atomically creates the notification outbox row.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS finalization_started_at       timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS finalization_status           text NOT NULL DEFAULT 'pending'
    CHECK (finalization_status IN (
      'pending', 'processing', 'failed_closed', 'duplicate', 'finalized'
    )),
  ADD COLUMN IF NOT EXISTS finalization_error            jsonb,
  ADD COLUMN IF NOT EXISTS finalized_produce_session_id  uuid
    REFERENCES public.produce_sessions(id);

ALTER TABLE public.produce_sessions
  ADD COLUMN IF NOT EXISTS finalization_started_at  timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_at             timestamptz;

CREATE TABLE IF NOT EXISTS public.produce_session_notifications (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produce_session_id                uuid NOT NULL UNIQUE
    REFERENCES public.produce_sessions(id),
  session_key                       text NOT NULL,
  session_generation                uuid NOT NULL,
  source_id                         text NOT NULL,
  correlation_id                    text NOT NULL,
  notification_status               text NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending', 'sending', 'sent', 'failed')),
  notification_attempt_count        integer NOT NULL DEFAULT 0
    CHECK (notification_attempt_count >= 0),
  notification_cycle_attempt_count  integer NOT NULL DEFAULT 0
    CHECK (notification_cycle_attempt_count >= 0),
  notification_retryable            boolean NOT NULL DEFAULT true,
  last_notification_error           text,
  last_notification_attempt_at      timestamptz,
  notification_sent_at              timestamptz,
  notification_payload              text NOT NULL
    CHECK (length(notification_payload) > 0),
  line_retry_key                    uuid NOT NULL DEFAULT gen_random_uuid(),
  next_notification_attempt_at      timestamptz NOT NULL DEFAULT now(),
  sending_started_at                timestamptz,
  resend_count                      integer NOT NULL DEFAULT 0
    CHECK (resend_count >= 0),
  last_resend_requested_at          timestamptz,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS produce_notifications_due_idx
  ON public.produce_session_notifications (next_notification_attempt_at)
  WHERE notification_status IN ('pending', 'failed')
    AND notification_retryable = true;

CREATE INDEX IF NOT EXISTS produce_notifications_stale_sending_idx
  ON public.produce_session_notifications (sending_started_at)
  WHERE notification_status = 'sending';

CREATE TABLE IF NOT EXISTS public.produce_notification_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id       uuid NOT NULL
    REFERENCES public.produce_session_notifications(id),
  attempt_number        integer NOT NULL,
  cycle_attempt_number  integer NOT NULL,
  correlation_id        text NOT NULL,
  transition_from       text NOT NULL,
  transition_to         text NOT NULL DEFAULT 'sending',
  attempted_at          timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  http_status           integer,
  retry_after_ms        integer,
  error                 text,
  UNIQUE (notification_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS produce_notification_attempts_notification_idx
  ON public.produce_notification_attempts (notification_id, attempt_number);

-- Atomically claim due notifications. Stale "sending" rows are reclaimed with
-- their existing LINE retry key so an accepted-but-not-recorded request cannot
-- produce a duplicate notification.
CREATE OR REPLACE FUNCTION public.claim_due_produce_notifications(
  p_limit integer DEFAULT 25
)
RETURNS SETOF public.produce_session_notifications
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT n.id, n.notification_status AS previous_status
    FROM public.produce_session_notifications n
    WHERE (
      n.notification_status IN ('pending', 'failed')
      AND n.notification_retryable = true
      AND n.next_notification_attempt_at <= now()
    ) OR (
      n.notification_status = 'sending'
      AND n.sending_started_at <= now() - interval '2 minutes'
    )
    ORDER BY COALESCE(n.next_notification_attempt_at, n.sending_started_at)
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  ),
  claimed AS (
    UPDATE public.produce_session_notifications n
    SET notification_status = 'sending',
        notification_attempt_count = n.notification_attempt_count + 1,
        notification_cycle_attempt_count =
          n.notification_cycle_attempt_count + 1,
        last_notification_attempt_at = now(),
        sending_started_at = now(),
        next_notification_attempt_at = NULL,
        updated_at = now()
    FROM candidates c
    WHERE n.id = c.id
    RETURNING n.*
  ),
  attempts AS (
    INSERT INTO public.produce_notification_attempts (
      notification_id,
      attempt_number,
      cycle_attempt_number,
      correlation_id,
      transition_from,
      transition_to,
      attempted_at
    )
    SELECT
      c.id,
      c.notification_attempt_count,
      c.notification_cycle_attempt_count,
      c.correlation_id,
      candidates.previous_status,
      'sending',
      c.last_notification_attempt_at
    FROM claimed c
    JOIN candidates ON candidates.id = c.id
  )
  SELECT claimed.* FROM claimed;
END;
$$;

-- Claim exactly one already-queued notification. Used by the operator resend
-- path after requeueing; it never touches produce_sessions or produce_items.
-- Complete only the attempt that is currently claimed. An old worker cannot
-- overwrite a newer attempt after its lease was reclaimed.
CREATE OR REPLACE FUNCTION public.complete_produce_notification_attempt(
  p_notification_id       uuid,
  p_attempt_number        integer,
  p_status                text,
  p_error                 text DEFAULT NULL,
  p_retryable             boolean DEFAULT false,
  p_next_attempt_at       timestamptz DEFAULT NULL,
  p_http_status           integer DEFAULT NULL,
  p_retry_after_ms        integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'invalid terminal notification attempt status: %', p_status;
  END IF;

  UPDATE public.produce_session_notifications
  SET notification_status = p_status,
      notification_retryable =
        CASE WHEN p_status = 'sent' THEN false ELSE p_retryable END,
      last_notification_error =
        CASE WHEN p_status = 'sent' THEN NULL ELSE p_error END,
      notification_sent_at =
        CASE WHEN p_status = 'sent' THEN now() ELSE notification_sent_at END,
      next_notification_attempt_at =
        CASE WHEN p_status = 'sent' THEN NULL ELSE p_next_attempt_at END,
      sending_started_at = NULL,
      updated_at = now()
  WHERE id = p_notification_id
    AND notification_status = 'sending'
    AND notification_attempt_count = p_attempt_number;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN false;
  END IF;

  UPDATE public.produce_notification_attempts
  SET transition_to = p_status,
      completed_at = now(),
      http_status = p_http_status,
      retry_after_ms = p_retry_after_ms,
      error = p_error
  WHERE notification_id = p_notification_id
    AND attempt_number = p_attempt_number;

  RETURN true;
END;
$$;

-- Operator-only application code atomically requeues and claims this row. A
-- new retry key makes an intentional resend a new LINE delivery while the
-- immutable stored payload and all accounting rows remain untouched.
CREATE OR REPLACE FUNCTION public.requeue_produce_notification(
  p_produce_session_id uuid
)
RETURNS SETOF public.produce_session_notifications
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous_status text;
  v_row public.produce_session_notifications%ROWTYPE;
BEGIN
  SELECT n.notification_status
  INTO v_previous_status
  FROM public.produce_session_notifications n
  WHERE n.produce_session_id = p_produce_session_id
    AND n.notification_status <> 'sending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.produce_session_notifications n
  SET notification_status = 'sending',
      notification_attempt_count = n.notification_attempt_count + 1,
      notification_cycle_attempt_count = 1,
      notification_retryable = true,
      last_notification_error = NULL,
      last_notification_attempt_at = now(),
      notification_sent_at = NULL,
      line_retry_key = gen_random_uuid(),
      next_notification_attempt_at = NULL,
      sending_started_at = now(),
      resend_count = n.resend_count + 1,
      last_resend_requested_at = now(),
      updated_at = now()
  WHERE n.produce_session_id = p_produce_session_id
  RETURNING n.* INTO v_row;

  INSERT INTO public.produce_notification_attempts (
    notification_id,
    attempt_number,
    cycle_attempt_number,
    correlation_id,
    transition_from,
    transition_to,
    attempted_at
  )
  VALUES (
    v_row.id,
    v_row.notification_attempt_count,
    v_row.notification_cycle_attempt_count,
    v_row.correlation_id,
    v_previous_status,
    'sending',
    v_row.last_notification_attempt_at
  );

  RETURN NEXT v_row;
END;
$$;

-- Latest finalization authority (0033 + notification outbox). The signature
-- stays unchanged so deployed application instances remain compatible during
-- a rolling release.
CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation(
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
  v_row                     public.pending_sessions%ROWTYPE;
  v_missing                 integer[];
  v_validation              jsonb;
  v_session_id              uuid;
  v_notification_id         uuid;
  v_imported_id             uuid;
  v_inserted_items          integer;
  v_item_count              integer;
  v_raw_message_id          uuid;
  v_finalization_started_at timestamptz;
  v_finalized_at            timestamptz;
  v_notification_payload    text;
  v_notification_source_id  text;
  v_correlation_id          text;
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

  v_finalization_started_at := COALESCE(
    NULLIF(p_session->>'finalization_started_at', '')::timestamptz,
    clock_timestamp()
  );

  UPDATE public.pending_sessions
  SET finalization_started_at = v_finalization_started_at,
      finalization_status = 'processing',
      finalization_error = NULL
  WHERE session_key = p_session_key
    AND session_generation = p_expected_generation;

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
      SET next_attempt_at = close_deadline_at,
          finalization_status = 'pending'
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'pending', 'reason', 'missing_items', 'missing', to_jsonb(v_missing)
      );
    END IF;

    v_finalized_at := clock_timestamp();
    UPDATE public.pending_sessions
    SET terminalized = true,
        next_attempt_at = NULL,
        finalized_at = v_finalized_at,
        finalization_status = 'failed_closed',
        finalization_error = jsonb_build_object(
          'reason', 'missing_items',
          'missing', to_jsonb(v_missing)
        )
    WHERE session_key = p_session_key
      AND session_generation = p_expected_generation;

    RETURN jsonb_build_object(
      'status', 'failed_closed', 'reason', 'missing_items', 'missing', to_jsonb(v_missing)
    );
  END IF;

  IF jsonb_array_length(v_validation) > 0 THEN
    v_finalized_at := clock_timestamp();
    UPDATE public.pending_sessions
    SET terminalized = true,
        next_attempt_at = NULL,
        finalized_at = v_finalized_at,
        finalization_status = 'failed_closed',
        finalization_error = jsonb_build_object(
          'reason', 'validation_failed',
          'validation_errors', v_validation
        )
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

  v_notification_payload := p_session->>'notification_payload';
  v_notification_source_id := p_session->>'notification_source_id';
  v_correlation_id := COALESCE(
    NULLIF(p_session->>'correlation_id', ''),
    p_session_key || ':' || p_expected_generation::text
  );

  -- During a rolling deploy, the prior application may omit these new keys
  -- and continues its existing direct push. New application instances always
  -- provide both keys and therefore atomically create the durable outbox row.

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
    v_finalized_at := clock_timestamp();
    UPDATE public.pending_sessions
    SET terminalized = true,
        next_attempt_at = NULL,
        finalized_at = v_finalized_at,
        finalization_status = 'duplicate'
    WHERE session_key = p_session_key
      AND session_generation = p_expected_generation;

    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  v_finalized_at := clock_timestamp();
  INSERT INTO public.produce_sessions (
    raw_message_id, line_user_id, staff_name, sender_name,
    transaction_time, session_date, session_title, total_items, parser_errors,
    finalization_started_at, finalized_at
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
    NULL,
    v_finalization_started_at,
    v_finalized_at
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.produce_items (
    session_id, item_number, product_name, price_per_unit,
    quantity, unit, section, transaction_type, item_hash,
    basis_quantity, basis_unit, basis_price
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
    NULLIF(item->>'item_hash', ''),
    NULLIF(item->>'basis_quantity', '')::numeric,
    NULLIF(item->>'basis_unit', ''),
    NULLIF(item->>'basis_price', '')::numeric
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_inserted_items = ROW_COUNT;
  IF v_inserted_items IS DISTINCT FROM v_item_count THEN
    RAISE EXCEPTION
      'produce item insert count mismatch: expected %, inserted %',
      v_item_count, v_inserted_items;
  END IF;

  IF COALESCE(v_notification_payload, '') <> ''
     AND COALESCE(v_notification_source_id, '') <> '' THEN
  INSERT INTO public.produce_session_notifications (
    produce_session_id,
    session_key,
    session_generation,
    source_id,
    correlation_id,
    notification_payload
  )
  VALUES (
    v_session_id,
    p_session_key,
    p_expected_generation,
    v_notification_source_id,
    v_correlation_id,
    v_notification_payload
  )
  RETURNING id INTO v_notification_id;
  END IF;

  UPDATE public.raw_messages
  SET is_processed = true, processed_at = now()
  WHERE id = v_raw_message_id;

  UPDATE public.pending_sessions
  SET terminalized = true,
      next_attempt_at = NULL,
      finalized_at = v_finalized_at,
      finalization_status = 'finalized',
      finalized_produce_session_id = v_session_id
  WHERE session_key = p_session_key
    AND session_generation = p_expected_generation;

  RETURN jsonb_build_object(
    'status', 'finalized',
    'session_id', v_session_id,
    'notification_id', v_notification_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_due_produce_notifications(integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_produce_notification_attempt(
  uuid, integer, text, text, boolean, timestamptz, integer, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_produce_notification_attempt(
  uuid, integer, text, text, boolean, timestamptz, integer, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.requeue_produce_notification(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.requeue_produce_notification(uuid)
  TO service_role;
