-- Allow an authoritative House Stock snapshot with zero item rows.
-- App-layer still fail-closes unless the priced parser saw an explicit
-- empty declaration. Empty array is not inferred from parse failure.
-- No new tables/columns: snapshot header + item_count=0 is the contract.

ALTER TABLE public.physical_inventory_snapshots
  DROP CONSTRAINT IF EXISTS physical_inventory_snapshots_item_count_check;

DO $$
DECLARE
  v_con name;
BEGIN
  SELECT c.conname INTO v_con
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'physical_inventory_snapshots'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ~ 'item_count\s*>\s*0';
  IF v_con IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.physical_inventory_snapshots DROP CONSTRAINT %I',
      v_con
    );
  END IF;
END $$;

ALTER TABLE public.physical_inventory_snapshots
  ADD CONSTRAINT physical_inventory_snapshots_item_count_check
  CHECK (item_count >= 0);

CREATE OR REPLACE FUNCTION public.finalize_physical_inventory_session_base(
  p_session_id               uuid,
  p_expected_generation      uuid,
  p_expected_ingest_revision bigint,
  p_expected_ingest_hash     text,
  p_business_date            date,
  p_parser_version           text,
  p_warnings                 jsonb,
  p_items                    jsonb,
  p_fail_closed              boolean,
  p_fail_reason              text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session     public.physical_inventory_sessions%ROWTYPE;
  v_snapshot    public.physical_inventory_snapshots%ROWTYPE;
  v_key         text;
  v_item        jsonb;
  v_ord         int := 0;
  v_acc_norm    int := 0;
  v_acc_raw     int := 0;
  v_rejected    int := 0;
  v_item_count  int := 0;
  v_status      text;
  v_counted_at  timestamptz;
  v_now         timestamptz := clock_timestamp();
  v_hash        text;
  v_hash_in     text;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session_id required';
  END IF;
  IF p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'expected_generation required';
  END IF;
  v_hash_in := btrim(coalesce(p_expected_ingest_hash, ''));
  IF length(v_hash_in) = 0 THEN
    RAISE EXCEPTION 'expected_ingest_hash required';
  END IF;
  IF p_parser_version IS NULL OR btrim(p_parser_version) = '' THEN
    RAISE EXCEPTION 'parser_version required';
  END IF;

  SELECT * INTO v_session
  FROM public.physical_inventory_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'physical inventory session not found';
  END IF;

  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;

  v_key := v_session.id::text || ':' || v_session.session_generation::text;

  IF v_session.status = 'finalized' AND v_session.snapshot_id IS NOT NULL THEN
    SELECT * INTO v_snapshot
    FROM public.physical_inventory_snapshots
    WHERE id = v_session.snapshot_id;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'status', 'finalized',
      'snapshot_id', v_snapshot.id,
      'session_id', v_session.id,
      'finalized_ingest_revision', v_snapshot.finalized_ingest_revision,
      'finalized_ingest_hash', v_snapshot.finalized_ingest_hash
    );
  END IF;

  IF v_session.status = 'failed_closed' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'status', 'failed_closed',
      'snapshot_id', NULL,
      'session_id', v_session.id,
      'fail_reason', v_session.fail_reason
    );
  END IF;

  IF v_session.status IS DISTINCT FROM 'closing' THEN
    RAISE EXCEPTION 'close_boundary_required';
  END IF;

  IF v_session.close_event_timestamp_ms IS NULL
     OR v_session.close_quiet_until IS NULL
     OR v_session.close_deadline_at IS NULL THEN
    RAISE EXCEPTION 'close_boundary_required';
  END IF;

  IF v_session.ingest_revision IS DISTINCT FROM p_expected_ingest_revision THEN
    RAISE EXCEPTION 'stale_ingest_revision';
  END IF;

  v_hash := public.physical_inventory_compute_ingest_set_hash(p_session_id);
  IF v_hash IS DISTINCT FROM v_hash_in THEN
    RAISE EXCEPTION 'stale_ingest_hash';
  END IF;

  IF NOT (
    v_now >= v_session.close_quiet_until
    OR v_now >= v_session.close_deadline_at
  ) THEN
    RAISE EXCEPTION 'close_quiet_window';
  END IF;

  IF coalesce(p_fail_closed, false) THEN
    UPDATE public.physical_inventory_sessions
    SET status = 'failed_closed',
        failed_closed_at = v_now,
        closed_at = v_now,
        fail_reason = coalesce(nullif(btrim(p_fail_reason), ''), 'failed_closed'),
        warnings = coalesce(p_warnings, '[]'::jsonb),
        parser_version = btrim(p_parser_version),
        updated_at = v_now
    WHERE id = v_session.id;

    INSERT INTO public.physical_inventory_lifecycle_events (
      session_id, event, actor, detail
    ) VALUES (
      v_session.id,
      'failed_closed',
      'system',
      jsonb_build_object(
        'fail_reason', coalesce(p_fail_reason, 'failed_closed'),
        'finalized_ingest_revision', v_session.ingest_revision,
        'finalized_ingest_hash', v_hash
      )
    );

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', false,
      'status', 'failed_closed',
      'snapshot_id', NULL,
      'session_id', v_session.id,
      'fail_reason', coalesce(p_fail_reason, 'failed_closed'),
      'finalized_ingest_revision', v_session.ingest_revision,
      'finalized_ingest_hash', v_hash
    );
  END IF;

  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date_required';
  END IF;

  -- Empty array is a valid authoritative snapshot (item_count=0).
  -- Null or non-array payloads remain illegal.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'items_required';
  END IF;

  v_item_count := jsonb_array_length(p_items);
  v_counted_at := to_timestamp(v_session.close_event_timestamp_ms / 1000.0);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_status := v_item->>'resolution_status';
    IF v_status = 'ACCEPTED_NORMALIZED' THEN
      v_acc_norm := v_acc_norm + 1;
    ELSIF v_status = 'ACCEPTED_RAW' THEN
      v_acc_raw := v_acc_raw + 1;
    ELSIF v_status = 'REJECTED' THEN
      v_rejected := v_rejected + 1;
    ELSE
      RAISE EXCEPTION 'invalid_resolution_status';
    END IF;
  END LOOP;

  IF v_acc_norm + v_acc_raw + v_rejected <> v_item_count THEN
    RAISE EXCEPTION 'item_count_mismatch';
  END IF;

  INSERT INTO public.physical_inventory_snapshots (
    session_id,
    warehouse_code,
    source_type,
    source_id,
    sender_line_user_id,
    business_date,
    counted_at,
    parser_version,
    accepted_normalized_count,
    accepted_raw_count,
    rejected_count,
    item_count,
    warnings,
    status,
    ingest_idempotency_key,
    finalized_ingest_revision,
    finalized_ingest_hash,
    finalized_at
  ) VALUES (
    v_session.id,
    'MAIN',
    v_session.source_type,
    v_session.source_id,
    v_session.sender_line_user_id,
    p_business_date,
    v_counted_at,
    btrim(p_parser_version),
    v_acc_norm,
    v_acc_raw,
    v_rejected,
    v_item_count,
    coalesce(p_warnings, '[]'::jsonb),
    'finalized',
    v_key,
    v_session.ingest_revision,
    v_hash,
    v_now
  )
  RETURNING * INTO v_snapshot;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_ord := v_ord + 1;
    INSERT INTO public.physical_inventory_items (
      snapshot_id,
      item_ordinal,
      staff_sequence,
      raw_text,
      raw_product_description,
      normalized_product,
      quantity,
      raw_unit,
      normalized_unit,
      resolution_status,
      reason
    ) VALUES (
      v_snapshot.id,
      v_ord,
      NULLIF(v_item->>'staff_sequence', '')::int,
      coalesce(v_item->>'raw_text', ''),
      v_item->>'raw_product_description',
      v_item->>'normalized_product',
      NULLIF(v_item->>'quantity', '')::numeric,
      v_item->>'raw_unit',
      v_item->>'normalized_unit',
      v_item->>'resolution_status',
      v_item->>'reason'
    );
  END LOOP;

  UPDATE public.physical_inventory_sessions
  SET status = 'finalized',
      closed_at = v_now,
      business_date = p_business_date,
      parser_version = btrim(p_parser_version),
      snapshot_id = v_snapshot.id,
      warnings = coalesce(p_warnings, '[]'::jsonb),
      updated_at = v_now
  WHERE id = v_session.id;

  INSERT INTO public.physical_inventory_lifecycle_events (
    session_id, snapshot_id, event, actor, detail
  ) VALUES (
    v_session.id,
    v_snapshot.id,
    'finalized',
    'system',
    jsonb_build_object(
      'item_count', v_item_count,
      'accepted_normalized_count', v_acc_norm,
      'accepted_raw_count', v_acc_raw,
      'rejected_count', v_rejected,
      'counted_at', v_counted_at,
      'finalized_ingest_revision', v_session.ingest_revision,
      'finalized_ingest_hash', v_hash
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'status', 'finalized',
    'snapshot_id', v_snapshot.id,
    'session_id', v_session.id,
    'item_count', v_item_count,
    'counted_at', v_counted_at,
    'finalized_ingest_revision', v_session.ingest_revision,
    'finalized_ingest_hash', v_hash
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_physical_inventory_session_base(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) IS
  'SECURITY DEFINER. Atomically finalize or fail-close after close barrier. '
  'Empty item arrays are allowed as authoritative zero-count snapshots. '
  'Never posts ledger. Failed_closed cannot skip CLOSING/close barrier.';

REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session_base(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finalize_physical_inventory_session(
  p_session_id               uuid,
  p_expected_generation      uuid,
  p_expected_ingest_revision bigint,
  p_expected_ingest_hash     text,
  p_business_date            date,
  p_parser_version           text,
  p_warnings                 jsonb,
  p_items                    jsonb,
  p_fail_closed              boolean,
  p_fail_reason              text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_parser_version = 'house-stock-priced-1.0.0'
     AND NOT coalesce(p_fail_closed, false)
     AND (
       p_items IS NULL
       OR jsonb_typeof(p_items) <> 'array'
       OR (
         jsonb_array_length(p_items) > 0
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(p_items) item
           WHERE coalesce(item->>'unit_price_satang', '') !~ '^[0-9]+$'
              OR (item->>'unit_price_satang')::numeric <= 0
              OR (item->>'unit_price_satang')::numeric > 9223372036854775807
         )
       )
     ) THEN
    RAISE EXCEPTION 'priced_house_stock_unit_price_required';
  END IF;

  PERFORM set_config(
    'bot_summary.priced_house_stock_items',
    CASE WHEN p_parser_version = 'house-stock-priced-1.0.0' THEN coalesce(p_items, '[]'::jsonb)::text ELSE '' END,
    true
  );

  v_result := public.finalize_physical_inventory_session_base(
    p_session_id,
    p_expected_generation,
    p_expected_ingest_revision,
    p_expected_ingest_hash,
    p_business_date,
    p_parser_version,
    p_warnings,
    p_items,
    p_fail_closed,
    p_fail_reason
  );
  PERFORM set_config('bot_summary.priced_house_stock_items', '', true);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) TO service_role;
