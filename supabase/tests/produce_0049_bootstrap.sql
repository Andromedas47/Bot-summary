-- Disposable-DB bootstrap for the Produce 0049 structured-foundation harness.
-- Runs against an empty throwaway PostgreSQL container ONLY. It never connects
-- to, reads from, or resets Production.
--
-- The committed migration chain does not build cleanly (it fails at 0032
-- because the 0042-era pending-session baseline was applied out-of-band and is
-- absent from version control — see the header of 0031). This file supplies
-- exactly that missing baseline, transcribed from the live Production
-- information_schema, so that 0048 and 0049 can be applied verbatim on top of
-- it. It is a test fixture, not a migration, and is never applied to Production.

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

-- ── Pending-session baseline (0042-era, absent from version control) ─────────

CREATE TABLE IF NOT EXISTS public.pending_sessions (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key                  text NOT NULL UNIQUE,
  accumulated_text             text NOT NULL DEFAULT '',
  latest_reply_token           text,
  line_user_id                 text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  session_generation           uuid NOT NULL DEFAULT gen_random_uuid(),
  close_event_timestamp_ms     bigint,
  close_requested_at           timestamptz,
  close_line_event_id          text,
  close_finalize_started_at    timestamptz,
  source_id                    text,
  terminalized                 boolean NOT NULL DEFAULT false,
  next_attempt_at              timestamptz,
  close_deadline_at            timestamptz,
  close_session_generation     uuid,
  expected_item_count          integer,
  ingest_revision              integer NOT NULL DEFAULT 0,
  finalization_started_at      timestamptz,
  finalized_at                 timestamptz,
  finalization_status          text NOT NULL DEFAULT 'pending',
  finalization_error           jsonb,
  finalized_produce_session_id uuid,
  CONSTRAINT pending_sessions_finalization_status_check
    CHECK (finalization_status = ANY (ARRAY[
      'pending'::text, 'processing'::text, 'failed_closed'::text,
      'duplicate'::text, 'finalized'::text
    ]))
);

CREATE TABLE IF NOT EXISTS public.pending_session_ingest (
  session_key        text NOT NULL
    REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE,
  session_generation uuid NOT NULL,
  line_event_id      text NOT NULL,
  line_timestamp_ms  bigint NOT NULL,
  raw_text           text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);

CREATE TABLE IF NOT EXISTS public.pending_session_admission (
  session_key        text NOT NULL
    REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE,
  session_generation uuid NOT NULL,
  line_event_id      text NOT NULL,
  line_timestamp_ms  bigint NOT NULL,
  admitted_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);

-- ── Historical rows, created BEFORE 0049 ─────────────────────────────────────
-- Check 1 asserts these still read entry_origin IS NULL after 0049 applies.
-- The accumulated_text carries three non-blank lines so check 12 can prove the
-- legacy_accumulated escape hatch is still reachable for a legacy row.

INSERT INTO public.pending_sessions
  (session_key, source_id, line_user_id, accumulated_text)
VALUES
  ('dm:LEGACY1', 'LEGACY1', 'LEGACY1',
   E'พี่ดำ-วิหาร เบิก 10/6/2569\n1.แตงโม10บาท\n1โล'),
  ('dm:LEGACY2', 'LEGACY2', 'LEGACY2', '')
ON CONFLICT (session_key) DO NOTHING;
