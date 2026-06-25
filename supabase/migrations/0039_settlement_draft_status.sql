-- Extend settlement_drafts lifecycle for the multi-message LINE intake flow.
--
--   pending          — draft opened, awaiting declared amounts
--   declared         — amounts recorded, awaiting user confirmation (ยืนยันส่งเงิน)
--   submitted        — user confirmed; submitted for reviewer
--   variance_found   — reconciliation found a transfer variance
--   ready_for_review — evidence reconciled, ready for reviewer
--   approved         — reviewer approved
--   needs_correction — reviewer flagged for correction

ALTER TABLE public.settlement_drafts
  DROP CONSTRAINT IF EXISTS settlement_drafts_status_check;

UPDATE public.settlement_drafts
SET    status = 'submitted'
WHERE  status = 'awaiting_evidence';

ALTER TABLE public.settlement_drafts
  ADD CONSTRAINT settlement_drafts_status_check
  CHECK (status IN (
    'pending', 'declared', 'submitted', 'variance_found',
    'ready_for_review', 'approved', 'needs_correction'
  ));
