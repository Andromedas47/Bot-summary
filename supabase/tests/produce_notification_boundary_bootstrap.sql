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
