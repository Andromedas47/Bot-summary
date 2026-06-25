-- Settlement draft — LINE-first settlement declaration tied to a Work Round.
--
-- One draft per Work Round per version.  Corrections create a new version
-- and write the prior data to settlement_draft_history for full audit trail.
--
-- declared_via: 'line' for LINE-initiated drafts, 'website' for website-initiated.
-- Identity is work_round_id, not seller+market text or source_id+date alone.

CREATE TABLE public.settlement_drafts (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  work_round_id            uuid        NOT NULL REFERENCES public.work_rounds(id),
  declared_transfer        numeric(12,2),
  declared_cash            numeric(12,2),
  declared_expenses        numeric(12,2),
  declared_labor           numeric(12,2),
  notes                    text,
  status                   text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN (
                             'pending', 'awaiting_evidence', 'variance_found',
                             'ready_for_review', 'approved', 'needs_correction'
                           )),
  declared_by_line_user_id text,
  declared_via             text        NOT NULL DEFAULT 'line'
                           CHECK (declared_via IN ('line', 'website')),
  white_bill_ref           text,
  approved_by              text,
  approved_at              timestamptz,
  version                  integer     NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX settlement_drafts_work_round_id_idx ON public.settlement_drafts (work_round_id);
CREATE INDEX settlement_drafts_status_idx         ON public.settlement_drafts (status);

ALTER TABLE public.settlement_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_read_settlement_drafts
  ON public.settlement_drafts FOR SELECT TO anon USING (true);

-- Audit log for settlement_drafts.  Never overwrite; always append.
CREATE TABLE public.settlement_draft_history (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id       uuid        NOT NULL REFERENCES public.settlement_drafts(id),
  changed_by     text,
  change_type    text        NOT NULL,
  previous_data  jsonb,
  new_data       jsonb,
  changed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX settlement_draft_history_draft_id_idx
  ON public.settlement_draft_history (draft_id);

ALTER TABLE public.settlement_draft_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_read_settlement_draft_history
  ON public.settlement_draft_history FOR SELECT TO anon USING (true);
