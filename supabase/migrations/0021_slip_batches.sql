-- Additive migration: slip batch processing (phase 3)
-- Adds slip_batches table to group images sent in rapid succession,
-- and links slip_evidences to batches.
-- Existing evidence rows are unaffected (batch_id defaults to NULL).

CREATE TABLE public.slip_batches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       text        NOT NULL,
  source_type     text,
  sender_id       text,
  status          text        NOT NULL DEFAULT 'collecting',
  first_image_at  timestamptz NOT NULL DEFAULT now(),
  last_image_at   timestamptz NOT NULL DEFAULT now(),
  image_count     integer     NOT NULL DEFAULT 0,
  success_count   integer     NOT NULL DEFAULT 0,
  failed_count    integer     NOT NULL DEFAULT 0,
  summary_sent_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT slip_batches_status_check
    CHECK (status IN ('collecting', 'processing', 'completed', 'review_needed', 'failed'))
);

-- Fast lookup: find an active collecting batch for a given source + sender
CREATE INDEX slip_batches_collecting_source_idx
  ON public.slip_batches (source_id, sender_id, last_image_at DESC)
  WHERE status = 'collecting';

-- Fast lookup: find all due batches in the finalizer
CREATE INDEX slip_batches_due_idx
  ON public.slip_batches (last_image_at)
  WHERE status = 'collecting';

ALTER TABLE public.slip_batches ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.set_slip_batch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_slip_batches_updated_at
  BEFORE UPDATE ON public.slip_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_slip_batch_updated_at();

-- Add batch linkage to slip_evidences (additive — existing rows keep NULL)
ALTER TABLE public.slip_evidences
  ADD COLUMN batch_id    uuid REFERENCES public.slip_batches(id) ON DELETE SET NULL,
  ADD COLUMN batch_index integer;

CREATE INDEX slip_evidences_batch_idx
  ON public.slip_evidences (batch_id)
  WHERE batch_id IS NOT NULL;

-- Atomic function: increments batch image_count and links the evidence.
-- Uses a single transaction so concurrent calls from different requests
-- get distinct sequential batch_index values.
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
  WHERE id = p_batch_id AND status = 'collecting'
  RETURNING image_count INTO v_batch_index;

  IF v_batch_index IS NULL THEN
    RAISE EXCEPTION 'slip_batch % not found or not in collecting status', p_batch_id;
  END IF;

  UPDATE public.slip_evidences
  SET batch_id    = p_batch_id,
      batch_index = v_batch_index
  WHERE id = p_evidence_id;

  RETURN v_batch_index;
END;
$$;
