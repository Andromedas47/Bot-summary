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

CREATE OR REPLACE FUNCTION pg_temp.gm51_hash(seed text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(extensions.digest(seed, 'sha256'), 'hex');
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
  v_hash     text;
  v_hash2    text;
  v_user     text := 'U-active';
  v_event    text := 'evt-consume-1';
  v_created  timestamptz;
  v_expires  timestamptz;
  v_ttl_sec  numeric;
  v_ok       boolean;
  v_table    text;
BEGIN
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

  -- ── 1. Operator identity ───────────────────────────────────────────────────
  INSERT INTO public.line_operator_identities (line_user_id, staff_label, active)
  VALUES ('U-active', 'Test Staff', true);

  INSERT INTO public.line_operator_identities (line_user_id, staff_label, active)
  VALUES ('U-inactive', 'Inactive Staff', false);

  SELECT staff_label INTO v_label
    FROM public.line_operator_identities
   WHERE line_user_id = 'U-active' AND active IS TRUE;
  PERFORM pg_temp.gm51_assert(v_label = 'Test Staff', '1: active operator lookup');

  -- ── 2. Trusted markets + token_hash column ─────────────────────────────────
  SELECT count(*) INTO v_count FROM public.line_guided_menu_markets WHERE active;
  PERFORM pg_temp.gm51_assert(v_count >= 3, '2: trusted markets seeded');

  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'line_menu_states'
     AND column_name ILIKE '%token%';
  PERFORM pg_temp.gm51_assert(v_count = 1, '2: exactly one token column (token_hash)');

  -- ── 3. create_line_menu_state — navigation TTL 30m ─────────────────────────
  v_hash := pg_temp.gm51_hash('create-nav');
  v_result := public.create_line_menu_state(
    v_hash, 'menu_root', v_user, 'user', v_user, NULL, '{}'::jsonb
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'created', '3: create menu_root');
  v_created := (v_result->>'created_at')::timestamptz;
  v_expires := (v_result->>'expires_at')::timestamptz;
  v_ttl_sec := extract(epoch FROM (v_expires - v_created));
  PERFORM pg_temp.gm51_assert(
    v_ttl_sec BETWEEN 1790 AND 1810,
    format('3: navigation TTL ~30m got %s sec', v_ttl_sec)
  );

  -- ── 4. create confirm_open — mutating TTL 10m ──────────────────────────────
  v_hash2 := pg_temp.gm51_hash('create-mut');
  v_result := public.create_line_menu_state(
    v_hash2,
    'confirm_open',
    v_user,
    'user',
    v_user,
    NULL,
    jsonb_build_object(
      'transaction_type', 'withdraw',
      'market_code', 'kee',
      'date_mode', 'today'
    )
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'created', '4: create confirm_open');
  v_created := (v_result->>'created_at')::timestamptz;
  v_expires := (v_result->>'expires_at')::timestamptz;
  v_ttl_sec := extract(epoch FROM (v_expires - v_created));
  PERFORM pg_temp.gm51_assert(
    v_ttl_sec BETWEEN 590 AND 610,
    format('4: mutating TTL ~10m got %s sec', v_ttl_sec)
  );

  -- ── 5. Direct insert cannot stretch TTL ────────────────────────────────────
  v_hash := pg_temp.gm51_hash('direct-ttl');
  INSERT INTO public.line_menu_states (
    token_hash, action_type, line_user_id, source_type, source_id,
    session_key, payload, expires_at
  ) VALUES (
    v_hash, 'menu_root', v_user, 'user', v_user, NULL,
    '{}'::jsonb, now() + interval '1 hour'
  );
  SELECT created_at, expires_at INTO v_created, v_expires
    FROM public.line_menu_states WHERE token_hash = v_hash;
  v_ttl_sec := extract(epoch FROM (v_expires - v_created));
  PERFORM pg_temp.gm51_assert(
    v_ttl_sec BETWEEN 1790 AND 1810,
    format('5: direct insert TTL forced to ~30m got %s', v_ttl_sec)
  );

  -- ── 6. Reject unknown action / bad payload / untrusted market / bad hash ───
  v_result := public.create_line_menu_state(
    pg_temp.gm51_hash('bad-action'), 'not_an_action', v_user, 'user', v_user,
    NULL, '{}'::jsonb
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '6: unknown action');

  v_result := public.create_line_menu_state(
    pg_temp.gm51_hash('bad-keys'),
    'choose_transaction_type',
    v_user, 'user', v_user, NULL,
    jsonb_build_object('transaction_type', 'withdraw', 'extra', 1)
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '6: unknown payload key');

  v_result := public.create_line_menu_state(
    pg_temp.gm51_hash('missing-tx'),
    'choose_transaction_type',
    v_user, 'user', v_user, NULL,
    '{}'::jsonb
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '6: missing required key');

  v_result := public.create_line_menu_state(
    pg_temp.gm51_hash('bad-tx'),
    'choose_transaction_type',
    v_user, 'user', v_user, NULL,
    jsonb_build_object('transaction_type', 'เบิก')
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '6: invalid transaction_type');

  v_result := public.create_line_menu_state(
    pg_temp.gm51_hash('bad-market'),
    'choose_market',
    v_user, 'user', v_user, NULL,
    jsonb_build_object(
      'transaction_type', 'withdraw',
      'market_code', 'not_a_real_market'
    )
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '6: untrusted market');

  BEGIN
    INSERT INTO public.line_menu_states (
      token_hash, action_type, line_user_id, source_type, source_id, payload
    ) VALUES (
      'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
      'menu_root', v_user, 'user', v_user, '{}'::jsonb
    );
    v_ok := false;
  EXCEPTION WHEN check_violation OR others THEN
    v_ok := true;
  END;
  PERFORM pg_temp.gm51_assert(v_ok, '6: uppercase hash rejected');

  BEGIN
    INSERT INTO public.line_menu_states (
      token_hash, action_type, line_user_id, source_type, source_id, payload
    ) VALUES (
      'short',
      'menu_root', v_user, 'user', v_user, '{}'::jsonb
    );
    v_ok := false;
  EXCEPTION WHEN check_violation OR others THEN
    v_ok := true;
  END;
  PERFORM pg_temp.gm51_assert(v_ok, '6: short hash rejected');

  -- ── 7. Consume happy path + same-event replay ──────────────────────────────
  v_hash := pg_temp.gm51_hash('consume-ok');
  PERFORM public.create_line_menu_state(
    v_hash, 'menu_root', v_user, 'user', v_user, NULL, '{}'::jsonb
  );

  v_result := public.consume_line_menu_state(
    v_hash, v_event, v_user, 'user', v_user, NULL
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'consumed', '7: fresh consume');
  PERFORM pg_temp.gm51_assert(v_result->>'action_type' = 'menu_root', '7: action returned');
  PERFORM pg_temp.gm51_assert(v_result ? 'payload', '7: payload returned');

  v_result := public.consume_line_menu_state(
    v_hash, v_event, v_user, 'user', v_user, NULL
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'replay', '7: same-event replay');
  PERFORM pg_temp.gm51_assert(v_result->>'action_type' = 'menu_root', '7: replay keeps action');

  -- ── 8. Different-event already_consumed is redacted ────────────────────────
  v_result := public.consume_line_menu_state(
    v_hash, 'evt-other', v_user, 'user', v_user, NULL
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'already_consumed', '8: already_consumed');
  PERFORM pg_temp.gm51_assert(NOT (v_result ? 'action_type'), '8: no action_type');
  PERFORM pg_temp.gm51_assert(NOT (v_result ? 'payload'), '8: no payload');
  PERFORM pg_temp.gm51_assert(NOT (v_result ? 'result'), '8: no result');

  -- ── 9. Wrong binding / expired → invalid_or_expired ────────────────────────
  v_hash := pg_temp.gm51_hash('wrong-bind');
  PERFORM public.create_line_menu_state(
    v_hash, 'menu_root', v_user, 'user', v_user, NULL, '{}'::jsonb
  );
  v_result := public.consume_line_menu_state(
    v_hash, 'evt-w', 'U-other', 'user', v_user, NULL
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '9: wrong user');
  PERFORM pg_temp.gm51_assert(NOT (v_result ? 'payload'), '9: no payload on wrong user');

  v_result := public.consume_line_menu_state(
    v_hash, 'evt-w2', v_user, 'group', v_user, NULL
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '9: wrong source type');

  v_result := public.consume_line_menu_state(
    v_hash, 'evt-w3', v_user, 'user', 'U-else', NULL
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '9: wrong source id');

  v_hash := pg_temp.gm51_hash('session-bind');
  PERFORM public.create_line_menu_state(
    v_hash, 'menu_root', v_user, 'user', v_user, 'dm:bound', '{}'::jsonb
  );
  v_result := public.consume_line_menu_state(
    v_hash, 'evt-s', v_user, 'user', v_user, 'dm:other'
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '9: wrong session key');

  v_hash := pg_temp.gm51_hash('expired');
  PERFORM public.create_line_menu_state(
    v_hash, 'menu_root', v_user, 'user', v_user, NULL, '{}'::jsonb
  );
  -- Skip immutability trigger; keep expires_at > created_at CHECK valid.
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.line_menu_states
     SET created_at = now() - interval '1 hour',
         expires_at = now() - interval '1 second'
   WHERE token_hash = v_hash;
  PERFORM set_config('session_replication_role', 'origin', true);

  v_result := public.consume_line_menu_state(
    v_hash, 'evt-exp', v_user, 'user', v_user, NULL
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '9: expired');

  -- ── 10. record_line_menu_state_result full binding ─────────────────────────
  v_hash := pg_temp.gm51_hash('record-ok');
  PERFORM public.create_line_menu_state(
    v_hash, 'menu_root', v_user, 'user', v_user, NULL, '{}'::jsonb
  );
  PERFORM public.consume_line_menu_state(
    v_hash, 'evt-rec', v_user, 'user', v_user, NULL
  );

  v_result := public.record_line_menu_state_result(
    v_hash, 'evt-rec', v_user, 'user', v_user, NULL,
    jsonb_build_object('screen', 'ok')
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'recorded', '10: recorded');

  v_result := public.record_line_menu_state_result(
    v_hash, 'evt-rec', v_user, 'user', v_user, NULL,
    jsonb_build_object('screen', 'ok')
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'replay', '10: identical replay');

  v_result := public.record_line_menu_state_result(
    v_hash, 'evt-rec', v_user, 'user', v_user, NULL,
    jsonb_build_object('screen', 'other')
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'result_conflict', '10: conflict');
  PERFORM pg_temp.gm51_assert(v_result->'result'->>'screen' = 'ok', '10: first result retained');

  v_result := public.record_line_menu_state_result(
    v_hash, 'evt-rec', 'U-wrong', 'user', v_user, NULL,
    jsonb_build_object('screen', 'x')
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'invalid_or_expired', '10: wrong binding redacted');
  PERFORM pg_temp.gm51_assert(NOT (v_result ? 'result'), '10: no result disclosure');

  -- ── 11. session_key required actions ───────────────────────────────────────
  v_result := public.create_line_menu_state(
    pg_temp.gm51_hash('need-session'),
    'view_status',
    v_user, 'user', v_user, NULL, '{}'::jsonb
  );
  PERFORM pg_temp.gm51_assert(
    v_result->>'status' = 'invalid_or_expired',
    '11: view_status requires session_key'
  );

  v_result := public.create_line_menu_state(
    pg_temp.gm51_hash('with-session'),
    'view_status',
    v_user, 'user', v_user, 'dm:status', '{}'::jsonb
  );
  PERFORM pg_temp.gm51_assert(v_result->>'status' = 'created', '11: view_status with session_key');

  -- ── 12. No Produce / admission side effects ────────────────────────────────
  SELECT count(*) INTO v_produce FROM public.produce_sessions;
  SELECT count(*) INTO v_items FROM public.produce_items;
  SELECT count(*) INTO v_admit FROM public.pending_session_admission;
  SELECT count(*) INTO v_pending FROM public.pending_sessions;
  PERFORM pg_temp.gm51_assert(v_produce = 0, '12: no produce_sessions writes');
  PERFORM pg_temp.gm51_assert(v_items = 0, '12: no produce_items writes');
  PERFORM pg_temp.gm51_assert(v_admit = 0, '12: no admission writes');
  PERFORM pg_temp.gm51_assert(v_pending = 35, '12: pending_sessions unchanged');

  -- ── 13. Grants: SIU only for service_role; no anon/auth table or RPC access ─
  FOREACH v_table IN ARRAY ARRAY[
    'public.line_operator_identities',
    'public.line_guided_menu_markets',
    'public.line_menu_states'
  ]
  LOOP
    PERFORM pg_temp.gm51_assert(
      has_table_privilege('service_role', v_table, 'SELECT'),
      '13: service_role SELECT on ' || v_table
    );
    PERFORM pg_temp.gm51_assert(
      has_table_privilege('service_role', v_table, 'INSERT'),
      '13: service_role INSERT on ' || v_table
    );
    PERFORM pg_temp.gm51_assert(
      has_table_privilege('service_role', v_table, 'UPDATE'),
      '13: service_role UPDATE on ' || v_table
    );
    PERFORM pg_temp.gm51_assert(
      NOT has_table_privilege('service_role', v_table, 'DELETE'),
      '13: no service_role DELETE on ' || v_table
    );
    PERFORM pg_temp.gm51_assert(
      NOT has_table_privilege('service_role', v_table, 'TRUNCATE'),
      '13: no service_role TRUNCATE on ' || v_table
    );
    PERFORM pg_temp.gm51_assert(
      NOT has_table_privilege('service_role', v_table, 'REFERENCES'),
      '13: no service_role REFERENCES on ' || v_table
    );
    PERFORM pg_temp.gm51_assert(
      NOT has_table_privilege('service_role', v_table, 'TRIGGER'),
      '13: no service_role TRIGGER on ' || v_table
    );
    PERFORM pg_temp.gm51_assert(
      NOT has_table_privilege('anon', v_table, 'SELECT')
        AND NOT has_table_privilege('authenticated', v_table, 'SELECT'),
      '13: anon/authenticated no SELECT on ' || v_table
    );
  END LOOP;

  PERFORM pg_temp.gm51_assert(
    NOT has_function_privilege(
      'anon',
      'public.create_line_menu_state(text,text,text,text,text,text,jsonb)',
      'EXECUTE'
    ),
    '13: anon cannot create'
  );
  PERFORM pg_temp.gm51_assert(
    has_function_privilege(
      'service_role',
      'public.create_line_menu_state(text,text,text,text,text,text,jsonb)',
      'EXECUTE'
    )
    AND has_function_privilege(
      'service_role',
      'public.consume_line_menu_state(text,text,text,text,text,text)',
      'EXECUTE'
    )
    AND has_function_privilege(
      'service_role',
      'public.record_line_menu_state_result(text,text,text,text,text,text,jsonb)',
      'EXECUTE'
    ),
    '13: service_role executes menu RPCs'
  );

  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'line_operator_identities',
      'line_menu_states',
      'line_guided_menu_markets'
    );
  PERFORM pg_temp.gm51_assert(v_count = 0, '13: zero RLS policies');

  RAISE NOTICE 'guided_menu_0051_verification: OK';
END
$$;
