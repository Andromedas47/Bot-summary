-- Work Round — the canonical operational unit for produce, settlement, and evidence.
--
-- One Work Round represents a single operational cycle for a specific
-- seller + market + business_date within a LINE group.  A group may have
-- multiple Work Rounds on the same business date (different sellers or markets).
--
-- source_id is the LINE groupId — the reply destination only.
-- seller_name and market_name come from the parsed explicit message header
-- (e.g. "กี้-วัดทุ่งลานนา เบิก 24/06/2569" → seller=กี้, market=วัดทุ่งลานนา).
-- round_seq distinguishes multiple rounds for the same seller+market on the same day.
--
-- Status lifecycle:
--   open               → produce sessions being attached
--   produce_complete   → all produce sessions finalized
--   awaiting_settlement → produce done, waiting for settlement declaration
--   awaiting_evidence   → settlement declared, waiting for slip evidence
--   variance_found      → declared settlement does not match slip evidence
--   ready_for_review    → all evidence in, ready for staff approval
--   approved            → settlement approved by reviewer
--   needs_correction    → reviewer flagged for correction

CREATE TABLE public.work_rounds (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     text        NOT NULL,
  business_date date        NOT NULL,
  seller_name   text        NOT NULL,
  market_name   text        NOT NULL,
  round_seq     integer     NOT NULL DEFAULT 1,
  status        text        NOT NULL DEFAULT 'open'
                CHECK (status IN (
                  'open', 'produce_complete', 'awaiting_settlement',
                  'awaiting_evidence', 'variance_found', 'ready_for_review',
                  'approved', 'needs_correction'
                )),
  source_meta   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- One active round per seller+market+date within a group.
  -- round_seq allows re-opening if a new round is needed after approval.
  UNIQUE (source_id, business_date, seller_name, market_name, round_seq)
);

CREATE INDEX work_rounds_source_date_idx ON public.work_rounds (source_id, business_date);
CREATE INDEX work_rounds_status_idx       ON public.work_rounds (status);
CREATE INDEX work_rounds_open_idx         ON public.work_rounds (source_id, business_date)
  WHERE status = 'open';

ALTER TABLE public.work_rounds ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_read_work_rounds ON public.work_rounds FOR SELECT TO anon USING (true);
