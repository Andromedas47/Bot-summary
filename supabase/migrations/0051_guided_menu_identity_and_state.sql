-- 0051: Guided Menu Identity + Opaque Menu State (Slice 1) — review-fixed.
--
-- WHAT THIS IS
-- ------------
-- Operator identity, trusted market allowlist, opaque menu-state persistence,
-- and SECURITY INVOKER RPCs for create / consume / record with database-
-- authoritative TTL and action-specific payload contracts.
--
-- WHAT THIS IS NOT
-- ----------------
--   * no LINE webhook / postback / Flex wiring;
--   * no Produce open/append/admission/ingest/close/confirm writes;
--   * no Production operator identity seed rows;
--   * no rewrite of 0050 or earlier migrations.
--
-- TRUSTED MARKET SOURCE
-- ---------------------
-- public.line_guided_menu_markets is the authoritative allowlist for
-- market_code validation. Labels are reconstructed from this table; payloads
-- never store market_label / staff_label.

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
REVOKE ALL ON TABLE public.line_operator_identities FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_operator_identities TO service_role;

-- ── 2) line_guided_menu_markets (authoritative market allowlist) ─────────────

CREATE TABLE public.line_guided_menu_markets (
  market_code text PRIMARY KEY,
  label       text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_guided_menu_markets_code_format
    CHECK (market_code ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT line_guided_menu_markets_label_nonblank
    CHECK (btrim(label) <> '')
);

COMMENT ON TABLE public.line_guided_menu_markets IS
  'Trusted Guided Menu market allowlist. market_code in payloads must match an active row.';

ALTER TABLE public.line_guided_menu_markets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.line_guided_menu_markets FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_markets FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_markets FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_markets TO service_role;

-- Reference seed (configuration, not Production operator identities).
INSERT INTO public.line_guided_menu_markets (market_code, label, active) VALUES
  ('kee', 'ตลาดกี้', true),
  ('seven_front', 'หน้าเซเวน', true),
  ('wat_taklam', 'วัดตะกล่ำ', true);

-- ── 3) Helpers: action class, TTL, payload validation ────────────────────────

CREATE OR REPLACE FUNCTION public.guided_menu_action_is_mutating(p_action text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO public, pg_temp
AS $$
  SELECT p_action IN ('confirm_open', 'request_close', 'confirm_finalize');
$$;

CREATE OR REPLACE FUNCTION public.guided_menu_action_requires_session_key(p_action text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO public, pg_temp
AS $$
  SELECT p_action IN ('view_status', 'request_close', 'confirm_finalize');
$$;

CREATE OR REPLACE FUNCTION public.guided_menu_ttl_interval(p_action text)
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path TO public, pg_temp
AS $$
  SELECT CASE
    WHEN public.guided_menu_action_is_mutating(p_action)
      THEN interval '10 minutes'
    ELSE interval '30 minutes'
  END;
$$;

CREATE OR REPLACE FUNCTION public.guided_menu_iso_date_valid(p_iso text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, pg_temp
AS $fn$
BEGIN
  IF p_iso IS NULL OR p_iso !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN false;
  END IF;
  PERFORM p_iso::date;
  RETURN true;
EXCEPTION
  WHEN others THEN
    RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.guided_menu_payload_valid(
  p_action  text,
  p_payload jsonb
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_keys text[];
  v_tx   text;
  v_mkt  text;
  v_dm   text;
  v_iso  text;
  v_intent text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF (p_payload ? 'staff_label') OR (p_payload ? 'market_label') THEN
    RETURN false;
  END IF;

  SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[])
    INTO v_keys
  FROM jsonb_object_keys(p_payload) AS k;

  CASE p_action
    WHEN 'menu_root' THEN
      IF cardinality(v_keys) = 0 THEN
        RETURN true;
      END IF;
      IF v_keys = ARRAY['intent'] THEN
        v_intent := p_payload->>'intent';
        RETURN v_intent = 'cancel';
      END IF;
      RETURN false;

    WHEN 'choose_transaction_type' THEN
      IF v_keys IS DISTINCT FROM ARRAY['transaction_type'] THEN
        RETURN false;
      END IF;
      v_tx := p_payload->>'transaction_type';
      RETURN v_tx IN ('withdraw', 'return', 'damaged_return');

    WHEN 'choose_market' THEN
      IF v_keys IS DISTINCT FROM ARRAY['market_code', 'transaction_type'] THEN
        RETURN false;
      END IF;
      v_tx := p_payload->>'transaction_type';
      v_mkt := p_payload->>'market_code';
      IF v_tx NOT IN ('withdraw', 'return', 'damaged_return') THEN
        RETURN false;
      END IF;
      IF v_mkt IS NULL OR v_mkt !~ '^[a-z0-9_]{1,32}$' THEN
        RETURN false;
      END IF;
      RETURN EXISTS (
        SELECT 1
          FROM public.line_guided_menu_markets m
         WHERE m.market_code = v_mkt
           AND m.active IS TRUE
      );

    WHEN 'choose_date', 'confirm_open' THEN
      v_tx := p_payload->>'transaction_type';
      v_mkt := p_payload->>'market_code';
      v_dm := p_payload->>'date_mode';
      v_iso := p_payload->>'iso_date';
      IF v_tx NOT IN ('withdraw', 'return', 'damaged_return') THEN
        RETURN false;
      END IF;
      IF v_mkt IS NULL OR v_mkt !~ '^[a-z0-9_]{1,32}$' THEN
        RETURN false;
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM public.line_guided_menu_markets m
         WHERE m.market_code = v_mkt
           AND m.active IS TRUE
      ) THEN
        RETURN false;
      END IF;
      IF v_dm IN ('today', 'yesterday') THEN
        RETURN v_keys IS NOT DISTINCT FROM
          ARRAY['date_mode', 'market_code', 'transaction_type'];
      END IF;
      IF v_dm = 'iso' THEN
        IF v_keys IS DISTINCT FROM
          ARRAY['date_mode', 'iso_date', 'market_code', 'transaction_type'] THEN
          RETURN false;
        END IF;
        RETURN public.guided_menu_iso_date_valid(v_iso);
      END IF;
      RETURN false;

    WHEN 'view_status', 'request_close', 'confirm_finalize' THEN
      RETURN cardinality(v_keys) = 0;

    ELSE
      RETURN false;
  END CASE;
END;
$fn$;

REVOKE ALL ON FUNCTION public.guided_menu_action_is_mutating(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guided_menu_action_requires_session_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guided_menu_ttl_interval(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guided_menu_iso_date_valid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guided_menu_payload_valid(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guided_menu_action_is_mutating(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.guided_menu_action_requires_session_key(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.guided_menu_ttl_interval(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.guided_menu_iso_date_valid(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.guided_menu_payload_valid(text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guided_menu_action_is_mutating(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.guided_menu_action_requires_session_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.guided_menu_ttl_interval(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.guided_menu_iso_date_valid(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.guided_menu_payload_valid(text, jsonb) TO service_role;

-- ── 4) line_menu_states ──────────────────────────────────────────────────────

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

  CONSTRAINT line_menu_states_token_hash_sha256_hex
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
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
REVOKE ALL ON TABLE public.line_menu_states FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_menu_states TO service_role;

-- Force DB-authoritative created_at / expires_at / payload / session_key rules
-- even for direct privileged inserts.
CREATE OR REPLACE FUNCTION public.enforce_line_menu_state_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_skey text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := v_now;
    NEW.updated_at := v_now;
    NEW.expires_at := v_now + public.guided_menu_ttl_interval(NEW.action_type);
    NEW.consumed_at := NULL;
    NEW.consumed_line_event_id := NULL;
    NEW.result := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Never allow client clocks to stretch TTL or rewrite creation time.
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION '0051: created_at is immutable';
    END IF;
    IF NEW.action_type IS DISTINCT FROM OLD.action_type THEN
      RAISE EXCEPTION '0051: action_type is immutable';
    END IF;
    IF NEW.payload IS DISTINCT FROM OLD.payload THEN
      RAISE EXCEPTION '0051: payload is immutable';
    END IF;
    IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
      RAISE EXCEPTION '0051: token_hash is immutable';
    END IF;
    IF NEW.line_user_id IS DISTINCT FROM OLD.line_user_id
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.session_key IS DISTINCT FROM OLD.session_key THEN
      RAISE EXCEPTION '0051: binding fields are immutable';
    END IF;
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION '0051: expires_at is immutable';
    END IF;
    NEW.updated_at := v_now;
  END IF;

  v_skey := NULLIF(btrim(coalesce(NEW.session_key, '')), '');
  NEW.session_key := v_skey;

  IF public.guided_menu_action_requires_session_key(NEW.action_type)
     AND v_skey IS NULL THEN
    RAISE EXCEPTION '0051: session_key required for action %', NEW.action_type;
  END IF;

  IF NOT public.guided_menu_payload_valid(NEW.action_type, NEW.payload) THEN
    RAISE EXCEPTION '0051: invalid payload for action %', NEW.action_type;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_line_menu_state_invariants
  ON public.line_menu_states;

CREATE TRIGGER trg_enforce_line_menu_state_invariants
  BEFORE INSERT OR UPDATE ON public.line_menu_states
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_line_menu_state_invariants();

REVOKE ALL ON FUNCTION public.enforce_line_menu_state_invariants() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_line_menu_state_invariants() FROM anon, authenticated;

-- ── 5) create_line_menu_state ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_line_menu_state(
  p_token_hash   text,
  p_action_type  text,
  p_line_user_id text,
  p_source_type  text,
  p_source_id    text,
  p_session_key  text DEFAULT NULL,
  p_payload      jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_hash text;
  v_user text;
  v_stype text;
  v_sid text;
  v_skey text;
  v_action text;
  v_payload jsonb;
  v_row public.line_menu_states%ROWTYPE;
BEGIN
  v_hash := btrim(coalesce(p_token_hash, ''));
  v_user := btrim(coalesce(p_line_user_id, ''));
  v_stype := btrim(coalesce(p_source_type, ''));
  v_sid := btrim(coalesce(p_source_id, ''));
  v_skey := NULLIF(btrim(coalesce(p_session_key, '')), '');
  v_action := btrim(coalesce(p_action_type, ''));
  v_payload := coalesce(p_payload, '{}'::jsonb);

  IF v_hash !~ '^[0-9a-f]{64}$'
     OR length(v_user) = 0
     OR length(v_stype) = 0
     OR length(v_sid) = 0
     OR length(v_action) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  IF v_stype NOT IN ('user', 'group', 'room') THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  IF NOT public.guided_menu_payload_valid(v_action, v_payload) THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  IF public.guided_menu_action_requires_session_key(v_action) AND v_skey IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  INSERT INTO public.line_menu_states (
    token_hash, action_type, line_user_id, source_type, source_id,
    session_key, payload
  ) VALUES (
    v_hash, v_action, v_user, v_stype, v_sid, v_skey, v_payload
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'status', 'created',
    'action_type', v_row.action_type,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  WHEN others THEN
    -- Collapse constraint/trigger failures to generic invalid.
    RETURN jsonb_build_object('status', 'invalid_or_expired');
END;
$fn$;

COMMENT ON FUNCTION public.create_line_menu_state(
  text, text, text, text, text, text, jsonb
) IS
  'SECURITY INVOKER. Creates opaque menu state. DB sets created_at/expires_at from action TTL. '
  'Caller supplies SHA-256 token_hash only; raw tokens never persist.';

REVOKE ALL ON FUNCTION public.create_line_menu_state(
  text, text, text, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_line_menu_state(
  text, text, text, text, text, text, jsonb
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_line_menu_state(
  text, text, text, text, text, text, jsonb
) TO service_role;

-- ── 6) consume_line_menu_state ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.consume_line_menu_state(
  p_token_hash     text,
  p_line_event_id  text,
  p_line_user_id   text,
  p_source_type    text,
  p_source_id      text,
  p_session_key    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO public, pg_temp
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

  IF v_hash !~ '^[0-9a-f]{64}$'
     OR length(v_event) = 0
     OR length(v_user) = 0
     OR length(v_stype) = 0
     OR length(v_sid) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  SELECT * INTO v_row
  FROM public.line_menu_states
  WHERE token_hash = v_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

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

    -- Different-event already_consumed: redact action/payload/result.
    RETURN jsonb_build_object('status', 'already_consumed');
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
    'payload', v_row.payload
  );
END;
$fn$;

COMMENT ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) IS
  'SECURITY INVOKER. First-consume / same-event replay / redacted already_consumed. '
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

-- ── 7) record_line_menu_state_result (full binding) ──────────────────────────

CREATE OR REPLACE FUNCTION public.record_line_menu_state_result(
  p_token_hash             text,
  p_consumed_line_event_id text,
  p_line_user_id           text,
  p_source_type            text,
  p_source_id              text,
  p_session_key            text DEFAULT NULL,
  p_result                 jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO public, pg_temp
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
  v_event := btrim(coalesce(p_consumed_line_event_id, ''));
  v_user  := btrim(coalesce(p_line_user_id, ''));
  v_stype := btrim(coalesce(p_source_type, ''));
  v_sid   := btrim(coalesce(p_source_id, ''));
  v_skey  := NULLIF(btrim(coalesce(p_session_key, '')), '');

  IF v_hash !~ '^[0-9a-f]{64}$'
     OR length(v_event) = 0
     OR length(v_user) = 0
     OR length(v_stype) = 0
     OR length(v_sid) = 0 THEN
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
     OR v_row.consumed_line_event_id IS DISTINCT FROM v_event
     OR v_row.line_user_id IS DISTINCT FROM v_user
     OR v_row.source_type IS DISTINCT FROM v_stype
     OR v_row.source_id IS DISTINCT FROM v_sid
     OR v_row.session_key IS DISTINCT FROM v_skey THEN
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
  text, text, text, text, text, text, jsonb
) IS
  'SECURITY INVOKER. First-write / identical-replay / conflicting-result with full binding. '
  'Never executes Produce commands.';

REVOKE ALL ON FUNCTION public.record_line_menu_state_result(
  text, text, text, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_line_menu_state_result(
  text, text, text, text, text, text, jsonb
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_line_menu_state_result(
  text, text, text, text, text, text, jsonb
) TO service_role;

-- ── 8) Postconditions ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'line_operator_identities',
      'line_menu_states',
      'line_guided_menu_markets'
    );
  IF v_count <> 3 THEN
    RAISE EXCEPTION '0051: expected exactly 3 new tables, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.line_guided_menu_markets
  WHERE active IS TRUE;
  IF v_count < 1 THEN
    RAISE EXCEPTION '0051: trusted market allowlist must be non-empty';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'line_menu_states_token_hash_sha256_hex'
  ) THEN
    RAISE EXCEPTION '0051: token_hash hex CHECK missing';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'create_line_menu_state',
      'consume_line_menu_state',
      'record_line_menu_state_result'
    );
  IF v_count <> 3 THEN
    RAISE EXCEPTION '0051: expected exactly 3 menu RPCs, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'create_line_menu_state',
        'consume_line_menu_state',
        'record_line_menu_state_result',
        'guided_menu_payload_valid',
        'enforce_line_menu_state_invariants'
      )
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION '0051: menu RPCs/helpers must be SECURITY INVOKER';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.create_line_menu_state(text,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.create_line_menu_state(text,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
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
       'public.record_line_menu_state_result(text,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.record_line_menu_state_result(text,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION '0051: anon/authenticated must not execute menu RPCs';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.create_line_menu_state(text,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.consume_line_menu_state(text,text,text,text,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.record_line_menu_state_result(text,text,text,text,text,text,jsonb)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION '0051: service_role must execute menu RPCs';
  END IF;

  IF has_table_privilege('anon', 'public.line_menu_states', 'SELECT')
     OR has_table_privilege('authenticated', 'public.line_menu_states', 'SELECT')
     OR has_table_privilege('anon', 'public.line_operator_identities', 'SELECT')
     OR has_table_privilege('authenticated', 'public.line_operator_identities', 'SELECT')
     OR has_table_privilege('anon', 'public.line_guided_menu_markets', 'SELECT')
     OR has_table_privilege('authenticated', 'public.line_guided_menu_markets', 'SELECT')
  THEN
    RAISE EXCEPTION '0051: anon/authenticated must not access menu tables';
  END IF;

  IF has_table_privilege('service_role', 'public.line_menu_states', 'DELETE')
     OR has_table_privilege('service_role', 'public.line_operator_identities', 'DELETE')
     OR has_table_privilege('service_role', 'public.line_guided_menu_markets', 'DELETE')
     OR has_table_privilege('service_role', 'public.line_menu_states', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.line_operator_identities', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.line_guided_menu_markets', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.line_menu_states', 'REFERENCES')
     OR has_table_privilege('service_role', 'public.line_operator_identities', 'REFERENCES')
     OR has_table_privilege('service_role', 'public.line_guided_menu_markets', 'REFERENCES')
     OR has_table_privilege('service_role', 'public.line_menu_states', 'TRIGGER')
     OR has_table_privilege('service_role', 'public.line_operator_identities', 'TRIGGER')
     OR has_table_privilege('service_role', 'public.line_guided_menu_markets', 'TRIGGER')
  THEN
    RAISE EXCEPTION '0051: service_role must not have DELETE/TRUNCATE/REFERENCES/TRIGGER on menu tables';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'line_operator_identities',
      'line_menu_states',
      'line_guided_menu_markets'
    );
  IF v_count <> 0 THEN
    RAISE EXCEPTION '0051: expected zero RLS policies, found %', v_count;
  END IF;
END $$;
