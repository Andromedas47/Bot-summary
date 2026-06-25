-- Associate slip evidence batches and manual slip sessions with a Work Round.
-- Nullable so that existing rows remain valid; V2 sessions will set this.
-- Multiple Work Rounds may exist in one group/day, so slip evidence must link
-- to the specific Work Round rather than relying on source_id + date alone.

ALTER TABLE public.slip_batches
  ADD COLUMN work_round_id uuid REFERENCES public.work_rounds(id);

ALTER TABLE public.manual_slip_sessions
  ADD COLUMN work_round_id uuid REFERENCES public.work_rounds(id);

CREATE INDEX slip_batches_work_round_id_idx
  ON public.slip_batches (work_round_id)
  WHERE work_round_id IS NOT NULL;

CREATE INDEX manual_slip_sessions_work_round_id_idx
  ON public.manual_slip_sessions (work_round_id)
  WHERE work_round_id IS NOT NULL;
