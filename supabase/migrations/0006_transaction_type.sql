-- Add transaction_type to produce_items.
-- Values: เบิก | เบิกเพิ่ม | คืน | คืนเสีย
ALTER TABLE produce_items
  ADD COLUMN transaction_type TEXT NOT NULL DEFAULT 'เบิก';

-- Add sender_name (LINE sender from TIME_PREFIX) and transaction_time
-- to produce_sessions.  Previously staff_name doubled as both; now they're split.
ALTER TABLE produce_sessions
  ADD COLUMN sender_name     TEXT,
  ADD COLUMN transaction_time TEXT;

-- Refresh VIEW to expose the new fields.
-- Must DROP first because PostgreSQL forbids inserting columns into an
-- existing view definition (existing column positions cannot change).
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
  END                       AS total_amount,
  pi.unit,
  pi.section,
  pi.transaction_type,
  pi.created_at             AS item_created_at,
  ps.id                     AS session_id,
  ps.session_date           AS transaction_date,
  ps.transaction_time,
  ps.session_title          AS market_name,
  ps.staff_name,
  ps.sender_name,
  ps.created_at             AS session_created_at,
  ps.raw_message_id,
  rm.raw_text               AS source_message
FROM  produce_items    pi
JOIN  produce_sessions ps ON ps.id = pi.session_id
LEFT JOIN raw_messages rm ON rm.id = ps.raw_message_id;

COMMENT ON VIEW public.produce_transactions IS
  'Primary operational view. Each row = one transaction (parsed product line). '
  'Joins produce_items + produce_sessions; raw_messages for debugging only.';
