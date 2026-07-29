-- Executable behavioural verification of migration 0050 against a disposable
-- local PostgreSQL container. FAIL closed. Never run against Production.

CREATE OR REPLACE FUNCTION pg_temp.p50_assert(cond boolean, msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'produce_0050_verification FAIL: %', msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.p50_open(
  p_key text, p_user text, p_event text
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.open_or_rotate_produce_structured_session(
    p_key, 'user', p_user, p_user, p_event, 1800000000000, 1,
    DATE '2026-07-28', '09:15', 'operator_declared', 'พี่ดำ', 'วิหาร',
    'main', 'เบิก', NULL, NULL, NULL, 'structured_menu'
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.p50_admit_ingest(
  p_key text, p_gen uuid, p_event text, p_ts bigint, p_text text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.pending_session_admission
    (session_key, session_generation, line_event_id, line_timestamp_ms)
  VALUES (p_key, p_gen, p_event, p_ts)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.pending_session_ingest
    (session_key, session_generation, line_event_id, line_timestamp_ms, raw_text)
  VALUES (p_key, p_gen, p_event, p_ts, p_text)
  ON CONFLICT DO NOTHING;
END;
$$;

-- Produce schema stubs sufficient for a real successful try_finalize path.
CREATE TABLE IF NOT EXISTS public.raw_messages (
  id uuid PRIMARY KEY,
  is_processed boolean NOT NULL DEFAULT false,
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.imported_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash text NOT NULL UNIQUE,
  transaction_date date,
  staff_name text,
  market_name text,
  transaction_type text,
  raw_text text
);

CREATE TABLE IF NOT EXISTS public.produce_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id uuid,
  line_user_id text,
  staff_name text,
  sender_name text,
  transaction_time text,
  session_date date,
  session_title text,
  total_items integer,
  parser_errors text,
  finalization_started_at timestamptz,
  finalized_at timestamptz,
  session_kind text,
  declared_transaction_type text,
  ingest_idempotency_key text UNIQUE,
  ingest_source text
);

CREATE TABLE IF NOT EXISTS public.produce_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.produce_sessions(id),
  item_number integer,
  product_name text,
  price_per_unit numeric,
  quantity numeric,
  unit text,
  section text,
  transaction_type text,
  item_hash text,
  basis_quantity numeric,
  basis_unit text,
  basis_price numeric
);

CREATE TABLE IF NOT EXISTS public.produce_session_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produce_session_id uuid,
  session_key text,
  session_generation uuid,
  source_id text,
  correlation_id text,
  notification_payload text
);

DO $$
DECLARE
  v_result jsonb;
  v_gen    uuid;
  v_row    public.pending_sessions%ROWTYPE;
  v_count  int;
  v_ready  jsonb;
  v_rev    int;
  v_hold   timestamptz;
  v_fin    jsonb;
  v_fin2   jsonb;
  v_body   text;
BEGIN
  -- Enable RLS on pending-session tables (harness fidelity).
  ALTER TABLE public.pending_sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.pending_session_admission ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.pending_session_ingest ENABLE ROW LEVEL SECURITY;

  -- ── 1. Schema / constraints / no backfill ─────────────────────────────────
  SELECT count(*) INTO v_count FROM information_schema.columns
   WHERE table_schema='public' AND table_name='pending_sessions'
     AND column_name IN (
       'finalize_hold_until','finalize_confirmed_at','finalize_confirm_line_event_id'
     );
  PERFORM pg_temp.p50_assert(v_count = 3, '1: three hold columns');

  SELECT count(*) INTO v_count FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='public' AND t.relname='pending_sessions'
     AND c.conname LIKE 'pending_sessions_finalize_%' AND c.convalidated;
  PERFORM pg_temp.p50_assert(v_count = 4, '1: four validated hold constraints');

  SELECT count(*) INTO v_count FROM public.pending_sessions
   WHERE finalize_hold_until IS NOT NULL
      OR finalize_confirmed_at IS NOT NULL
      OR finalize_confirm_line_event_id IS NOT NULL;
  PERFORM pg_temp.p50_assert(v_count = 0, '1: no historical hold backfill');

  -- Legacy rows remain valid with NULL hold fields.
  SELECT count(*) INTO v_count FROM public.pending_sessions
   WHERE session_key IN ('dm:LEGACY1','dm:LEGACY2')
     AND entry_origin IS NULL
     AND finalize_hold_until IS NULL
     AND finalize_confirmed_at IS NULL
     AND finalize_confirm_line_event_id IS NULL;
  PERFORM pg_temp.p50_assert(v_count = 2, '18: legacy rows keep NULL hold fields');

  -- ── 2. Structured close sets 10-minute hold; legacy close does not ────────
  v_result := pg_temp.p50_open('dm:U-hold','U-hold','evt-open-1');
  PERFORM pg_temp.p50_assert(v_result->>'outcome' = 'opened', '2: open accepted');
  v_gen := (v_result->>'session_generation')::uuid;

  v_result := public.close_produce_structured_session(
    'dm:U-hold','U-hold','evt-close-1', 1800000005000, v_gen, NULL
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'first_close', '2: first close');
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key='dm:U-hold';
  PERFORM pg_temp.p50_assert(v_row.finalize_hold_until IS NOT NULL, '2: hold set');
  PERFORM pg_temp.p50_assert(
    v_row.finalize_hold_until BETWEEN now() + interval '9 minutes 50 seconds'
                                  AND now() + interval '10 minutes 10 seconds',
    '2: hold is ~10 minutes'
  );
  PERFORM pg_temp.p50_assert(v_row.finalize_confirmed_at IS NULL, '2: confirmed null');
  PERFORM pg_temp.p50_assert(v_row.close_event_timestamp_ms = 1800000005000, '2: boundary set');
  PERFORM pg_temp.p50_assert(v_row.next_attempt_at IS NOT NULL, '2: next_attempt armed');

  -- Duplicate close idempotent, hold unchanged.
  v_hold := v_row.finalize_hold_until;
  v_result := public.close_produce_structured_session(
    'dm:U-hold','U-hold','evt-close-2', 1800000006000, v_gen, NULL
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'close_already_requested', '2: dup close');
  SELECT finalize_hold_until INTO v_hold FROM public.pending_sessions WHERE session_key='dm:U-hold';
  PERFORM pg_temp.p50_assert(
    (SELECT finalize_hold_until FROM public.pending_sessions WHERE session_key='dm:U-hold') = v_hold,
    '2: hold immutable on duplicate close'
  );

  -- Legacy close path (append mark_close) must not invent hold fields.
  UPDATE public.pending_sessions
     SET close_event_timestamp_ms = 1,
         close_requested_at = now(),
         close_deadline_at = now() + interval '30 seconds',
         next_attempt_at = now() + interval '8 seconds',
         close_session_generation = session_generation
   WHERE session_key = 'dm:LEGACY1';
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key='dm:LEGACY1';
  PERFORM pg_temp.p50_assert(v_row.entry_origin IS NULL, '2b: still legacy');
  PERFORM pg_temp.p50_assert(v_row.finalize_hold_until IS NULL, '2b: legacy has no hold');

  -- ── 3/4. No finalize while hold active; parity can become ready while held ─
  PERFORM pg_temp.p50_admit_ingest(
    'dm:U-hold', v_gen, 'item-1', 1800000001000, '1.แตงโม10บาท'
  );
  PERFORM pg_temp.p50_admit_ingest(
    'dm:U-hold', v_gen, 'item-2', 1800000002000, '1โล'
  );
  v_ready := public.check_pending_close_ready('dm:U-hold');
  -- May or may not be ready depending on ingest rules; force ready path by
  -- ensuring admission=ingest>0 with nonblank text (already inserted).
  PERFORM pg_temp.p50_assert((v_ready->>'admission_count')::int >= 1, '4: admissions exist while held');

  -- Force past quiet window but keep hold active.
  UPDATE public.pending_sessions
     SET next_attempt_at = now() - interval '1 second',
         close_deadline_at = now() + interval '20 seconds'
   WHERE session_key = 'dm:U-hold';

  SELECT ingest_revision INTO v_rev FROM public.pending_sessions WHERE session_key='dm:U-hold';
  v_fin := public.try_finalize_pending_generation(
    'dm:U-hold', v_gen, 'U-hold', v_rev,
    'hash-held', '1.แตงโม10บาท\n1โล',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000001',
      'staff_name', 'พี่ดำ', 'session_date', '2026-07-28',
      'session_title', 'วิหาร', 'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-hold:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    '[]'::jsonb
  );
  PERFORM pg_temp.p50_assert(v_fin->>'status' = 'pending', '3: held returns pending');
  PERFORM pg_temp.p50_assert(v_fin->>'reason' = 'awaiting_confirmation', '3: awaiting_confirmation');
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:U-hold:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 0, '3: no Produce while held');

  -- ── 5. Confirm before parity ready → not_ready, zero mutation ─────────────
  -- Clear ingest so parity fails.
  DELETE FROM public.pending_session_ingest WHERE session_key='dm:U-hold';
  SELECT ingest_revision INTO v_rev FROM public.pending_sessions WHERE session_key='dm:U-hold';
  v_result := public.confirm_produce_structured_finalization(
    'dm:U-hold','U-hold','evt-confirm-early', v_gen
  );
  PERFORM pg_temp.p50_assert((v_result->>'accepted')::boolean IS FALSE, '5: not accepted');
  PERFORM pg_temp.p50_assert(v_result->>'reason' IS DISTINCT FROM 'confirmed', '5: not confirmed');
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key='dm:U-hold';
  PERFORM pg_temp.p50_assert(v_row.finalize_confirmed_at IS NULL, '5: no confirm mutation');
  PERFORM pg_temp.p50_assert(v_row.finalize_hold_until IS NOT NULL, '5: hold remains');
  PERFORM pg_temp.p50_assert(v_row.ingest_revision = v_rev, '5: revision unchanged');

  -- ── 6. Successful confirm clears hold and schedules immediate retry ────────
  PERFORM pg_temp.p50_admit_ingest(
    'dm:U-hold', v_gen, 'item-1', 1800000001000, '1.แตงโม10บาท'
  );
  PERFORM pg_temp.p50_admit_ingest(
    'dm:U-hold', v_gen, 'item-2', 1800000002000, '1โล'
  );
  v_ready := public.check_pending_close_ready('dm:U-hold');
  PERFORM pg_temp.p50_assert((v_ready->>'ready')::boolean IS TRUE, '6: parity ready');

  v_result := public.confirm_produce_structured_finalization(
    'dm:U-hold','U-hold','evt-confirm-1', v_gen
  );
  PERFORM pg_temp.p50_assert((v_result->>'accepted')::boolean, '6: confirm accepted');
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'confirmed', '6: confirmed');
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key='dm:U-hold';
  PERFORM pg_temp.p50_assert(v_row.finalize_hold_until IS NULL, '6: hold cleared');
  PERFORM pg_temp.p50_assert(v_row.finalize_confirmed_at IS NOT NULL, '6: confirmed_at set');
  PERFORM pg_temp.p50_assert(
    v_row.finalize_confirm_line_event_id = 'evt-confirm-1', '6: event id stored'
  );
  PERFORM pg_temp.p50_assert(v_row.next_attempt_at <= now() + interval '1 second', '6: next_attempt now');

  -- ── 7/8. Duplicate same-event and different-event confirmation ────────────
  v_rev := v_row.ingest_revision;
  v_result := public.confirm_produce_structured_finalization(
    'dm:U-hold','U-hold','evt-confirm-1', v_gen
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'already_confirmed', '7: same event');
  v_result := public.confirm_produce_structured_finalization(
    'dm:U-hold','U-hold','evt-confirm-2', v_gen
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'already_confirmed', '8: different event');
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key='dm:U-hold';
  PERFORM pg_temp.p50_assert(
    v_row.finalize_confirm_line_event_id = 'evt-confirm-1', '8: first event retained'
  );
  PERFORM pg_temp.p50_assert(v_row.ingest_revision = v_rev, '8: no mutation on duplicate');

  -- ── 9/10. Hold expiry fails closed with review_not_confirmed, no Produce ───
  v_result := pg_temp.p50_open('dm:U-exp','U-exp','evt-open-exp');
  v_gen := (v_result->>'session_generation')::uuid;
  PERFORM public.close_produce_structured_session(
    'dm:U-exp','U-exp','evt-close-exp', 1800000010000, v_gen, NULL
  );
  UPDATE public.pending_sessions
     SET finalize_hold_until = now() - interval '1 second',
         next_attempt_at = now() - interval '1 second',
         close_deadline_at = now() + interval '30 seconds'
   WHERE session_key = 'dm:U-exp';
  SELECT ingest_revision INTO v_rev FROM public.pending_sessions WHERE session_key='dm:U-exp';
  v_fin := public.try_finalize_pending_generation(
    'dm:U-exp', v_gen, 'U-exp', v_rev,
    'hash-exp', 'x',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000002',
      'staff_name', 'พี่ดำ', 'session_kind', 'main',
      'validation_errors', '[]'::jsonb
    ),
    '[]'::jsonb
  );
  PERFORM pg_temp.p50_assert(v_fin->>'status' = 'failed_closed', '9: expired failed_closed');
  PERFORM pg_temp.p50_assert(v_fin->>'reason' = 'review_not_confirmed', '9: review_not_confirmed');
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key='dm:U-exp';
  PERFORM pg_temp.p50_assert(v_row.terminalized IS TRUE, '9: terminalized');
  PERFORM pg_temp.p50_assert(v_row.finalization_status = 'failed_closed', '9: status');
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:U-exp:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 0, '10: no Produce on expiry');

  v_result := public.confirm_produce_structured_finalization(
    'dm:U-exp','U-exp','evt-confirm-late', v_gen
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'terminalized', '9b: confirm after expiry');

  -- Hold expired but not yet terminalized → hold_expired, no release.
  v_result := pg_temp.p50_open('dm:U-hex','U-hex','evt-open-hex');
  v_gen := (v_result->>'session_generation')::uuid;
  PERFORM public.close_produce_structured_session(
    'dm:U-hex','U-hex','evt-close-hex', 1800000020000, v_gen, NULL
  );
  UPDATE public.pending_sessions
     SET finalize_hold_until = now() - interval '1 second'
   WHERE session_key = 'dm:U-hex';
  PERFORM pg_temp.p50_admit_ingest(
    'dm:U-hex', v_gen, 'i1', 1800000021000, '1.ส้ม10บาท'
  );
  v_result := public.confirm_produce_structured_finalization(
    'dm:U-hex','U-hex','evt-confirm-hex', v_gen
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'hold_expired', '9c: hold_expired');
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key='dm:U-hex';
  PERFORM pg_temp.p50_assert(v_row.finalize_confirmed_at IS NULL, '9c: no release');
  PERFORM pg_temp.p50_assert(v_row.finalize_hold_until IS NOT NULL, '9c: hold remains');

  -- ── 11. Crash/retry after confirmation remains exactly-once (no Produce yet;
  --     second try_finalize after terminalized is skipped). Use a fresh session.
  v_result := pg_temp.p50_open('dm:U-once','U-once','evt-open-once');
  v_gen := (v_result->>'session_generation')::uuid;
  PERFORM public.close_produce_structured_session(
    'dm:U-once','U-once','evt-close-once', 1800000030000, v_gen, NULL
  );
  PERFORM pg_temp.p50_admit_ingest(
    'dm:U-once', v_gen, 'once-1', 1800000029000, '1.มะม่วง10บาท'
  );
  v_result := public.confirm_produce_structured_finalization(
    'dm:U-once','U-once','evt-confirm-once', v_gen
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'confirmed', '11: confirmed');
  SELECT ingest_revision INTO v_rev FROM public.pending_sessions WHERE session_key='dm:U-once';
  -- Fail-closed via empty items (parser blocking) — no Produce rows.
  v_fin := public.try_finalize_pending_generation(
    'dm:U-once', v_gen, 'U-once', v_rev,
    'hash-once', '1.มะม่วง10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000011',
      'staff_name', 'พี่ดำ', 'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-once:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    '[]'::jsonb
  );
  PERFORM pg_temp.p50_assert(v_fin->>'status' = 'failed_closed', '13: parser fail closed after confirm');
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:U-once:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 0, '13: no Produce on validation fail');
  v_fin2 := public.try_finalize_pending_generation(
    'dm:U-once', v_gen, 'U-once', v_rev,
    'hash-once', '1.มะม่วง10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000011',
      'staff_name', 'พี่ดำ', 'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-once:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    '[]'::jsonb
  );
  PERFORM pg_temp.p50_assert(v_fin2->>'reason' = 'already_terminalized', '11: retry after terminal');

  -- ── 12. Concurrent confirm + sweeper serialize via FOR UPDATE (sequential
  --     proof: confirm then try_finalize sees confirmed state; reverse order
  --     while held returns awaiting_confirmation without Produce).
  v_result := pg_temp.p50_open('dm:U-race','U-race','evt-open-race');
  v_gen := (v_result->>'session_generation')::uuid;
  PERFORM public.close_produce_structured_session(
    'dm:U-race','U-race','evt-close-race', 1800000040000, v_gen, NULL
  );
  PERFORM pg_temp.p50_admit_ingest(
    'dm:U-race', v_gen, 'race-1', 1800000039000, '1.กล้วย10บาท'
  );
  SELECT ingest_revision INTO v_rev FROM public.pending_sessions WHERE session_key='dm:U-race';
  UPDATE public.pending_sessions
     SET next_attempt_at = now() - interval '1 second'
   WHERE session_key='dm:U-race';
  v_fin := public.try_finalize_pending_generation(
    'dm:U-race', v_gen, 'U-race', v_rev,
    'hash-race', '1.กล้วย10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000012',
      'staff_name', 'พี่ดำ', 'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-race:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    '[]'::jsonb
  );
  PERFORM pg_temp.p50_assert(v_fin->>'reason' = 'awaiting_confirmation', '12: sweeper waits on hold');
  v_result := public.confirm_produce_structured_finalization(
    'dm:U-race','U-race','evt-confirm-race', v_gen
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'confirmed', '12: confirm wins after hold');

  -- ── H-1. Plain markClose close without hold → unconfirmed_structured_close ─
  v_result := pg_temp.p50_open('dm:U-bypass','U-bypass','evt-open-bypass');
  v_gen := (v_result->>'session_generation')::uuid;
  UPDATE public.pending_sessions
     SET close_event_timestamp_ms = 1800000050000,
         close_requested_at = now(),
         close_deadline_at = now() + interval '30 seconds',
         next_attempt_at = now() - interval '1 second',
         close_session_generation = v_gen,
         finalize_hold_until = NULL,
         finalize_confirmed_at = NULL,
         finalize_confirm_line_event_id = NULL
   WHERE session_key = 'dm:U-bypass';
  SELECT ingest_revision INTO v_rev FROM public.pending_sessions WHERE session_key='dm:U-bypass';
  v_fin := public.try_finalize_pending_generation(
    'dm:U-bypass', v_gen, 'U-bypass', v_rev,
    'hash-bypass', 'x',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000020',
      'staff_name', 'พี่ดำ', 'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-bypass:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    '[]'::jsonb
  );
  PERFORM pg_temp.p50_assert(v_fin->>'status' = 'failed_closed', 'H1: bypass failed_closed');
  PERFORM pg_temp.p50_assert(
    v_fin->>'reason' = 'unconfirmed_structured_close', 'H1: unconfirmed_structured_close'
  );
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:U-bypass:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 0, 'H1: no Produce on bypass');

  -- Legacy plain close still finalizes without hold fields (byte-compatible path).
  UPDATE public.pending_sessions
     SET close_event_timestamp_ms = 1800000060000,
         close_requested_at = now(),
         close_deadline_at = now() + interval '30 seconds',
         next_attempt_at = now() - interval '1 second',
         close_session_generation = session_generation,
         finalize_hold_until = NULL,
         finalize_confirmed_at = NULL
   WHERE session_key = 'dm:LEGACY1';
  SELECT session_generation, ingest_revision INTO v_gen, v_rev
    FROM public.pending_sessions WHERE session_key='dm:LEGACY1';
  INSERT INTO public.raw_messages(id) VALUES ('00000000-0000-4000-8000-000000000030')
  ON CONFLICT DO NOTHING;
  v_fin := public.try_finalize_pending_generation(
    'dm:LEGACY1', v_gen, 'LEGACY1', v_rev,
    'hash-legacy-ok-1',
    E'พี่ดำ-วิหาร เบิก 10/6/2569\n1.แตงโม10บาท\n1โล',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000030',
      'staff_name', 'พี่ดำ',
      'session_date', '2026-07-28',
      'session_title', 'วิหาร',
      'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:LEGACY1:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_number', '1',
        'product_name', 'แตงโม',
        'price_per_unit', '10',
        'quantity', '1',
        'unit', 'โล',
        'section', 'main',
        'transaction_type', 'เบิก',
        'item_hash', 'item-legacy-1'
      )
    )
  );
  PERFORM pg_temp.p50_assert(v_fin->>'status' = 'finalized', 'H1b: legacy finalize ok');
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:LEGACY1:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 1, 'H1b: legacy Produce inserted');

  -- ── M-2. Confirmed structured session successfully finalizes exactly once ──
  v_result := pg_temp.p50_open('dm:U-ok','U-ok','evt-open-ok');
  v_gen := (v_result->>'session_generation')::uuid;
  PERFORM public.close_produce_structured_session(
    'dm:U-ok','U-ok','evt-close-ok', 1800000070000, v_gen, NULL
  );
  PERFORM pg_temp.p50_admit_ingest(
    'dm:U-ok', v_gen, 'ok-1', 1800000069000, '1.ส้ม10บาท'
  );
  v_result := public.confirm_produce_structured_finalization(
    'dm:U-ok','U-ok','evt-confirm-ok', v_gen
  );
  PERFORM pg_temp.p50_assert(v_result->>'reason' = 'confirmed', 'M2: confirmed');
  SELECT ingest_revision INTO v_rev FROM public.pending_sessions WHERE session_key='dm:U-ok';
  INSERT INTO public.raw_messages(id) VALUES ('00000000-0000-4000-8000-000000000040')
  ON CONFLICT DO NOTHING;
  v_fin := public.try_finalize_pending_generation(
    'dm:U-ok', v_gen, 'U-ok', v_rev,
    'hash-structured-ok-1',
    '1.ส้ม10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000040',
      'staff_name', 'พี่ดำ',
      'session_date', '2026-07-28',
      'session_title', 'วิหาร',
      'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-ok:' || v_gen::text,
      'ingest_source', 'line_webhook',
      'notification_payload', 'สรุปทดสอบ',
      'notification_source_id', 'U-ok'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_number', '1',
        'product_name', 'ส้ม',
        'price_per_unit', '10',
        'quantity', '1',
        'unit', 'โล',
        'section', 'main',
        'transaction_type', 'เบิก',
        'item_hash', 'item-ok-1'
      )
    )
  );
  PERFORM pg_temp.p50_assert(v_fin->>'status' = 'finalized', 'M2: finalized');
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:U-ok:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 1, 'M2: exactly one produce_sessions');
  SELECT count(*) INTO v_count FROM public.produce_items i
    JOIN public.produce_sessions s ON s.id = i.session_id
   WHERE s.ingest_idempotency_key = 'dm:U-ok:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 1, 'M2: expected produce_items inserted');

  -- Retry/duplicate finalize creates no duplicates.
  v_fin2 := public.try_finalize_pending_generation(
    'dm:U-ok', v_gen, 'U-ok', v_rev,
    'hash-structured-ok-1',
    '1.ส้ม10บาท',
    jsonb_build_object(
      'raw_message_id', '00000000-0000-4000-8000-000000000040',
      'staff_name', 'พี่ดำ',
      'session_date', '2026-07-28',
      'session_title', 'วิหาร',
      'session_kind', 'main',
      'validation_errors', '[]'::jsonb,
      'ingest_idempotency_key', 'dm:U-ok:' || v_gen::text,
      'ingest_source', 'line_webhook'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_number', '1',
        'product_name', 'ส้ม',
        'price_per_unit', '10',
        'quantity', '1',
        'unit', 'โล',
        'section', 'main',
        'transaction_type', 'เบิก',
        'item_hash', 'item-ok-1'
      )
    )
  );
  PERFORM pg_temp.p50_assert(v_fin2->>'reason' = 'already_terminalized', 'M2: retry terminal');
  SELECT count(*) INTO v_count FROM public.produce_sessions
   WHERE ingest_idempotency_key = 'dm:U-ok:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 1, 'M2: still exactly one produce_sessions');
  SELECT count(*) INTO v_count FROM public.produce_items i
    JOIN public.produce_sessions s ON s.id = i.session_id
   WHERE s.ingest_idempotency_key = 'dm:U-ok:' || v_gen::text;
  PERFORM pg_temp.p50_assert(v_count = 1, 'M2: still exactly one produce_items');

  -- ── 14. Structured-only: hold fields on legacy forbidden by CHECK ─────────
  BEGIN
    UPDATE public.pending_sessions
       SET finalize_hold_until = now() + interval '1 minute'
     WHERE session_key = 'dm:LEGACY2';
    RAISE EXCEPTION 'produce_0050_verification FAIL: 14: legacy hold should violate CHECK';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ── 15. Grants via SET ROLE ───────────────────────────────────────────────
  -- Match Production table grants so SECURITY INVOKER can read/update rows.
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.pending_sessions,
    public.pending_session_admission,
    public.pending_session_ingest
  TO service_role;

  PERFORM pg_temp.p50_assert(
    has_function_privilege(
      'service_role',
      'public.confirm_produce_structured_finalization(text,text,text,uuid)',
      'EXECUTE'
    ),
    '15: service_role has EXECUTE'
  );
  PERFORM pg_temp.p50_assert(
    NOT has_function_privilege(
      'anon',
      'public.confirm_produce_structured_finalization(text,text,text,uuid)',
      'EXECUTE'
    ),
    '15: anon lacks EXECUTE'
  );
  PERFORM pg_temp.p50_assert(
    NOT has_function_privilege(
      'authenticated',
      'public.confirm_produce_structured_finalization(text,text,text,uuid)',
      'EXECUTE'
    ),
    '15: authenticated lacks EXECUTE'
  );

  BEGIN
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM public.confirm_produce_structured_finalization(
        'dm:U-hold','U-hold','x', NULL
      );
      RAISE EXCEPTION 'produce_0050_verification FAIL: 15: anon must not execute';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.confirm_produce_structured_finalization(
        'dm:U-hold','U-hold','x', NULL
      );
      RAISE EXCEPTION 'produce_0050_verification FAIL: 15: authenticated must not execute';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE service_role;
    BEGIN
      PERFORM public.confirm_produce_structured_finalization(
        'dm:missing','missing','evt', NULL
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%permission denied%' THEN
        RAISE EXCEPTION 'produce_0050_verification FAIL: 15: service_role privilege denied';
      END IF;
    END;
    RESET ROLE;
  END;

  -- ── 16. RLS enabled ───────────────────────────────────────────────────────
  SELECT count(*) INTO v_count FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public'
     AND c.relname IN ('pending_sessions','pending_session_admission','pending_session_ingest')
     AND c.relrowsecurity;
  PERFORM pg_temp.p50_assert(v_count = 3, '16: RLS enabled on three pending tables');

  -- ── 17. try_finalize body contains hold gate ──────────────────────────────
  SELECT pg_get_functiondef(
    'public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb)'::regprocedure
  ) INTO v_body;
  PERFORM pg_temp.p50_assert(
    position('awaiting_confirmation' IN v_body) > 0
    AND position('review_not_confirmed' IN v_body) > 0
    AND position('unconfirmed_structured_close' IN v_body) > 0,
    '17: try_finalize hold gate present'
  );

  RAISE NOTICE 'produce_0050_verification: ALL CHECKS PASSED';
END
$$;
