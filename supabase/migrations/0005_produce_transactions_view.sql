-- produce_transactions: primary operational view for the frontend.
-- Each row = one transaction (one parsed product line from a LINE message).
--
-- Architecture intent:
--   produce_items     → source rows (written by parser, keep forever)
--   produce_sessions  → grouping metadata (one LINE message = one session)
--   raw_messages      → debugging/audit only
--   produce_transactions → this view, the primary operational entity

CREATE OR REPLACE VIEW public.produce_transactions AS
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
  END                     AS total_amount,
  pi.unit,
  pi.section,
  pi.created_at           AS item_created_at,
  ps.id                   AS session_id,
  ps.session_date         AS transaction_date,
  ps.session_title        AS market_name,
  ps.staff_name,
  ps.created_at           AS session_created_at,
  ps.raw_message_id,
  rm.raw_text             AS source_message
FROM  produce_items   pi
JOIN  produce_sessions ps ON ps.id = pi.session_id
LEFT JOIN raw_messages rm ON rm.id = ps.raw_message_id;

COMMENT ON VIEW public.produce_transactions IS
  'Primary operational view. Each row = one transaction (parsed product line). '
  'Joins produce_items + produce_sessions; raw_messages for debugging only.';
