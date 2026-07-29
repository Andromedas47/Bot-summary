-- Assert deterministic concurrency outcomes. Never Production.
DO $$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
  v_count int;
  v_fin jsonb;
  v_gen uuid;
  v_rev int;
BEGIN
  -- Ordering A: confirm completed after waiting behind finalizer lock.
  IF NOT EXISTS (
    SELECT 1 FROM public.p50_sync WHERE k = 'fin_first_blocker_observed' AND v = '1'
  ) THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: confirm was not observed blocked';
  END IF;

  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = 'dm:U-fin1';
  IF v_row.finalize_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: fin1 not confirmed';
  END IF;
  IF v_row.finalize_confirm_line_event_id IS DISTINCT FROM 'evt-confirm-fin1' THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: fin1 confirm event not retained';
  END IF;
  IF v_row.finalize_hold_until IS NOT NULL THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: fin1 hold not cleared';
  END IF;

  -- No Produce before/without a successful post-confirm finalize for fin1 yet
  -- (ordering A only confirms under contention; finalize may still be pending).
  -- Ordering B must have finalized cfm1 exactly once.
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key LIKE 'dm:U-cfm1:%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'produce_0050_concurrency FAIL: cfm1 expected 1 Produce, found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.produce_items i
    JOIN public.produce_sessions s ON s.id = i.session_id
   WHERE s.ingest_idempotency_key LIKE 'dm:U-cfm1:%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'produce_0050_concurrency FAIL: cfm1 expected 1 item, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.p50_sync WHERE k = 'confirm_first_blocker_observed' AND v = '1'
  ) THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: finalize was not observed blocked';
  END IF;

  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = 'dm:U-cfm1';
  IF v_row.finalize_confirm_line_event_id IS DISTINCT FROM 'evt-confirm-cfm1' THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: cfm1 confirm event not retained';
  END IF;
  IF v_row.finalization_status IS DISTINCT FROM 'finalized' THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: cfm1 not finalized';
  END IF;

  -- Twin finalize exactly-once.
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key LIKE 'dm:U-once2:%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'produce_0050_concurrency FAIL: once2 expected 1 Produce, found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.produce_items i
    JOIN public.produce_sessions s ON s.id = i.session_id
   WHERE s.ingest_idempotency_key LIKE 'dm:U-once2:%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'produce_0050_concurrency FAIL: once2 expected 1 item, found %', v_count;
  END IF;

  SELECT session_generation, ingest_revision INTO v_gen, v_rev
    FROM public.pending_sessions WHERE session_key = 'dm:U-once2';
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
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: once2 duplicated after retry';
  END IF;

  -- Finalize fin1 after contention confirm (fresh call; proves no pre-confirm Produce).
  SELECT session_generation, ingest_revision INTO v_gen, v_rev
    FROM public.pending_sessions WHERE session_key = 'dm:U-fin1';
  INSERT INTO public.raw_messages(id)
  VALUES ('00000000-0000-4000-8000-000000000061')
  ON CONFLICT DO NOTHING;
  v_fin := public.try_finalize_pending_generation(
    'dm:U-fin1', v_gen, 'U-fin1', v_rev,
    'hash-fin1-final', '1.มะละกอ10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000061',
      'staff_name', 'พี่ดำ',
      'session_date', '2026-07-28',
      'session_title', 'วิหาร',
      'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-fin1:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_number', '1',
        'product_name', 'มะละกอ',
        'price_per_unit', '10',
        'quantity', '1',
        'unit', 'โล',
        'section', 'main',
        'transaction_type', 'เบิก',
        'item_hash', 'item-fin1-1'
      )
    )
  );
  IF v_fin->>'status' IS DISTINCT FROM 'finalized' THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: fin1 finalize %', v_fin;
  END IF;
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key LIKE 'dm:U-fin1:%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'produce_0050_concurrency FAIL: fin1 Produce count %', v_count;
  END IF;

  RAISE NOTICE 'produce_0050_concurrency: ALL CHECKS PASSED';
END
$$;
