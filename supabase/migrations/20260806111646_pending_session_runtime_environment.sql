-- Environment ownership for pending_sessions, so the produce close-barrier
-- sweep (finalizeDuePendingGenerations, cron: finalize-pending-produce-sessions)
-- can never let a Production worker claim a Preview-created session or vice
-- versa. Preview and Production currently share one Supabase project; the
-- sweep query had no environment scope at all, so whichever deployment's
-- cron polled first won the row regardless of which deployment created it —
-- confirmed in UAT: a Preview-created session was finalized by Production's
-- pre-fix parser code.
--
-- Nullable, no backfill: existing rows predate this concept entirely and are
-- treated as Production's own by the application-layer sweep filter (see
-- getRuntimeEnvironment() callers) — that preserves current Production
-- behavior for anything already in flight. Preview/development sweeps never
-- match NULL.

ALTER TABLE public.pending_sessions
  ADD COLUMN runtime_environment text;

ALTER TABLE public.pending_sessions
  ADD CONSTRAINT pending_sessions_runtime_environment_check
  CHECK (runtime_environment IS NULL OR runtime_environment IN ('production', 'preview', 'development'));

-- Partial index matching the sweep's own predicate shape (terminalized=false
-- rows only) plus the new environment filter, so the added WHERE clause
-- doesn't degrade the existing due-session scan.
CREATE INDEX pending_sessions_runtime_environment_sweep_idx
  ON public.pending_sessions (runtime_environment, next_attempt_at)
  WHERE terminalized = false;

-- ── Extend the same boundary through the produce notification outbox ────────
--
-- Preview successfully finalizing a session (the fix above) creates a
-- produce_session_notifications row. Production's globally scoped
-- claim_due_produce_notifications RPC could then claim that Preview
-- notification and push it using Production's own LINE credentials — the
-- write would succeed while the Preview/Test OA channel never receives it.
-- Same nullable/no-backfill/production-owns-legacy shape as pending_sessions.
--
-- Ownership is stamped from the originating pending_sessions row at the
-- single place a notification row is ever created (try_finalize_pending_generation,
-- 0050) — never re-derived independently later, so it can't drift from the
-- session that actually produced it.

ALTER TABLE public.produce_session_notifications
  ADD COLUMN runtime_environment text;

ALTER TABLE public.produce_session_notifications
  ADD CONSTRAINT produce_session_notifications_runtime_environment_check
  CHECK (runtime_environment IS NULL OR runtime_environment IN ('production', 'preview', 'development'));

-- Matches claim_due_produce_notifications' own candidate predicate shape.
CREATE INDEX produce_notifications_runtime_environment_due_idx
  ON public.produce_session_notifications (runtime_environment, next_notification_attempt_at)
  WHERE notification_status IN ('pending', 'failed') AND notification_retryable = true;

-- try_finalize_pending_generation (0050), reissued in full — Postgres
-- functions replace as a whole unit, not as a diff — with exactly one
-- change: the notification INSERT now carries v_row.runtime_environment,
-- read from the same locked pending_sessions row (SELECT * INTO v_row ...
-- FOR UPDATE) already fetched at the top of the function. No new parameter,
-- no independent re-derivation.
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
AS $fn$
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
  v_session_kind            text;
  v_declared_tx_type        text;
  v_idempotency_key         text;
  v_ingest_source           text;
  v_existing_session_id     uuid;
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

  -- 0050: structured review hold. A structured session that has been closed for
  -- review must not persist until the operator confirms. Legacy rows never carry
  -- a hold (CHECK pending_sessions_finalize_hold_structured_only), so this block
  -- is unreachable for them.
  IF v_row.finalize_hold_until IS NOT NULL THEN
    IF now() < v_row.finalize_hold_until THEN
      UPDATE public.pending_sessions
         SET next_attempt_at = v_row.finalize_hold_until
       WHERE session_key = p_session_key
         AND session_generation = p_expected_generation;
      RETURN jsonb_build_object(
        'status', 'pending',
        'reason', 'awaiting_confirmation',
        'next_attempt_at', v_row.finalize_hold_until
      );
    END IF;

    -- expired unconfirmed: fail closed, write nothing
    UPDATE public.pending_sessions
       SET terminalized = true,
           next_attempt_at = NULL,
           finalized_at = clock_timestamp(),
           finalization_status = 'failed_closed',
           finalization_error = jsonb_build_object('reason', 'review_not_confirmed')
     WHERE session_key = p_session_key
       AND session_generation = p_expected_generation;
    RETURN jsonb_build_object(
      'status', 'failed_closed',
      'reason', 'review_not_confirmed'
    );
  END IF;

  -- 0050 H-1: a structured session that is closing without a hold and without
  -- confirmation (for example plain-text "จบรายการ" via append markClose) must
  -- never persist. Legacy rows (entry_origin IS NULL) skip this guard.
  -- Confirmed structured rows (finalize_confirmed_at IS NOT NULL) continue.
  IF v_row.entry_origin IS NOT NULL
     AND v_row.finalize_confirmed_at IS NULL THEN
    UPDATE public.pending_sessions
       SET terminalized = true,
           next_attempt_at = NULL,
           finalized_at = clock_timestamp(),
           finalization_status = 'failed_closed',
           finalization_error = jsonb_build_object(
             'reason', 'unconfirmed_structured_close'
           )
     WHERE session_key = p_session_key
       AND session_generation = p_expected_generation;
    RETURN jsonb_build_object(
      'status', 'failed_closed',
      'reason', 'unconfirmed_structured_close'
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

  v_session_kind    := COALESCE(NULLIF(btrim(p_session->>'session_kind'), ''), 'main');
  v_declared_tx_type := NULLIF(btrim(p_session->>'declared_transaction_type'), '');
  v_idempotency_key := NULLIF(btrim(p_session->>'ingest_idempotency_key'), '');
  v_ingest_source   := NULLIF(btrim(p_session->>'ingest_source'), '');

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

  IF v_session_kind NOT IN ('main', 'additional') THEN
    v_validation := v_validation || jsonb_build_array('invalid session_kind');
    v_session_kind := 'main';
  END IF;

  -- Additional sessions require explicit provenance — no fallbacks.
  IF v_session_kind = 'additional' THEN
    IF v_declared_tx_type IS NULL
       OR v_declared_tx_type NOT IN ('เบิก', 'คืน', 'คืนเสีย') THEN
      v_validation := v_validation
        || jsonb_build_array('additional session requires a declared base transaction type');
    END IF;
    IF COALESCE(btrim(p_session->>'session_date'), '') = '' THEN
      v_validation := v_validation
        || jsonb_build_array('additional session requires an explicit date');
    END IF;
    IF COALESCE(btrim(p_session->>'session_title'), '') = '' THEN
      v_validation := v_validation
        || jsonb_build_array('additional session requires an explicit market');
    END IF;
    IF jsonb_typeof(p_items) = 'array' AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_items) AS item
      WHERE COALESCE(btrim(item->>'transaction_type'), '')
              NOT IN ('เบิก', 'คืน', 'คืนเสีย')
    ) THEN
      v_validation := v_validation
        || jsonb_build_array('additional session items must use base transaction types');
    END IF;
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

  -- Authoritative idempotency: the immutable ingest/generation identity. A
  -- retry that already produced a session terminates without new rows.
  IF v_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_session_id
    FROM public.produce_sessions
    WHERE ingest_idempotency_key = v_idempotency_key;

    IF v_existing_session_id IS NOT NULL THEN
      v_finalized_at := clock_timestamp();
      UPDATE public.pending_sessions
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = v_finalized_at,
          finalization_status = 'duplicate'
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'duplicate',
        'reason', 'idempotency_key',
        'session_id', v_existing_session_id
      );
    END IF;
  END IF;

  v_notification_payload := p_session->>'notification_payload';
  v_notification_source_id := p_session->>'notification_source_id';
  v_correlation_id := COALESCE(
    NULLIF(p_session->>'correlation_id', ''),
    p_session_key || ':' || p_expected_generation::text
  );

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

  -- Content hash is a global duplicate blocker for main sessions only. For
  -- additional sessions it is a best-effort audit fingerprint: two
  -- intentional additional batches with identical content but different
  -- generation identities must both persist.
  IF v_imported_id IS NULL AND v_session_kind = 'main' THEN
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
    finalization_started_at, finalized_at,
    session_kind, declared_transaction_type,
    ingest_idempotency_key, ingest_source
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
    v_finalized_at,
    v_session_kind,
    v_declared_tx_type,
    v_idempotency_key,
    v_ingest_source
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
    notification_payload,
    runtime_environment
  )
  VALUES (
    v_session_id,
    p_session_key,
    p_expected_generation,
    v_notification_source_id,
    v_correlation_id,
    v_notification_payload,
    v_row.runtime_environment
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
$fn$;

REVOKE ALL ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb
) TO service_role;

-- claim_due_produce_notifications (0034): add a required environment
-- parameter so Production and Preview can never dequeue each other's
-- notification rows. NULL runtime_environment (legacy, pre-0061) is
-- Production's own, same compatibility rule as pending_sessions;
-- Preview/development must match exactly, never NULL.
--
-- Rollout ordering: this migration must apply to the shared database before
-- any deployment (Production or Preview) runs the new code that calls the
-- 2-arg RPC. Until every deployment is redeployed, Production's *currently
-- running* cron process still calls the old 1-arg signature — dropping it
-- here would break that in-flight deployment the instant the migration
-- lands, before its own redeploy. So the 1-arg overload is kept, not
-- dropped: it becomes a thin wrapper hardcoded to p_environment='production'
-- (preserving exactly its current real-world behavior — it has only ever
-- run on Production) and delegates to the new 2-arg function for the actual
-- claim logic. Remove the 1-arg wrapper in a later migration once every
-- deployment is confirmed to be calling the 2-arg RPC.
CREATE OR REPLACE FUNCTION public.claim_due_produce_notifications(
  p_limit       integer DEFAULT 25,
  p_environment text    DEFAULT NULL
)
RETURNS SETOF public.produce_session_notifications
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'claim_due_produce_notifications: p_environment must be production, preview, or development, got %', p_environment;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT n.id, n.notification_status AS previous_status
    FROM public.produce_session_notifications n
    WHERE (
      (
        n.notification_status IN ('pending', 'failed')
        AND n.notification_retryable = true
        AND n.next_notification_attempt_at <= now()
      ) OR (
        n.notification_status = 'sending'
        AND n.sending_started_at <= now() - interval '2 minutes'
      )
    )
    AND (
      CASE
        WHEN p_environment = 'production'
          THEN n.runtime_environment = 'production' OR n.runtime_environment IS NULL
        ELSE n.runtime_environment = p_environment
      END
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

REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_produce_notifications(integer, text) TO service_role;

-- Legacy 1-arg wrapper — kept for rollout safety (see note above), reissued
-- so its body no longer runs the old unscoped 0034 query. Delegates to the
-- 2-arg function with p_environment hardcoded to 'production': this matches
-- exactly what the 1-arg signature has only ever actually done in practice
-- (only Production's cron calls it), and means it can never claim a
-- 'preview' or 'development' row even if invoked from the wrong place.
CREATE OR REPLACE FUNCTION public.claim_due_produce_notifications(
  p_limit integer DEFAULT 25
)
RETURNS SETOF public.produce_session_notifications
LANGUAGE sql
AS $$
  SELECT * FROM public.claim_due_produce_notifications(p_limit, 'production');
$$;

REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_due_produce_notifications(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_produce_notifications(integer) TO service_role;
