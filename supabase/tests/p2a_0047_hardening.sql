-- P2A 0047 hardening assertions against a disposable local DB.
-- FAIL closed: any failed check RAISE EXCEPTION. Expect NOTICE PASS at end.
-- Quiet waits use PERFORM pg_sleep(8.1) only when finalize/fail_closed needs barrier.

CREATE OR REPLACE FUNCTION pg_temp.p2a_assert(cond boolean, msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT cond THEN
    RAISE EXCEPTION 'p2a_0047_hardening FAIL: %', msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.p2a_expect_error(p_sql text, p_needle text, p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_err text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'p2a_0047_hardening FAIL: % (expected error containing %)', p_msg, p_needle;
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF position(lower(p_needle) IN lower(v_err)) = 0 THEN
        RAISE EXCEPTION
          'p2a_0047_hardening FAIL: % — got "%" (wanted substring "%")',
          p_msg, v_err, p_needle;
      END IF;
  END;
END;
$$;

-- ── 1. Concurrent-ish opens: same source+sender, different events → one active ─
DO $$
DECLARE
  r1 jsonb;
  r2 jsonb;
  n_active int;
BEGIN
  r1 := public.open_physical_inventory_session(
    'group', 'G-c1', 'U-c1', 'evt-open-c1-a', 1000, 'header A', NULL, NULL, NULL, 'test'
  );
  PERFORM pg_temp.p2a_assert(COALESCE((r1->>'opened')::boolean, false), '1: first open should open');

  r2 := public.open_physical_inventory_session(
    'group', 'G-c1', 'U-c1', 'evt-open-c1-b', 1001, 'header B', NULL, NULL, NULL, 'test'
  );
  PERFORM pg_temp.p2a_assert(
    NOT COALESCE((r2->>'opened')::boolean, true)
    OR (r2->>'reason') IN ('already_open_or_duplicate', 'duplicate_open_event'),
    format('1: second open must not create another active session; got %s', r2::text)
  );

  SELECT count(*) INTO n_active
  FROM public.physical_inventory_sessions
  WHERE source_id = 'G-c1' AND sender_line_user_id = 'U-c1' AND status IN ('open', 'closing');
  PERFORM pg_temp.p2a_assert(n_active = 1, format('1: expected 1 active session, got %s', n_active));
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
  r1 := public.open_physical_inventory_session(
    'group', 'G-idem', 'U-idem', 'evt-open-idem', 2000, 'header idem', NULL, NULL, NULL, 'test'
  );
  PERFORM pg_temp.p2a_assert(COALESCE((r1->>'opened')::boolean, false), '2: first open');

  r2 := public.open_physical_inventory_session(
    'group', 'G-idem', 'U-idem', 'evt-open-idem', 2000, 'header idem', NULL, NULL, NULL, 'test'
  );
  PERFORM pg_temp.p2a_assert(COALESCE((r2->>'idempotent')::boolean, false), '2: second open idempotent');
  PERFORM pg_temp.p2a_assert(
    (r2->>'session_id') = (r1->>'session_id'),
    '2: same session_id on redelivery'
  );

  SELECT count(*) INTO n_sess FROM public.physical_inventory_sessions WHERE opened_line_event_id = 'evt-open-idem';
  SELECT count(*) INTO n_ingest FROM public.physical_inventory_session_ingests WHERE line_event_id = 'evt-open-idem';
  PERFORM pg_temp.p2a_assert(n_sess = 1, '2: one session');
  PERFORM pg_temp.p2a_assert(n_ingest = 1, '2: one header ingest');
END;
$$;

-- ── 3–8 + 9: admit / close barrier / finalize / immutability ─────────────────
DO $$
DECLARE
  r jsonb;
  v_sid uuid;
  v_gen uuid;
  v_rev bigint;
  v_hash text;
  v_snap uuid;
  v_item uuid;
  v_ingest uuid;
  v_life uuid;
  n int;
  cand jsonb;
  fin1 jsonb;
  fin2 jsonb;
  other jsonb;
  other_sid uuid;
  other_gen uuid;
BEGIN
  -- Open primary session
  r := public.open_physical_inventory_session(
    'group', 'G-bar', 'U-bar', 'evt-h-bar', 3000,
    'สตอกผลไม้คงเหลือ', NULL, NULL, CURRENT_DATE, 'test'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;

  -- Item 7
  r := public.admit_physical_inventory_event(
    v_sid, v_gen, 'evt-item7', 3100, 'item', '7แตงโม', NULL, NULL
  );
  PERFORM pg_temp.p2a_assert(COALESCE((r->>'inserted')::boolean, false), '5: item7 admitted');

  -- 3. Duplicate item event → one ingest
  r := public.admit_physical_inventory_event(
    v_sid, v_gen, 'evt-item7', 3100, 'item', '7แตงโม', NULL, NULL
  );
  PERFORM pg_temp.p2a_assert(COALESCE((r->>'inserted')::boolean, true) = false, '3: dup not inserted');
  PERFORM pg_temp.p2a_assert((r->>'reason') = 'duplicate_event', '3: duplicate_event reason');
  SELECT count(*) INTO n FROM public.physical_inventory_session_ingests WHERE line_event_id = 'evt-item7';
  PERFORM pg_temp.p2a_assert(n = 1, '3: one ingest for item7');

  -- Open another session for conflict test
  other := public.open_physical_inventory_session(
    'group', 'G-other', 'U-other', 'evt-h-other', 3000, 'header other', NULL, NULL, NULL, 'test'
  );
  other_sid := (other->>'session_id')::uuid;
  other_gen := (other->>'session_generation')::uuid;

  -- 4. Same event against another session → line_event_conflict
  PERFORM pg_temp.p2a_expect_error(
    format(
      $q$SELECT public.admit_physical_inventory_event(%L::uuid, %L::uuid, 'evt-item7', 3100, 'item', '7แตงโม', NULL, NULL)$q$,
      other_sid, other_gen
    ),
    'line_event_conflict',
    '4: cross-session event conflict'
  );

  -- Close
  r := public.admit_physical_inventory_event(
    v_sid, v_gen, 'evt-close-bar', 4000, 'close', 'จบ', NULL, NULL
  );
  PERFORM pg_temp.p2a_assert(COALESCE((r->>'inserted')::boolean, false), '5: close admitted');
  PERFORM pg_temp.p2a_assert((r->>'status') = 'closing', '5: status closing');

  -- 5. Late pre-boundary item8 → admitted
  r := public.admit_physical_inventory_event(
    v_sid, v_gen, 'evt-item8', 3900, 'item', '8มะละกอ', NULL, NULL
  );
  PERFORM pg_temp.p2a_assert(COALESCE((r->>'inserted')::boolean, false), '5: late item8 admitted');

  -- 6. Post-boundary event → after_close_boundary
  PERFORM pg_temp.p2a_expect_error(
    format(
      $q$SELECT public.admit_physical_inventory_event(%L::uuid, %L::uuid, 'evt-post', 4001, 'item', 'post', NULL, NULL)$q$,
      v_sid, v_gen
    ),
    'after_close_boundary',
    '6: post-boundary rejected'
  );

  cand := public.get_physical_inventory_finalize_candidate(v_sid, v_gen);
  v_rev := (cand->>'ingest_revision')::bigint;
  v_hash := cand->>'ingest_set_hash';

  -- 7. Stale revision/hash → no snapshot (before quiet is fine; revision/hash checked first)
  PERFORM pg_temp.p2a_expect_error(
    format(
      $q$SELECT public.finalize_physical_inventory_session(
        %L::uuid, %L::uuid, %s::bigint, %L::text,
        CURRENT_DATE, 'test', '[]'::jsonb,
        '[{"raw_text":"7แตงโม","raw_product_description":"แตงโม","quantity":"45","raw_unit":"ลูก","resolution_status":"ACCEPTED_RAW"}]'::jsonb,
        false, NULL)$q$,
      v_sid, v_gen, v_rev - 1, v_hash
    ),
    'stale_ingest_revision',
    '7: stale revision'
  );
  PERFORM pg_temp.p2a_expect_error(
    format(
      $q$SELECT public.finalize_physical_inventory_session(
        %L::uuid, %L::uuid, %s::bigint, 'deadbeef',
        CURRENT_DATE, 'test', '[]'::jsonb,
        '[{"raw_text":"7แตงโม","raw_product_description":"แตงโม","quantity":"45","raw_unit":"ลูก","resolution_status":"ACCEPTED_RAW"}]'::jsonb,
        false, NULL)$q$,
      v_sid, v_gen, v_rev
    ),
    'stale_ingest_hash',
    '7: stale hash'
  );
  SELECT count(*) INTO n FROM public.physical_inventory_snapshots WHERE session_id = v_sid;
  PERFORM pg_temp.p2a_assert(n = 0, '7: no snapshot after stale attempts');

  -- 8. After quiet: finalize succeeds; second finalize idempotent → one snapshot
  PERFORM pg_sleep(8.1);
  cand := public.get_physical_inventory_finalize_candidate(v_sid, v_gen);
  v_rev := (cand->>'ingest_revision')::bigint;
  v_hash := cand->>'ingest_set_hash';

  fin1 := public.finalize_physical_inventory_session(
    v_sid, v_gen, v_rev, v_hash,
    CURRENT_DATE, 'test', '[]'::jsonb,
    jsonb_build_array(
      jsonb_build_object(
        'raw_text', '7แตงโม',
        'raw_product_description', 'แตงโม',
        'quantity', '45',
        'raw_unit', 'ลูก',
        'resolution_status', 'ACCEPTED_RAW'
      ),
      jsonb_build_object(
        'raw_text', '8มะละกอ',
        'raw_product_description', 'มะละกอ',
        'quantity', '15',
        'raw_unit', 'ลูก',
        'resolution_status', 'ACCEPTED_RAW'
      )
    ),
    false, NULL
  );
  PERFORM pg_temp.p2a_assert(COALESCE((fin1->>'ok')::boolean, false), '8: finalize ok');
  PERFORM pg_temp.p2a_assert((fin1->>'status') = 'finalized', '8: status finalized');
  PERFORM pg_temp.p2a_assert(NOT COALESCE((fin1->>'idempotent')::boolean, true), '8: first not idempotent');
  v_snap := (fin1->>'snapshot_id')::uuid;

  fin2 := public.finalize_physical_inventory_session(
    v_sid, v_gen, v_rev, v_hash,
    CURRENT_DATE, 'test', '[]'::jsonb,
    jsonb_build_array(
      jsonb_build_object(
        'raw_text', '7แตงโม',
        'raw_product_description', 'แตงโม',
        'quantity', '45',
        'raw_unit', 'ลูก',
        'resolution_status', 'ACCEPTED_RAW'
      )
    ),
    false, NULL
  );
  PERFORM pg_temp.p2a_assert(COALESCE((fin2->>'idempotent')::boolean, false), '8: second finalize idempotent');
  PERFORM pg_temp.p2a_assert((fin2->>'snapshot_id') = v_snap::text, '8: same snapshot');
  SELECT count(*) INTO n FROM public.physical_inventory_snapshots WHERE session_id = v_sid;
  PERFORM pg_temp.p2a_assert(n = 1, '8: exactly one snapshot');

  -- 9. UPDATE/DELETE on finalized evidence rejected
  SELECT id INTO v_item FROM public.physical_inventory_items WHERE snapshot_id = v_snap LIMIT 1;
  SELECT id INTO v_ingest FROM public.physical_inventory_session_ingests WHERE session_id = v_sid LIMIT 1;
  SELECT id INTO v_life FROM public.physical_inventory_lifecycle_events WHERE session_id = v_sid LIMIT 1;

  PERFORM pg_temp.p2a_expect_error(
    format('UPDATE public.physical_inventory_snapshots SET warnings = ''[]''::jsonb WHERE id = %L', v_snap),
    'immutable',
    '9: snapshot UPDATE'
  );
  PERFORM pg_temp.p2a_expect_error(
    format('DELETE FROM public.physical_inventory_snapshots WHERE id = %L', v_snap),
    'immutable',
    '9: snapshot DELETE'
  );
  PERFORM pg_temp.p2a_expect_error(
    format('UPDATE public.physical_inventory_items SET reason = ''x'' WHERE id = %L', v_item),
    'immutable',
    '9: item UPDATE'
  );
  PERFORM pg_temp.p2a_expect_error(
    format('DELETE FROM public.physical_inventory_items WHERE id = %L', v_item),
    'immutable',
    '9: item DELETE'
  );
  PERFORM pg_temp.p2a_expect_error(
    format('UPDATE public.physical_inventory_session_ingests SET raw_text = ''x'' WHERE id = %L', v_ingest),
    'immutable',
    '9: ingest UPDATE'
  );
  PERFORM pg_temp.p2a_expect_error(
    format('DELETE FROM public.physical_inventory_session_ingests WHERE id = %L', v_ingest),
    'immutable',
    '9: ingest DELETE'
  );
  PERFORM pg_temp.p2a_expect_error(
    format('UPDATE public.physical_inventory_lifecycle_events SET actor = ''x'' WHERE id = %L', v_life),
    'immutable',
    '9: lifecycle UPDATE'
  );
  PERFORM pg_temp.p2a_expect_error(
    format('DELETE FROM public.physical_inventory_lifecycle_events WHERE id = %L', v_life),
    'immutable',
    '9: lifecycle DELETE'
  );

  -- Stash ids for later checks via temp table
  CREATE TEMP TABLE IF NOT EXISTS p2a_0047_ids (
    k text PRIMARY KEY,
    v text NOT NULL
  );
  DELETE FROM p2a_0047_ids;
  INSERT INTO p2a_0047_ids(k, v) VALUES
    ('snap', v_snap::text),
    ('sess', v_sid::text),
    ('other_sess', other_sid::text);
END;
$$;

-- ── 10. Privileges: anon/authenticated denied; service_role execute+select, no insert ─
DO $$
DECLARE
  v_ok boolean;
  v_snap uuid;
  v_sess uuid;
  v_other uuid;
BEGIN
  SELECT v::uuid INTO v_snap FROM p2a_0047_ids WHERE k = 'snap';
  SELECT v::uuid INTO v_sess FROM p2a_0047_ids WHERE k = 'sess';
  SELECT v::uuid INTO v_other FROM p2a_0047_ids WHERE k = 'other_sess';

  -- anon: no SELECT
  BEGIN
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM 1 FROM public.physical_inventory_sessions LIMIT 1;
      RAISE EXCEPTION 'p2a_0047_hardening FAIL: 10 anon SELECT should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
      PERFORM public.open_physical_inventory_session(
        'group', 'G-priv', 'U-priv', 'evt-priv-a', 1, 'h', NULL, NULL, NULL, 'test'
      );
      RAISE EXCEPTION 'p2a_0047_hardening FAIL: 10 anon EXECUTE should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    RESET ROLE;
  END;

  -- authenticated: no SELECT / EXECUTE
  BEGIN
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM 1 FROM public.physical_inventory_snapshots LIMIT 1;
      RAISE EXCEPTION 'p2a_0047_hardening FAIL: 10 authenticated SELECT should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
      PERFORM public.get_physical_inventory_finalize_candidate(v_sess, '00000000-0000-4000-8000-000000000001'::uuid);
      RAISE EXCEPTION 'p2a_0047_hardening FAIL: 10 authenticated EXECUTE should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    RESET ROLE;
  END;

  -- service_role: SELECT + EXECUTE ok; direct INSERT into snapshots denied
  -- Use open other_sess (no snapshot yet) so a mistaken INSERT grant would not
  -- collapse into unique_violation on session_id.
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM 1 FROM public.physical_inventory_sessions WHERE id = v_sess;
    PERFORM 1 FROM public.physical_inventory_snapshots WHERE id = v_snap;
    PERFORM public.get_physical_inventory_finalize_candidate(
      v_sess,
      (SELECT session_generation FROM public.physical_inventory_sessions WHERE id = v_sess)
    );
    BEGIN
      INSERT INTO public.physical_inventory_snapshots (
        session_id, warehouse_code, source_type, source_id, sender_line_user_id,
        business_date, counted_at, parser_version,
        accepted_normalized_count, accepted_raw_count, rejected_count, item_count,
        status, ingest_idempotency_key, finalized_ingest_revision, finalized_ingest_hash
      ) VALUES (
        v_other, 'MAIN', 'group', 'G-other', 'U-other',
        CURRENT_DATE, now(), 'test',
        0, 1, 0, 1,
        'finalized', 'should-fail-insert', 1, 'abc'
      );
      RAISE EXCEPTION 'p2a_0047_hardening FAIL: 10 service_role INSERT snapshots should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    RESET ROLE;
  END;

  v_ok := true;
  PERFORM pg_temp.p2a_assert(v_ok, '10: privilege checks');
END;
$$;

-- ── 11. Malformed ACCEPTED_* direct insert (as postgres) → CHECK rejects ─────
DO $$
DECLARE
  v_snap uuid;
BEGIN
  SELECT v::uuid INTO v_snap FROM p2a_0047_ids WHERE k = 'snap';
  PERFORM pg_temp.p2a_expect_error(
    format(
      $q$INSERT INTO public.physical_inventory_items (
        snapshot_id, item_ordinal, raw_text, resolution_status
      ) VALUES (%L::uuid, 99, 'bad', 'ACCEPTED_NORMALIZED')$q$,
      v_snap
    ),
    'physical_inventory_items_accepted_fields',
    '11: malformed ACCEPTED_NORMALIZED rejected'
  );
  PERFORM pg_temp.p2a_expect_error(
    format(
      $q$INSERT INTO public.physical_inventory_items (
        snapshot_id, item_ordinal, raw_text, resolution_status
      ) VALUES (%L::uuid, 98, 'bad', 'ACCEPTED_RAW')$q$,
      v_snap
    ),
    'physical_inventory_items_accepted_fields',
    '11: malformed ACCEPTED_RAW rejected'
  );
END;
$$;

-- ── 12. fail_closed from OPEN without close → close_boundary_required ────────
DO $$
DECLARE
  r jsonb;
  v_sid uuid;
  v_gen uuid;
  v_hash text;
BEGIN
  r := public.open_physical_inventory_session(
    'group', 'G-fc-open', 'U-fc-open', 'evt-fc-open', 5000, 'header', NULL, NULL, NULL, 'test'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;
  v_hash := public.physical_inventory_compute_ingest_set_hash(v_sid);

  PERFORM pg_temp.p2a_expect_error(
    format(
      $q$SELECT public.finalize_physical_inventory_session(
        %L::uuid, %L::uuid, 1::bigint, %L::text,
        CURRENT_DATE, 'test', '[]'::jsonb, '[]'::jsonb, true, 'no_close')$q$,
      v_sid, v_gen, v_hash
    ),
    'close_boundary_required',
    '12: fail_closed without close'
  );
END;
$$;

-- ── 13. item1, close, late item2, fail_closed after quiet; item2 before terminal ─
DO $$
DECLARE
  r jsonb;
  cand jsonb;
  fin jsonb;
  v_sid uuid;
  v_gen uuid;
  v_rev bigint;
  v_hash text;
  n_item2 int;
  n_snap int;
BEGIN
  r := public.open_physical_inventory_session(
    'group', 'G-fc-late', 'U-fc-late', 'evt-fc-h', 6000, 'header', NULL, NULL, NULL, 'test'
  );
  v_sid := (r->>'session_id')::uuid;
  v_gen := (r->>'session_generation')::uuid;

  PERFORM public.admit_physical_inventory_event(
    v_sid, v_gen, 'evt-fc-i1', 6100, 'item', '1item', NULL, NULL
  );
  PERFORM public.admit_physical_inventory_event(
    v_sid, v_gen, 'evt-fc-close', 7000, 'close', 'จบ', NULL, NULL
  );
  r := public.admit_physical_inventory_event(
    v_sid, v_gen, 'evt-fc-i2', 6900, 'item', '2late', NULL, NULL
  );
  PERFORM pg_temp.p2a_assert(COALESCE((r->>'inserted')::boolean, false), '13: late item2 admitted');

  SELECT count(*) INTO n_item2
  FROM public.physical_inventory_session_ingests
  WHERE session_id = v_sid AND line_event_id = 'evt-fc-i2';
  PERFORM pg_temp.p2a_assert(n_item2 = 1, '13: item2 ingest exists before terminal');

  PERFORM pg_sleep(8.1);

  cand := public.get_physical_inventory_finalize_candidate(v_sid, v_gen);
  v_rev := (cand->>'ingest_revision')::bigint;
  v_hash := cand->>'ingest_set_hash';

  fin := public.finalize_physical_inventory_session(
    v_sid, v_gen, v_rev, v_hash,
    CURRENT_DATE, 'test', '[]'::jsonb, '[]'::jsonb,
    true, 'no_items'
  );
  PERFORM pg_temp.p2a_assert(COALESCE((fin->>'ok')::boolean, false), '13: fail_closed ok');
  PERFORM pg_temp.p2a_assert((fin->>'status') = 'failed_closed', '13: status failed_closed');

  SELECT count(*) INTO n_item2
  FROM public.physical_inventory_session_ingests
  WHERE session_id = v_sid AND line_event_id = 'evt-fc-i2';
  PERFORM pg_temp.p2a_assert(n_item2 = 1, '13: item2 ingest still present after terminal');

  SELECT count(*) INTO n_snap FROM public.physical_inventory_snapshots WHERE session_id = v_sid;
  PERFORM pg_temp.p2a_assert(n_snap = 0, '13: no snapshot on fail_closed');
END;
$$;

-- ── 14. Lifecycle referencing wrong snapshot session → rejected ──────────────
DO $$
DECLARE
  v_snap uuid;
  v_other uuid;
BEGIN
  SELECT v::uuid INTO v_snap FROM p2a_0047_ids WHERE k = 'snap';
  SELECT v::uuid INTO v_other FROM p2a_0047_ids WHERE k = 'other_sess';

  PERFORM pg_temp.p2a_expect_error(
    format(
      $q$INSERT INTO public.physical_inventory_lifecycle_events (
        session_id, snapshot_id, event, actor
      ) VALUES (%L::uuid, %L::uuid, 'finalized', 'test')$q$,
      v_other, v_snap
    ),
    'lifecycle snapshot_id must belong to lifecycle session_id',
    '14: lifecycle session/snapshot mismatch'
  );
END;
$$;

DO $$
BEGIN
  RAISE NOTICE 'p2a_0047_hardening PASS';
END;
$$;
