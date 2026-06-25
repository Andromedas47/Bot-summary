-- Align work_rounds.status with the V2 review-queue status set.
-- Replaces 'awaiting_evidence' (from 0032) with 'awaiting_slips'.
--
-- Final status set:
--   open | produce_complete | awaiting_settlement | awaiting_slips
--   variance_found | ready_for_review | approved | needs_correction

ALTER TABLE public.work_rounds
  DROP CONSTRAINT IF EXISTS work_rounds_status_check;

UPDATE public.work_rounds
SET    status = 'awaiting_slips'
WHERE  status = 'awaiting_evidence';

ALTER TABLE public.work_rounds
  ADD CONSTRAINT work_rounds_status_check
  CHECK (status IN (
    'open', 'produce_complete', 'awaiting_settlement', 'awaiting_slips',
    'variance_found', 'ready_for_review', 'approved', 'needs_correction'
  ));
