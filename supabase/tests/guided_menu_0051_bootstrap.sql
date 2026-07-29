-- Disposable-DB bootstrap for migration 0051 Guided Menu harness ONLY.
-- Never connects to, reads from, or resets Production.

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
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Reproduce Production pg_default_acl behavior: new tables inherit broad
-- service_role privileges (including DELETE/TRUNCATE/REFERENCES/TRIGGER).
-- Migration 0051 must revoke these before granting SIU only.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES
  TO service_role;

-- Minimal pending_sessions stub so 0051 precondition passes.
CREATE TABLE IF NOT EXISTS public.pending_sessions (
  session_key text PRIMARY KEY
);
