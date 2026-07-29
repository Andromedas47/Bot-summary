-- Assert concurrency outcomes after the two-connection races.
DO $$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
  v_count int;
  v_fin jsonb;
  v_rev int;
  v_gen uuid;
BEGIN
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = 'dm:U-conc';
  IF v_row.finalize_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: confirm did not land';
  END IF;
  IF v_row.finalize_hold_until IS NOT NULL THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: hold not cleared after confirm';
  END IF;
  IF v_row.finalize_confirm_line_event_id IS DISTINCT FROM 'evt-confirm-conc' THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: confirm event mismatch';
  END IF;

  -- No Produce was written before confirmation (held race path).
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key LIKE 'dm:U-conc:%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: Produce before confirmation';
  END IF;

  -- Exactly-once twin finalize.
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key LIKE 'dm:U-once2:%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'produce_0050_concurrency FAIL: expected exactly one Produce, found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.produce_items i
    JOIN public.produce_sessions s ON s.id = i.session_id
   WHERE s.ingest_idempotency_key LIKE 'dm:U-once2:%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'produce_0050_concurrency FAIL: expected exactly one item, found %', v_count;
  END IF;

  SELECT session_generation, ingest_revision INTO v_gen, v_rev
    FROM public.pending_sessions WHERE session_key = 'dm:U-once2';
  IF NOT FOUND OR v_gen IS NULL THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: once2 row missing';
  END IF;

  -- Post-terminal retry remains harmless.
  v_fin := public.try_finalize_pending_generation(
    'dm:U-once2', v_gen, 'U-once2', v_rev,
    'hash-conc-once2', '1.ฝรั่ง10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000050',
      'staff_name', 'พี่ดำ',
      'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-once2:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_number', '1',
        'product_name', 'ฝรั่ง',
        'price_per_unit', '10',
        'quantity', '1',
        'unit', 'โล',
        'section', 'main',
        'transaction_type', 'เบิก',
        'item_hash', 'item-once2-1'
      )
    )
  );
  IF v_fin->>'reason' IS DISTINCT FROM 'already_terminalized'
     AND v_fin->>'status' IS DISTINCT FROM 'duplicate' THEN
    RAISE EXCEPTION
      'produce_0050_concurrency FAIL: unexpected post-terminal result %', v_fin;
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key LIKE 'dm:U-once2:%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: duplicate Produce after retry';
  END IF;

  RAISE NOTICE 'produce_0050_concurrency: ALL CHECKS PASSED';
END
$$;
