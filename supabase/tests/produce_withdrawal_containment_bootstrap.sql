-- Adapter fixture: the reviewed market identity layer, on top of the
-- fingerprint compatibility bootstrap.
--
-- The withdrawal containment guard lives inside try_finalize_pending_generation
-- and compares business identity with `accountability_round_same_market`, so the
-- finalizer's isolated test database now needs the market identity functions
-- too. Rather than restate them here — which would drift — this fixture supplies
-- only what migration 20260811090000 and 20260815160000 need in order to be
-- applied, and those migrations supply the real definitions.
--
-- Apply order: produce_fingerprint_compatibility_bootstrap.sql, 0061, THIS,
-- 20260811090000, 20260815160000, 20260815150000, 20260817090100.
--
-- Disposable test databases only. Never run against Production.

-- Reviewed market catalog (0055). Alias rows are human-reviewed mappings.
CREATE TABLE public.line_guided_menu_markets (
  market_code text PRIMARY KEY,
  label       text NOT NULL,
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE public.line_guided_menu_market_aliases (
  alias_label text PRIMARY KEY,
  market_code text NOT NULL REFERENCES public.line_guided_menu_markets (market_code),
  active      boolean NOT NULL DEFAULT true
);

-- Verbatim from 20260808105001, because the identity functions compare against it.
CREATE OR REPLACE FUNCTION public.accountability_round_normalize(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT btrim(normalize(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g'), NFC))
$$;

-- The round tables exist because plpgsql resolves %ROWTYPE at COMPILE time: the
-- real `bind_plain_text_accountability_round` those two migrations install would
-- not even be creatable without them. Nothing in the containment tests reads or
-- writes these.
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
  closed_at               timestamptz
);

CREATE TABLE public.produce_transactions (
  accountability_round_id uuid NOT NULL REFERENCES public.accountability_rounds(id),
  base_transaction_type   text NOT NULL
);

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);

ALTER TABLE public.produce_sessions
  ADD COLUMN IF NOT EXISTS accountability_round_id uuid
    REFERENCES public.accountability_rounds(id),
  ADD COLUMN IF NOT EXISTS voided_at timestamptz;

-- Only the shape matters. 20260811090000 and 20260815160000 both preflight on
-- this signature existing, and both then CREATE OR REPLACE it with the real
-- body.
CREATE OR REPLACE FUNCTION public.bind_plain_text_accountability_round(
  p_session_key             text,
  p_session_generation      uuid,
  p_source_type             text,
  p_source_id               text,
  p_line_user_id            text,
  p_business_date           date,
  p_seller_label            text,
  p_market_label            text,
  p_market_label_normalized text,
  p_is_new_round            boolean
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'round binding is out of scope for the containment fixture';
END;
$$;
