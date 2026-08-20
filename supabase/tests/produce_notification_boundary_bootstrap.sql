-- Disposable-DB bootstrap for the produce notification boundary lockdown
-- migration (20260820090000). Does NOT touch Production. Run against an
-- empty local database only.
--
-- Creates only the roles and the two upstream tables that 0034 ALTERs /
-- references (pending_sessions, produce_sessions) — just enough for 0034 to
-- apply cleanly. plpgsql function bodies are not semantically validated at
-- CREATE time, so 0034's try_finalize_pending_generation can reference
-- imported_sessions/raw_messages/produce_items without those tables existing
-- here; this test never calls that function.
--
-- CRITICAL: this bootstrap must reproduce the actual vulnerable starting
-- state, not just the roles. Production's P0 exists because of a
-- project-level `ALTER DEFAULT PRIVILEGES` that grants anon/authenticated
-- (and service_role) full privileges on every table and function role
-- `postgres` subsequently creates in schema public (proven via
-- pg_default_acl introspection — see the lockdown migration's header). If
-- this bootstrap does not set the same default privileges BEFORE 0034 runs,
-- the tables/functions 0034 creates come out clean by pure accident of a
-- fresh local database's own (non-Supabase) defaults, and the lockdown
-- migration's pg test would pass even if the migration were a no-op — it
-- would never reproduce the bug it exists to catch. This must run before
-- ANY table or function is created by role postgres in schema public.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

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

-- Reproduce production's project-level default ACL. Anything role postgres
-- creates in schema public from this point on — including everything 0034
-- creates — is born with full anon/authenticated/service_role privileges,
-- exactly as pg_default_acl shows in production. This is the actual
-- vulnerable starting state the lockdown migration has to fix.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.pending_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key        text NOT NULL UNIQUE,
  session_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  terminalized       boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.produce_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date date,
  staff_name   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
