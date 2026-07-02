-- Universal Units + Generic Price-Basis Support.
--
-- Scope of THIS migration only:
--   1. Retire the hard-coded unit whitelist (produce_items_unit_check has
--      been re-declared 9 times across 0002/0013/0016/0017/0018/0025/0026 to
--      add one unit each time). Replaced with a non-empty check — the
--      extensible alias/conversion strategy now lives entirely in the
--      application parser (src/lib/parsers/weigh-session/units.ts). Any
--      unit text may be stored; nothing here validates unit spelling.
--   2. Add basis_quantity/basis_unit/basis_price to produce_items, for
--      bundled-price lines like "3หัว20บาท" (3 หัว for 20 บาท).
--   3. Extend produce_transactions (pure column append — see 0011 for the
--      last committed definition) with the new basis columns, a computed
--      pricing_mode, and a basis-aware total_amount that never derives from
--      the rounded price_per_unit display approximation.
--   4. Re-create try_finalize_pending_generation (from 0032) with the SAME
--      signature so existing grants are preserved automatically — the only
--      change is three additional columns on the produce_items INSERT.
--      No barrier/generation/closing logic is touched.
--
-- Does not touch: deferred-close timing, session identity/generation
-- semantics, cron, slips, reconciliation, or any other report.

-- ── 1. Retire the unit whitelist ────────────────────────────────────────────
ALTER TABLE public.produce_items
  DROP CONSTRAINT IF EXISTS produce_items_unit_check;

ALTER TABLE public.produce_items
  ADD CONSTRAINT produce_items_unit_check
  CHECK (unit IS NULL OR length(btrim(unit)) > 0);

-- ── 2. Basis columns ─────────────────────────────────────────────────────────
ALTER TABLE public.produce_items
  ADD COLUMN IF NOT EXISTS basis_quantity numeric(10,3),
  ADD COLUMN IF NOT EXISTS basis_unit     text,
  ADD COLUMN IF NOT EXISTS basis_price    numeric(10,2);

-- ── 3. produce_transactions: append basis columns + basis-aware total ───────
-- CREATE OR REPLACE is sufficient here (no DROP needed) because we are only
-- appending new output columns at the end; no existing column changes
-- position, type, or name.
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
  CASE WHEN pi.basis_quantity IS NOT NULL THEN 'basis' ELSE 'unit' END AS pricing_mode
FROM  produce_items    pi
JOIN  produce_sessions ps ON ps.id = pi.session_id
LEFT JOIN raw_messages rm ON rm.id = ps.raw_message_id;

COMMENT ON VIEW public.produce_transactions IS
  'Primary operational view. Each row = one transaction (parsed product line). '
  'market_name is COALESCE(session_title, ''''). total_amount for basis rows is '
  'round(quantity * basis_price / basis_quantity, 2), never derived from the '
  'rounded price_per_unit display approximation.';

-- ── 4. try_finalize_pending_generation: pass basis fields through ──────────
-- Identical to the 0032 definition except the produce_items INSERT gains
-- basis_quantity/basis_unit/basis_price, sourced from the same jsonb item
-- payload the application already sends (src/lib/line/pending-session-finalizer.ts
-- spreads the parsed item, which now includes these fields, into p_items).
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
