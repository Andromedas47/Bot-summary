-- 0048: version the live pending-session function baseline (parity only).
--
-- WHAT THIS IS
-- ------------
-- public.register_pending_session_ingest(text,text,bigint,text) and
-- public.check_pending_close_ready(text) exist in Production but in no
-- committed migration. Migration slot 0042 is RESERVED and empty; 0031's
-- header records that this baseline was "applied out-of-band, outside any
-- committed migration", and 0044 only ASSERTS the two functions exist.
--
-- This migration brings those two live definitions into version control,
-- captured verbatim from Production via pg_get_functiondef / pg_proc.prosrc.
-- The bodies were transported as base64 and differ from the live copies only
-- in line endings (Production stores CRLF; this file uses LF). No statement,
-- expression, identifier, literal or comment was altered.
--
-- Provenance (Production project apjjsqibavjaitcedavn, read-only introspection):
--   check_pending_close_ready(text)
--     md5(prosrc)                              = 33308ba75860a583107bd041531c918f
--     md5(pg_get_functiondef) raw (CRLF)       = ce95b1c9bdb1d4cb9b2c00ef30e8e6f9
--     md5(pg_get_functiondef) CR-stripped (LF) = 86c63b48ce14f4df308292577a4b21ed
--   register_pending_session_ingest(text,text,bigint,text)
--     md5(prosrc)                              = fb67d9c58989a40ca852f8a5bb94a59d
--     md5(pg_get_functiondef) raw (CRLF)       = edb9ed893bd7dc9f0796f7f9d05098a8
--     md5(pg_get_functiondef) CR-stripped (LF) = affe62834f11b14f581018ec68fb7bed
--
-- The CR-stripped hash is the parity target: after this migration is applied,
--   md5(replace(pg_get_functiondef(oid), chr(13), ''))
-- must equal the value above for each function. The raw hash necessarily
-- changes on Production, because the stored body is re-recorded with LF
-- endings. That is a byte change with no semantic effect: plpgsql attributes
-- no meaning to CR, and no string literal in either body contains one.
--
-- WHAT THIS IS NOT
-- ----------------
-- Baseline parity ONLY. This migration deliberately does NOT:
--   * introduce the Produce Structured Session feature;
--   * add pending_sessions metadata columns, operator identities or menu state;
--   * add the entry_origin guard to the legacy_accumulated path
--     (that behavioral change belongs to 0049);
--   * change readiness semantics in any way;
--   * convert either function to SECURITY DEFINER;
--   * harden the wider Produce RPC family;
--   * replay, resurrect or reference reserved migration 0042;
--   * create the missing 0042-era baseline objects (see LIMITATION below);
--   * mutate any table row or fabricate supabase_migrations history.
--
-- SECURITY INVOKER IS PRESERVED DELIBERATELY
-- ------------------------------------------
-- Production has both functions as SECURITY INVOKER (prosecdef = false) with
-- proconfig = NULL (no pinned search_path), owned by postgres. This migration
-- reproduces that exactly. A `SET search_path` is NOT added: every object both
-- bodies touch is already schema-qualified (public.pending_sessions,
-- public.pending_session_ingest, public.pending_session_admission), so pinning
-- would be semantically inert, but it would change pg_proc.proconfig and make
-- the committed definition differ from the live baseline this migration exists
-- to capture. Pinning search_path across the Produce RPC family is a separate,
-- deliberate hardening change and must not ride along with a baseline capture.
--
-- LIMITATION: THIS DOES NOT MAKE A CLEAN CHAIN BUILD
-- --------------------------------------------------
-- Verified empirically against a clean postgres:17 database by applying every
-- tracked migration in order: the chain fails at 0032, well before this file,
-- because the 0042-era baseline is absent from version control. Missing on a
-- clean build: pending_sessions.{session_generation, close_event_timestamp_ms,
-- close_requested_at, close_line_event_id, close_finalize_started_at,
-- finalization_started_at, finalized_at, finalization_status,
-- finalization_error, finalized_produce_session_id} and both ledger tables
-- (pending_session_ingest, pending_session_admission). Restoring those is a
-- separate baseline migration and is NOT attempted here, because it cannot be
-- done without replaying reserved 0042 content. The assertions below therefore
-- fail closed rather than create anything.

DO $$
DECLARE
  v_oid    regprocedure;
  v_result text;
  v_secdef boolean;
BEGIN
  -- 1) Required tables ------------------------------------------------------
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION '0048: required table public.pending_sessions is missing';
  END IF;
  IF to_regclass('public.pending_session_ingest') IS NULL THEN
    RAISE EXCEPTION
      '0048: required table public.pending_session_ingest is missing (0042-era baseline absent)';
  END IF;
  IF to_regclass('public.pending_session_admission') IS NULL THEN
    RAISE EXCEPTION
      '0048: required table public.pending_session_admission is missing (0042-era baseline absent)';
  END IF;

  -- 2) Required columns, with the exact types both bodies rely on -----------
  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.pending_sessions'::regclass
     AND attname = 'session_generation' AND NOT attisdropped
     AND format_type(atttypid, atttypmod) = 'uuid';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0048: pending_sessions.session_generation uuid is missing';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.pending_sessions'::regclass
     AND attname = 'close_event_timestamp_ms' AND NOT attisdropped
     AND format_type(atttypid, atttypmod) = 'bigint';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0048: pending_sessions.close_event_timestamp_ms bigint is missing';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.pending_sessions'::regclass
     AND attname = 'close_requested_at' AND NOT attisdropped
     AND format_type(atttypid, atttypmod) = 'timestamp with time zone';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0048: pending_sessions.close_requested_at timestamptz is missing';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.pending_sessions'::regclass
     AND attname = 'accumulated_text' AND NOT attisdropped
     AND format_type(atttypid, atttypmod) = 'text';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0048: pending_sessions.accumulated_text text is missing';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.pending_session_ingest'::regclass
     AND attname = 'raw_text' AND NOT attisdropped
     AND format_type(atttypid, atttypmod) = 'text';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0048: pending_session_ingest.raw_text text is missing';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.pending_session_ingest'::regclass
     AND attname = 'line_timestamp_ms' AND NOT attisdropped
     AND format_type(atttypid, atttypmod) = 'bigint';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0048: pending_session_ingest.line_timestamp_ms bigint is missing';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.pending_session_admission'::regclass
     AND attname = 'admitted_at' AND NOT attisdropped
     AND format_type(atttypid, atttypmod) = 'timestamp with time zone';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0048: pending_session_admission.admitted_at timestamptz is missing';
  END IF;

  -- 3) ON CONFLICT arbiter must exist ---------------------------------------
  -- register_pending_session_ingest uses
  --   ON CONFLICT (session_generation, line_event_id)
  -- which requires a unique index on exactly those columns, in that order.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.oid = 'public.pending_session_ingest'::regclass
      AND i.indisunique
      AND pg_get_indexdef(i.indexrelid) ~* '\(session_generation, line_event_id\)'
  ) THEN
    RAISE EXCEPTION
      '0048: pending_session_ingest has no unique index on (session_generation, line_event_id) — ON CONFLICT target';
  END IF;

  -- 4) Pre-existing definitions must be replaceable, not silently downgraded -
  -- CREATE OR REPLACE cannot change a result type, so an incompatible result
  -- must fail here rather than mid-statement. A SECURITY DEFINER function in
  -- this database would mean someone hardened it ahead of us; overwriting it
  -- with the INVOKER baseline would be a silent security regression.
  BEGIN
    v_oid := 'public.check_pending_close_ready(text)'::regprocedure;
    SELECT pg_get_function_result(v_oid), p.prosecdef
      INTO v_result, v_secdef
      FROM pg_proc p WHERE p.oid = v_oid;
    IF lower(v_result) IS DISTINCT FROM 'jsonb' THEN
      RAISE EXCEPTION
        '0048: check_pending_close_ready(text) result type is %, expected jsonb', v_result;
    END IF;
    IF v_secdef THEN
      RAISE EXCEPTION
        '0048: check_pending_close_ready(text) is SECURITY DEFINER here; refusing to overwrite a hardened definition with the INVOKER baseline';
    END IF;
  EXCEPTION WHEN undefined_function THEN
    NULL;  -- absent is fine: this migration defines it.
  END;

  BEGIN
    v_oid := 'public.register_pending_session_ingest(text,text,bigint,text)'::regprocedure;
    SELECT pg_get_function_result(v_oid), p.prosecdef
      INTO v_result, v_secdef
      FROM pg_proc p WHERE p.oid = v_oid;
    IF lower(v_result) IS DISTINCT FROM 'void' THEN
      RAISE EXCEPTION
        '0048: register_pending_session_ingest(...) result type is %, expected void', v_result;
    END IF;
    IF v_secdef THEN
      RAISE EXCEPTION
        '0048: register_pending_session_ingest(...) is SECURITY DEFINER here; refusing to overwrite a hardened definition with the INVOKER baseline';
    END IF;
  EXCEPTION WHEN undefined_function THEN
    NULL;
  END;
END $$;

-- 5) Baseline definitions, verbatim from Production ---------------------------
-- SECURITY INVOKER (the default) and no SET clause: see header.

CREATE OR REPLACE FUNCTION public.register_pending_session_ingest(
  p_session_key       text,
  p_line_event_id     text,
  p_line_timestamp_ms bigint,
  p_raw_text          text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_generation uuid;
BEGIN
  SELECT session_generation INTO v_generation
  FROM public.pending_sessions
  WHERE session_key = p_session_key;

  IF NOT FOUND OR p_raw_text IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.pending_session_ingest (
    session_key,
    session_generation,
    line_event_id,
    line_timestamp_ms,
    raw_text
  )
  VALUES (
    p_session_key,
    v_generation,
    p_line_event_id,
    p_line_timestamp_ms,
    p_raw_text
  )
  ON CONFLICT (session_generation, line_event_id) DO UPDATE SET
    raw_text          = EXCLUDED.raw_text,
    line_timestamp_ms = EXCLUDED.line_timestamp_ms;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.check_pending_close_ready(
  p_session_key text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_session public.pending_sessions%ROWTYPE;
  v_admission_count int;
  v_ingest_count int;
  v_straggler_count int;
BEGIN
  SELECT * INTO v_session
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_session.close_event_timestamp_ms IS NULL
     OR v_session.close_requested_at IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'not_closing');
  END IF;

  SELECT COUNT(*)::int INTO v_admission_count
  FROM public.pending_session_admission a
  WHERE a.session_key = p_session_key
    AND a.session_generation = v_session.session_generation
    AND a.line_timestamp_ms <= v_session.close_event_timestamp_ms;

  SELECT COUNT(*)::int INTO v_ingest_count
  FROM public.pending_session_ingest i
  WHERE i.session_key = p_session_key
    AND i.session_generation = v_session.session_generation
    AND i.line_timestamp_ms <= v_session.close_event_timestamp_ms
    AND i.raw_text IS NOT NULL
    AND btrim(i.raw_text) <> '';

  SELECT COUNT(*)::int INTO v_straggler_count
  FROM public.pending_session_admission a
  WHERE a.session_key = p_session_key
    AND a.session_generation = v_session.session_generation
    AND a.line_timestamp_ms <= v_session.close_event_timestamp_ms
    AND a.admitted_at > v_session.close_requested_at
    AND NOT EXISTS (
      SELECT 1
      FROM public.pending_session_ingest i
      WHERE i.session_generation = a.session_generation
        AND i.line_event_id = a.line_event_id
        AND i.raw_text IS NOT NULL
        AND btrim(i.raw_text) <> ''
    );

  -- Pre-0042 rows: accumulated_text already holds items but no admission ledger yet.
  IF v_admission_count = 0
     AND btrim(v_session.accumulated_text) <> ''
     AND (
       SELECT COUNT(*)::int
       FROM regexp_split_to_table(btrim(v_session.accumulated_text), E'\n') AS t(line)
       WHERE btrim(line) <> ''
     ) >= 3
  THEN
    RETURN jsonb_build_object(
      'ready',           true,
      'reason',          'legacy_accumulated',
      'admission_count', v_admission_count,
      'ingest_count',    v_ingest_count,
      'straggler_count', v_straggler_count,
      'session_generation', v_session.session_generation,
      'close_event_timestamp_ms', v_session.close_event_timestamp_ms
    );
  END IF;

  RETURN jsonb_build_object(
    'ready',           (v_admission_count = v_ingest_count AND v_straggler_count = 0 AND v_admission_count > 0),
    'reason',          CASE
                         WHEN v_admission_count = 0 THEN 'no_admissions'
                         WHEN v_admission_count <> v_ingest_count THEN 'awaiting_ingest'
                         WHEN v_straggler_count > 0 THEN 'stragglers'
                         ELSE 'ready'
                       END,
    'admission_count', v_admission_count,
    'ingest_count',    v_ingest_count,
    'straggler_count', v_straggler_count,
    'session_generation', v_session.session_generation,
    'close_event_timestamp_ms', v_session.close_event_timestamp_ms
  );
END;
$fn$;

-- 6) Post-conditions: prove the baseline was reproduced, not drifted ----------
DO $$
DECLARE
  v_secdef boolean;
  v_config text[];
  v_lang   text;
  v_vol    "char";
BEGIN
  SELECT p.prosecdef, p.proconfig, l.lanname, p.provolatile
    INTO v_secdef, v_config, v_lang, v_vol
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public.check_pending_close_ready(text)'::regprocedure;

  IF v_secdef THEN
    RAISE EXCEPTION '0048: check_pending_close_ready must remain SECURITY INVOKER';
  END IF;
  IF v_config IS NOT NULL THEN
    RAISE EXCEPTION
      '0048: check_pending_close_ready must keep proconfig NULL to match the captured baseline, found %', v_config;
  END IF;
  IF v_lang <> 'plpgsql' OR v_vol <> 'v' THEN
    RAISE EXCEPTION
      '0048: check_pending_close_ready language/volatility drift: %/%', v_lang, v_vol;
  END IF;

  SELECT p.prosecdef, p.proconfig, l.lanname, p.provolatile
    INTO v_secdef, v_config, v_lang, v_vol
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public.register_pending_session_ingest(text,text,bigint,text)'::regprocedure;

  IF v_secdef THEN
    RAISE EXCEPTION '0048: register_pending_session_ingest must remain SECURITY INVOKER';
  END IF;
  IF v_config IS NOT NULL THEN
    RAISE EXCEPTION
      '0048: register_pending_session_ingest must keep proconfig NULL to match the captured baseline, found %', v_config;
  END IF;
  IF v_lang <> 'plpgsql' OR v_vol <> 'v' THEN
    RAISE EXCEPTION
      '0048: register_pending_session_ingest language/volatility drift: %/%', v_lang, v_vol;
  END IF;
END $$;

-- 7) EXECUTE grants ----------------------------------------------------------
-- Production ACL for both functions, read from pg_proc.proacl, is exactly
--   {postgres=X/postgres, service_role=X/postgres}
-- i.e. owner + service_role only: anon and authenticated hold no EXECUTE, and
-- PUBLIC's implicit default grant has already been revoked. That matches the
-- runtime — every call site reaches these functions through the service-role
-- client (createServiceClient), never an anon/authenticated session.
-- Restating the grants keeps a freshly created function (which would otherwise
-- inherit the PUBLIC EXECUTE default) identical to the Production baseline.
-- Idempotent in effect: re-running never broadens access.

REVOKE ALL ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) TO service_role;

REVOKE ALL ON FUNCTION public.check_pending_close_ready(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_pending_close_ready(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pending_close_ready(text) TO service_role;

COMMENT ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) IS
  'SECURITY INVOKER. Baseline captured verbatim from Production by 0048 (no behavior change). '
  'Records a generation-scoped ingest row for a LINE event; no-op when the session is absent or raw text is NULL.';

COMMENT ON FUNCTION public.check_pending_close_ready(text) IS
  'SECURITY INVOKER. Baseline captured verbatim from Production by 0048 (no behavior change). '
  'Reports whether a closing pending session has admission/ingest parity. Retains the legacy_accumulated '
  'compatibility path for pre-0042 rows; the structured-session exclusion belongs to 0049, not here.';
