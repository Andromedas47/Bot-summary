-- Disposable-DB bootstrap for the P4A plain-text round binding migration.
-- Does NOT touch Production. Run against an empty local database only.
--
-- Only what 20260810120000 actually reads has to be faithful: the P2E
-- accountability_rounds shape (including its status CHECK and the UNIQUE
-- created_line_event_id that makes creation idempotent), the normalizer, and
-- pending_sessions with a uuid session_generation. produce_sessions is present
-- only so a test can prove that binding writes no produce rows.

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

CREATE TABLE public.accountability_rounds (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type             text NOT NULL CHECK (source_type IN ('user', 'group', 'room')),
  source_id               text NOT NULL,
  owner_line_user_id      text NOT NULL,
  business_date           date NOT NULL,
  seller_label            text NOT NULL,
  market_label            text NOT NULL,
  market_label_normalized text NOT NULL,
  status                  text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'cancelled')),
  created_line_event_id   text NOT NULL UNIQUE,
  closed_line_event_id    text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz
);

CREATE TABLE public.pending_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key             text NOT NULL UNIQUE,
  session_generation      uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id               text NOT NULL,
  line_user_id            text,
  accumulated_text        text NOT NULL DEFAULT '',
  accountability_round_id uuid REFERENCES public.accountability_rounds(id),
  terminalized            boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.produce_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date            date,
  staff_name              text,
  accountability_round_id uuid REFERENCES public.accountability_rounds(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Verbatim from 20260808105001, because the binding RPC compares against it.
CREATE OR REPLACE FUNCTION public.accountability_round_normalize(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT btrim(normalize(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g'), NFC))
$$;
