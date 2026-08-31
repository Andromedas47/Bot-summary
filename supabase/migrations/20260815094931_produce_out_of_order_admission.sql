-- Preserve plain-text Produce items when concurrent LINE webhook executions
-- arrive in a different order from their authoritative LINE timestamps.
-- Suspicious item-only events wait durably for at most the existing 30-second
-- close barrier. Normal in-order messages still admit in one transaction.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS plain_text_opened_line_event_id text,
  ADD COLUMN IF NOT EXISTS plain_text_opened_line_timestamp_ms bigint;

COMMENT ON COLUMN public.pending_sessions.plain_text_opened_line_event_id IS
  'LINE delivery identity for the current plain-text generation opener. NULL for structured and pre-hotfix rows.';
COMMENT ON COLUMN public.pending_sessions.plain_text_opened_line_timestamp_ms IS
  'Authoritative LINE timestamp for the current plain-text generation opener. Items must be strictly later.';

CREATE TABLE public.pending_produce_deferred_events (
  line_event_id          text        PRIMARY KEY CHECK (length(btrim(line_event_id)) > 0),
  raw_message_id         uuid        NOT NULL UNIQUE REFERENCES public.raw_messages(id),
  session_key            text        NOT NULL CHECK (length(btrim(session_key)) > 0),
  source_id              text        NOT NULL CHECK (length(btrim(source_id)) > 0),
  line_user_id           text        NOT NULL CHECK (length(btrim(line_user_id)) > 0),
  line_timestamp_ms      bigint      NOT NULL CHECK (line_timestamp_ms > 0),
  raw_text               text        NOT NULL CHECK (length(btrim(raw_text)) > 0),
  reply_token            text,
  runtime_environment    text        NOT NULL
    CHECK (runtime_environment IN ('production', 'preview', 'development')),
  status                 text        NOT NULL DEFAULT 'waiting'
    CHECK (status IN (
      'waiting', 'admitted', 'rejected_orphan',
      'rejected_before_opener', 'rejected_after_close'
    )),
  defer_reason           text        NOT NULL DEFAULT 'opener_not_materialized',
  session_generation     uuid,
  opener_line_event_id   text,
  opener_line_timestamp_ms bigint,
  close_line_event_id    text,
  close_line_timestamp_ms bigint,
  received_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at             timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '30 seconds'),
  resolved_at            timestamptz,
  CHECK (
    (status = 'waiting' AND resolved_at IS NULL)
    OR (status <> 'waiting' AND resolved_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.pending_produce_deferred_events IS
  'Durable bounded reorder ledger for item-only plain-text Produce LINE events. line_event_id is idempotency identity; LINE timestamp is causal order.';

CREATE INDEX pending_produce_deferred_waiting_stream_idx
  ON public.pending_produce_deferred_events (
    runtime_environment, session_key, line_timestamp_ms, line_event_id
  )
  WHERE status = 'waiting';
CREATE INDEX pending_produce_deferred_expiry_idx
  ON public.pending_produce_deferred_events (runtime_environment, expires_at)
  WHERE status = 'waiting';

ALTER TABLE public.pending_produce_deferred_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pending_produce_deferred_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pending_produce_deferred_events TO service_role;

-- Atomic opener materialization and reconciliation. The advisory lock is keyed
-- by the existing source+sender session key, so two Vercel executions choose
-- exactly one order without sharing process memory.
CREATE FUNCTION public.open_pending_plain_text_generation(
  p_session_key                 text,
  p_source_id                   text,
  p_line_user_id                text,
  p_line_event_id               text,
  p_line_timestamp_ms           bigint,
  p_raw_text                    text,
  p_reply_token                 text,
  p_mark_close                  boolean,
  p_expected_item_count         integer,
  p_expected_session_generation uuid,
  p_runtime_environment         text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_row            public.pending_sessions%ROWTYPE;
  v_generation     uuid;
  v_now            timestamptz := clock_timestamp();
  v_existing       boolean := false;
  v_reconciled     integer := 0;
  v_deferred       public.pending_produce_deferred_events%ROWTYPE;
  v_append         jsonb;
BEGIN
  IF COALESCE(btrim(p_session_key), '') = ''
     OR COALESCE(btrim(p_source_id), '') = ''
     OR COALESCE(btrim(p_line_user_id), '') = ''
     OR COALESCE(btrim(p_line_event_id), '') = ''
     OR COALESCE(btrim(p_raw_text), '') = ''
     OR p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION 'plain-text opener identity, timestamp, and text are required';
  END IF;
  IF p_runtime_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'invalid runtime_environment: %', p_runtime_environment;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_session_key, 0));

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF FOUND THEN
    v_existing := true;
    IF v_row.entry_origin IS NOT NULL THEN
      RETURN jsonb_build_object('opened', false, 'reason', 'structured_session_active');
    END IF;
    IF v_row.plain_text_opened_line_event_id = p_line_event_id THEN
      v_generation := v_row.session_generation;
    ELSE
      IF p_expected_session_generation IS NOT NULL
         AND v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
        RETURN jsonb_build_object('opened', false, 'reason', 'generation_conflict');
      END IF;
      IF p_expected_session_generation IS NULL AND NOT v_row.terminalized THEN
        RETURN jsonb_build_object('opened', false, 'reason', 'active_generation_exists');
      END IF;

      v_generation := gen_random_uuid();
      UPDATE public.pending_sessions
      SET session_generation = v_generation,
          source_id = p_source_id,
          accumulated_text = p_raw_text,
          latest_reply_token = p_reply_token,
          line_user_id = p_line_user_id,
          created_at = v_now,
          updated_at = v_now,
          plain_text_opened_line_event_id = p_line_event_id,
          plain_text_opened_line_timestamp_ms = p_line_timestamp_ms,
          close_event_timestamp_ms = CASE WHEN p_mark_close THEN p_line_timestamp_ms END,
          close_requested_at = CASE WHEN p_mark_close THEN v_now END,
          close_line_event_id = CASE WHEN p_mark_close THEN p_line_event_id END,
          close_finalize_started_at = NULL,
          terminalized = false,
          next_attempt_at = CASE WHEN p_mark_close THEN v_now + interval '8 seconds' END,
          close_deadline_at = CASE WHEN p_mark_close THEN v_now + interval '30 seconds' END,
          close_session_generation = CASE WHEN p_mark_close THEN v_generation END,
          expected_item_count = CASE WHEN p_mark_close THEN p_expected_item_count END,
          ingest_revision = 1,
          finalization_started_at = NULL,
          finalized_at = NULL,
          finalization_status = 'pending',
          finalization_error = NULL,
          finalized_produce_session_id = NULL,
          accountability_round_id = NULL,
          finalize_hold_until = NULL,
          finalize_confirmed_at = NULL,
          finalize_confirm_line_event_id = NULL,
          runtime_environment = p_runtime_environment
      WHERE session_key = p_session_key;
    END IF;
  ELSE
    IF p_expected_session_generation IS NOT NULL THEN
      RETURN jsonb_build_object('opened', false, 'reason', 'generation_conflict');
    END IF;
    v_generation := gen_random_uuid();
    INSERT INTO public.pending_sessions (
      session_key, source_id, accumulated_text, latest_reply_token, line_user_id,
      created_at, updated_at, session_generation,
      plain_text_opened_line_event_id, plain_text_opened_line_timestamp_ms,
      close_event_timestamp_ms, close_requested_at, close_line_event_id,
      terminalized, next_attempt_at, close_deadline_at, close_session_generation,
      expected_item_count, ingest_revision, finalization_status, runtime_environment
    ) VALUES (
      p_session_key, p_source_id, p_raw_text, p_reply_token, p_line_user_id,
      v_now, v_now, v_generation,
      p_line_event_id, p_line_timestamp_ms,
      CASE WHEN p_mark_close THEN p_line_timestamp_ms END,
      CASE WHEN p_mark_close THEN v_now END,
      CASE WHEN p_mark_close THEN p_line_event_id END,
      false,
      CASE WHEN p_mark_close THEN v_now + interval '8 seconds' END,
      CASE WHEN p_mark_close THEN v_now + interval '30 seconds' END,
      CASE WHEN p_mark_close THEN v_generation END,
      CASE WHEN p_mark_close THEN p_expected_item_count END,
      1, 'pending', p_runtime_environment
    );
  END IF;

  INSERT INTO public.pending_session_admission (
    session_key, session_generation, line_event_id, line_timestamp_ms
  ) VALUES (p_session_key, v_generation, p_line_event_id, p_line_timestamp_ms)
  ON CONFLICT (session_generation, line_event_id) DO NOTHING;
  INSERT INTO public.pending_session_ingest (
    session_key, session_generation, line_event_id, line_timestamp_ms, raw_text
  ) VALUES (p_session_key, v_generation, p_line_event_id, p_line_timestamp_ms, p_raw_text)
  ON CONFLICT (session_generation, line_event_id) DO NOTHING;

  FOR v_deferred IN
    SELECT *
    FROM public.pending_produce_deferred_events
    WHERE status = 'waiting'
      AND runtime_environment = p_runtime_environment
      AND session_key = p_session_key
      AND expires_at > v_now
      AND line_timestamp_ms > p_line_timestamp_ms
      AND (NOT p_mark_close OR line_timestamp_ms < p_line_timestamp_ms)
    ORDER BY line_timestamp_ms, line_event_id
    FOR UPDATE
  LOOP
    v_append := public.append_pending_session(
      p_session_key,
      v_deferred.raw_text,
      v_deferred.reply_token,
      v_deferred.line_event_id,
      v_deferred.line_timestamp_ms,
      false,
      v_generation,
      NULL
    );
    IF COALESCE((v_append->>'accepted')::boolean, false) THEN
      UPDATE public.pending_produce_deferred_events
      SET status = 'admitted', defer_reason = 'reconciled_with_opener',
          session_generation = v_generation,
          opener_line_event_id = p_line_event_id,
          opener_line_timestamp_ms = p_line_timestamp_ms,
          close_line_event_id = CASE WHEN p_mark_close THEN p_line_event_id END,
          close_line_timestamp_ms = CASE WHEN p_mark_close THEN p_line_timestamp_ms END,
          resolved_at = clock_timestamp()
      WHERE line_event_id = v_deferred.line_event_id AND status = 'waiting';
      v_reconciled := v_reconciled + 1;
    END IF;
  END LOOP;

  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = p_session_key;
  RETURN jsonb_build_object(
    'opened', true,
    'reason', CASE WHEN v_existing THEN 'rotated_or_idempotent' ELSE 'created' END,
    'reconciled_count', v_reconciled,
    'session', to_jsonb(v_row)
  );
END;
$fn$;

-- Decide admission under the same stream lock as the opener. Only a suspicious
-- or boundary-rejected event needs a deferred row; normal traffic stays fast.
CREATE FUNCTION public.append_or_defer_pending_produce_item(
  p_raw_message_id       uuid,
  p_session_key          text,
  p_source_id            text,
  p_line_user_id         text,
  p_line_event_id        text,
  p_line_timestamp_ms    bigint,
  p_raw_text             text,
  p_reply_token          text,
  p_runtime_environment  text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_row       public.pending_sessions%ROWTYPE;
  v_event     public.pending_produce_deferred_events%ROWTYPE;
  v_append    jsonb;
  v_was_waiting boolean;
  v_inserted integer;
BEGIN
  IF p_raw_message_id IS NULL
     OR COALESCE(btrim(p_session_key), '') = ''
     OR COALESCE(btrim(p_source_id), '') = ''
     OR COALESCE(btrim(p_line_user_id), '') = ''
     OR COALESCE(btrim(p_line_event_id), '') = ''
     OR COALESCE(btrim(p_raw_text), '') = ''
     OR p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION 'deferred Produce item identity, timestamp, and text are required';
  END IF;
  IF p_runtime_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'invalid runtime_environment: %', p_runtime_environment;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_session_key, 0));

  -- Fast path: an ordinary in-order item needs no deferred-table row. It still
  -- takes the stream advisory lock, so a concurrent opener/rotation cannot
  -- change the generation between the boundary check and append.
  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;
  IF FOUND AND NOT v_row.terminalized AND v_row.entry_origin IS NULL
     AND v_row.plain_text_opened_line_timestamp_ms IS NOT NULL
     AND p_line_timestamp_ms > v_row.plain_text_opened_line_timestamp_ms
     AND (v_row.close_event_timestamp_ms IS NULL
          OR p_line_timestamp_ms < v_row.close_event_timestamp_ms) THEN
    v_append := public.append_pending_session(
      p_session_key, p_raw_text, p_reply_token, p_line_event_id,
      p_line_timestamp_ms, false, v_row.session_generation, NULL
    );
    IF COALESCE((v_append->>'accepted')::boolean, false) THEN
      RETURN jsonb_build_object(
        'action', 'admitted',
        'idempotent', v_append->>'reason' = 'duplicate_event',
        'session_generation', v_row.session_generation,
        'session', v_append->'session'
      );
    END IF;
  END IF;

  INSERT INTO public.pending_produce_deferred_events (
    line_event_id, raw_message_id, session_key, source_id, line_user_id,
    line_timestamp_ms, raw_text, reply_token, runtime_environment
  ) VALUES (
    p_line_event_id, p_raw_message_id, p_session_key, p_source_id, p_line_user_id,
    p_line_timestamp_ms, p_raw_text, p_reply_token, p_runtime_environment
  ) ON CONFLICT (line_event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT * INTO v_event
  FROM public.pending_produce_deferred_events
  WHERE line_event_id = p_line_event_id
  FOR UPDATE;
  IF v_event.session_key IS DISTINCT FROM p_session_key
     OR v_event.line_timestamp_ms IS DISTINCT FROM p_line_timestamp_ms
     OR v_event.raw_text IS DISTINCT FROM p_raw_text THEN
    RAISE EXCEPTION 'line_event_id % was redelivered with different Produce identity', p_line_event_id;
  END IF;
  IF v_event.status <> 'waiting' THEN
    RETURN jsonb_build_object(
      'action', v_event.status,
      'idempotent', true,
      'session_generation', v_event.session_generation
    );
  END IF;
  v_was_waiting := v_inserted = 0;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND OR v_row.terminalized OR v_row.entry_origin IS NOT NULL
     OR v_row.plain_text_opened_line_timestamp_ms IS NULL THEN
    RETURN jsonb_build_object('action', 'deferred', 'idempotent', false);
  END IF;

  IF p_line_timestamp_ms <= v_row.plain_text_opened_line_timestamp_ms THEN
    UPDATE public.pending_produce_deferred_events
    SET status = 'rejected_before_opener', defer_reason = 'item_timestamp_not_after_opener',
        session_generation = v_row.session_generation,
        opener_line_event_id = v_row.plain_text_opened_line_event_id,
        opener_line_timestamp_ms = v_row.plain_text_opened_line_timestamp_ms,
        close_line_event_id = v_row.close_line_event_id,
        close_line_timestamp_ms = v_row.close_event_timestamp_ms,
        resolved_at = clock_timestamp()
    WHERE line_event_id = p_line_event_id;
    RETURN jsonb_build_object(
      'action', 'rejected_before_opener', 'session', to_jsonb(v_row)
    );
  END IF;

  IF v_row.close_event_timestamp_ms IS NOT NULL
     AND p_line_timestamp_ms >= v_row.close_event_timestamp_ms THEN
    UPDATE public.pending_produce_deferred_events
    SET status = 'rejected_after_close', defer_reason = 'item_timestamp_not_before_close',
        session_generation = v_row.session_generation,
        opener_line_event_id = v_row.plain_text_opened_line_event_id,
        opener_line_timestamp_ms = v_row.plain_text_opened_line_timestamp_ms,
        close_line_event_id = v_row.close_line_event_id,
        close_line_timestamp_ms = v_row.close_event_timestamp_ms,
        resolved_at = clock_timestamp()
    WHERE line_event_id = p_line_event_id;
    RETURN jsonb_build_object('action', 'rejected_after_close', 'session', to_jsonb(v_row));
  END IF;

  v_append := public.append_pending_session(
    p_session_key, p_raw_text, p_reply_token, p_line_event_id,
    p_line_timestamp_ms, false, v_row.session_generation, NULL
  );
  IF NOT COALESCE((v_append->>'accepted')::boolean, false) THEN
    RETURN jsonb_build_object('action', 'deferred', 'reason', v_append->>'reason');
  END IF;

  UPDATE public.pending_produce_deferred_events
  SET status = 'admitted',
      defer_reason = CASE WHEN v_was_waiting THEN 'reconciled_with_opener' ELSE 'active_session' END,
      session_generation = v_row.session_generation,
      opener_line_event_id = v_row.plain_text_opened_line_event_id,
      opener_line_timestamp_ms = v_row.plain_text_opened_line_timestamp_ms,
      close_line_event_id = v_row.close_line_event_id,
      close_line_timestamp_ms = v_row.close_event_timestamp_ms,
      resolved_at = clock_timestamp()
  WHERE line_event_id = p_line_event_id;

  RETURN jsonb_build_object(
    'action', CASE WHEN v_was_waiting THEN 'reconciled' ELSE 'admitted' END,
    'session_generation', v_row.session_generation,
    'session', v_append->'session'
  );
END;
$fn$;

-- Cron-side bounded expiry. One last serialized reconciliation is attempted;
-- only events with no temporally valid generation become operator-visible
-- rejected orphans. The rows remain durable audit evidence.
CREATE FUNCTION public.claim_expired_pending_produce_events(
  p_limit integer,
  p_runtime_environment text
)
RETURNS SETOF public.pending_produce_deferred_events
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_event public.pending_produce_deferred_events%ROWTYPE;
  v_row public.pending_sessions%ROWTYPE;
  v_append jsonb;
BEGIN
  IF p_runtime_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'invalid runtime_environment: %', p_runtime_environment;
  END IF;
  FOR v_event IN
    SELECT * FROM public.pending_produce_deferred_events
    WHERE status = 'waiting'
      AND runtime_environment = p_runtime_environment
      AND expires_at <= clock_timestamp()
    ORDER BY expires_at, line_event_id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_event.session_key, 0));
    SELECT * INTO v_row FROM public.pending_sessions
    WHERE session_key = v_event.session_key FOR UPDATE;

    IF FOUND AND NOT v_row.terminalized AND v_row.entry_origin IS NULL
       AND v_row.plain_text_opened_line_timestamp_ms IS NOT NULL
       AND v_event.line_timestamp_ms > v_row.plain_text_opened_line_timestamp_ms
       AND (v_row.close_event_timestamp_ms IS NULL
            OR v_event.line_timestamp_ms < v_row.close_event_timestamp_ms) THEN
      v_append := public.append_pending_session(
        v_event.session_key, v_event.raw_text, v_event.reply_token,
        v_event.line_event_id, v_event.line_timestamp_ms, false,
        v_row.session_generation, NULL
      );
      IF COALESCE((v_append->>'accepted')::boolean, false) THEN
        UPDATE public.pending_produce_deferred_events
        SET status = 'admitted', defer_reason = 'reconciled_at_expiry',
            session_generation = v_row.session_generation,
            opener_line_event_id = v_row.plain_text_opened_line_event_id,
            opener_line_timestamp_ms = v_row.plain_text_opened_line_timestamp_ms,
            close_line_event_id = v_row.close_line_event_id,
            close_line_timestamp_ms = v_row.close_event_timestamp_ms,
            resolved_at = clock_timestamp()
        WHERE line_event_id = v_event.line_event_id;
        CONTINUE;
      END IF;
    END IF;

    UPDATE public.pending_produce_deferred_events
    SET status = CASE
          WHEN FOUND AND v_row.plain_text_opened_line_timestamp_ms IS NOT NULL
               AND v_event.line_timestamp_ms <= v_row.plain_text_opened_line_timestamp_ms
            THEN 'rejected_before_opener'
          WHEN FOUND AND v_row.close_event_timestamp_ms IS NOT NULL
               AND v_event.line_timestamp_ms >= v_row.close_event_timestamp_ms
            THEN 'rejected_after_close'
          ELSE 'rejected_orphan'
        END,
        defer_reason = CASE
          WHEN NOT FOUND THEN 'reorder_window_elapsed_without_opener'
          WHEN v_row.terminalized THEN 'generation_already_terminalized'
          ELSE 'no_temporally_valid_generation'
        END,
        session_generation = CASE WHEN FOUND THEN v_row.session_generation END,
        opener_line_event_id = CASE WHEN FOUND THEN v_row.plain_text_opened_line_event_id END,
        opener_line_timestamp_ms = CASE WHEN FOUND THEN v_row.plain_text_opened_line_timestamp_ms END,
        close_line_event_id = CASE WHEN FOUND THEN v_row.close_line_event_id END,
        close_line_timestamp_ms = CASE WHEN FOUND THEN v_row.close_event_timestamp_ms END,
        resolved_at = clock_timestamp()
    WHERE line_event_id = v_event.line_event_id;
  END LOOP;

  RETURN QUERY
  SELECT * FROM public.pending_produce_deferred_events
  WHERE runtime_environment = p_runtime_environment
    AND resolved_at >= transaction_timestamp()
    AND status IN ('rejected_orphan', 'rejected_before_opener', 'rejected_after_close')
  ORDER BY resolved_at, line_event_id;
END;
$fn$;

-- Any committed waiting item that is temporally inside a closing generation
-- blocks the authoritative finalizer's first transition to processing. Raising
-- rolls the whole finalization RPC back; the cron retries after reconciliation.
CREATE FUNCTION public.guard_pending_produce_deferred_finalization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF NEW.finalization_status = 'processing'
     AND OLD.finalization_status IS DISTINCT FROM 'processing'
     AND NEW.plain_text_opened_line_timestamp_ms IS NOT NULL
     AND NEW.close_event_timestamp_ms IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.pending_produce_deferred_events d
       WHERE d.status = 'waiting'
         AND d.runtime_environment = NEW.runtime_environment
         AND d.session_key = NEW.session_key
         AND d.line_timestamp_ms > NEW.plain_text_opened_line_timestamp_ms
         AND d.line_timestamp_ms < NEW.close_event_timestamp_ms
     ) THEN
    RAISE EXCEPTION 'unresolved deferred Produce events for generation %', NEW.session_generation;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER pending_sessions_deferred_finalization_guard
BEFORE UPDATE OF finalization_status ON public.pending_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_pending_produce_deferred_finalization();

REVOKE ALL ON FUNCTION public.open_pending_plain_text_generation(
  text, text, text, text, bigint, text, text, boolean, integer, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_pending_plain_text_generation(
  text, text, text, text, bigint, text, text, boolean, integer, uuid, text
) TO service_role;
REVOKE ALL ON FUNCTION public.append_or_defer_pending_produce_item(
  uuid, text, text, text, text, bigint, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_or_defer_pending_produce_item(
  uuid, text, text, text, text, bigint, text, text, text
) TO service_role;
REVOKE ALL ON FUNCTION public.claim_expired_pending_produce_events(integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_expired_pending_produce_events(integer, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.guard_pending_produce_deferred_finalization()
  FROM PUBLIC, anon, authenticated;
