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

-- ── 2. Same header event twice → one session, idempotent ─────────────────────
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

-- ── 3-9: admit / close barrier / conflicting reuse / one-message close ───────
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
    v_sid, v_gen, 'evt-item1', 3100, 'item', 'ซื้อรายการ 1', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, false), '3: item1 admitted');

  -- 3. Duplicate item event → one ingest
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'evt-item1', 3100, 'item', 'ซื้อรายการ 1', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, true) = false, '3: dup not inserted');
  PERFORM pg_temp.pc_assert((r->>'reason') = 'duplicate_event', '3: duplicate_event reason');
  SELECT count(*) INTO n FROM public.purchase_capture_session_ingests WHERE line_event_id = 'evt-item1';
  PERFORM pg_temp.pc_assert(n = 1, '3: one ingest for item1');

  -- Open another session for conflict test
  other := public.open_purchase_capture_session(
    'group', 'G-other', 'U-other', 'evt-h-other', 3000, 'header other'
  );
  other_sid := (other->>'session_id')::uuid;
  other_gen := (other->>'session_generation')::uuid;

  -- 4. Same event against another session → line_event_conflict
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'evt-item1', 3100, 'item', 'x', NULL, NULL)$q$,
      other_sid, other_gen
    ),
    'line_event_conflict',
    '4: cross-session event conflict'
  );

  -- costs block
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'evt-costs', 3150, 'costs', 'สรุปค่าใช้จ่ายซื้อ', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, false), '5: costs admitted');

  -- Close
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'evt-close-bar', 4000, 'close', 'ปิดซื้อ 1 รายการ', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, false), '5: close admitted');
  PERFORM pg_temp.pc_assert((r->>'status') = 'closing', '5: status closing');

  -- Redelivered close → close_already_requested, boundary unchanged
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'evt-close-bar-2', 4050, 'close', 'ปิดซื้อ 1 รายการ', NULL, NULL
  );
  PERFORM pg_temp.pc_assert((r->>'reason') = 'close_already_requested', '5b: duplicate close does not move boundary');
  PERFORM pg_temp.pc_assert((r->>'close_event_timestamp_ms') = '4000', '5b: boundary unchanged');

  -- 6. Late pre-boundary item → admitted
  r := public.admit_purchase_capture_event(
    v_sid, v_gen, 'evt-item-late', 3900, 'item', 'late item', NULL, NULL
  );
  PERFORM pg_temp.pc_assert(COALESCE((r->>'inserted')::boolean, false), '6: late item admitted');

  -- 7. Post-boundary event → after_close_boundary
  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'evt-post', 4001, 'item', 'post', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'after_close_boundary',
    '7: post-boundary rejected'
  );

  cand := public.get_purchase_capture_finalize_candidate(v_sid, v_gen);
  PERFORM pg_temp.pc_assert((cand->>'status') = 'closing', '8: candidate status closing');
  PERFORM pg_temp.pc_assert(NOT COALESCE((cand->>'quiet_elapsed')::boolean, true), '8: quiet not yet elapsed');
  PERFORM pg_temp.pc_assert(NOT COALESCE((cand->>'eligible_for_finalize')::boolean, true), '8: not yet eligible');
  SELECT count(*) INTO n
  FROM jsonb_array_elements(cand->'ingests') e
  WHERE e->>'line_event_id' = 'evt-post';
  PERFORM pg_temp.pc_assert(n = 0, '8: post-boundary event excluded from candidate');

  PERFORM pg_sleep(8.1);
  cand := public.get_purchase_capture_finalize_candidate(v_sid, v_gen);
  PERFORM pg_temp.pc_assert(COALESCE((cand->>'quiet_elapsed')::boolean, false), '9: quiet elapsed after 8.1s');
  PERFORM pg_temp.pc_assert(COALESCE((cand->>'eligible_for_finalize')::boolean, false), '9: eligible after quiet');
  PERFORM pg_temp.pc_assert(
    (cand->>'ingest_set_hash') = public.purchase_capture_compute_ingest_set_hash(v_sid),
    '9: candidate hash matches compute hash'
  );
END;
$$;

-- ── 10. One-message open+close path: exactly one ingest row, idempotent close ─
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

  first_close := public.close_purchase_capture_open_event(v_sid, v_gen, 'evt-onemsg');
  PERFORM pg_temp.pc_assert(NOT COALESCE((first_close->>'idempotent')::boolean, true), '10: first close not idempotent');
  PERFORM pg_temp.pc_assert((first_close->>'status') = 'closing', '10: status closing after inline close');

  second_close := public.close_purchase_capture_open_event(v_sid, v_gen, 'evt-onemsg');
  PERFORM pg_temp.pc_assert(COALESCE((second_close->>'idempotent')::boolean, false), '10: redelivered close idempotent');

  SELECT count(*) INTO n_ingest
  FROM public.purchase_capture_session_ingests
  WHERE session_id = v_sid;
  PERFORM pg_temp.pc_assert(n_ingest = 1, format('10: exactly one ingest row, got %s', n_ingest));

  PERFORM pg_temp.pc_assert(
    (SELECT close_event_timestamp_ms FROM public.purchase_capture_sessions WHERE id = v_sid) = 5000,
    '10: boundary derived from the persisted opening event timestamp'
  );
END;
$$;

-- ── 11. Append-only protection: ingests / lifecycle events immutable ─────────
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
    '11: ingest UPDATE'
  );
  PERFORM pg_temp.pc_expect_error(
    format('DELETE FROM public.purchase_capture_session_ingests WHERE id = %L', v_ingest),
    'immutable',
    '11: ingest DELETE'
  );
  PERFORM pg_temp.pc_expect_error(
    format('UPDATE public.purchase_capture_lifecycle_events SET actor = ''x'' WHERE id = %L', v_life),
    'immutable',
    '11: lifecycle UPDATE'
  );
  PERFORM pg_temp.pc_expect_error(
    format('DELETE FROM public.purchase_capture_lifecycle_events WHERE id = %L', v_life),
    'immutable',
    '11: lifecycle DELETE'
  );
END;
$$;

-- ── 12. Terminal session immutability (cancelled) + cancel invalid_state ─────
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

  r := public.cancel_purchase_capture_session(v_sid, v_gen);
  PERFORM pg_temp.pc_assert(NOT COALESCE((r->>'idempotent')::boolean, true), '12: first cancel not idempotent');
  PERFORM pg_temp.pc_assert((r->>'status') = 'cancelled', '12: status cancelled');

  r := public.cancel_purchase_capture_session(v_sid, v_gen);
  PERFORM pg_temp.pc_assert(COALESCE((r->>'idempotent')::boolean, false), '12: second cancel idempotent');

  PERFORM pg_temp.pc_expect_error(
    format('UPDATE public.purchase_capture_sessions SET fail_reason = ''x'' WHERE id = %L', v_sid),
    'terminal and immutable',
    '12: cancelled session UPDATE rejected'
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
    format('SELECT public.cancel_purchase_capture_session(%L::uuid, %L::uuid)', v_sid, v_gen),
    'invalid_state',
    '12: cancel from confirming refuses invalid_state'
  );
END;
$$;

-- ── 13. Stale generation refused ──────────────────────────────────────────────
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
  PERFORM pg_temp.pc_assert(v_wrong_gen <> v_gen, '13: fixture sanity');

  PERFORM pg_temp.pc_expect_error(
    format(
      $q$SELECT public.admit_purchase_capture_event(%L::uuid, %L::uuid, 'evt-stale-item', 8100, 'item', 'x', NULL, NULL)$q$,
      v_sid, v_wrong_gen
    ),
    'generation_conflict',
    '13: admit with stale generation refused'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.get_purchase_capture_finalize_candidate(%L::uuid, %L::uuid)', v_sid, v_wrong_gen),
    'generation_conflict',
    '13: candidate with stale generation refused'
  );
  PERFORM pg_temp.pc_expect_error(
    format('SELECT public.cancel_purchase_capture_session(%L::uuid, %L::uuid)', v_sid, v_wrong_gen),
    'generation_conflict',
    '13: cancel with stale generation refused'
  );
END;
$$;

-- ── 14. Sender/source isolation ───────────────────────────────────────────────
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
  PERFORM pg_temp.pc_assert(COALESCE((ra->>'opened')::boolean, false), '14: session A opened');
  PERFORM pg_temp.pc_assert(COALESCE((rb->>'opened')::boolean, false), '14: session B opened independently');
  PERFORM pg_temp.pc_assert((ra->>'session_id') <> (rb->>'session_id'), '14: distinct sessions per source');
END;
$$;

-- ── 15. RLS enabled, no policies, on every new table ──────────────────────────
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
    PERFORM pg_temp.pc_assert(v_rls, format('15: %s RLS must be enabled', t));
    SELECT count(*) INTO v_policy_count FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    PERFORM pg_temp.pc_assert(v_policy_count = 0, format('15: %s must have no policies', t));
  END LOOP;
END;
$$;

-- ── 16. Privileges: anon/authenticated denied; service_role execute+select, no insert ─
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
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 16 anon SELECT should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.open_purchase_capture_session('group', 'G-priv', 'U-priv', 'evt-priv-a', 1, 'h');
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 16 anon EXECUTE should be denied';
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
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 16 authenticated SELECT should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.get_purchase_capture_finalize_candidate(v_sid, v_gen);
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 16 authenticated EXECUTE should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END;

  -- service_role: SELECT + EXECUTE ok; direct INSERT denied
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM 1 FROM public.purchase_capture_sessions WHERE id = v_sid;
    PERFORM public.get_purchase_capture_finalize_candidate(v_sid, v_gen);
    BEGIN
      INSERT INTO public.purchase_capture_sessions (
        source_type, source_id, sender_line_user_id, opened_line_event_id
      ) VALUES (
        'group', 'G-direct-insert', 'U-direct-insert', 'evt-direct-insert'
      );
      RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 16 service_role INSERT should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END;
END;
$$;

-- ── 17. No idle-expiration: a never-closed session simply stays open ─────────
DO $$
DECLARE
  r jsonb;
  status text;
BEGIN
  r := public.open_purchase_capture_session(
    'group', 'G-idle', 'U-idle', 'evt-idle', 10000, 'header'
  );
  SELECT s.status INTO status FROM public.purchase_capture_sessions s WHERE id = (r->>'session_id')::uuid;
  PERFORM pg_temp.pc_assert(status = 'open', '17: session with no close event remains open');
END;
$$;

-- ── 18. expect_error helper must FAIL when statement unexpectedly succeeds ───
DO $$
BEGIN
  BEGIN
    PERFORM pg_temp.pc_expect_error('SELECT 1', 'line_event_conflict', '18: should fail');
    RAISE EXCEPTION 'purchase_capture_slice_a_hardening FAIL: 18 expect_error falsely passed on success';
  EXCEPTION
    WHEN OTHERS THEN
      IF position('expected error containing' IN SQLERRM) = 0
         OR position('statement succeeded' IN SQLERRM) = 0 THEN
        RAISE EXCEPTION
          'purchase_capture_slice_a_hardening FAIL: 18 unexpected error from expect_error: %', SQLERRM;
      END IF;
  END;
END;
$$;

DO $$
BEGIN
  RAISE NOTICE 'purchase_capture_slice_a_hardening PASS';
END;
$$;
