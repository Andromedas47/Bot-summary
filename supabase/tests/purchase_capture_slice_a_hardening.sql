-- P2B purchase-capture Slice A hardening assertions against a disposable local DB.
-- FAIL closed: any failed check RAISE EXCEPTION. Expect NOTICE PASS at end.

CREATE OR REPLACE FUNCTION pg_temp.pc_assert(cond boolean, msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT cond THEN
    RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: %', msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_expect_error(p_sql text, p_needle text, p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_err text;
  v_state text;
  v_raised boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION
    WHEN OTHERS THEN
      v_raised := true;
      GET STACKED DIAGNOSTICS
        v_err = MESSAGE_TEXT,
        v_state = RETURNED_SQLSTATE;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION
      'purchase_capture_slice_a_hardening FAIL: % (expected error containing "%"; statement succeeded)',
      p_msg, p_needle;
  END IF;

  IF position(lower(p_needle) IN lower(v_err)) = 0 THEN
    RAISE EXCEPTION
      'purchase_capture_slice_a_hardening FAIL: % — got "%" sqlstate=% (wanted substring "%")',
      p_msg, v_err, v_state, p_needle;
  END IF;
END;
$$;

-- ── 1. One active session per source+sender; distinguishable already_open ────
DO $$
DECLARE
  r1 jsonb;
  r2 jsonb;
  n_active int;
BEGIN
  r1 := public.open_purchase_capture_session(
    'group', 'G-c1', 'U-c1', 'evt-open-c1-a', 1000, 'header A'
  );
  PERFORM pg_temp.pc_assert(COALESCE((r1->>'opened')::boolean, false), '1: first open should open');

  r2 := public.open_purchase_capture_session(
    'group', 'G-c1', 'U-c1', 'evt-open-c1-b', 1001, 'header B'
  );
  PERFORM pg_temp.pc_assert(
    NOT COALESCE((r2->>'opened')::boolean, true) AND (r2->>'reason') = 'already_open',
    format('1: second open must be distinctly already_open; got %s', r2::text)
  );
  PERFORM pg_temp.pc_assert((r2->>'session_id') = (r1->>'session_id'), '1: already_open reports the active session');

  SELECT count(*) INTO n_active
  FROM public.purchase_capture_sessions
  WHERE source_id = 'G-c1' AND sender_line_user_id = 'U-c1' AND status IN ('open', 'closing');
  PERFORM pg_temp.pc_assert(n_active = 1, format('1: expected 1 active session, got %s', n_active));
END;
$$;

-- ── 2. Same header event twice with identical fingerprint → idempotent ───────
DO $$
DECLARE
  r1 jsonb;
  r2 jsonb;
  n_sess int;
  n_ingest int;
BEGIN
  r1 := public.open_purchase_capture_session(
    'group', 'G-idem', 'U-idem', 'evt-open-idem', 2000, 'header idem'
  );
  PERFORM pg_temp.pc_assert(COALESCE((r1->>'opened')::boolean, false), '2: first open');

  r2 := public.open_purchase_capture_session(
    'group', 'G-idem', 'U-idem', 'evt-open-idem', 2000, 'header idem'
  );
  PERFORM pg_temp.pc_assert(COALESCE((r2->>'idempotent')::boolean, false), '2: second open idempotent');
  PERFORM pg_temp.pc_assert((r2->>'reason') = 'duplicate_open_event', '2: duplicate_open_event reason');
  PERFORM pg_temp.pc_assert((r2->>'session_id') = (r1->>'session_id'), '2: same session_id on redelivery');

  SELECT count(*) INTO n_sess FROM public.purchase_capture_sessions WHERE opened_line_event_id = 'evt-open-idem';
  SELECT count(*) INTO n_ingest FROM public.purchase_capture_session_ingests WHERE line_event_id = 'evt-open-idem';
  PERFORM pg_temp.pc_assert(n_sess = 1, '2: one session');
  PERFORM pg_temp.pc_assert(n_ingest = 1, '2: one header ingest');
END;
$$;

-- ── 3. Duplicate open with different raw_text / source / sender fails closed ─
DO $$
DECLARE
  r jsonb;
BEGIN
  r := public.open_purchase_capture_session(
    'group', 'G-fp-open', 'U-fp-open', 'evt-fp-open', 2500, 'original header text'
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'opened')::boolean, false), '3: fixture open');

  PERFORM pg_temp.pc_expect_error(
    $q$SELECT public.open_purchase_capture_session(
      'group', 'G-fp-open', 'U-fp-open', 'evt-fp-open', 2500, 'DIFFERENT header text')$q$,
    'line_event_conflict',
    '3: duplicate open with different raw_text fails closed'
  );
  PERFORM pg_temp.pc_expect_error(
    $q$SELECT public.open_purchase_capture_session(
      'group', 'G-fp-open', 'U-fp-open', 'evt-fp-open', 9999, 'original header text')$q$,
    'line_event_conflict',
    '3: duplicate open with different line_timestamp_ms fails closed'
  );
  PERFORM pg_temp.pc_expect_error(
    $q$SELECT public.open_purchase_capture_session(
      'group', 'G-fp-open-DIFFERENT', 'U-fp-open', 'evt-fp-open', 2500, 'original header text')$q$,
    'line_event_conflict',
    '3: duplicate open with different source_id fails closed'
  );
  PERFORM pg_temp.pc_expect_error(
    $q$SELECT public.open_purchase_capture_session(
      'group', 'G-fp-open', 'U-fp-open-DIFFERENT', 'evt-fp-open', 2500, 'original header text')$q$,
    'line_event_conflict',
    '3: duplicate open with different sender_line_user_id fails closed'
  );

  -- A conflicting redelivery must never have mutated the original row.
  PERFORM pg_temp.pc_assert(
    (SELECT raw_text FROM public.purchase_capture_session_ingests WHERE line_event_id = 'evt-fp-open') = 'original header text',
    '3: original ingest content untouched by rejected conflicting redelivery'
  );
END;
$$;

-- ── 4-11: admit / close barrier / conflicting reuse / one-message close ──────
DO $$
DECLARE
  r jsonb;
  v_sid uuid;
  v_gen uuid;
  n int;
  cand jsonb;
  other jsonb;
  other_sid uuid;
  other_gen uuid;
BEGIN
  r := public.open_purchase_capture_session(
    'group', 'G-bar', 'U-bar', 'evt-h-bar', 3000, 'เริ่มซื้อ 4/8/2569 09:30'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;

  -- Item admitted
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-bar', 'U-bar', 'evt-item1', 3100, 'item', 'ซื้อรายการ 1', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, false), '4: item1 admitted');

  -- 4b. Duplicate item event, identical fingerprint → one ingest, idempotent
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-bar', 'U-bar', 'evt-item1', 3100, 'item', 'ซื้อรายการ 1', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, true) = false, '4b: dup not inserted');
  PERFORM pg_temp.pc_assert((r->>'reason') = 'duplicate_event', '4b: duplicate_event reason');
  SELECT count(*) INTO n FROM public.purchase_capture_session_ingests WHERE line_event_id = 'evt-item1';
  PERFORM pg_temp.pc_assert(n = 1, '4b: one ingest for item1');

  -- 5. Duplicate admit with different raw_text / kind / timestamp / message ids fails closed
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-bar', 'U-bar', 'evt-item1', 3100, 'item', 'DIFFERENT TEXT', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'line_event_conflict',
    '5: duplicate admit with different raw_text fails closed'
  );
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-bar', 'U-bar', 'evt-item1', 3100, 'costs', 'ซื้อรายการ 1', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'line_event_conflict',
    '5: duplicate admit with different kind fails closed'
  );
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-bar', 'U-bar', 'evt-item1', 3101, 'item', 'ซื้อรายการ 1', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'line_event_conflict',
    '5: duplicate admit with different line_timestamp_ms fails closed'
  );
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-bar', 'U-bar', 'evt-item1', 3100, 'item', 'ซื้อรายการ 1', 'msg-different', NULL)$q$,
      v_sid, v_gen
    ),
    'line_event_conflict',
    '5: duplicate admit with different line_message_id fails closed'
  );
  SELECT count(*) INTO n FROM public.purchase_capture_session_ingests WHERE line_event_id = 'evt-item1';
  PERFORM pg_temp.pc_assert(n = 1, '5: still exactly one ingest row after every rejected conflicting redelivery');
  PERFORM pg_temp.pc_assert(
    (SELECT raw_text FROM public.purchase_capture_session_ingests WHERE line_event_id = 'evt-item1') = 'ซื้อรายการ 1',
    '5: original ingest content untouched by rejected conflicting redeliveries'
  );

  -- Open another session for cross-session conflict test
  other := public.open_purchase_capture_session(
    'group', 'G-other', 'U-other', 'evt-h-other', 3000, 'header other'
  );
  other_sid := (other->>'session_id')::uuid;
  other_gen := (other->>'session_generation')::uuid;

  -- 6. Same event against another session → line_event_conflict
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-other', 'U-other', 'evt-item1', 3100, 'item', 'x', NULL, NULL)$q$,
      other_sid, other_gen
    ),
    'line_event_conflict',
    '6: cross-session event conflict'
  );

  -- costs block
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-bar', 'U-bar', 'evt-costs', 3150, 'costs', 'สรุปค่าใช้จ่ายซื้อ', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, false), '7: costs admitted');

  -- Close
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-bar', 'U-bar', 'evt-close-bar', 4000, 'close', 'ปิดซื้อ 1 รายการ', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, false), '7: close admitted');
  PERFORM pg_temp.pc_assert((r->>'status') = 'closing', '7: status closing');

  -- Redelivered close → close_already_requested, boundary unchanged
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-bar', 'U-bar', 'evt-close-bar-2', 4050, 'close', 'ปิดซื้อ 1 รายการ', NULL, NULL
  );
  PERFORM pg_temp.pc_assert((r->>'reason') = 'close_already_requested', '7b: duplicate close does not move boundary');
  PERFORM pg_temp.pc_assert((r->>'close_event_timestamp_ms') = '4000', '7b: boundary unchanged');

  -- 8. Late pre-boundary item → admitted
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-bar', 'U-bar', 'evt-item-late', 3900, 'item', 'late item', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, false), '8: late item admitted');

  -- 9. Post-boundary event → after_close_boundary
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-bar', 'U-bar', 'evt-post', 4001, 'item', 'post', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'after_close_boundary',
    '9: post-boundary rejected'
  );

  cand := public.get_purchase_capture_finalize_candidate(v_sid, v_gen, 'group', 'G-bar', 'U-bar');
  PERFORM pg_temp.pc_assert((cand->>'status') = 'closing', '10: candidate status closing');
  PERFORM pg_temp.pc_assert(NOT COALESCE((cand->>'quiet_elapsed')::boolean, true), '10: quiet not yet elapsed');
  PERFORM pg_temp.pc_assert(NOT COALESCE((cand->>'eligible_for_finalize')::boolean, true), '10: not yet eligible');
  SELECT count(*) INTO n
  FROM jsonb_array_elements(cand->'ingests') e
  WHERE e->>'line_event_id' = 'evt-post';
  PERFORM pg_temp.pc_assert(n = 0, '10: post-boundary event excluded from candidate');

  PERFORM pg_sleep(8.1);
  cand := public.get_purchase_capture_finalize_candidate(v_sid, v_gen, 'group', 'G-bar', 'U-bar');
  PERFORM pg_temp.pc_assert(COALESCE((cand->>'quiet_elapsed')::boolean, false), '11: quiet elapsed after 8.1s');
  PERFORM pg_temp.pc_assert(COALESCE((cand->>'eligible_for_finalize')::boolean, false), '11: eligible after quiet');
  PERFORM pg_temp.pc_assert(
    (cand->>'ingest_set_hash') = public.purchase_capture_compute_ingest_set_hash(v_sid),
    '11: candidate hash matches compute hash'
  );
END;
$$;

-- ── 12. One-message open+close path: exactly one ingest row, idempotent close ─
DO $$
DECLARE
  r jsonb;
  first_close jsonb;
  second_close jsonb;
  v_sid uuid;
  v_gen uuid;
  n_ingest int;
BEGIN
  r := public.open_purchase_capture_session(
    'group', 'G-onemsg', 'U-onemsg', 'evt-onemsg', 5000, 'complete document in one message'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;

  first_close := public.close_purchase_capture_open_event(v_sid, v_gen, 'group', 'G-onemsg', 'U-onemsg', 'evt-onemsg');
  PERFORM pg_temp.pc_assert(NOT COALESCE((first_close->>'idempotent')::boolean, true), '12: first close not idempotent');
  PERFORM pg_temp.pc_assert((first_close->>'status') = 'closing', '12: status closing after inline close');

  second_close := public.close_purchase_capture_open_event(v_sid, v_gen, 'group', 'G-onemsg', 'U-onemsg', 'evt-onemsg');
  PERFORM pg_temp.pc_assert(COALESCE((second_close->>'idempotent')::boolean, false), '12: redelivered close idempotent');

  SELECT count(*) INTO n_ingest
  FROM public.purchase_capture_session_ingests
  WHERE session_id = v_sid;
  PERFORM pg_temp.pc_assert(n_ingest = 1, format('12: exactly one ingest row, got %s', n_ingest));

  PERFORM pg_temp.pc_assert(
    (SELECT close_event_timestamp_ms FROM public.purchase_capture_sessions WHERE id = v_sid) = 5000,
    '12: boundary derived from the persisted opening event timestamp'
  );
END;
$$;

-- ── 13. Append-only protection: ingests / lifecycle events immutable ─────────
DO $$
DECLARE
  v_sid uuid;
  v_ingest uuid;
  v_life uuid;
BEGIN
  SELECT id INTO v_sid FROM public.purchase_capture_sessions WHERE opened_line_event_id = 'evt-h-bar';
  SELECT id INTO v_ingest FROM public.purchase_capture_session_ingests WHERE session_id = v_sid LIMIT 1;
  SELECT id INTO v_life FROM public.purchase_capture_lifecycle_events WHERE session_id = v_sid LIMIT 1;

  PERFORM pg_temp.pc_expect_error(
    format('UPDATE public.purchase_capture_session_ingests SET raw_text = ''x'' WHERE id = %L', v_ingest),
    'immutable',
    '13: ingest UPDATE'
  );
  PERFORM pg_temp.pc_expect_error(
    format('DELETE FROM public.purchase_capture_session_ingests WHERE id = %L', v_ingest),
    'immutable',
    '13: ingest DELETE'
  );
  PERFORM pg_temp.pc_expect_error(
    format('UPDATE public.purchase_capture_lifecycle_events SET actor = ''x'' WHERE id = %L', v_life),
    'immutable',
    '13: lifecycle UPDATE'
  );
  PERFORM pg_temp.pc_expect_error(
    format('DELETE FROM public.purchase_capture_lifecycle_events WHERE id = %L', v_life),
    'immutable',
    '13: lifecycle DELETE'
  );
END;
$$;

-- ── 14. Terminal session immutability (cancelled) + cancel invalid_state ─────
DO $$
DECLARE
  r jsonb;
  v_sid uuid;
  v_gen uuid;
  v_receipt uuid := gen_random_uuid();
BEGIN
  r := public.open_purchase_capture_session(
    'group', 'G-cancel', 'U-cancel', 'evt-cancel', 6000, 'header'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;

  r := public.cancel_purchase_capture_session(v_sid, v_gen, 'group', 'G-cancel', 'U-cancel');
  PERFORM pg_temp.pc_assert(NOT COALESCE((r->>'idempotent')::boolean, true), '14: first cancel not idempotent');
  PERFORM pg_temp.pc_assert((r->>'status') = 'cancelled', '14: status cancelled');

  r := public.cancel_purchase_capture_session(v_sid, v_gen, 'group', 'G-cancel', 'U-cancel');
  PERFORM pg_temp.pc_assert(COALESCE((r->>'idempotent')::boolean, false), '14: second cancel idempotent');

  PERFORM pg_temp.pc_expect_error(
    format('UPDATE public.purchase_capture_sessions SET fail_reason = ''x'' WHERE id = %L', v_sid),
    'terminal and immutable',
    '14: cancelled session UPDATE rejected'
  );

  -- Force a non-terminal 'confirming' state (as table owner, bypassing the
  -- Slice A RPC surface deliberately, to exercise cancel's own CHECK-guarded
  -- refusal from a status Slice A itself can never reach) and confirm cancel
  -- refuses invalid_state rather than silently cancelling a confirming purchase.
  INSERT INTO public.purchase_receipts (id) VALUES (v_receipt);
  r := public.open_purchase_capture_session(
    'group', 'G-confirming', 'U-confirming', 'evt-confirming', 7000, 'header'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;
  UPDATE public.purchase_capture_sessions
  SET status = 'confirming', receipt_id = v_receipt, draft_revision = 0
  WHERE id = v_sid;

  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.cancel_purchase_capture_session(%L::uuid, %L::uuid, ''group'', ''G-confirming'', ''U-confirming'')', v_sid, v_gen),
    'invalid_state',
    '14: cancel from confirming refuses invalid_state'
  );
END;
$$;

-- ── 15. Stale generation refused ──────────────────────────────────────────────
DO $$
DECLARE
  r jsonb;
  v_sid uuid;
  v_gen uuid;
  v_wrong_gen uuid := gen_random_uuid();
BEGIN
  r := public.open_purchase_capture_session(
    'group', 'G-stale-gen', 'U-stale-gen', 'evt-stale-gen', 8000, 'header'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;
  PERFORM pg_temp.pc_assert(v_wrong_gen <> v_gen, '15: fixture sanity');

  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-stale-gen', 'U-stale-gen', 'evt-stale-item', 8100, 'item', 'x', NULL, NULL)$q$,
      v_sid, v_wrong_gen
    ),
    'generation_conflict',
    '15: admit with stale generation refused'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.get_purchase_capture_finalize_candidate(%L::uuid, %L::uuid, ''group'', ''G-stale-gen'', ''U-stale-gen'')', v_sid, v_wrong_gen),
    'generation_conflict',
    '15: candidate with stale generation refused'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.cancel_purchase_capture_session(%L::uuid, %L::uuid, ''group'', ''G-stale-gen'', ''U-stale-gen'')', v_sid, v_wrong_gen),
    'generation_conflict',
    '15: cancel with stale generation refused'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.close_purchase_capture_open_event(%L::uuid, %L::uuid, ''group'', ''G-stale-gen'', ''U-stale-gen'', ''evt-stale-gen'')', v_sid, v_wrong_gen),
    'generation_conflict',
    '15: close with stale generation refused'
  );
END;
$$;

-- ── 16. Ownership mismatch: correct session_id/generation is NOT sufficient ──
-- A valid session id + generation must still be refused if the caller's
-- claimed source_type/source_id/sender_line_user_id doesn't match the
-- session's own — and no mutation may occur.
DO $$
DECLARE
  r jsonb;
  v_sid uuid;
  v_gen uuid;
  n_ingest_before int;
  n_ingest_after int;
  n_lifecycle_before int;
  n_lifecycle_after int;
BEGIN
  r := public.open_purchase_capture_session(
    'group', 'G-own', 'U-own', 'evt-own', 8500, 'header'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;

  SELECT count(*) INTO n_ingest_before FROM public.purchase_capture_session_ingests WHERE session_id = v_sid;
  SELECT count(*) INTO n_lifecycle_before FROM public.purchase_capture_lifecycle_events WHERE session_id = v_sid;

  -- admit: wrong source_type / source_id / sender each individually refused
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'user', 'G-own', 'U-own', 'evt-own-item', 8600, 'item', 'x', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'ownership_mismatch',
    '16: admit refuses wrong expected_source_type'
  );
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-own-WRONG', 'U-own', 'evt-own-item', 8600, 'item', 'x', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'ownership_mismatch',
    '16: admit refuses wrong expected_source_id'
  );
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'group', 'G-own', 'U-own-WRONG', 'evt-own-item', 8600, 'item', 'x', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'ownership_mismatch',
    '16: admit refuses wrong expected_sender_line_user_id'
  );

  -- close: same three mismatches refused
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.close_purchase_capture_open_event(%L::uuid, %L::uuid, ''user'', ''G-own'', ''U-own'', ''evt-own'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: close refuses wrong expected_source_type'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.close_purchase_capture_open_event(%L::uuid, %L::uuid, ''group'', ''G-own-WRONG'', ''U-own'', ''evt-own'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: close refuses wrong expected_source_id'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.close_purchase_capture_open_event(%L::uuid, %L::uuid, ''group'', ''G-own'', ''U-own-WRONG'', ''evt-own'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: close refuses wrong expected_sender_line_user_id'
  );

  -- cancel: same three mismatches refused
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.cancel_purchase_capture_session(%L::uuid, %L::uuid, ''user'', ''G-own'', ''U-own'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: cancel refuses wrong expected_source_type'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.cancel_purchase_capture_session(%L::uuid, %L::uuid, ''group'', ''G-own-WRONG'', ''U-own'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: cancel refuses wrong expected_source_id'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.cancel_purchase_capture_session(%L::uuid, %L::uuid, ''group'', ''G-own'', ''U-own-WRONG'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: cancel refuses wrong expected_sender_line_user_id'
  );

  -- candidate (a read): same three mismatches refused, distinct from generation_conflict
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.get_purchase_capture_finalize_candidate(%L::uuid, %L::uuid, ''user'', ''G-own'', ''U-own'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: candidate refuses wrong expected_source_type'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.get_purchase_capture_finalize_candidate(%L::uuid, %L::uuid, ''group'', ''G-own-WRONG'', ''U-own'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: candidate refuses wrong expected_source_id'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.get_purchase_capture_finalize_candidate(%L::uuid, %L::uuid, ''group'', ''G-own'', ''U-own-WRONG'')', v_sid, v_gen),
    'ownership_mismatch',
    '16: candidate refuses wrong expected_sender_line_user_id'
  );

  -- No ingest, boundary, cancellation or lifecycle mutation occurred from any
  -- of the rejected calls above.
  SELECT count(*) INTO n_ingest_after FROM public.purchase_capture_session_ingests WHERE session_id = v_sid;
  SELECT count(*) INTO n_lifecycle_after FROM public.purchase_capture_lifecycle_events WHERE session_id = v_sid;
  PERFORM pg_temp.pc_assert(n_ingest_after = n_ingest_before, '16: no ingest mutation from any ownership_mismatch call');
  PERFORM pg_temp.pc_assert(n_lifecycle_after = n_lifecycle_before, '16: no lifecycle mutation from any ownership_mismatch call');
  PERFORM pg_temp.pc_assert(
    (SELECT status FROM public.purchase_capture_sessions WHERE id = v_sid) = 'open',
    '16: session status untouched by any ownership_mismatch call'
  );
  PERFORM pg_temp.pc_assert(
    (SELECT close_event_timestamp_ms FROM public.purchase_capture_sessions WHERE id = v_sid) IS NULL,
    '16: close boundary untouched by any ownership_mismatch call'
  );
END;
$$;

-- ── 17. Sender/source isolation ───────────────────────────────────────────────
DO $$
DECLARE
  ra jsonb;
  rb jsonb;
BEGIN
  -- Same sender, two different LINE groups → two independent sessions.
  ra := public.open_purchase_capture_session(
    'group', 'G-iso-1', 'U-iso-shared', 'evt-iso-1', 9000, 'header'
  );
  rb := public.open_purchase_capture_session(
    'group', 'G-iso-2', 'U-iso-shared', 'evt-iso-2', 9000, 'header'
  );
  PERFORM pg_temp.pc_assert(COALESCE((ra->>'opened')::boolean, false), '17: session A opened');
  PERFORM pg_temp.pc_assert(COALESCE((rb->>'opened')::boolean, false), '17: session B opened independently');
  PERFORM pg_temp.pc_assert((ra->>'session_id') <> (rb->>'session_id'), '17: distinct sessions per source');
END;
$$;

-- ── 18. RLS enabled, no policies, on every new table ──────────────────────────
DO $$
DECLARE
  t text;
  v_rls boolean;
  v_policy_count int;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'purchase_capture_sessions',
    'purchase_capture_session_ingests',
    'purchase_capture_lifecycle_events'
  ])
  LOOP
    SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = ('public.' || t)::regclass;
    PERFORM pg_temp.pc_assert(v_rls, format('18: %s RLS must be enabled', t));
    SELECT count(*) INTO v_policy_count FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    PERFORM pg_temp.pc_assert(v_policy_count = 0, format('18: %s must have no policies', t));
  END LOOP;
END;
$$;

-- ── 19. Privileges: anon/authenticated denied; service_role execute+select, no insert ─
DO $$
DECLARE
  v_sid uuid;
  v_gen uuid;
BEGIN
  SELECT id, session_generation INTO v_sid, v_gen
  FROM public.purchase_capture_sessions
  WHERE opened_line_event_id = 'evt-iso-1';

  -- anon: no SELECT, no EXECUTE
  BEGIN
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM 1 FROM public.purchase_capture_sessions LIMIT 1;
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 19 anon SELECT should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.open_purchase_capture_session('group', 'G-priv', 'U-priv', 'evt-priv-a', 1, 'h');
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 19 anon EXECUTE should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END;

  -- authenticated: no SELECT / EXECUTE
  BEGIN
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM 1 FROM public.purchase_capture_session_ingests LIMIT 1;
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 19 authenticated SELECT should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.get_purchase_capture_finalize_candidate(v_sid, v_gen, 'group', 'G-iso-1', 'U-iso-shared');
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 19 authenticated EXECUTE should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END;

  -- service_role: SELECT + EXECUTE ok; direct INSERT denied
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM 1 FROM public.purchase_capture_sessions WHERE id = v_sid;
    PERFORM public.get_purchase_capture_finalize_candidate(v_sid, v_gen, 'group', 'G-iso-1', 'U-iso-shared');
    BEGIN
      INSERT INTO public.purchase_capture_sessions (
        source_type, source_id, sender_line_user_id, opened_line_event_id
      ) VALUES (
        'group', 'G-direct-insert', 'U-direct-insert', 'evt-direct-insert'
      );
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 19 service_role INSERT should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END;
END;
$$;

-- ── 20. No idle-expiration: a never-closed session simply stays open ─────────
DO $$
DECLARE
  r jsonb;
  status text;
BEGIN
  r := public.open_purchase_capture_session(
    'group', 'G-idle', 'U-idle', 'evt-idle', 10000, 'header'
  );
  SELECT s.status INTO status FROM public.purchase_capture_sessions s WHERE id = (r->>'session_id')::uuid;
  PERFORM pg_temp.pc_assert(status = 'open', '20: session with no close event remains open');
END;
$$;

-- ── 21. Ingest-set hash is admission-order independent ───────────────────────
-- line_event_id must be globally unique, so two sessions can never share
-- byte-identical hashed tuples; the discriminating proof instead is: within
-- ONE session, the returned hash must equal a reference hash computed
-- directly from that session's own rows in canonical (line_timestamp_ms,
-- line_event_id) order — regardless of the order those rows were actually
-- admitted in. Session A admits in ascending-timestamp (= admission-order-
-- matches-canonical-order) sequence; Session B admits the higher-timestamp
-- event FIRST, so its admission order (and therefore ingest_ordinal) is the
-- REVERSE of canonical order — a hash keyed on ingest_ordinal would disagree
-- with the canonical-order reference for B; a hash keyed on
-- (line_timestamp_ms, line_event_id), as required, agrees for both.
DO $$
DECLARE
  ra jsonb;
  rb jsonb;
  v_sid_a uuid;
  v_gen_a uuid;
  v_sid_b uuid;
  v_gen_b uuid;
  hash_a text;
  hash_b text;
  canonical_ref_a text;
  canonical_ref_b text;
  ordinal_ref_b text;
  cand_a jsonb;
BEGIN
  -- Session A: open (ts=100), admit item1 (ts=200), then item2 (ts=300) —
  -- admission order already matches canonical timestamp order.
  ra := public.open_purchase_capture_session(
    'group', 'G-hash-a', 'U-hash-a', 'evt-hash-open-a', 100, 'header'
  );
  v_sid_a := (ra->>'session_id')::uuid;
  v_gen_a := (ra->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid_a, v_gen_a, 'group', 'G-hash-a', 'U-hash-a', 'evt-hash-item1', 200, 'item', 'item one', NULL, NULL
  );
  PERFORM public.admit_purchase_capture_event(
    v_sid_a, v_gen_a, 'group', 'G-hash-a', 'U-hash-a', 'evt-hash-item2', 300, 'item', 'item two', NULL, NULL
  );

  -- Session B: open (ts=100), admit item2 (ts=300) FIRST, then item1 (ts=200)
  -- — admission order is the reverse of canonical timestamp order.
  rb := public.open_purchase_capture_session(
    'group', 'G-hash-b', 'U-hash-b', 'evt-hash-open-b', 100, 'header'
  );
  v_sid_b := (rb->>'session_id')::uuid;
  v_gen_b := (rb->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid_b, v_gen_b, 'group', 'G-hash-b', 'U-hash-b', 'evt-hash-item2b', 300, 'item', 'item two', NULL, NULL
  );
  PERFORM public.admit_purchase_capture_event(
    v_sid_b, v_gen_b, 'group', 'G-hash-b', 'U-hash-b', 'evt-hash-item1b', 200, 'item', 'item one', NULL, NULL
  );

  hash_a := public.purchase_capture_compute_ingest_set_hash(v_sid_a);
  hash_b := public.purchase_capture_compute_ingest_set_hash(v_sid_b);

  SELECT encode(extensions.digest(string_agg(
    i.line_event_id || E'\x1f' || i.line_timestamp_ms::text || E'\x1f' || i.kind || E'\x1f' || i.raw_text,
    E'\n' ORDER BY i.line_timestamp_ms ASC, i.line_event_id ASC
  ), 'sha256'), 'hex')
  INTO canonical_ref_a
  FROM public.purchase_capture_session_ingests i WHERE i.session_id = v_sid_a;

  SELECT encode(extensions.digest(string_agg(
    i.line_event_id || E'\x1f' || i.line_timestamp_ms::text || E'\x1f' || i.kind || E'\x1f' || i.raw_text,
    E'\n' ORDER BY i.line_timestamp_ms ASC, i.line_event_id ASC
  ), 'sha256'), 'hex')
  INTO canonical_ref_b
  FROM public.purchase_capture_session_ingests i WHERE i.session_id = v_sid_b;

  SELECT encode(extensions.digest(string_agg(
    i.line_event_id || E'\x1f' || i.line_timestamp_ms::text || E'\x1f' || i.kind || E'\x1f' || i.raw_text,
    E'\n' ORDER BY i.ingest_ordinal ASC
  ), 'sha256'), 'hex')
  INTO ordinal_ref_b
  FROM public.purchase_capture_session_ingests i WHERE i.session_id = v_sid_b;

  PERFORM pg_temp.pc_assert(
    hash_a = canonical_ref_a,
    '21: session A hash matches the canonical (timestamp, event_id) order reference'
  );
  PERFORM pg_temp.pc_assert(
    hash_b = canonical_ref_b,
    '21: session B hash matches the canonical order reference despite reverse admission order'
  );
  PERFORM pg_temp.pc_assert(
    hash_b <> ordinal_ref_b,
    '21: session B hash does NOT match the admission-order (ingest_ordinal) reference — proves ordinal is not used'
  );

  cand_a := public.get_purchase_capture_finalize_candidate(v_sid_a, v_gen_a, 'group', 'G-hash-a', 'U-hash-a');
  PERFORM pg_temp.pc_assert((cand_a->>'ingest_set_hash') = hash_a, '21: candidate hash equals compute_ingest_set_hash');

  -- 21b. Changing timestamp, event id, kind or raw_text changes the hash —
  -- verified by comparing session A's hash against a session with one field
  -- of one tuple perturbed.
  DECLARE
    v_sid_ts uuid; v_gen_ts uuid; r_ts jsonb; hash_ts text;
    v_sid_ev uuid; v_gen_ev uuid; r_ev jsonb; hash_ev text;
    v_sid_kind uuid; v_gen_kind uuid; r_kind jsonb; hash_kind text;
    v_sid_text uuid; v_gen_text uuid; r_text jsonb; hash_text text;
  BEGIN
    r_ts := public.open_purchase_capture_session('group', 'G-hash-ts', 'U-hash-ts', 'evt-hash-ts-open', 100, 'header');
    v_sid_ts := (r_ts->>'session_id')::uuid; v_gen_ts := (r_ts->>'session_generation')::uuid;
    PERFORM public.admit_purchase_capture_event(v_sid_ts, v_gen_ts, 'group', 'G-hash-ts', 'U-hash-ts', 'evt-hash-ts-item1', 999, 'item', 'item one', NULL, NULL);
    PERFORM public.admit_purchase_capture_event(v_sid_ts, v_gen_ts, 'group', 'G-hash-ts', 'U-hash-ts', 'evt-hash-ts-item2', 300, 'item', 'item two', NULL, NULL);
    hash_ts := public.purchase_capture_compute_ingest_set_hash(v_sid_ts);
    PERFORM pg_temp.pc_assert(hash_ts <> hash_a, '21b: changing line_timestamp_ms changes the hash');

    r_ev := public.open_purchase_capture_session('group', 'G-hash-ev', 'U-hash-ev', 'evt-hash-ev-open', 100, 'header');
    v_sid_ev := (r_ev->>'session_id')::uuid; v_gen_ev := (r_ev->>'session_generation')::uuid;
    PERFORM public.admit_purchase_capture_event(v_sid_ev, v_gen_ev, 'group', 'G-hash-ev', 'U-hash-ev', 'evt-hash-ev-item1-DIFFERENT', 200, 'item', 'item one', NULL, NULL);
    PERFORM public.admit_purchase_capture_event(v_sid_ev, v_gen_ev, 'group', 'G-hash-ev', 'U-hash-ev', 'evt-hash-ev-item2', 300, 'item', 'item two', NULL, NULL);
    hash_ev := public.purchase_capture_compute_ingest_set_hash(v_sid_ev);
    PERFORM pg_temp.pc_assert(hash_ev <> hash_a, '21b: changing line_event_id changes the hash');

    r_kind := public.open_purchase_capture_session('group', 'G-hash-kind', 'U-hash-kind', 'evt-hash-kind-open', 100, 'header');
    v_sid_kind := (r_kind->>'session_id')::uuid; v_gen_kind := (r_kind->>'session_generation')::uuid;
    PERFORM public.admit_purchase_capture_event(v_sid_kind, v_gen_kind, 'group', 'G-hash-kind', 'U-hash-kind', 'evt-hash-kind-item1', 200, 'costs', 'item one', NULL, NULL);
    PERFORM public.admit_purchase_capture_event(v_sid_kind, v_gen_kind, 'group', 'G-hash-kind', 'U-hash-kind', 'evt-hash-kind-item2', 300, 'item', 'item two', NULL, NULL);
    hash_kind := public.purchase_capture_compute_ingest_set_hash(v_sid_kind);
    PERFORM pg_temp.pc_assert(hash_kind <> hash_a, '21b: changing kind changes the hash');

    r_text := public.open_purchase_capture_session('group', 'G-hash-text', 'U-hash-text', 'evt-hash-text-open', 100, 'header');
    v_sid_text := (r_text->>'session_id')::uuid; v_gen_text := (r_text->>'session_generation')::uuid;
    PERFORM public.admit_purchase_capture_event(v_sid_text, v_gen_text, 'group', 'G-hash-text', 'U-hash-text', 'evt-hash-text-item1', 200, 'item', 'DIFFERENT TEXT', NULL, NULL);
    PERFORM public.admit_purchase_capture_event(v_sid_text, v_gen_text, 'group', 'G-hash-text', 'U-hash-text', 'evt-hash-text-item2', 300, 'item', 'item two', NULL, NULL);
    hash_text := public.purchase_capture_compute_ingest_set_hash(v_sid_text);
    PERFORM pg_temp.pc_assert(hash_text <> hash_a, '21b: changing raw_text changes the hash');
  END;
END;
$$;

-- ── 22. expect_error helper must FAIL when statement unexpectedly succeeds ───
DO $$
BEGIN
  BEGIN
    PERFORM pg_temp.pc_expect_error('SELECT 1', 'line_event_conflict', '22: should fail');
    RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 22 expect_error falsely passed on success';
  EXCEPTION
    WHEN OTHERS THEN
      IF position('expected error containing' IN SQLERRM) = 0
         OR position('statement succeeded' IN SQLERRM) = 0 THEN
        RAISE EXCEPTION
          'purchase_capture_slice_a_hardening FAIL: 22 unexpected error from expect_error: %', SQLERRM;
      END IF;
  END;
END;
$$;

DO $$
BEGIN
  RAISE NOTICE 'purchase_capture_slice_a_hardening PASS';
END;
$$;
