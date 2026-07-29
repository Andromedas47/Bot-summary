-- Disposable-DB bootstrap for P2B migration 0052.
-- Does NOT touch Production. Run against an empty local database only.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
DECLARE
  v_pgcrypto_schema text;
BEGIN
  SELECT n.nspname
    INTO v_pgcrypto_schema
    FROM pg_extension AS e
    JOIN pg_namespace AS n ON n.oid = e.extnamespace
   WHERE e.extname = 'pgcrypto';

  IF v_pgcrypto_schema IS DISTINCT FROM 'extensions' THEN
    RAISE EXCEPTION 'pgcrypto must be installed in extensions, found %',
      coalesce(v_pgcrypto_schema, '<missing>');
  END IF;

  IF to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'extensions.digest(bytea,text) must exist';
  END IF;

  IF to_regprocedure('public.digest(bytea,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'public.digest(bytea,text) must be absent';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE service_role WITH BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Minimal stub so 0052 FK to raw_messages(id) resolves.
CREATE TABLE IF NOT EXISTS public.raw_messages (
  id uuid PRIMARY KEY
);
