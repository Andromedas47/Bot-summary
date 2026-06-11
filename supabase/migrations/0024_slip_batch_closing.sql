-- Migration 0024: graceful slip batch closing
--
-- Adds a 'closing' intermediate state so "จบสลิป" can immediately acknowledge
-- the user while late-arriving images and in-flight OCR finish in the background.
--
-- New lifecycle:
--   collecting → closing    ("จบสลิป" received; bot replies with ack immediately)
--   closing    → processing  (cron: quiet period elapsed AND all checks terminal,
--                              or max timeout reached)
--   processing → completed / review_needed / failed  (unchanged)

-- 1. Widen the status check constraint to permit 'closing'.
ALTER TABLE public.slip_batches
  DROP CONSTRAINT slip_batches_status_check,
  ADD CONSTRAINT slip_batches_status_check
    CHECK (status IN ('collecting', 'closing', 'processing', 'completed', 'review_needed', 'failed'));

-- 2. Record when the user sent "จบสลิป" (used for max-timeout calculation).
ALTER TABLE public.slip_batches
  ADD COLUMN closing_at timestamptz;

-- 3. Allow images to be attached while the batch is closing.
--    Replaces the function from migration 0021.  Updating last_image_at for a
--    closing batch resets the quiet-period window so the finalizer waits longer.
--    The UPDATE acquires a row-level lock, which serializes against the
--    claim_closing_slip_batch SELECT … FOR UPDATE on the same row.
CREATE OR REPLACE FUNCTION public.attach_evidence_to_slip_batch(
  p_batch_id    uuid,
  p_evidence_id uuid
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_index integer;
BEGIN
  UPDATE public.slip_batches
  SET image_count   = image_count + 1,
      last_image_at = now()
  WHERE id = p_batch_id AND status IN ('collecting', 'closing')
  RETURNING image_count INTO v_batch_index;

  IF v_batch_index IS NULL THEN
    RAISE EXCEPTION 'slip_batch % not found or not in collecting/closing status', p_batch_id;
  END IF;

  UPDATE public.slip_evidences
  SET batch_id    = p_batch_id,
      batch_index = v_batch_index
  WHERE id = p_evidence_id;

  RETURN v_batch_index;
END;
$$;

-- 4. Atomic claim for the closing finalizer.
--
--    Locks the batch row first, then re-evaluates all readiness conditions while
--    holding the lock.  Because attach_evidence_to_slip_batch also issues an UPDATE
--    on the same row (which acquires the same row-level lock), the two operations
--    are serialized by PostgreSQL:
--
--      • If attach wins: last_image_at is refreshed before we evaluate the quiet
--        window → we correctly see that the quiet period has not yet elapsed and
--        return no rows (batch not claimed).
--      • If claim wins: we transition status to 'processing' first; the attach's
--        WHERE status IN ('collecting','closing') predicate then fails and raises
--        an exception → the late image is correctly rejected.
--
--    Returns one row when the batch was claimed, zero rows otherwise.
CREATE OR REPLACE FUNCTION public.claim_closing_slip_batch(
  p_batch_id       uuid,
  p_quiet_seconds  integer,
  p_max_seconds    integer
) RETURNS TABLE(claimed_id uuid, claimed_source_id text, was_timeout boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch     public.slip_batches%ROWTYPE;
  v_now       timestamptz := now();
  v_timed_out boolean;
  v_quiet_ok  boolean;
  v_ev_count  bigint;
  v_ck_count  bigint;
  v_pr_count  bigint;
BEGIN
  -- Lock the batch row; serializes against attach_evidence_to_slip_batch.
  SELECT * INTO v_batch
  FROM   public.slip_batches
  WHERE  id = p_batch_id AND status = 'closing'
  FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  v_timed_out := v_now - COALESCE(v_batch.closing_at, v_batch.last_image_at)
                   >= make_interval(secs => p_max_seconds);
  v_quiet_ok  := v_now - v_batch.last_image_at
                   >= make_interval(secs => p_quiet_seconds);

  IF NOT v_timed_out AND NOT v_quiet_ok THEN RETURN; END IF;

  -- If not timed out, also require all checks to be terminal.
  IF NOT v_timed_out THEN
    SELECT COUNT(*) INTO v_ev_count
    FROM   public.slip_evidences
    WHERE  batch_id = p_batch_id;

    IF v_ev_count > 0 THEN
      SELECT COUNT(*) INTO v_ck_count
      FROM   public.slip_checks sc
      JOIN   public.slip_evidences se ON sc.evidence_id = se.id
      WHERE  se.batch_id = p_batch_id;

      IF v_ck_count < v_ev_count THEN RETURN; END IF;

      SELECT COUNT(*) INTO v_pr_count
      FROM   public.slip_checks sc
      JOIN   public.slip_evidences se ON sc.evidence_id = se.id
      WHERE  se.batch_id = p_batch_id AND sc.status = 'PROCESSING';

      IF v_pr_count > 0 THEN RETURN; END IF;
    END IF;
  END IF;

  -- All conditions satisfied — atomically claim the batch.
  UPDATE public.slip_batches
  SET    status = 'processing'
  WHERE  id = p_batch_id;

  RETURN QUERY SELECT v_batch.id, v_batch.source_id, v_timed_out;
END;
$$;

-- 5. Index for the closing finalizer: look up closing batches by quiet-window and timeout.
CREATE INDEX slip_batches_closing_due_idx
  ON public.slip_batches (closing_at, last_image_at)
  WHERE status = 'closing';
