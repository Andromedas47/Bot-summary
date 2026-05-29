-- Idempotency guard for weigh sessions.
-- session_hash is computed from (date, staff, market, sorted items)
-- so re-submitting the same data is safely rejected.

CREATE TABLE imported_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash     text        NOT NULL UNIQUE,
  transaction_date date,
  staff_name       text        NOT NULL DEFAULT '',
  market_name      text        NOT NULL DEFAULT '',
  transaction_type text        NOT NULL DEFAULT '',
  raw_text         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX imported_sessions_date_idx  ON imported_sessions (transaction_date);
CREATE INDEX imported_sessions_staff_idx ON imported_sessions (staff_name);

ALTER TABLE imported_sessions ENABLE ROW LEVEL SECURITY;

-- Add item-level fingerprint for audit use (no unique constraint — natural
-- repeated items are valid; session_hash is the primary dedup guard).
ALTER TABLE produce_items
  ADD COLUMN IF NOT EXISTS item_hash text;

-- Fix: produce_transactions view must return '' (not NULL) for market_name
-- so daily_summaries aggregation queries match correctly.
DROP VIEW IF EXISTS public.produce_transactions;
CREATE VIEW public.produce_transactions AS
SELECT
  pi.id,
  pi.item_number,
  pi.product_name,
  pi.price_per_unit,
  pi.quantity,
  CASE
    WHEN pi.quantity IS NOT NULL AND pi.price_per_unit IS NOT NULL
    THEN pi.quantity * pi.price_per_unit
    ELSE NULL
  END                                   AS total_amount,
  pi.unit,
  pi.section,
  pi.transaction_type,
  pi.item_hash,
  pi.created_at                         AS item_created_at,
  ps.id                                 AS session_id,
  ps.session_date                       AS transaction_date,
  ps.transaction_time,
  COALESCE(ps.session_title, '')        AS market_name,
  ps.staff_name,
  ps.sender_name,
  ps.created_at                         AS session_created_at,
  ps.raw_message_id,
  rm.raw_text                           AS source_message
FROM  produce_items    pi
JOIN  produce_sessions ps ON ps.id = pi.session_id
LEFT JOIN raw_messages rm ON rm.id = ps.raw_message_id;

COMMENT ON VIEW public.produce_transactions IS
  'Primary operational view. Each row = one transaction (parsed product line). '
  'market_name is COALESCE(session_title, '''') so it is never NULL.';
