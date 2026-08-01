-- Disposable-DB bootstrap for migration 0059 (manual_white_sheet_note_sessions
-- + close_manual_white_sheet_note_session). Does NOT touch Production. Run
-- against an empty local database only.
--
-- close_manual_white_sheet_note_session writes into
-- digital_white_sheet_cash_entries, so this harness also applies 0038/0043/
-- 0045 (the migrations that create that table and its FINALIZED lifecycle)
-- ahead of 0059 — see migration-0059.pg.test.ts.

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
