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
  ADD COLUMN IF NOT EXISTS close_deadline_at     timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at       timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_at          timestamptz,
  ADD COLUMN IF NOT EXISTS finalization_status   text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS finalization_error    jsonb,
  ADD COLUMN IF NOT EXISTS runtime_environment   text;

ALTER TABLE public.produce_sessions
  ADD COLUMN IF NOT EXISTS voided_at timestamptz;

CREATE TABLE IF NOT EXISTS public.produce_transactions (
  accountability_round_id uuid NOT NULL REFERENCES public.accountability_rounds(id),
  base_transaction_type   text NOT NULL
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
