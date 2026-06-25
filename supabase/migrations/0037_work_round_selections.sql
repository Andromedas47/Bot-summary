-- Durable pending-selection state for numbered LINE replies.
--
-- When more than one Work Round is eligible for a financial action
-- (settlement, produce attach, slip, manual slip), the bot must NEVER auto-pick.
-- It records the candidate options here, replies with a numbered list, and waits
-- for a numeric reply (e.g. "1", "2") tied to the SAME source_id + sender + date.
--
-- intent          — which action is awaiting a Work Round choice
-- candidates      — [{work_round_id, seller_name, market_name, round_seq, expected_sales}]
-- payload         — intent-specific context needed to resume the action
-- status          — pending → resolved | expired
-- expires_at      — stale selections must not consume unrelated numeric messages

CREATE TABLE public.work_round_selections (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id              text        NOT NULL,
  line_user_id           text,
  business_date          date        NOT NULL,
  intent                 text        NOT NULL
                         CHECK (intent IN ('settlement', 'produce_attach', 'slip', 'manual_slip', 'close_round', 'close_round_confirm')),
  candidates             jsonb       NOT NULL,
  payload                jsonb,
  status                 text        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'resolved', 'expired')),
  resolved_work_round_id uuid        REFERENCES public.work_rounds(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  resolved_at            timestamptz
);

-- Fast lookup of the active pending selection for a given sender in a group.
CREATE INDEX work_round_selections_active_idx
  ON public.work_round_selections (source_id, line_user_id, status)
  WHERE status = 'pending';

ALTER TABLE public.work_round_selections ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_read_work_round_selections
  ON public.work_round_selections FOR SELECT TO anon USING (true);
