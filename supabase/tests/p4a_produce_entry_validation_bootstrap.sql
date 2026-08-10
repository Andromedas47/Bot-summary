-- Disposable-DB bootstrap for the P4A produce entry validation gate migration.
-- Does NOT touch Production. Run against an empty local database only.
--
-- The P4A migration asserts four tables exist and takes exactly one FK, to
-- accountability_rounds(id). Only that column shape has to be faithful; the
-- other three tables are modelled with the columns P4A's preflight looks for
-- and nothing else, so this harness proves the migration against a realistic
-- current schema without dragging in the whole produce history.

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

-- P2E identity, in the shape 20260808105001 creates it.
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
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pending_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key             text NOT NULL,
  session_generation      bigint NOT NULL DEFAULT 1,
  line_user_id            text,
  accumulated_text        text NOT NULL DEFAULT '',
  accountability_round_id uuid REFERENCES public.accountability_rounds(id),
  finalization_status     text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.produce_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date            date,
  staff_name              text,
  sender_name             text,
  line_user_id            text,
  accountability_round_id uuid REFERENCES public.accountability_rounds(id),
  voided_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.produce_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES public.produce_sessions(id) ON DELETE CASCADE,
  item_number      integer,
  product_name     text NOT NULL,
  price_per_unit   numeric(10,2),
  quantity         numeric(10,3),
  unit             text,
  transaction_type text NOT NULL DEFAULT 'เบิก',
  created_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.accountability_rounds (
  id, source_type, source_id, owner_line_user_id, business_date,
  seller_label, market_label, market_label_normalized, created_line_event_id
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'group', 'G-round', 'U-owner', DATE '2026-08-09',
  'กี้', 'วัดทุ่งลานนา', 'วัดทุ่งลานนา', 'evt-round-open'
);
