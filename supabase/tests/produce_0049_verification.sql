-- Executable behavioural verification of migration 0049 against a disposable
-- local PostgreSQL container. FAIL closed: every failed check raises. A clean
-- run ends with NOTICE "produce_0049_verification: ALL CHECKS PASSED".
--
-- Never run against Production. See supabase/tests/run-produce-0049-docker.sh.

CREATE OR REPLACE FUNCTION pg_temp.p49_assert(cond boolean, msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'produce_0049_verification FAIL: %', msg;
  END IF;
END;
$$;

-- Runs p_sql and requires it to fail with an error containing p_needle.
-- Assertion failures are raised AFTER the block so they cannot substring-match
-- the needle and produce a false PASS.
CREATE OR REPLACE FUNCTION pg_temp.p49_expect_error(p_sql text, p_needle text, p_msg text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_err text;
  v_raised boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION
      'produce_0049_verification FAIL: % (expected an error containing "%"; statement succeeded)',
      p_msg, p_needle;
  END IF;
  IF position(p_needle IN v_err) = 0 THEN
    RAISE EXCEPTION
      'produce_0049_verification FAIL: % (expected "%", got "%")', p_msg, p_needle, v_err;
  END IF;
END;
$$;

-- Convenience wrapper: a well-formed structured open for one session key.
CREATE OR REPLACE FUNCTION pg_temp.p49_open(
  p_key text, p_source_type text, p_source text, p_user text, p_event text,
  p_kind text DEFAULT 'main', p_initial text DEFAULT 'เบิก',
  p_declared text DEFAULT NULL, p_opener text DEFAULT NULL,
  p_expected uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.open_or_rotate_produce_structured_session(
    p_key, p_source_type, p_source, p_user, p_event, 1800000000000, 1,
    DATE '2026-07-28', '09:15', 'operator_declared', 'พี่ดำ', 'วิหาร',
    p_kind, p_initial, p_declared, p_opener, p_expected, 'structured_menu'
  );
$$;

DO $$
DECLARE
  v_result jsonb;
  v_gen    uuid;
  v_gen2   uuid;
  v_row    public.pending_sessions%ROWTYPE;
  v_count  int;
  v_type   text;
  v_ready  jsonb;
BEGIN
  -- ── 1. Historical rows remain NULL ────────────────────────────────────────
  SELECT count(*) INTO v_count
    FROM public.pending_sessions WHERE entry_origin IS NOT NULL;
  PERFORM pg_temp.p49_assert(v_count = 0, '1: 0049 must not backfill entry_origin');

  SELECT count(*) INTO v_count
    FROM public.pending_sessions
   WHERE session_key IN ('dm:LEGACY1', 'dm:LEGACY2')
     AND entry_origin IS NULL
     AND command_contract_version IS NULL
     AND business_date IS NULL
     AND transaction_time IS NULL
     AND transaction_time_source IS NULL
     AND staff_label IS NULL
     AND market_label IS NULL
     AND session_kind IS NULL
     AND initial_transaction_type IS NULL
     AND declared_transaction_type IS NULL
     AND additional_opener IS NULL
     AND opened_line_event_id IS NULL;
  PERFORM pg_temp.p49_assert(v_count = 2, '1: pre-existing rows must stay fully legacy');

  -- ── 2. Incomplete metadata is rejected by CHECK, not by convention ────────
  PERFORM pg_temp.p49_expect_error(
    $q$UPDATE public.pending_sessions
          SET entry_origin = 'structured_menu' WHERE session_key = 'dm:LEGACY2'$q$,
    'pending_sessions_structured_metadata_complete',
    '2: a partially structured row must violate the completeness CHECK');

  PERFORM pg_temp.p49_expect_error(
    $q$UPDATE public.pending_sessions SET
         entry_origin = 'structured_menu', command_contract_version = 1,
         business_date = DATE '2026-07-28', transaction_time = '09:15',
         transaction_time_source = 'operator_declared', staff_label = 'พี่ดำ',
         market_label = 'วิหาร', session_kind = 'main',
         opened_line_event_id = 'e-partial'
       WHERE session_key = 'dm:LEGACY2'$q$,
    'pending_sessions_structured_metadata_complete',
    '2: a structured row without initial_transaction_type must be rejected');

  PERFORM pg_temp.p49_expect_error(
    $q$UPDATE public.pending_sessions SET
         entry_origin = 'structured_menu', command_contract_version = 1,
         business_date = DATE '2026-07-28', transaction_time = '25:99',
         transaction_time_source = 'operator_declared', staff_label = 'พี่ดำ',
         market_label = 'วิหาร', session_kind = 'main',
         initial_transaction_type = 'เบิก', opened_line_event_id = 'e-partial'
       WHERE session_key = 'dm:LEGACY2'$q$,
    'pending_sessions_structured_transaction_time_format',
    '2: an out-of-range transaction_time must be rejected');

  -- ── 3. All three main transaction types are representable ─────────────────
  FOREACH v_type IN ARRAY ARRAY['เบิก', 'คืน', 'คืนเสีย'] LOOP
    v_result := pg_temp.p49_open(
      'dm:U-' || v_type, 'user', 'U-' || v_type, 'U-' || v_type,
      'evt-main-' || v_type, 'main', v_type);
    PERFORM pg_temp.p49_assert(v_result->>'outcome' = 'opened',
      '3: a guided main ' || v_type || ' session must open');

    SELECT * INTO v_row FROM public.pending_sessions
     WHERE session_key = 'dm:U-' || v_type;
    PERFORM pg_temp.p49_assert(v_row.initial_transaction_type = v_type,
      '3: initial_transaction_type must persist as ' || v_type);
    PERFORM pg_temp.p49_assert(v_row.session_kind = 'main',
      '3: session_kind must be main');
    PERFORM pg_temp.p49_assert(v_row.declared_transaction_type IS NULL,
      '3: a main session declares no transaction type');
    -- No textual section marker anywhere: the type lives only in metadata.
    PERFORM pg_temp.p49_assert(v_row.accumulated_text = '',
      '3: a typed open writes no synthetic text');
  END LOOP;

  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('dm:U-bad','user','U-bad','U-bad','e-bad','main','ขาย')$q$,
    'initial_transaction_type is required',
    '3: an out-of-domain initial_transaction_type must be refused');

  -- ── 4. Additional opener / declared type mapping ──────────────────────────
  v_result := pg_temp.p49_open(
    'dm:U-add', 'user', 'U-add', 'U-add', 'evt-add-1',
    'additional', 'คืน', 'คืน', 'ชั่งคืนเพิ่ม');
  PERFORM pg_temp.p49_assert(v_result->>'outcome' = 'opened',
    '4: a well-formed additional open must succeed');

  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('dm:U-add2','user','U-add2','U-add2','e-a2',
        'additional','เบิก','คืน','ชั่งคืนเพิ่ม')$q$,
    'must equal declared_transaction_type',
    '4: an additional initial type must equal its declared type');

  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('dm:U-add3','user','U-add3','U-add3','e-a3',
        'additional','เบิก','เบิก','ชั่งคืนเพิ่ม')$q$,
    'pending_sessions_structured_additional_opener',
    '4: an opener that contradicts the declared type must be refused');

  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('dm:U-add4','user','U-add4','U-add4','e-a4',
        'additional','เบิก',NULL,NULL)$q$,
    'requires declared_transaction_type and additional_opener',
    '4: an additional open without its pair must be refused');

  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('dm:U-add5','user','U-add5','U-add5','e-a5',
        'main','เบิก','เบิก','เบิกเพิ่ม')$q$,
    'a main session must not declare',
    '4: a main open must not carry additional fields');

  -- ── 5. Repeated opens leave exactly one current generation ────────────────
  -- The advisory lock plus FOR UPDATE serialize genuinely concurrent callers;
  -- what is asserted here is the invariant that survives that serialization —
  -- one row, one current generation, and every prior generation superseded.
  v_result := pg_temp.p49_open('dm:U-rot','user','U-rot','U-rot','evt-r1');
  v_gen := (v_result->>'session_generation')::uuid;
  v_result := pg_temp.p49_open('dm:U-rot','user','U-rot','U-rot','evt-r2');
  v_gen2 := (v_result->>'session_generation')::uuid;
  PERFORM pg_temp.p49_assert(v_result->>'outcome' = 'rotated',
    '5: a second distinct open event must rotate');
  PERFORM pg_temp.p49_assert(v_gen2 IS DISTINCT FROM v_gen,
    '5: rotation must mint a new generation');

  SELECT count(*) INTO v_count
    FROM public.pending_sessions WHERE session_key = 'dm:U-rot';
  PERFORM pg_temp.p49_assert(v_count = 1, '5: a session key holds exactly one row');
  SELECT session_generation INTO v_gen FROM public.pending_sessions
   WHERE session_key = 'dm:U-rot';
  PERFORM pg_temp.p49_assert(v_gen = v_gen2,
    '5: the stored generation must be the last one returned');

  -- ── 6. A redelivered open does not rotate ─────────────────────────────────
  v_result := pg_temp.p49_open('dm:U-rot','user','U-rot','U-rot','evt-r2');
  PERFORM pg_temp.p49_assert(v_result->>'outcome' = 'idempotent',
    '6: a redelivered open event must be idempotent');
  PERFORM pg_temp.p49_assert((v_result->>'session_generation')::uuid = v_gen2,
    '6: a redelivered open must not change the generation');
  PERFORM pg_temp.p49_assert(v_result->>'reason' = 'duplicate_open_event',
    '6: redelivery must be reported as duplicate_open_event');

  -- ── 7. Ownership is rejected BEFORE the idempotency shortcut ──────────────
  v_result := pg_temp.p49_open(
    'group:C1:user:U1','group','C1','U1','evt-own-1');
  v_gen := (v_result->>'session_generation')::uuid;

  UPDATE public.pending_sessions SET source_id = 'C-other'
   WHERE session_key = 'group:C1:user:U1';
  v_result := pg_temp.p49_open('group:C1:user:U1','group','C1','U1','evt-own-1');
  PERFORM pg_temp.p49_assert(v_result->>'outcome' = 'ownership_conflict',
    '7: a duplicate event from the wrong source must not be idempotent');
  PERFORM pg_temp.p49_assert(v_result->>'reason' = 'source_mismatch',
    '7: the refusal must name the source mismatch');

  UPDATE public.pending_sessions SET source_id = 'C1', line_user_id = 'U-other'
   WHERE session_key = 'group:C1:user:U1';
  v_result := pg_temp.p49_open('group:C1:user:U1','group','C1','U1','evt-own-1');
  PERFORM pg_temp.p49_assert(v_result->>'outcome' = 'ownership_conflict',
    '7: a duplicate event from the wrong user must not be idempotent');
  PERFORM pg_temp.p49_assert(v_result->>'reason' = 'user_mismatch',
    '7: the refusal must name the user mismatch');

  UPDATE public.pending_sessions SET line_user_id = 'U1'
   WHERE session_key = 'group:C1:user:U1';
  v_result := pg_temp.p49_open('group:C1:user:U1','group','C1','U1','evt-own-1');
  PERFORM pg_temp.p49_assert(v_result->>'outcome' = 'idempotent',
    '7: the correct duplicate must still be idempotent');
  PERFORM pg_temp.p49_assert((v_result->>'session_generation')::uuid = v_gen,
    '7: the correct duplicate must not rotate');

  -- Canonical session-key binding: the caller cannot name another key.
  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('group:C1:user:U1','group','C-other','U1','e-k1')$q$,
    'does not match the canonical key',
    '7: a group source_id that contradicts the key must be refused');
  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('dm:U1','user','U-other','U1','e-k2')$q$,
    'source_id equal to line_user_id',
    '7: a user source_id that is not the user id must be refused');
  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('room:R1:user:U1','room','R-other','U1','e-k3')$q$,
    'does not match the canonical key',
    '7: a room source_id that contradicts the key must be refused');
  PERFORM pg_temp.p49_expect_error(
    $q$SELECT pg_temp.p49_open('dm:U1','user','U1',NULL,'e-k4')$q$,
    'line_user_id is required',
    '7: a command with no LINE user id must fail closed');

  -- ── 8. Rotation clears every generation-scoped field ──────────────────────
  v_result := pg_temp.p49_open('dm:U-clr','user','U-clr','U-clr','evt-c1');
  v_gen := (v_result->>'session_generation')::uuid;

  UPDATE public.pending_sessions SET
    accumulated_text          = '1.แตงโม10บาท',
    close_event_timestamp_ms  = 1800000009000,
    close_requested_at        = now(),
    close_line_event_id       = 'evt-close-old',
    close_session_generation  = v_gen,
    close_deadline_at         = now() + interval '30 seconds',
    next_attempt_at           = now(),
    expected_item_count       = 7,
    ingest_revision           = 5,
    latest_reply_token        = 'tok',
    finalization_started_at   = now(),
    finalization_status       = 'processing'
  WHERE session_key = 'dm:U-clr';

  v_result := pg_temp.p49_open(
    'dm:U-clr','user','U-clr','U-clr','evt-c2','main','คืนเสีย');
  PERFORM pg_temp.p49_assert(v_result->>'outcome' = 'rotated', '8: must rotate');

  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = 'dm:U-clr';
  PERFORM pg_temp.p49_assert(v_row.accumulated_text = '', '8: accumulated_text cleared');
  PERFORM pg_temp.p49_assert(v_row.close_event_timestamp_ms IS NULL, '8: close boundary cleared');
  PERFORM pg_temp.p49_assert(v_row.close_requested_at IS NULL, '8: close_requested_at cleared');
  PERFORM pg_temp.p49_assert(v_row.close_line_event_id IS NULL, '8: close event id cleared');
  PERFORM pg_temp.p49_assert(v_row.close_session_generation IS NULL, '8: close generation cleared');
  PERFORM pg_temp.p49_assert(v_row.close_deadline_at IS NULL, '8: close deadline cleared');
  PERFORM pg_temp.p49_assert(v_row.next_attempt_at IS NULL, '8: next_attempt_at cleared');
  PERFORM pg_temp.p49_assert(v_row.expected_item_count IS NULL, '8: expected_item_count cleared');
  PERFORM pg_temp.p49_assert(v_row.ingest_revision = 0, '8: ingest_revision reset');
  PERFORM pg_temp.p49_assert(v_row.latest_reply_token IS NULL, '8: reply token cleared');
  PERFORM pg_temp.p49_assert(v_row.terminalized = false, '8: terminalized cleared');
  PERFORM pg_temp.p49_assert(v_row.finalization_started_at IS NULL, '8: finalization state cleared');
  PERFORM pg_temp.p49_assert(v_row.finalization_status = 'pending', '8: finalization status reset');
  -- Structured metadata is fully rewritten, not merged with the old generation.
  PERFORM pg_temp.p49_assert(v_row.initial_transaction_type = 'คืนเสีย',
    '8: the new generation carries the newly declared initial type');
  PERFORM pg_temp.p49_assert(v_row.opened_line_event_id = 'evt-c2',
    '8: opened_line_event_id follows the rotating event');

  -- ── 9/10. Open and close are control events: no ledger rows, no text ──────
  SELECT count(*) INTO v_count FROM public.pending_session_admission;
  PERFORM pg_temp.p49_assert(v_count = 0,
    '9/10: a typed open must create no admission row');
  SELECT count(*) INTO v_count FROM public.pending_session_ingest;
  PERFORM pg_temp.p49_assert(v_count = 0,
    '9/10: a typed open must create no ingest row');

  v_result := public.close_produce_structured_session(
    'dm:U-clr', 'U-clr', 'evt-close-1', 1800000010000, NULL, NULL);
  PERFORM pg_temp.p49_assert((v_result->>'accepted')::boolean,
    '10: a structured close must be accepted');
  PERFORM pg_temp.p49_assert(v_result->>'reason' = 'first_close',
    '10: the first close sets the boundary');

  SELECT count(*) INTO v_count FROM public.pending_session_admission;
  PERFORM pg_temp.p49_assert(v_count = 0,
    '10: a postback close must create no admission row');
  SELECT count(*) INTO v_count FROM public.pending_session_ingest;
  PERFORM pg_temp.p49_assert(v_count = 0,
    '10: a postback close must create no ingest row');

  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = 'dm:U-clr';
  PERFORM pg_temp.p49_assert(v_row.accumulated_text = '',
    '10: a postback close writes no synthetic Thai closer text');
  PERFORM pg_temp.p49_assert(v_row.close_event_timestamp_ms = 1800000010000,
    '10: the close boundary comes from the real LINE event timestamp');
  PERFORM pg_temp.p49_assert(v_row.close_line_event_id = 'evt-close-1',
    '10: the close event id is the real postback id');

  -- The first boundary is immutable; a repeat close is a status request.
  v_result := public.close_produce_structured_session(
    'dm:U-clr', 'U-clr', 'evt-close-2', 1800000099000, NULL, NULL);
  PERFORM pg_temp.p49_assert(v_result->>'reason' = 'close_already_requested',
    '10: a repeat close must be a status request');
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = 'dm:U-clr';
  PERFORM pg_temp.p49_assert(v_row.close_event_timestamp_ms = 1800000010000,
    '10: the immutable close boundary must not move');

  -- A structured command never drives a legacy row.
  v_result := public.close_produce_structured_session(
    'dm:LEGACY1', 'LEGACY1', 'evt-close-legacy', 1800000010000, NULL, NULL);
  PERFORM pg_temp.p49_assert(v_result->>'reason' = 'not_structured',
    '10: close must refuse a legacy row');

  -- ── 11. A structured row cannot become ready from accumulated_text ────────
  -- The structured row above is closing with zero admissions. Force text into
  -- it to prove the escape hatch is closed even then.
  UPDATE public.pending_sessions
     SET accumulated_text = E'พี่ดำ-วิหาร เบิก 10/6/2569\n1.แตงโม10บาท\n1โล'
   WHERE session_key = 'dm:U-clr';
  v_ready := public.check_pending_close_ready('dm:U-clr');
  PERFORM pg_temp.p49_assert((v_ready->>'ready')::boolean IS FALSE,
    '11: a structured session must never be ready with zero admissions');
  PERFORM pg_temp.p49_assert(v_ready->>'reason' = 'no_admissions',
    '11: the reason must be no_admissions, not legacy_accumulated');

  -- ── 12. The legacy escape hatch still works for a legacy row ──────────────
  UPDATE public.pending_sessions SET
    close_event_timestamp_ms = 1800000010000,
    close_requested_at       = now()
  WHERE session_key = 'dm:LEGACY1';
  v_ready := public.check_pending_close_ready('dm:LEGACY1');
  PERFORM pg_temp.p49_assert((v_ready->>'ready')::boolean,
    '12: a legacy row must still reach legacy_accumulated readiness');
  PERFORM pg_temp.p49_assert(v_ready->>'reason' = 'legacy_accumulated',
    '12: the legacy compatibility reason is unchanged');

  -- ── 13/14. Privileges ────────────────────────────────────────────────────
  PERFORM pg_temp.p49_assert(
    NOT has_function_privilege('anon',
      'public.open_or_rotate_produce_structured_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,uuid,text)',
      'EXECUTE'),
    '13: anon must not execute the open RPC');
  PERFORM pg_temp.p49_assert(
    NOT has_function_privilege('authenticated',
      'public.open_or_rotate_produce_structured_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,uuid,text)',
      'EXECUTE'),
    '13: authenticated must not execute the open RPC');
  PERFORM pg_temp.p49_assert(
    NOT has_function_privilege('anon',
      'public.close_produce_structured_session(text,text,text,bigint,uuid,integer)', 'EXECUTE'),
    '13: anon must not execute the close RPC');
  PERFORM pg_temp.p49_assert(
    NOT has_function_privilege('authenticated',
      'public.check_pending_close_ready(text)', 'EXECUTE'),
    '13: authenticated must not execute check_pending_close_ready');

  PERFORM pg_temp.p49_assert(
    has_function_privilege('service_role',
      'public.open_or_rotate_produce_structured_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,uuid,text)',
      'EXECUTE'),
    '14: service_role must execute the open RPC');
  PERFORM pg_temp.p49_assert(
    has_function_privilege('service_role',
      'public.close_produce_structured_session(text,text,text,bigint,uuid,integer)', 'EXECUTE'),
    '14: service_role must execute the close RPC');
  PERFORM pg_temp.p49_assert(
    has_function_privilege('service_role',
      'public.check_pending_close_ready(text)', 'EXECUTE'),
    '14: service_role must execute check_pending_close_ready');

  -- Exactly one SECURITY DEFINER function, with a pinned search_path.
  SELECT count(*) INTO v_count FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND p.proname IN ('open_or_rotate_produce_structured_session',
                       'close_produce_structured_session',
                       'check_pending_close_ready',
                       'register_pending_session_ingest');
  PERFORM pg_temp.p49_assert(v_count = 1,
    '14: exactly one Produce function may be SECURITY DEFINER');

  -- ── 15. Equal counts are not set identity ────────────────────────────────
  -- Admission {A,B} with ingest {A,C}: the close barrier sees 2 = 2 and reports
  -- ready, so joining every ingest row would parse C (never admitted) and drop
  -- B (admitted). This is exactly why structured finalization compares the
  -- generation-scoped line_event_id SETS instead of trusting the counts.
  v_result := pg_temp.p49_open('dm:U-set','user','U-set','U-set','evt-s1');
  v_gen := (v_result->>'session_generation')::uuid;

  INSERT INTO public.pending_session_admission
    (session_key, session_generation, line_event_id, line_timestamp_ms)
  VALUES ('dm:U-set', v_gen, 'A', 1800000001000),
         ('dm:U-set', v_gen, 'B', 1800000002000);
  INSERT INTO public.pending_session_ingest
    (session_key, session_generation, line_event_id, line_timestamp_ms, raw_text)
  VALUES ('dm:U-set', v_gen, 'A', 1800000001000, '1.แตงโม10บาท'),
         ('dm:U-set', v_gen, 'C', 1800000003000, '99.ของแปลกปลอม999บาท');

  UPDATE public.pending_sessions SET
    close_event_timestamp_ms = 1800000009000,
    close_requested_at       = now()
  WHERE session_key = 'dm:U-set';

  v_ready := public.check_pending_close_ready('dm:U-set');
  PERFORM pg_temp.p49_assert((v_ready->>'admission_count')::int = 2,
    '15: the admission count is 2');
  PERFORM pg_temp.p49_assert((v_ready->>'ingest_count')::int = 2,
    '15: the ingest count is also 2 — counts agree');
  PERFORM pg_temp.p49_assert((v_ready->>'ready')::boolean,
    '15: the close barrier reports ready on count parity alone');

  SELECT count(*) INTO v_count FROM (
    (SELECT line_event_id FROM public.pending_session_admission
      WHERE session_generation = v_gen
     EXCEPT
     SELECT line_event_id FROM public.pending_session_ingest
      WHERE session_generation = v_gen)
    UNION ALL
    (SELECT line_event_id FROM public.pending_session_ingest
      WHERE session_generation = v_gen
     EXCEPT
     SELECT line_event_id FROM public.pending_session_admission
      WHERE session_generation = v_gen)
  ) AS set_difference;
  PERFORM pg_temp.p49_assert(v_count > 0,
    '15: the event-id sets differ despite equal counts — structured '
    || 'finalization must compare sets and fail closed');

  -- A blank ingest row never counts towards parity, which is why a degenerate
  -- append is refused before it can create admission_count=1 / ingest_count=0.
  v_result := pg_temp.p49_open('dm:U-blank','user','U-blank','U-blank','evt-b1');
  v_gen := (v_result->>'session_generation')::uuid;
  INSERT INTO public.pending_session_admission
    (session_key, session_generation, line_event_id, line_timestamp_ms)
  VALUES ('dm:U-blank', v_gen, 'BLANK', 1800000001000);
  INSERT INTO public.pending_session_ingest
    (session_key, session_generation, line_event_id, line_timestamp_ms, raw_text)
  VALUES ('dm:U-blank', v_gen, 'BLANK', 1800000001000, '   ');
  UPDATE public.pending_sessions SET
    close_event_timestamp_ms = 1800000009000,
    close_requested_at       = now()
  WHERE session_key = 'dm:U-blank';

  v_ready := public.check_pending_close_ready('dm:U-blank');
  PERFORM pg_temp.p49_assert((v_ready->>'admission_count')::int = 1,
    '9: a blank append would be admitted');
  PERFORM pg_temp.p49_assert((v_ready->>'ingest_count')::int = 0,
    '9: but a blank raw_text never counts towards ingest parity');
  PERFORM pg_temp.p49_assert((v_ready->>'ready')::boolean IS FALSE,
    '9: so a blank append strands the session — it must be refused upstream');

  RAISE NOTICE 'produce_0049_verification: ALL CHECKS PASSED';
END
$$;
