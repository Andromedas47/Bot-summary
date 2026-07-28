-- 0050: Produce Finalization Hold.
--
-- WHAT THIS IS
-- ------------
-- The database half of the structured Produce review gate: three nullable hold
-- columns on public.pending_sessions, a 10-minute hold set by structured close,
-- a confirm RPC that releases the hold only when admission/ingest parity is
-- ready, and a try_finalize gate that blocks Produce persistence until confirm
-- or fails closed on expiry.
--
-- WHAT THIS IS NOT
-- ----------------
--   * no Guided Menu / postback wiring (0051);
--   * no change to the sweeper query or pg_cron schedule;
--   * no rewrite of 0049 / 0048 / 0042;
--   * no historical backfill — every pre-existing row keeps hold fields NULL;
--   * no Produce writes inside the confirm RPC.
--
-- UX CONTRACT
-- -----------
-- ตรวจและจบ → immutable close + finalize_hold_until = now()+10m
-- → parity may settle while held → confirm releases hold
-- → sweeper finalizes exactly once → expiry fails closed (review_not_confirmed).

-- ── 0) Preconditions ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION '0050: required table public.pending_sessions is missing';
  END IF;
  IF to_regprocedure(
    'public.close_produce_structured_session(text,text,text,bigint,uuid,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION '0050: close_produce_structured_session missing; apply 0049 first';
  END IF;
  IF to_regprocedure('public.check_pending_close_ready(text)') IS NULL THEN
    RAISE EXCEPTION '0050: check_pending_close_ready missing; apply 0048/0049 first';
  END IF;
  -- try_finalize_pending_generation is CREATE OR REPLACE'd below from the live
  -- 0036 body plus the hold gate. The 0049 Docker bootstrap does not install
  -- 0032–0036, so its prior existence is not required here.
END $$;

-- ── 1) Hold columns (nullable, no DEFAULT, no backfill) ──────────────────────

ALTER TABLE public.pending_sessions
  ADD COLUMN finalize_hold_until            timestamptz,
  ADD COLUMN finalize_confirmed_at          timestamptz,
  ADD COLUMN finalize_confirm_line_event_id text;

COMMENT ON COLUMN public.pending_sessions.finalize_hold_until IS
  'Non-NULL blocks Produce persistence for a structured session until confirm or expiry.';
COMMENT ON COLUMN public.pending_sessions.finalize_confirmed_at IS
  'Operator confirmation instant for structured finalization. Paired with finalize_confirm_line_event_id.';
COMMENT ON COLUMN public.pending_sessions.finalize_confirm_line_event_id IS
  'Real LINE event id that confirmed finalization. Never synthesized.';

-- ── 2) DB-enforced invariants ────────────────────────────────────────────────

ALTER TABLE public.pending_sessions
  ADD CONSTRAINT pending_sessions_finalize_hold_structured_only
    CHECK (
      entry_origin IS NOT NULL
      OR (
        finalize_hold_until IS NULL
        AND finalize_confirmed_at IS NULL
        AND finalize_confirm_line_event_id IS NULL
      )
    ),

  ADD CONSTRAINT pending_sessions_finalize_confirm_pair
    CHECK (
      (finalize_confirmed_at IS NULL) = (finalize_confirm_line_event_id IS NULL)
    ),

  ADD CONSTRAINT pending_sessions_finalize_confirm_releases_hold
    CHECK (
      finalize_confirmed_at IS NULL OR finalize_hold_until IS NULL
    ),

  ADD CONSTRAINT pending_sessions_finalize_confirm_event_nonblank
    CHECK (
      finalize_confirm_line_event_id IS NULL
      OR btrim(finalize_confirm_line_event_id) <> ''
    );

-- ── 3) Structured close — signature unchanged, sets 10-minute hold ───────────

CREATE OR REPLACE FUNCTION public.close_produce_structured_session(
  p_session_key                 text,
  p_line_user_id                text,
  p_close_line_event_id         text,
  p_line_timestamp_ms           bigint,
  p_expected_session_generation uuid DEFAULT NULL,
  p_expected_item_count         integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_row  public.pending_sessions%ROWTYPE;
  v_user text;
BEGIN
  v_user := btrim(coalesce(p_line_user_id, ''));
  IF length(v_user) = 0 THEN
    RAISE EXCEPTION '0049: line_user_id is required for a structured session command';
  END IF;
  IF p_close_line_event_id IS NULL OR length(btrim(p_close_line_event_id)) = 0 THEN
    RAISE EXCEPTION '0049: close_line_event_id is required';
  END IF;
  IF p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION '0049: line_timestamp_ms must be positive';
  END IF;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  -- Structured commands never drive a legacy row: that would close a session
  -- whose metadata the structured finalization path is not entitled to trust.
  IF v_row.entry_origin IS NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_structured');
  END IF;

  IF v_row.line_user_id IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'ownership_conflict');
  END IF;

  IF p_expected_session_generation IS NOT NULL
     AND v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object(
      'accepted', false, 'reason', 'terminalized', 'session', to_jsonb(v_row)
    );
  END IF;

  -- Redelivery of the same close postback, and any repeat close, are status
  -- requests. The boundary set by the first close is immutable.
  IF v_row.close_event_timestamp_ms IS NOT NULL THEN
    RETURN jsonb_build_object(
      'accepted', true, 'reason', 'close_already_requested', 'session', to_jsonb(v_row)
    );
  END IF;

  IF p_expected_item_count IS NOT NULL AND p_expected_item_count < 1 THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'invalid_expected_item_count');
  END IF;

  UPDATE public.pending_sessions
  SET
    close_event_timestamp_ms = p_line_timestamp_ms,
    close_requested_at       = now(),
    close_line_event_id      = btrim(p_close_line_event_id),
    close_session_generation = session_generation,
    close_deadline_at        = now() + interval '30 seconds',
    next_attempt_at          = now() + interval '8 seconds',
    expected_item_count      = p_expected_item_count,
    finalize_hold_until      = now() + interval '10 minutes',
    updated_at               = now(),
    ingest_revision          = ingest_revision + 1
  WHERE session_key = p_session_key
    AND session_generation = v_row.session_generation
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  RETURN jsonb_build_object(
    'accepted', true, 'reason', 'first_close', 'session', to_jsonb(v_row)
  );
END;
$fn$;

COMMENT ON FUNCTION public.close_produce_structured_session(
  text, text, text, bigint, uuid, integer
) IS
  'SECURITY INVOKER. Sets the immutable close boundary for a structured produce session '
  'from real postback evidence and arms a 10-minute finalization hold. Creates no admission '
  'row, no ingest row and no synthetic close text. Repeat close is a status request; refuses '
  'legacy (entry_origin IS NULL) rows.';

REVOKE ALL ON FUNCTION public.close_produce_structured_session(
  text, text, text, bigint, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_produce_structured_session(
  text, text, text, bigint, uuid, integer
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_produce_structured_session(
  text, text, text, bigint, uuid, integer
) TO service_role;

-- ── 4) Confirm RPC — releases hold when parity is ready ──────────────────────

CREATE OR REPLACE FUNCTION public.confirm_produce_structured_finalization(
  p_session_key                 text,
  p_line_user_id                text,
  p_confirm_line_event_id       text,
  p_expected_session_generation uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_row    public.pending_sessions%ROWTYPE;
  v_user   text;
  v_event  text;
  v_ready  jsonb;
BEGIN
  v_user := btrim(coalesce(p_line_user_id, ''));
  IF length(v_user) = 0 THEN
    RAISE EXCEPTION '0050: line_user_id is required for finalization confirmation';
  END IF;

  v_event := btrim(coalesce(p_confirm_line_event_id, ''));
  IF length(v_event) = 0 THEN
    RAISE EXCEPTION '0050: confirm_line_event_id is required';
  END IF;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  IF v_row.entry_origin IS NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_structured');
  END IF;

  IF v_row.line_user_id IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'ownership_conflict');
  END IF;

  IF p_expected_session_generation IS NOT NULL
     AND v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object(
      'accepted', false, 'reason', 'terminalized', 'session', to_jsonb(v_row)
    );
  END IF;

  IF v_row.close_event_timestamp_ms IS NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_closing');
  END IF;

  -- Duplicate / replay: first confirmation wins; any later event is a no-op.
  IF v_row.finalize_confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'accepted', true, 'reason', 'already_confirmed', 'session', to_jsonb(v_row)
    );
  END IF;

  IF v_row.finalize_hold_until IS NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_held');
  END IF;

  IF now() >= v_row.finalize_hold_until THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'hold_expired');
  END IF;

  v_ready := public.check_pending_close_ready(p_session_key);
  IF coalesce(v_ready->>'ready', 'false') <> 'true' THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'reason', 'not_ready',
      'readiness_reason', coalesce(v_ready->>'reason', 'not_ready'),
      'admission_count', coalesce((v_ready->>'admission_count')::integer, 0),
      'ingest_count', coalesce((v_ready->>'ingest_count')::integer, 0),
      'straggler_count', coalesce((v_ready->>'straggler_count')::integer, 0)
    );
  END IF;

  UPDATE public.pending_sessions
  SET
    finalize_confirmed_at          = now(),
    finalize_confirm_line_event_id = v_event,
    finalize_hold_until            = NULL,
    next_attempt_at                = now(),
    updated_at                     = now(),
    ingest_revision                = ingest_revision + 1
  WHERE session_key = p_session_key
    AND session_generation = v_row.session_generation
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  RETURN jsonb_build_object(
    'accepted', true, 'reason', 'confirmed', 'session', to_jsonb(v_row)
  );
END;
$fn$;

COMMENT ON FUNCTION public.confirm_produce_structured_finalization(
  text, text, text, uuid
) IS
  'SECURITY INVOKER. Releases the structured finalization hold after operator confirmation '
  'when admission/ingest parity is ready. Writes no Produce rows, no admission and no ingest.';

REVOKE ALL ON FUNCTION public.confirm_produce_structured_finalization(
  text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_produce_structured_finalization(
  text, text, text, uuid
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_produce_structured_finalization(
  text, text, text, uuid
) TO service_role;

-- ── 5) try_finalize — hold gate before Produce writes ────────────────────────

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

-- ── 6) Postconditions ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count int;
  v_body  text;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'pending_sessions'
    AND column_name IN (
      'finalize_hold_until',
      'finalize_confirmed_at',
      'finalize_confirm_line_event_id'
    );
  IF v_count <> 3 THEN
    RAISE EXCEPTION '0050: expected 3 hold columns, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'pending_sessions'
    AND c.conname IN (
      'pending_sessions_finalize_hold_structured_only',
      'pending_sessions_finalize_confirm_pair',
      'pending_sessions_finalize_confirm_releases_hold',
      'pending_sessions_finalize_confirm_event_nonblank'
    )
    AND c.convalidated;
  IF v_count <> 4 THEN
    RAISE EXCEPTION '0050: expected 4 validated hold constraints, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.pending_sessions
  WHERE finalize_hold_until IS NOT NULL
     OR finalize_confirmed_at IS NOT NULL
     OR finalize_confirm_line_event_id IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0050: hold fields must not be backfilled; found % rows', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'confirm_produce_structured_finalization';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0050: expected exactly one confirm RPC overload, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'confirm_produce_structured_finalization'
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION '0050: confirm_produce_structured_finalization must be SECURITY INVOKER';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.confirm_produce_structured_finalization(text,text,text,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.confirm_produce_structured_finalization(text,text,text,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION '0050: anon/authenticated must not execute confirm RPC';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.confirm_produce_structured_finalization(text,text,text,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION '0050: service_role must execute confirm RPC';
  END IF;

  IF to_regprocedure(
    'public.close_produce_structured_session(text,text,text,bigint,uuid,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION '0050: close signature must remain unchanged';
  END IF;

  SELECT pg_get_functiondef(
    'public.close_produce_structured_session(text,text,text,bigint,uuid,integer)'::regprocedure
  ) INTO v_body;
  IF position('10 minutes' IN v_body) = 0 THEN
    RAISE EXCEPTION '0050: close RPC must set finalize_hold_until to 10 minutes';
  END IF;

  SELECT pg_get_functiondef(
    'public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb)'::regprocedure
  ) INTO v_body;
  IF position('awaiting_confirmation' IN v_body) = 0
     OR position('review_not_confirmed' IN v_body) = 0 THEN
    RAISE EXCEPTION '0050: try_finalize must contain the hold gate';
  END IF;
END $$;
