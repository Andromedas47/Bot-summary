-- Add market_label / market_key to manual_slip_sessions so that multiple
-- stalls in the same LINE group can have separate sessions on the same date.
-- Safe sequence: add nullable, backfill, NOT NULL, swap unique constraint.

ALTER TABLE public.manual_slip_sessions
  ADD COLUMN market_label  text,
  ADD COLUMN market_key    text NOT NULL DEFAULT 'default';

-- Existing rows get market_key = 'default' via the DEFAULT clause above.

-- Replace UNIQUE(source_id, business_date) with
-- UNIQUE(source_id, business_date, market_key) to allow multiple markets per date.
ALTER TABLE public.manual_slip_sessions
  DROP CONSTRAINT manual_slip_sessions_source_id_business_date_key;

ALTER TABLE public.manual_slip_sessions
  ADD CONSTRAINT manual_slip_sessions_source_id_business_date_market_key_key
  UNIQUE (source_id, business_date, market_key);
