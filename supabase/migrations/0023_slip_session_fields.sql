-- Migration 0023: slip session metadata fields
-- Adds session context columns to slip_batches, then enforces the invariant
-- that each LINE source may have at most one collecting batch at a time.

-- ── 1. Add session context columns ───────────────────────────────────────────
ALTER TABLE public.slip_batches
  ADD COLUMN header_text  text,
  ADD COLUMN seller_name  text,
  ADD COLUMN market_name  text,
  ADD COLUMN slip_date    text,
  ADD COLUMN batch_type   text NOT NULL DEFAULT 'TRANSFER_SLIPS',
  ADD COLUMN finalized_at timestamptz;

-- ── 2. Deduplicate existing collecting rows before creating the unique index ──
-- Keep the newest collecting batch per (source_type, source_id); mark older
-- duplicates as failed.  'failed' is a valid status per the existing CHECK
-- constraint: CHECK (status IN ('collecting','processing','completed',
--                               'review_needed','failed')).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(source_type, ''), source_id
           ORDER BY created_at DESC
         ) AS rn
  FROM   public.slip_batches
  WHERE  status = 'collecting'
)
UPDATE public.slip_batches
SET    status = 'failed'
WHERE  id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 3. Unique partial index ───────────────────────────────────────────────────
-- At most one collecting batch per LINE source.
-- COALESCE handles the edge case where source_type is NULL so that NULLs
-- are treated as equal (PostgreSQL NULLs are never equal in unique indexes).
CREATE UNIQUE INDEX slip_batches_open_source_idx
  ON public.slip_batches (COALESCE(source_type, ''), source_id)
  WHERE status = 'collecting';
