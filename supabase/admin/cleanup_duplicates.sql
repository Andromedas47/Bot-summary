-- ─── Duplicate transaction cleanup ───────────────────────────────────────────
-- Run the SELECT first to review. Only delete after manual inspection.
-- Identity = (transaction_date, staff_name, market_name, transaction_type,
--             product_name, price_per_unit, quantity, unit).
-- Keep the row with the earliest created_at (first import).

-- STEP 1: Review duplicates
SELECT
  pi.id,
  ps.session_date        AS date,
  ps.staff_name,
  COALESCE(ps.session_title, '') AS market_name,
  pi.transaction_type,
  pi.product_name,
  pi.price_per_unit,
  pi.quantity,
  pi.unit,
  pi.created_at,
  ROW_NUMBER() OVER (
    PARTITION BY
      ps.session_date,
      ps.staff_name,
      COALESCE(ps.session_title, ''),
      pi.transaction_type,
      pi.product_name,
      pi.price_per_unit,
      pi.quantity,
      pi.unit
    ORDER BY pi.created_at ASC
  ) AS occurrence
FROM produce_items    pi
JOIN produce_sessions ps ON ps.id = pi.session_id
ORDER BY ps.session_date, ps.staff_name, pi.product_name, pi.created_at;

-- STEP 2: Delete rows where occurrence > 1 (keep first import only)
-- *** DO NOT RUN WITHOUT REVIEWING STEP 1 FIRST ***
/*
DELETE FROM produce_items
WHERE id IN (
  SELECT pi.id
  FROM produce_items pi
  JOIN produce_sessions ps ON ps.id = pi.session_id
  WHERE (
    SELECT COUNT(*)
    FROM produce_items pi2
    JOIN produce_sessions ps2 ON ps2.id = pi2.session_id
    WHERE ps2.session_date                    = ps.session_date
      AND ps2.staff_name                      = ps.staff_name
      AND COALESCE(ps2.session_title, '')     = COALESCE(ps.session_title, '')
      AND pi2.transaction_type                = pi.transaction_type
      AND pi2.product_name                    = pi.product_name
      AND pi2.price_per_unit                  = pi.price_per_unit
      AND pi2.quantity IS NOT DISTINCT FROM pi.quantity
      AND pi2.unit     IS NOT DISTINCT FROM pi.unit
      AND pi2.created_at                      < pi.created_at
  ) > 0
);
*/

-- STEP 3: Recalculate daily_summaries for affected dates after cleanup
-- Run DailySummaryService.recalculate() for each affected (date, staff, market)
-- or trigger via the application.
