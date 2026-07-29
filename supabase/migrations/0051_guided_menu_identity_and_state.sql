-- 0051: Guided Menu Identity + Opaque Menu State (Slice 1).
--
-- WHAT THIS IS
-- ------------
-- Persistence and SECURITY INVOKER RPCs for operator identity lookup and
-- opaque, revocable, bound Guided Menu action tokens. Application hashes the
-- raw CSPRNG token; the database stores only the digest.
--
-- WHAT THIS IS NOT
-- ----------------
--   * no LINE webhook / postback wiring;
--   * no Flex / Quick Reply builders;
--   * no open/status/close/confirm Produce command wiring;
--   * no Production allowlist / identity seed rows;
--   * no rewrite of 0050 or earlier migrations.
--
-- CLOCK
-- -----
-- Consume expiry checks use server now(). Client-supplied clocks are rejected
-- so expiry cannot be stretched by clock skew and tests seed expires_at.

-- ── 0) Preconditions ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION '0051: required table public.pending_sessions is missing';
  END IF;
END $$;

-- ── 1) line_operator_identities ──────────────────────────────────────────────

CREATE TABLE public.line_operator_identities (
  line_user_id text PRIMARY KEY,
  staff_label  text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_operator_identities_line_user_id_nonblank
    CHECK (btrim(line_user_id) <> ''),
  CONSTRAINT line_operator_identities_staff_label_nonblank
    CHECK (btrim(staff_label) <> '')
);

COMMENT ON TABLE public.line_operator_identities IS
  'Maps a real LINE user id to a trusted staff_label. Unmapped/inactive = no Guided Menu.';

ALTER TABLE public.line_operator_identities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.line_operator_identities FROM PUBLIC;
REVOKE ALL ON TABLE public.line_operator_identities FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.line_operator_identities TO service_role;

-- ── 2) line_menu_states ──────────────────────────────────────────────────────

CREATE TABLE public.line_menu_states (
  token_hash              text PRIMARY KEY,
  action_type             text NOT NULL,
  line_user_id            text NOT NULL,
  source_type             text NOT NULL,
  source_id               text NOT NULL,
  session_key             text,
  payload                 jsonb NOT NULL,
  expires_at              timestamptz NOT NULL,
  consumed_at             timestamptz,
  consumed_line_event_id  text,
  result                  jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT line_menu_states_token_hash_nonblank
    CHECK (btrim(token_hash) <> ''),
  CONSTRAINT line_menu_states_line_user_id_nonblank
    CHECK (btrim(line_user_id) <> ''),
  CONSTRAINT line_menu_states_source_id_nonblank
    CHECK (btrim(source_id) <> ''),
  CONSTRAINT line_menu_states_session_key_nonblank
    CHECK (session_key IS NULL OR btrim(session_key) <> ''),
  CONSTRAINT line_menu_states_source_type_allowed
    CHECK (source_type IN ('user', 'group', 'room')),
  CONSTRAINT line_menu_states_action_type_allowed
    CHECK (action_type IN (
      'menu_root',
      'choose_transaction_type',
      'choose_market',
      'choose_date',
      'confirm_open',
      'view_status',
      'request_close',
      'confirm_finalize'
    )),
  CONSTRAINT line_menu_states_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT line_menu_states_payload_no_trusted_labels
    CHECK (
      NOT (payload ? 'staff_label')
      AND NOT (payload ? 'market_label')
    ),
  CONSTRAINT line_menu_states_consume_pair
    CHECK (
      (consumed_at IS NULL) = (consumed_line_event_id IS NULL)
    ),
  CONSTRAINT line_menu_states_result_after_consume
    CHECK (result IS NULL OR consumed_at IS NOT NULL),
  CONSTRAINT line_menu_states_result_object
    CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  CONSTRAINT line_menu_states_expires_after_created
    CHECK (expires_at > created_at),
  CONSTRAINT line_menu_states_consumed_event_nonblank
    CHECK (
      consumed_line_event_id IS NULL
      OR btrim(consumed_line_event_id) <> ''
    )
);

COMMENT ON TABLE public.line_menu_states IS
  'Opaque Guided Menu action state. Stores token_hash only; raw tokens never persist.';

CREATE INDEX line_menu_states_expires_at_idx
  ON public.line_menu_states (expires_at);

CREATE INDEX line_menu_states_binding_idx
  ON public.line_menu_states (line_user_id, source_type, source_id);

CREATE INDEX line_menu_states_session_key_idx
  ON public.line_menu_states (session_key)
  WHERE session_key IS NOT NULL;

CREATE INDEX line_menu_states_consumed_at_idx
  ON public.line_menu_states (consumed_at)
  WHERE consumed_at IS NOT NULL;

ALTER TABLE public.line_menu_states ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.line_menu_states FROM PUBLIC;
REVOKE ALL ON TABLE public.line_menu_states FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.line_menu_states TO service_role;

-- ── 3) consume_line_menu_state ───────────────────────────────────────────────
-- Uses server now() for expiry. All failure modes collapse to invalid_or_expired.

CREATE OR REPLACE FUNCTION public.consume_line_menu_state(
  p_token_hash     text,
  p_line_event_id  text,
  p_line_user_id   text,
  p_source_type    text,
  p_source_id      text,
  p_session_key    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_hash   text;
  v_event  text;
  v_user   text;
  v_stype  text;
  v_sid    text;
  v_skey   text;
  v_row    public.line_menu_states%ROWTYPE;
BEGIN
  v_hash  := btrim(coalesce(p_token_hash, ''));
  v_event := btrim(coalesce(p_line_event_id, ''));
  v_user  := btrim(coalesce(p_line_user_id, ''));
  v_stype := btrim(coalesce(p_source_type, ''));
  v_sid   := btrim(coalesce(p_source_id, ''));
  v_skey  := NULLIF(btrim(coalesce(p_session_key, '')), '');

  IF length(v_hash) = 0 OR length(v_event) = 0 OR length(v_user) = 0
     OR length(v_stype) = 0 OR length(v_sid) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  SELECT * INTO v_row
  FROM public.line_menu_states
  WHERE token_hash = v_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  -- Binding / expiry / ownership collapse to the same oracle.
  IF v_row.line_user_id IS DISTINCT FROM v_user
     OR v_row.source_type IS DISTINCT FROM v_stype
     OR v_row.source_id IS DISTINCT FROM v_sid
     OR v_row.session_key IS DISTINCT FROM v_skey
     OR now() >= v_row.expires_at THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  IF v_row.consumed_at IS NOT NULL THEN
    IF v_row.consumed_line_event_id IS NOT DISTINCT FROM v_event THEN
      RETURN jsonb_build_object(
        'status', 'replay',
        'action_type', v_row.action_type,
        'payload', v_row.payload,
        'result', v_row.result
      );
    END IF;

    RETURN jsonb_build_object(
      'status', 'already_consumed',
      'action_type', v_row.action_type,
      'payload', v_row.payload,
      'result', v_row.result
    );
  END IF;

  UPDATE public.line_menu_states
  SET
    consumed_at            = now(),
    consumed_line_event_id = v_event,
    updated_at             = now()
  WHERE token_hash = v_hash
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'status', 'consumed',
    'action_type', v_row.action_type,
    'payload', v_row.payload,
    'result', NULL
  );
END;
$fn$;

COMMENT ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) IS
  'SECURITY INVOKER. First-consume / same-event replay / already-consumed for opaque menu tokens. '
  'Uses server now() for absolute expiry. Never executes Produce commands.';

REVOKE ALL ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) TO service_role;

-- ── 4) record_line_menu_state_result ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_line_menu_state_result(
  p_token_hash            text,
  p_consumed_line_event_id text,
  p_result                jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_hash   text;
  v_event  text;
  v_row    public.line_menu_states%ROWTYPE;
BEGIN
  v_hash  := btrim(coalesce(p_token_hash, ''));
  v_event := btrim(coalesce(p_consumed_line_event_id, ''));

  IF length(v_hash) = 0 OR length(v_event) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  IF p_result IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  SELECT * INTO v_row
  FROM public.line_menu_states
  WHERE token_hash = v_hash
  FOR UPDATE;

  IF NOT FOUND
     OR v_row.consumed_at IS NULL
     OR v_row.consumed_line_event_id IS DISTINCT FROM v_event THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  IF v_row.result IS NOT NULL THEN
    IF v_row.result = p_result THEN
      RETURN jsonb_build_object(
        'status', 'replay',
        'result', v_row.result
      );
    END IF;
    RETURN jsonb_build_object(
      'status', 'result_conflict',
      'result', v_row.result
    );
  END IF;

  UPDATE public.line_menu_states
  SET
    result     = p_result,
    updated_at = now()
  WHERE token_hash = v_hash
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'status', 'recorded',
    'result', v_row.result
  );
END;
$fn$;

COMMENT ON FUNCTION public.record_line_menu_state_result(
  text, text, jsonb
) IS
  'SECURITY INVOKER. First-write / identical-replay / conflicting-result for consumed menu tokens. '
  'Never executes Produce commands.';

REVOKE ALL ON FUNCTION public.record_line_menu_state_result(
  text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_line_menu_state_result(
  text, text, jsonb
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_line_menu_state_result(
  text, text, jsonb
) TO service_role;

-- ── 5) Postconditions ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('line_operator_identities', 'line_menu_states');
  IF v_count <> 2 THEN
    RAISE EXCEPTION '0051: expected exactly 2 new tables, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'line_operator_identities'
    AND column_name IN (
      'line_user_id', 'staff_label', 'active', 'created_at', 'updated_at'
    );
  IF v_count <> 5 THEN
    RAISE EXCEPTION '0051: line_operator_identities column count mismatch (%)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'line_menu_states'
    AND column_name IN (
      'token_hash', 'action_type', 'line_user_id', 'source_type', 'source_id',
      'session_key', 'payload', 'expires_at', 'consumed_at',
      'consumed_line_event_id', 'result', 'created_at', 'updated_at'
    );
  IF v_count <> 13 THEN
    RAISE EXCEPTION '0051: line_menu_states column count mismatch (%)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'line_menu_states'
    AND c.convalidated;
  IF v_count < 12 THEN
    RAISE EXCEPTION '0051: expected validated line_menu_states constraints, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'line_menu_states'
    AND indexname IN (
      'line_menu_states_expires_at_idx',
      'line_menu_states_binding_idx',
      'line_menu_states_session_key_idx',
      'line_menu_states_consumed_at_idx'
    );
  IF v_count <> 4 THEN
    RAISE EXCEPTION '0051: expected 4 line_menu_states indexes, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'line_operator_identities'
      AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'line_menu_states'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION '0051: RLS must be enabled on both tables';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('line_operator_identities', 'line_menu_states');
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0051: expected zero RLS policies, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('consume_line_menu_state', 'record_line_menu_state_result');
  IF v_count <> 2 THEN
    RAISE EXCEPTION '0051: expected exactly 2 RPCs, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('consume_line_menu_state', 'record_line_menu_state_result')
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION '0051: menu RPCs must be SECURITY INVOKER';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.consume_line_menu_state(text,text,text,text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.consume_line_menu_state(text,text,text,text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.record_line_menu_state_result(text,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.record_line_menu_state_result(text,text,jsonb)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION '0051: anon/authenticated must not execute menu RPCs';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.consume_line_menu_state(text,text,text,text,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.record_line_menu_state_result(text,text,jsonb)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION '0051: service_role must execute menu RPCs';
  END IF;

  IF has_table_privilege('anon', 'public.line_menu_states', 'SELECT')
     OR has_table_privilege('authenticated', 'public.line_menu_states', 'SELECT')
     OR has_table_privilege('anon', 'public.line_operator_identities', 'SELECT')
     OR has_table_privilege('authenticated', 'public.line_operator_identities', 'SELECT')
  THEN
    RAISE EXCEPTION '0051: anon/authenticated must not access menu tables';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.line_menu_states', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.line_operator_identities', 'SELECT')
  THEN
    RAISE EXCEPTION '0051: service_role table grants missing';
  END IF;
END $$;
