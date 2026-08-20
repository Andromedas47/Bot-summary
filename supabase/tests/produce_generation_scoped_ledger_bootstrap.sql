-- Disposable-DB bootstrap for the F-4 generation-scoped ledger ownership fix
-- (20260820110000_produce_generation_scoped_ledger.sql).
--
-- Reproduces, at minimum column fidelity, the LIVE production shape of the
-- three tables the migration touches (introspected read-only against
-- apjjsqibavjaitcedavn on 2026-08-20 — see PROD-EVIDENCE.md F-4):
--
--   pending_sessions           PRIMARY KEY (id); UNIQUE (session_key)
--                              session_generation uuid NOT NULL DEFAULT gen_random_uuid()
--   pending_session_ingest     PRIMARY KEY (session_generation, line_event_id)
--                              FOREIGN KEY (session_key) REFERENCES pending_sessions(session_key)
--                                ON DELETE CASCADE
--   pending_session_admission  PRIMARY KEY (session_generation, line_event_id)
--                              FOREIGN KEY (session_key) REFERENCES pending_sessions(session_key)
--                                ON DELETE CASCADE
--
-- pending_sessions holds exactly ONE row per session_key: session_generation is
-- mutated in place every time a generation rotates (open_pending_plain_text_generation,
-- PendingSessionService.replaceGeneration). It is NOT an append-only log of every
-- generation that ever existed — the ingest/admission tables are. This is the
-- root fact the migration's design depends on.
--
-- Disposable test databases only. Never run against Production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
  accumulated_text   text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pending_session_ingest (
  session_key        text NOT NULL REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE,
  session_generation uuid NOT NULL,
  line_event_id      text NOT NULL,
  line_timestamp_ms  bigint NOT NULL,
  raw_text           text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);
CREATE INDEX pending_session_ingest_session_key_idx
  ON public.pending_session_ingest (session_key, session_generation, line_timestamp_ms);

CREATE TABLE public.pending_session_admission (
  session_key        text NOT NULL REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE,
  session_generation uuid NOT NULL,
  line_event_id      text NOT NULL,
  line_timestamp_ms  bigint NOT NULL,
  admitted_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);
CREATE INDEX pending_session_admission_session_key_idx
  ON public.pending_session_admission (session_key, session_generation, line_timestamp_ms);

ALTER TABLE public.pending_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_session_ingest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_session_admission ENABLE ROW LEVEL SECURITY;
