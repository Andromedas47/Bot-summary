-- True crash/recovery: confirm succeeded in a prior process; this fresh
-- connection finalizes exactly once, then retries with no duplicates.
-- Never Production.

DO $$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
  v_fin jsonb;
  v_fin2 jsonb;
  v_gen uuid;
  v_rev int;
  v_count int;
BEGIN
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = 'dm:U-crash';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: crash fixture missing';
  END IF;
  IF v_row.finalize_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: not confirmed before recovery';
  END IF;
  IF v_row.finalize_hold_until IS NOT NULL THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: hold still set';
  END IF;
  IF v_row.next_attempt_at IS NULL OR v_row.next_attempt_at > now() THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: next_attempt_at not due';
  END IF;
  IF v_row.terminalized THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: already terminalized before recovery';
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key LIKE 'dm:U-crash:%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: Produce existed before recovery';
  END IF;

  v_gen := v_row.session_generation;
  v_rev := v_row.ingest_revision;

  INSERT INTO public.raw_messages(id)
  VALUES ('00000000-0000-4000-8000-000000000070')
  ON CONFLICT DO NOTHING;

  v_fin := public.try_finalize_pending_generation(
    'dm:U-crash', v_gen, 'U-crash', v_rev,
    'hash-crash-recovery',
    '1.มะม่วง10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000070',
      'staff_name', 'พี่ดำ',
      'session_date', '2026-07-28',
      'session_title', 'วิหาร',
      'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-crash:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_number', '1',
        'product_name', 'มะม่วง',
        'price_per_unit', '10',
        'quantity', '1',
        'unit', 'โล',
        'section', 'main',
        'transaction_type', 'เบิก',
        'item_hash', 'item-crash-1'
      )
    )
  );
  IF v_fin->>'status' IS DISTINCT FROM 'finalized' THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: first finalize %', v_fin;
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:U-crash:' || v_gen::text;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: expected 1 Produce, found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.produce_items i
    JOIN public.produce_sessions s ON s.id = i.session_id
   WHERE s.ingest_idempotency_key = 'dm:U-crash:' || v_gen::text;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: expected 1 item, found %', v_count;
  END IF;

  v_fin2 := public.try_finalize_pending_generation(
    'dm:U-crash', v_gen, 'U-crash', v_rev,
    'hash-crash-recovery',
    '1.มะม่วง10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000070',
      'staff_name', 'พี่ดำ',
      'session_date', '2026-07-28',
      'session_title', 'วิหาร',
      'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-crash:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_number', '1',
        'product_name', 'มะม่วง',
        'price_per_unit', '10',
        'quantity', '1',
        'unit', 'โล',
        'section', 'main',
        'transaction_type', 'เบิก',
        'item_hash', 'item-crash-1'
      )
    )
  );
  IF v_fin2->>'reason' IS DISTINCT FROM 'already_terminalized'
     AND v_fin2->>'status' IS DISTINCT FROM 'duplicate' THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: retry %', v_fin2;
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:U-crash:' || v_gen::text;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'produce_0050_crash_recovery FAIL: duplicate Produce after retry';
  END IF;

  RAISE NOTICE 'produce_0050_crash_recovery: ALL CHECKS PASSED';
END
$$;
