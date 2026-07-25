-- 0044: reconcile pending-close Production baseline (assert + ACL only).
--
-- Production already contains the generation-scoped pending-close baseline
-- (pending_session_ingest / pending_session_admission, pending_sessions
-- Release-A/Release-B columns, and the application-compatible RPC overloads).
-- That baseline was applied historically out-of-band and is not truthfully
-- represented by migration metadata. Migrations 0031 and 0032 assume it.
--
-- WHY historical backup 0042 is NOT replayed here
-- -----------------------------------------------
-- The danger is not that CREATE TABLE IF NOT EXISTS would necessarily delete
-- the existing rows. The danger is that replaying the historical file may
-- restore/replace OLD function definitions or otherwise regress later
-- Release-A/Release-B behavior, and it would misrepresent how Production
-- reached its current state.
--
-- 0042 remains RESERVED. This migration:
--   1) asserts material schema shape (types/nullability/defaults/PK/FK)
--   2) asserts required RPC signatures (+ return types where contracted)
--   3) normalizes EXECUTE grants to service_role only
--
-- No ledger rows are mutated. No supabase_migrations history is fabricated.
-- Fail closed on incompatible drift — never auto-repair destructive mismatch.
--
-- Shape sources (do not guess):
--   origin/backup/main-before-legacy:supabase/migrations/0042_pending_close_ingest.sql
--   supabase/migrations/0031_pending_session_sender_identity.sql
--   supabase/migrations/0032_pending_session_finalization_barrier.sql
--   supabase/migrations/0009_pending_sessions.sql (base table)

DO $$
BEGIN
  -- ── helpers (local to this DO block) ─────────────────────────────────────

  -- Normalize pg_get_expr / information_schema defaults for comparison.
  -- Strips schema qualifiers and cast suffixes; collapses whitespace.
  CREATE OR REPLACE FUNCTION pg_temp.norm_default(p text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  AS $f$
    SELECT NULLIF(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(btrim(COALESCE(p, ''))), '[[:space:]]+', ' ', 'g'),
          '([a-z_][a-z0-9_]*\.)+',
          '',
          'g'
        ),
        '::[a-z_][a-z0-9_ %()]*',
        '',
        'g'
      ),
      ''
    );
  $f$;

  CREATE OR REPLACE FUNCTION pg_temp.assert_table(p_schema text, p_table text)
  RETURNS void
  LANGUAGE plpgsql
  AS $f$
  BEGIN
    IF to_regclass(format('%I.%I', p_schema, p_table)) IS NULL THEN
      RAISE EXCEPTION '0044: required table %.% is missing', p_schema, p_table;
    END IF;
  END;
  $f$;

  -- Assert column exists with exact format_type, nullability, and default class.
  -- p_default_kind:
  --   'none'              → no default expression
  --   'gen_random_uuid'   → default involves gen_random_uuid()
  --   'now'               → default involves now()/current_timestamp
  --   'false'             → boolean false
  --   'zero'              → integer 0
  --   'empty_text'        → empty string
  CREATE OR REPLACE FUNCTION pg_temp.assert_column(
    p_table text,
    p_column text,
    p_format_type text,
    p_not_null boolean,
    p_default_kind text
  ) RETURNS void
  LANGUAGE plpgsql
  AS $f$
  DECLARE
    v_fmt text;
    v_not_null boolean;
    v_def text;
    v_norm text;
  BEGIN
    SELECT
      pg_catalog.format_type(a.atttypid, a.atttypmod),
      a.attnotnull,
      pg_get_expr(ad.adbin, ad.adrelid)
    INTO v_fmt, v_not_null, v_def
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef ad
      ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relname = p_table
      AND a.attname = p_column
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF NOT FOUND THEN
      RAISE EXCEPTION '0044: %.% is missing', p_table, p_column;
    END IF;

    IF v_fmt IS DISTINCT FROM p_format_type THEN
      RAISE EXCEPTION
        '0044: %.% type mismatch: expected %, found %',
        p_table, p_column, p_format_type, v_fmt;
    END IF;

    IF v_not_null IS DISTINCT FROM p_not_null THEN
      RAISE EXCEPTION
        '0044: %.% nullability mismatch: expected NOT NULL=%, found %',
        p_table, p_column, p_not_null, v_not_null;
    END IF;

    v_norm := pg_temp.norm_default(v_def);

    IF p_default_kind = 'none' THEN
      IF v_norm IS NOT NULL THEN
        RAISE EXCEPTION
          '0044: %.% unexpected default: %', p_table, p_column, v_def;
      END IF;
    ELSIF p_default_kind = 'gen_random_uuid' THEN
      IF v_norm IS NULL OR position('gen_random_uuid()' IN v_norm) = 0 THEN
        RAISE EXCEPTION
          '0044: %.% expected gen_random_uuid() default, found %',
          p_table, p_column, v_def;
      END IF;
    ELSIF p_default_kind = 'now' THEN
      IF v_norm IS NULL
         OR (
           position('now()' IN v_norm) = 0
           AND position('current_timestamp' IN v_norm) = 0
         ) THEN
        RAISE EXCEPTION
          '0044: %.% expected now()/current_timestamp default, found %',
          p_table, p_column, v_def;
      END IF;
    ELSIF p_default_kind = 'false' THEN
      IF v_norm IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION
          '0044: %.% expected false default, found %', p_table, p_column, v_def;
      END IF;
    ELSIF p_default_kind = 'zero' THEN
      IF v_norm IS DISTINCT FROM '0' THEN
        RAISE EXCEPTION
          '0044: %.% expected 0 default, found %', p_table, p_column, v_def;
      END IF;
    ELSIF p_default_kind = 'empty_text' THEN
      -- pg_get_expr renders empty-string defaults as '' (two quote chars).
      IF v_norm IS DISTINCT FROM '''''' THEN
        RAISE EXCEPTION
          '0044: %.% expected empty-string default, found %',
          p_table, p_column, v_def;
      END IF;
    ELSE
      RAISE EXCEPTION '0044: unknown default kind %', p_default_kind;
    END IF;
  END;
  $f$;

  CREATE OR REPLACE FUNCTION pg_temp.assert_pk_columns(
    p_table text,
    p_expected text[]
  ) RETURNS void
  LANGUAGE plpgsql
  AS $f$
  DECLARE
    v_actual text[];
  BEGIN
    SELECT coalesce(array_agg(a.attname ORDER BY k.ord), ARRAY[]::text[])
    INTO v_actual
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE n.nspname = 'public'
      AND c.relname = p_table
      AND i.indisprimary;

    IF v_actual IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION
        '0044: %. primary key columns/order mismatch: expected %, found %',
        p_table, p_expected, v_actual;
    END IF;
  END;
  $f$;

  CREATE OR REPLACE FUNCTION pg_temp.assert_fk_session_key(p_table text)
  RETURNS void
  LANGUAGE plpgsql
  AS $f$
  DECLARE
    v_ok boolean := false;
    r record;
  BEGIN
    FOR r IN
      SELECT pg_get_constraintdef(con.oid) AS def
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = p_table
        AND con.contype = 'f'
    LOOP
      IF r.def ~* 'FOREIGN KEY \(session_key\) REFERENCES (public\.)?pending_sessions\(session_key\).*ON DELETE CASCADE'
      THEN
        v_ok := true;
        EXIT;
      END IF;
    END LOOP;

    IF NOT v_ok THEN
      RAISE EXCEPTION
        '0044: %. missing FK session_key -> pending_sessions(session_key) ON DELETE CASCADE',
        p_table;
    END IF;
  END;
  $f$;

  CREATE OR REPLACE FUNCTION pg_temp.assert_function(
    p_identity text,
    p_expected_result text
  ) RETURNS void
  LANGUAGE plpgsql
  AS $f$
  DECLARE
    v_oid regprocedure;
    v_result text;
    v_exp text;
    v_got text;
  BEGIN
    BEGIN
      v_oid := ('public.' || p_identity)::regprocedure;
    EXCEPTION WHEN undefined_function THEN
      RAISE EXCEPTION '0044: required function public.% is missing', p_identity;
    END;

    v_result := pg_get_function_result(v_oid);
    v_exp := lower(regexp_replace(p_expected_result, 'public\.', '', 'gi'));
    v_got := lower(regexp_replace(v_result, 'public\.', '', 'gi'));
    IF v_got IS DISTINCT FROM v_exp THEN
      RAISE EXCEPTION
        '0044: public.% return type mismatch: expected %, found %',
        p_identity, p_expected_result, v_result;
    END IF;
  END;
  $f$;

  -- ── 1) pending_sessions material shape ───────────────────────────────────
  PERFORM pg_temp.assert_table('public', 'pending_sessions');

  -- Base (0009)
  PERFORM pg_temp.assert_column('pending_sessions', 'id', 'uuid', true, 'gen_random_uuid');
  PERFORM pg_temp.assert_column('pending_sessions', 'session_key', 'text', true, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'accumulated_text', 'text', true, 'empty_text');
  PERFORM pg_temp.assert_column('pending_sessions', 'latest_reply_token', 'text', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'line_user_id', 'text', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'created_at', 'timestamp with time zone', true, 'now');
  PERFORM pg_temp.assert_column('pending_sessions', 'updated_at', 'timestamp with time zone', true, 'now');

  -- Baseline close/generation columns (historical 0042)
  PERFORM pg_temp.assert_column('pending_sessions', 'session_generation', 'uuid', true, 'gen_random_uuid');
  PERFORM pg_temp.assert_column('pending_sessions', 'close_event_timestamp_ms', 'bigint', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'close_requested_at', 'timestamp with time zone', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'close_line_event_id', 'text', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'close_finalize_started_at', 'timestamp with time zone', false, 'none');

  -- Release A (0031)
  PERFORM pg_temp.assert_column('pending_sessions', 'source_id', 'text', false, 'none');

  -- Release B (0032)
  PERFORM pg_temp.assert_column('pending_sessions', 'terminalized', 'boolean', true, 'false');
  PERFORM pg_temp.assert_column('pending_sessions', 'next_attempt_at', 'timestamp with time zone', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'close_deadline_at', 'timestamp with time zone', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'close_session_generation', 'uuid', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'expected_item_count', 'integer', false, 'none');
  PERFORM pg_temp.assert_column('pending_sessions', 'ingest_revision', 'integer', true, 'zero');

  -- session_key must remain UNIQUE (FK target for ledger tables).
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'pending_sessions'
      AND con.contype IN ('u', 'p')
      AND pg_get_constraintdef(con.oid) ~* '\(session_key\)'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'pending_sessions'
      AND i.indisunique
      AND pg_get_indexdef(i.indexrelid) ~* '\(session_key\)'
  ) THEN
    RAISE EXCEPTION '0044: pending_sessions.session_key is not UNIQUE';
  END IF;

  -- ── 2) ledger tables ─────────────────────────────────────────────────────
  PERFORM pg_temp.assert_table('public', 'pending_session_ingest');
  PERFORM pg_temp.assert_column('pending_session_ingest', 'session_key', 'text', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_ingest', 'session_generation', 'uuid', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_ingest', 'line_event_id', 'text', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_ingest', 'line_timestamp_ms', 'bigint', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_ingest', 'raw_text', 'text', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_ingest', 'created_at', 'timestamp with time zone', true, 'now');
  PERFORM pg_temp.assert_pk_columns(
    'pending_session_ingest',
    ARRAY['session_generation', 'line_event_id']::text[]
  );
  PERFORM pg_temp.assert_fk_session_key('pending_session_ingest');

  PERFORM pg_temp.assert_table('public', 'pending_session_admission');
  PERFORM pg_temp.assert_column('pending_session_admission', 'session_key', 'text', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_admission', 'session_generation', 'uuid', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_admission', 'line_event_id', 'text', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_admission', 'line_timestamp_ms', 'bigint', true, 'none');
  PERFORM pg_temp.assert_column('pending_session_admission', 'admitted_at', 'timestamp with time zone', true, 'now');
  PERFORM pg_temp.assert_pk_columns(
    'pending_session_admission',
    ARRAY['session_generation', 'line_event_id']::text[]
  );
  PERFORM pg_temp.assert_fk_session_key('pending_session_admission');

  -- ── 3) RPC signatures + contracted return types ──────────────────────────
  -- Final application-compatible overloads (0031 + 0032 + historical baseline).
  PERFORM pg_temp.assert_function(
    'admit_pending_session_event(text,text,bigint)',
    'void'
  );
  PERFORM pg_temp.assert_function(
    'admit_pending_session_event(text,text,bigint,uuid)',
    'boolean'
  );

  PERFORM pg_temp.assert_function(
    'append_pending_session(text,text,text,text,bigint,boolean)',
    'SETOF pending_sessions'
  );
  PERFORM pg_temp.assert_function(
    'append_pending_session(text,text,text,text,bigint,boolean,uuid)',
    'SETOF pending_sessions'
  );
  PERFORM pg_temp.assert_function(
    'append_pending_session(text,text,text,text,bigint,boolean,uuid,integer)',
    'jsonb'
  );

  PERFORM pg_temp.assert_function(
    'claim_pending_close_finalize(text)',
    'jsonb'
  );
  PERFORM pg_temp.assert_function(
    'claim_pending_close_finalize(text,uuid)',
    'jsonb'
  );

  PERFORM pg_temp.assert_function(
    'try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb)',
    'jsonb'
  );

  PERFORM pg_temp.assert_function(
    'register_pending_session_ingest(text,text,bigint,text)',
    'void'
  );

  PERFORM pg_temp.assert_function(
    'check_pending_close_ready(text)',
    'jsonb'
  );
END $$;

-- ── 4) ACL normalization (service_role only) ────────────────────────────────
-- Idempotent: re-running these REVOKEs/GRANTs is safe and never broadens access.
-- Assertions above run first in the same migration transaction, so a failed
-- assertion rolls back any later grant changes as well.

REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_pending_session_event(text, text, bigint) TO service_role;

REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_close_finalize(text) TO service_role;

REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_close_finalize(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.try_finalize_pending_generation(text, uuid, text, integer, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_finalize_pending_generation(text, uuid, text, integer, text, text, jsonb, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_finalize_pending_generation(text, uuid, text, integer, text, text, jsonb, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) TO service_role;

REVOKE ALL ON FUNCTION public.check_pending_close_ready(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_pending_close_ready(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pending_close_ready(text) TO service_role;
