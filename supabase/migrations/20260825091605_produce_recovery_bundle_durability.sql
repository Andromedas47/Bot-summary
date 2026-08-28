-- Task 3: durable boundary recovery hardening.
--
-- ── PROBLEM A — unkeyed episodes ────────────────────────────────────────────
-- A genuine no-header burst (item-only messages with NO pending_sessions row
-- at all) has no opener_line_event_id, no close_line_event_id, and no
-- session_generation to key a recovery bundle off. Every such row ends up
-- with all three NULL and is clustered as "unkeyed" — stored safely,
-- never recovered (see durableRecoveryBundleKey in pending-produce-recovery.ts).
--
-- Fix: assign a durable recovery_bundle_id at DEFER TIME (inside
-- append_or_defer_pending_produce_item), not reconstructed later from
-- timestamp gaps. Assignment is serialized by the SAME
-- pg_advisory_xact_lock(hashtextextended(p_session_key, 0)) this function
-- already takes at its top for the identical reason (opener/item ordering) —
-- no new lock, no new table, no new unique index. Two concurrent Vercel
-- instances calling this function for the same session_key fully serialize on
-- that lock, so bundle lookup+insert cannot race.
--
-- A bundle is "active" (reusable by the next unkeyed item) only while it still
-- has a member inside its OWN pre-existing bounded reorder window
-- (status = 'waiting' AND expires_at > now()) — the same 30-second bound every
-- deferred row already carries, not a new heuristic. Once every member's
-- window elapses, the bundle is retired implicitly: no write, no "closed_at"
-- column, no cron. The next unkeyed item gets a fresh bundle id, so a 09:00
-- burst and a 14:00 burst can never merge. The column is copied forward
-- unchanged by claim_expired_pending_produce_events, so it survives the
-- waiting -> rejected_orphan transition for free.
--
-- ── PROBLEM B — transient deferred status after partial recovery ───────────
-- The old recovery loop (recoverLatestRejectedBundle) called
-- append_pending_session for each event and only batched
-- markDeferredEventsRecovered AFTER the whole loop finished without throwing.
-- A non-boundary error partway through left already-appended events
-- durably in pending_sessions.accumulated_text while their
-- pending_produce_deferred_events row still said 'waiting' — which the
-- guard_pending_produce_deferred_finalization trigger (0033) then reads as
-- "unresolved", permanently blocking that generation's finalization until an
-- operator manually flips the row.
--
-- Fix: recover_pending_produce_deferred_event ties the append and the
-- deferred-status flip into ONE transaction, reusing append_pending_session
-- exactly the way open_pending_plain_text_generation already calls it from
-- inside another function. Either both commit or neither does — there is no
-- window where one exists without the other, so retry (or a later recovery
-- attempt) converges with no manual cleanup, and append idempotency itself is
-- untouched.

ALTER TABLE public.pending_produce_deferred_events
  ADD COLUMN IF NOT EXISTS recovery_bundle_id uuid;

COMMENT ON COLUMN public.pending_produce_deferred_events.recovery_bundle_id IS
  'Durable identity for one no-header burst, assigned once at defer time under '
  'the session_key advisory lock. NULL for pre-migration rows and for rows '
  'resolved through the fast (non-deferred) admit path. Never reconstructed '
  'from timestamps after the fact.';

CREATE INDEX IF NOT EXISTS pending_produce_deferred_active_bundle_idx
  ON public.pending_produce_deferred_events (
    session_key, runtime_environment, expires_at
  )
  WHERE status = 'waiting' AND recovery_bundle_id IS NOT NULL;

-- Reuses the exact function signature; body adds bundle assignment only.
CREATE OR REPLACE FUNCTION public.append_or_defer_pending_produce_item(
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
  v_bundle_id uuid;
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

  -- Durable recovery-bundle identity (Task 3 / PROBLEM A). Computed under the
  -- same advisory lock taken above, so a second concurrent call for this
  -- session_key cannot observe a stale "no active bundle" snapshot. See the
  -- migration header for why this predicate is the right "closing" rule.
  SELECT recovery_bundle_id INTO v_bundle_id
  FROM public.pending_produce_deferred_events
  WHERE session_key = p_session_key
    AND runtime_environment = p_runtime_environment
    AND status = 'waiting'
    AND recovery_bundle_id IS NOT NULL
    AND expires_at > clock_timestamp()
  ORDER BY line_timestamp_ms, line_event_id
  LIMIT 1;
  IF v_bundle_id IS NULL THEN
    v_bundle_id := gen_random_uuid();
  END IF;

  INSERT INTO public.pending_produce_deferred_events (
    line_event_id, raw_message_id, session_key, source_id, line_user_id,
    line_timestamp_ms, raw_text, reply_token, runtime_environment,
    recovery_bundle_id
  ) VALUES (
    p_line_event_id, p_raw_message_id, p_session_key, p_source_id, p_line_user_id,
    p_line_timestamp_ms, p_raw_text, p_reply_token, p_runtime_environment,
    v_bundle_id
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

-- PROBLEM B: append and the deferred-status flip in ONE transaction, so a
-- crash between them is impossible. append_pending_session already takes its
-- own row lock on pending_sessions and is itself idempotent by line_event_id
-- (admission/ingest ON CONFLICT DO NOTHING) — no additional advisory lock is
-- needed here; the only new guarantee this wrapper adds is atomicity between
-- the append and the pending_produce_deferred_events status update.
CREATE FUNCTION public.recover_pending_produce_deferred_event(
  p_session_key                  text,
  p_line_event_id                text,
  p_raw_text                     text,
  p_reply_token                  text,
  p_line_timestamp_ms            bigint,
  p_expected_session_generation  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_append jsonb;
BEGIN
  IF COALESCE(btrim(p_session_key), '') = ''
     OR COALESCE(btrim(p_line_event_id), '') = ''
     OR p_expected_session_generation IS NULL THEN
    RAISE EXCEPTION 'deferred Produce recovery requires a session key, line event id, and expected generation';
  END IF;

  v_append := public.append_pending_session(
    p_session_key, p_raw_text, p_reply_token, p_line_event_id,
    p_line_timestamp_ms, false, p_expected_session_generation, NULL
  );

  IF COALESCE((v_append->>'accepted')::boolean, false) THEN
    UPDATE public.pending_produce_deferred_events
    SET status = 'admitted',
        defer_reason = 'explicit_recovery',
        session_generation = p_expected_session_generation,
        resolved_at = clock_timestamp()
    WHERE line_event_id = p_line_event_id
      AND status IN (
        'waiting', 'rejected_before_opener', 'rejected_after_close', 'rejected_orphan'
      );
  END IF;

  RETURN v_append;
END;
$fn$;

COMMENT ON FUNCTION public.recover_pending_produce_deferred_event(
  text, text, text, text, bigint, uuid
) IS
  'Explicit-recovery append: calls append_pending_session and, only if accepted, '
  'flips the matching pending_produce_deferred_events row to admitted in the SAME '
  'transaction. Eliminates the "appended but still shows waiting/rejected" window '
  'that otherwise needs manual cleanup after a partial-recovery crash.';

REVOKE ALL ON FUNCTION public.append_or_defer_pending_produce_item(
  uuid, text, text, text, text, bigint, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_or_defer_pending_produce_item(
  uuid, text, text, text, text, bigint, text, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.recover_pending_produce_deferred_event(
  text, text, text, text, bigint, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_pending_produce_deferred_event(
  text, text, text, text, bigint, uuid
) TO service_role;
