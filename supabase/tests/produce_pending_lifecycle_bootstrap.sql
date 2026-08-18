-- Adapter fixture: the pending-generation lifecycle columns, on top of the
-- round market identity bootstrap.
--
-- Supersession and close recovery both act on `pending_sessions` rows and on the
-- accountability round those rows own, so the fixture needs BOTH schemas. The
-- round bootstrap already supplies accountability_rounds (with its write-once
-- update guard, which these functions must work WITH, never around) and the
-- minimal pending/produce tables; this file adds only the lifecycle columns the
-- two migrations read and write.
--
-- Apply order: round_market_identity_bootstrap.sql, THIS, 20260817090200.
--
-- Disposable test databases only. Never run against Production.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS updated_at            timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS close_event_timestamp_ms bigint,
  ADD COLUMN IF NOT EXISTS close_requested_at    timestamptz,
  ADD COLUMN IF NOT EXISTS close_finalize_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS close_deadline_at     timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at       timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_at          timestamptz,
  ADD COLUMN IF NOT EXISTS finalization_status   text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS finalization_error    jsonb,
  ADD COLUMN IF NOT EXISTS runtime_environment   text,
  ADD COLUMN IF NOT EXISTS entry_origin          text,
  ADD COLUMN IF NOT EXISTS opened_line_event_id  text,
  ADD COLUMN IF NOT EXISTS plain_text_opened_line_event_id text,
  ADD COLUMN IF NOT EXISTS plain_text_opened_line_timestamp_ms bigint;

-- Production truth: migration 0031 added source_id as NULLABLE with no backfill,
-- so pre-rollout rows legitimately carry NULL. The base fixture declares it NOT
-- NULL, which would make a legacy row unrepresentable and quietly hide every
-- guard that has to cope with one.
ALTER TABLE public.pending_sessions
  ALTER COLUMN source_id DROP NOT NULL;

ALTER TABLE public.produce_sessions
  ADD COLUMN IF NOT EXISTS voided_at timestamptz;

CREATE TABLE IF NOT EXISTS public.produce_transactions (
  accountability_round_id uuid NOT NULL REFERENCES public.accountability_rounds(id),
  base_transaction_type   text NOT NULL
);

-- The cancellation boundary reads the opener's verbatim LINE timestamp. The
-- production raw_messages table is much wider; this fixture needs only the two
-- columns that the function reads.
CREATE TABLE IF NOT EXISTS public.raw_messages (
  line_event_id text PRIMARY KEY,
  payload       jsonb NOT NULL
);

-- Adversarial cancellation tests seed an out-of-order admission item here to
-- prove the cancel primitive never treats an admission MIN as opener evidence.
CREATE TABLE IF NOT EXISTS public.pending_session_admission (
  session_key       text NOT NULL,
  session_generation uuid NOT NULL,
  line_event_id     text NOT NULL,
  line_timestamp_ms bigint NOT NULL,
  admitted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);

-- The narrow duplicate-round helper migration 20260817090200 preflights on.
-- Its own body is out of scope here; only its presence is required.
CREATE OR REPLACE FUNCTION public.cancel_duplicate_plain_text_round(
  p_session_key        text,
  p_session_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'duplicate round cancellation is out of scope for this fixture';
END;
$$;
