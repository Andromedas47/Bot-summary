-- Executable behavioural verification of migration 0051 against a disposable
-- local PostgreSQL container. FAIL closed. Never run against Production.
-- Apply guided_menu_0051_bootstrap.sql, then 0051, then this file.

CREATE OR REPLACE FUNCTION pg_temp.gm51_assert(cond boolean, msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'guided_menu_0051_verification FAIL: %', msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.gm51_insert_menu_state(
  p_hash text,
  p_user text DEFAULT 'U-active',
  p_source_type text DEFAULT 'user',
  p_source_id text DEFAULT 'U-active',
  p_session_key text DEFAULT 'dm:gm51-test',
  p_action text DEFAULT 'menu_root',
  p_expires interval DEFAULT interval '1 hour'
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.line_menu_states (
    token_hash, action_type, line_user_id, source_type, source_id,
    session_key, payload, expires_at
  ) VALUES (
    p_hash, p_action, p_user, p_source_type, p_source_id,
    p_session_key, '{}'::jsonb, now() + p_expires
  );
END;
$$;

-- Empty stubs so Produce / admission side-effects are detectable.
CREATE TABLE IF NOT EXISTS public.produce_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE IF NOT EXISTS public.produce_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE IF NOT EXISTS public.pending_session_admission (
  session_key text NOT NULL,
  session_generation uuid NOT NULL,
  line_event_id text NOT NULL,
  PRIMARY KEY (session_generation, line_event_id)
);

DO $$
DECLARE
  v_result   jsonb;
  v_label    text;
  v_count    int;
  v_pending  int;
  v_produce  int;
  v_items    int;
  v_admit    int;
  v_hash     text := 'gm51-consume-ok';
  v_user     text := 'U-active';
  v_event    text := 'evt-consume-1';
BEGIN
  -- Seed 35 pending_sessions rows; all tests must leave this count unchanged.
  INSERT INTO public.pending_sessions (session_key)
  SELECT format('dm:stub-%s', g)
    FROM generate_series(1, 35) AS g
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO v_pending FROM public.pending_sessions;
  PERFORM pg_temp.gm51_assert(v_pending = 35, 'setup: expected 35 pending_sessions stubs');

  SELECT count(*) INTO v_produce FROM public.produce_sessions;
  SELECT count(*) INTO v_items FROM public.produce_items;
  SELECT count(*) INTO v_admit FROM public.pending_session_admission;
  PERFORM pg_temp.gm51_assert(v_produce = 0, 'setup: produce_sessions must start empty');
  PERFORM pg_temp.gm51_assert(v_items = 0, 'setup: produce_items must start empty');
  PERFORM pg_temp.gm51_assert(v_admit = 0, 'setup: pending_session_admission must start empty');

  -- ── 1. Operator identity lookup (SQL path; no Production seed rows) ─────────
  INSERT INTO public.line_operator_identities (line_user_id, staff_label, active)
  VALUES ('U-active', 'Test Staff', true);

  INSERT INTO public.line_operator_identities (line_user_id, staff_label, active)
  VALUES ('U-inactive', 'Inactive Staff', false);

  SELECT staff_label INTO v_label
    FROM public.line_operator_identities
   WHERE line_user_id = 'U-active'
     AND active IS TRUE;
  PERFORM pg_temp.gm51_assert(v_label = 'Test Staff', '1: active operator lookup');

  SELECT count(*) INTO v_count
    FROM public.line_operator_identities
   WHERE line_user_id = 'U-inactive'
     AND active IS TRUE;
  PERFORM pg_temp.gm51_assert(v_count = 0, '1: inactive operator rejected by active lookup');

  SELECT count(*) INTO v_count
    FROM public.line_operator_identities
   WHERE line_user_id = 'U-missing'
     AND active IS TRUE;
  PERFORM pg_temp.gm51_assert(v_count = 0, '1: missing operator rejected');

  -- ── 2. Menu state stores hash only (no raw token column) ──────────────────
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'line_menu_states'
     AND column_name ILIKE '%token%';
  PERFORM pg_temp.gm51_assert(v_count = 1, '2: exactly one token column (token_hash)');

  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'line_menu_states'
     AND column_name IN ('raw_token', 'token', 'menu_token');
  PERFORM pg_temp.gm51_assert(v_count = 0, '2: no raw token column');

  PERFORM pg_temp.gm51_insert_menu_state(v_hash);

  -- ── 3. Consume success ─────────────────────────────────────────────────────
  v_result := public.consume_line_menu_state(
    v_hash, v_event, v_user, 'user', v_user, 'dm:gm51-test'
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'consumed', '3: consume success');
  PERFORM pg_temp.gm51_assert(v_result->>'action_type' = 'menu_root', '3: action_type returned');

  -- ── 4. Same-event replay ───────────────────────────────────────────────────
  v_result := public.consume_line_menu_state(
    v_hash, v_event, v_user, 'user', v_user, 'dm:gm51-test'
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'replay', '4: same-event replay');

  -- ── 5. Different-event already_consumed ───────────────────────────────────
  v_result := public.consume_line_menu_state(
    v_hash, 'evt-consume-2', v_user, 'user', v_user, 'dm:gm51-test'
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'already_consumed', '5: different-event already_consumed');

  -- ── 6. Expired token → invalid_or_expired ──────────────────────────────────
  INSERT INTO public.line_menu_states (
    token_hash, action_type, line_user_id, source_type, source_id,
    session_key, payload, created_at, expires_at
  ) VALUES (
    'gm51-expired', 'menu_root', v_user, 'user', v_user,
    'dm:gm51-test', '{}'::jsonb,
    now() - interval '2 hours', now() - interval '1 hour'
  );
  v_result := public.consume_line_menu_state(
    'gm51-expired', 'evt-exp', v_user, 'user', v_user, 'dm:gm51-test'
  );
  PERFORM pg_temp.gm51_assert(
    v_result->>'status' = 'invalid_or_expired', '6: expired token'
  );

  -- ── 7. Wrong user / source / session → invalid_or_expired ─────────────────
  PERFORM pg_temp.gm51_insert_menu_state('gm51-bind-user');
  v_result := public.consume_line_menu_state(
    'gm51-bind-user', 'evt-bind-u', 'U-wrong', 'user', v_user, 'dm:gm51-test'
  );
  PERFORM pg_temp.gm51_assert(
    v_result->>'status' = 'invalid_or_expired', '7a: wrong user'
  );

  PERFORM pg_temp.gm51_insert_menu_state('gm51-bind-source');
  v_result := public.consume_line_menu_state(
    'gm51-bind-source', 'evt-bind-s', v_user, 'group', 'G-wrong', 'dm:gm51-test'
  );
  PERFORM pg_temp.gm51_assert(
    v_result->>'status' = 'invalid_or_expired', '7b: wrong source'
  );

  PERFORM pg_temp.gm51_insert_menu_state('gm51-bind-session');
  v_result := public.consume_line_menu_state(
    'gm51-bind-session', 'evt-bind-k', v_user, 'user', v_user, 'dm:wrong-session'
  );
  PERFORM pg_temp.gm51_assert(
    v_result->>'status' = 'invalid_or_expired', '7c: wrong session'
  );

  -- ── 8. Unknown token → invalid_or_expired ──────────────────────────────────
  v_result := public.consume_line_menu_state(
    'gm51-unknown-token', 'evt-unk', v_user, 'user', v_user, NULL
  );
  PERFORM pg_temp.gm51_assert(
    v_result->>'status' = 'invalid_or_expired', '8: unknown token'
  );

  -- ── 9. Tampered hash → invalid_or_expired ──────────────────────────────────
  v_result := public.consume_line_menu_state(
    'gm51-tampered-hash', 'evt-tamp', v_user, 'user', v_user, NULL
  );
  PERFORM pg_temp.gm51_assert(
    v_result->>'status' = 'invalid_or_expired', '9: tampered hash'
  );

  -- ── 10–12. record_line_menu_state_result ──────────────────────────────────
  v_result := public.record_line_menu_state_result(
    v_hash, v_event, jsonb_build_object('outcome', 'ok')
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'recorded', '10: result first write');

  v_result := public.record_line_menu_state_result(
    v_hash, v_event, jsonb_build_object('outcome', 'ok')
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'replay', '11: identical result replay');

  v_result := public.record_line_menu_state_result(
    v_hash, v_event, jsonb_build_object('outcome', 'different')
  );
  PERFORM pg_temp.gm51_assert(
    v_result->>'status' = 'result_conflict', '12: conflicting result'
  );

  -- ── 13. RLS enabled, zero policies ────────────────────────────────────────
  SELECT count(*) INTO v_count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('line_operator_identities', 'line_menu_states')
     AND c.relrowsecurity;
  PERFORM pg_temp.gm51_assert(v_count = 2, '13: RLS enabled on both tables');

  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('line_operator_identities', 'line_menu_states');
  PERFORM pg_temp.gm51_assert(v_count = 0, '13: zero RLS policies');

  -- ── 14. anon / authenticated cannot SELECT or EXECUTE ─────────────────────
  PERFORM pg_temp.gm51_assert(
    NOT has_table_privilege('anon', 'public.line_menu_states', 'SELECT'),
    '14: anon lacks line_menu_states SELECT'
  );
  PERFORM pg_temp.gm51_assert(
    NOT has_table_privilege('authenticated', 'public.line_menu_states', 'SELECT'),
    '14: authenticated lacks line_menu_states SELECT'
  );
  PERFORM pg_temp.gm51_assert(
    NOT has_table_privilege('anon', 'public.line_operator_identities', 'SELECT'),
    '14: anon lacks line_operator_identities SELECT'
  );
  PERFORM pg_temp.gm51_assert(
    NOT has_table_privilege('authenticated', 'public.line_operator_identities', 'SELECT'),
    '14: authenticated lacks line_operator_identities SELECT'
  );
  PERFORM pg_temp.gm51_assert(
    NOT has_function_privilege(
      'anon',
      'public.consume_line_menu_state(text,text,text,text,text,text)',
      'EXECUTE'
    ),
    '14: anon lacks consume EXECUTE'
  );
  PERFORM pg_temp.gm51_assert(
    NOT has_function_privilege(
      'authenticated',
      'public.record_line_menu_state_result(text,text,jsonb)',
      'EXECUTE'
    ),
    '14: authenticated lacks record EXECUTE'
  );

  BEGIN
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM 1 FROM public.line_menu_states LIMIT 1;
      RAISE EXCEPTION 'guided_menu_0051_verification FAIL: 14: anon must not SELECT line_menu_states';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    BEGIN
      PERFORM public.consume_line_menu_state(
        v_hash, v_event, v_user, 'user', v_user, NULL
      );
      RAISE EXCEPTION 'guided_menu_0051_verification FAIL: 14: anon must not EXECUTE consume';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM 1 FROM public.line_operator_identities LIMIT 1;
      RAISE EXCEPTION 'guided_menu_0051_verification FAIL: 14: authenticated must not SELECT identities';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    BEGIN
      PERFORM public.record_line_menu_state_result(
        v_hash, v_event, '{}'::jsonb
      );
      RAISE EXCEPTION 'guided_menu_0051_verification FAIL: 14: authenticated must not EXECUTE record';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    RESET ROLE;
  END;

  -- ── 15. service_role can SELECT and EXECUTE ───────────────────────────────
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM 1 FROM public.line_menu_states LIMIT 1;
    PERFORM 1 FROM public.line_operator_identities LIMIT 1;
    v_result := public.consume_line_menu_state(
      'gm51-svc-probe', 'evt-svc', v_user, 'user', v_user, NULL
    );
    PERFORM pg_temp.gm51_assert(
      v_result->>'status' = 'invalid_or_expired', '15: service_role consume callable'
    );
    RESET ROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'guided_menu_0051_verification FAIL: 15: service_role privilege denied';
  END;

  -- ── 16. No Produce / admission writes ─────────────────────────────────────
  SELECT count(*) INTO v_produce FROM public.produce_sessions;
  SELECT count(*) INTO v_items FROM public.produce_items;
  SELECT count(*) INTO v_admit FROM public.pending_session_admission;
  PERFORM pg_temp.gm51_assert(v_produce = 0, '16: produce_sessions unchanged');
  PERFORM pg_temp.gm51_assert(v_items = 0, '16: produce_items unchanged');
  PERFORM pg_temp.gm51_assert(v_admit = 0, '16: pending_session_admission unchanged');

  -- ── 17. pending_sessions count unchanged ──────────────────────────────────
  SELECT count(*) INTO v_count FROM public.pending_sessions;
  PERFORM pg_temp.gm51_assert(v_count = 35, '17: pending_sessions still 35');

  RAISE NOTICE 'guided_menu_0051_verification: ALL CHECKS PASSED';
END
$$;
