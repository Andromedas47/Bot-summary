-- Append-only additional produce entries (เบิกเพิ่ม / ชั่งคืนเพิ่ม / คืนเสียเพิ่ม).
--
-- Live-vs-repo note (verified against production via PostgREST introspection
-- before writing this migration): production carries out-of-band columns this
-- repo never declared (produce_sessions.work_round_id,
-- produce_sessions.is_append_session, the work_rounds table and its RPCs).
-- This migration does not touch, reuse, or depend on any of them — the new
-- session_kind column is the sole provenance authority for this feature and
-- is unrelated to the deployed-but-unversioned is_append_session flag.
--
-- Scope (additive and backward-compatible only):
--   1. produce_sessions: session_kind / declared_transaction_type /
--      ingest_idempotency_key / ingest_source. Existing rows default to
--      session_kind = 'main'; NO backfill or inference of historical
--      เบิกเพิ่ม sessions as 'additional'.
--   2. produce_transactions view: append base_transaction_type,
--      session_kind, declared_transaction_type at the END of the column
--      list (CREATE OR REPLACE, existing column order unchanged — same
--      technique as 0033).
--   3. try_finalize_pending_generation: same signature (grants preserved),
--      now persists the provenance columns, treats the immutable
--      ingest_idempotency_key (session_key:generation) as authoritative
--      idempotency, and demotes the imported_sessions content hash to an
--      audit fingerprint for additional sessions (it is NOT a duplicate
--      blocker for them — two intentional additional batches with identical
--      content but different generations must both persist).
--
-- No DELETE / TRUNCATE / DROP TABLE / CASCADE. No mutation of existing
-- produce_items or produce_sessions rows.
--
-- Rollback notes (each step independently reversible, no data loss):
--   * function: re-apply the 0034 definition of
--     try_finalize_pending_generation (CREATE OR REPLACE, same signature).
--     New app code tolerates the old RPC: sessions then persist without the
--     new columns (session_kind defaults to 'main' at the column level).
--   * view: re-apply the 0033 definition of produce_transactions
--     (CREATE OR REPLACE removing only the appended trailing columns
--     requires DROP VIEW + CREATE VIEW with the 0033 body; consumers select
--     named columns, so leaving the appended columns in place is also safe).
--   * columns: ALTER TABLE public.produce_sessions
--       DROP COLUMN IF EXISTS ingest_source,
--       DROP COLUMN IF EXISTS ingest_idempotency_key,
--       DROP COLUMN IF EXISTS declared_transaction_type,
--       DROP COLUMN IF EXISTS session_kind;
--     (drop the view first if it still references them).
--   * index: DROP INDEX IF EXISTS produce_sessions_ingest_idem_key_idx;

-- ── 1. Session-level provenance ─────────────────────────────────────────────

ALTER TABLE public.produce_sessions
  ADD COLUMN IF NOT EXISTS session_kind text NOT NULL DEFAULT 'main'
    CHECK (session_kind IN ('main', 'additional')),
  ADD COLUMN IF NOT EXISTS declared_transaction_type text
    CHECK (declared_transaction_type IS NULL
           OR declared_transaction_type IN ('เบิก', 'คืน', 'คืนเสีย')),
  ADD COLUMN IF NOT EXISTS ingest_idempotency_key text,
  ADD COLUMN IF NOT EXISTS ingest_source text;

-- An additional session must always carry its declared base transaction type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'produce_sessions_additional_declared_type_check'
  ) THEN
    ALTER TABLE public.produce_sessions
      ADD CONSTRAINT produce_sessions_additional_declared_type_check
      CHECK (session_kind <> 'additional' OR declared_transaction_type IS NOT NULL);
  END IF;
END;
$$;

-- Authoritative idempotency: one produce session per immutable ingest
-- generation identity. Partial so legacy rows (NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS produce_sessions_ingest_idem_key_idx
  ON public.produce_sessions (ingest_idempotency_key)
  WHERE ingest_idempotency_key IS NOT NULL;

-- ── 2. produce_transactions: append provenance columns ──────────────────────
-- Pure trailing column append; CREATE OR REPLACE is sufficient (see 0033).
-- base_transaction_type maps legacy in-session marker types onto the three
-- accounting base types; new additional-session items are already stored as
-- base types, so this mapping only normalizes legacy rows for display.
CREATE OR REPLACE VIEW public.produce_transactions AS
SELECT
  pi.id,
  pi.item_number,
  pi.product_name,
  pi.price_per_unit,
  pi.quantity,
  CASE
    WHEN pi.basis_quantity IS NOT NULL AND pi.basis_price IS NOT NULL
         AND pi.basis_quantity <> 0 AND pi.quantity IS NOT NULL
    THEN ROUND(pi.quantity * pi.basis_price / pi.basis_quantity, 2)
    WHEN pi.quantity IS NOT NULL AND pi.price_per_unit IS NOT NULL
    THEN pi.quantity * pi.price_per_unit
    ELSE NULL
  END                                   AS total_amount,
  pi.unit,
  pi.section,
  pi.transaction_type,
  pi.item_hash,
  pi.created_at                         AS item_created_at,
  ps.id                                 AS session_id,
  ps.session_date                       AS transaction_date,
  ps.transaction_time,
  COALESCE(ps.session_title, '')        AS market_name,
  ps.staff_name,
  ps.sender_name,
  ps.created_at                         AS session_created_at,
  ps.raw_message_id,
  rm.raw_text                           AS source_message,
  pi.basis_quantity,
  pi.basis_unit,
  pi.basis_price,
  CASE WHEN pi.basis_quantity IS NOT NULL THEN 'basis' ELSE 'unit' END AS pricing_mode,
  CASE pi.transaction_type
    WHEN 'เบิกเพิ่ม'   THEN 'เบิก'
    WHEN 'ชั่งคืนเพิ่ม' THEN 'คืน'
    WHEN 'คืนเสียเพิ่ม' THEN 'คืนเสีย'
    ELSE pi.transaction_type
  END                                   AS base_transaction_type,
  ps.session_kind,
  ps.declared_transaction_type
FROM  produce_items    pi
JOIN  produce_sessions ps ON ps.id = pi.session_id
LEFT JOIN raw_messages rm ON rm.id = ps.raw_message_id;

COMMENT ON VIEW public.produce_transactions IS
  'Primary operational view. Each row = one transaction (parsed product line). '
  'market_name is COALESCE(session_title, ''''). total_amount for basis rows is '
  'round(quantity * basis_price / basis_quantity, 2). base_transaction_type '
  'normalizes legacy เบิกเพิ่ม/ชั่งคืนเพิ่ม/คืนเสียเพิ่ม onto เบิก/คืน/คืนเสีย; '
  'session_kind marks ชุดหลัก (main) vs ชุดเพิ่ม (additional).';

-- ── 3. try_finalize_pending_generation: provenance + append-only idempotency ─
-- Identical to the 0034 definition except:
--   a. p_session may carry session_kind / declared_transaction_type /
--      ingest_idempotency_key / ingest_source, persisted onto the new
--      produce_sessions columns (trailing column-list append only).
--   b. additional sessions require explicit staff, market, date, and a
--      declared base transaction type, and every item must already be a base
--      transaction type (เบิก/คืน/คืนเสีย) — violations fail closed.
--   c. ingest_idempotency_key is the authoritative idempotency identity: a
--      retry carrying a key that already produced a session terminates as
--      'duplicate' without new rows (the unique index is the hard guarantee).
--   d. the imported_sessions content hash stays a global blocker ONLY for
--      main sessions; for additional sessions it is recorded best-effort as
--      an audit fingerprint and a hash collision does NOT block persistence.
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
$$;
