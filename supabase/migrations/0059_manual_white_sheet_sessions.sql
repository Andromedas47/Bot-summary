-- LINE Manual White Sheet session wrapper.
--
-- One session = one LINE source + normalized market + business date. The
-- operator opens with "<market> ส่งใบขาวมือ <date>", sends field lines across
-- one or more messages, then closes with "จบใบขาวมือ" (or cancels with
-- "ยกเลิกใบขาวมือ"). Closing hands off to the existing White Sheet
-- submission path (digital_white_sheet_cash_entries) — this table only tracks
-- the LINE-side accumulation session, never White Sheet arithmetic.
--
-- Nullable numeric columns distinguish "never sent" (NULL) from "explicitly
-- sent as zero" (0), matching the existing WhiteSheetCloseCommand contract
-- (undefined = omitted, number including 0 = explicit).

CREATE TABLE public.manual_white_sheet_sessions (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                text        NOT NULL,
  market_label             text        NOT NULL,
  market_label_normalized  text        NOT NULL,
  business_date            date        NOT NULL,
  -- Raw operator-typed DD/MM/BBBB (Buddhist) string, kept only for LINE
  -- reply display fidelity — business_date above is the canonical ISO value.
  business_date_display    text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'open'
                                        CHECK (status IN ('open', 'closing', 'closed', 'cancelled')),

  labor                    numeric(12,2),
  location_fee             numeric(12,2),
  bag                      numeric(12,2),
  snack                    numeric(12,2),
  other_amount             numeric(12,2),
  other_note               text,
  actual_cash_submitted    numeric(12,2),

  opened_by_line_user_id   text,
  opened_line_event_id     text        NOT NULL,
  opened_at                timestamptz NOT NULL DEFAULT now(),

  closed_by_line_user_id   text,
  closed_line_event_id     text,
  closed_at                timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- One session per source/market/date identity (matches White Sheet identity).
  UNIQUE (source_id, market_label_normalized, business_date)
);

-- At most one open (or in-flight closing) session per LINE source at a time.
CREATE UNIQUE INDEX manual_white_sheet_sessions_one_open_per_source
  ON public.manual_white_sheet_sessions (source_id)
  WHERE status IN ('open', 'closing');

CREATE INDEX manual_white_sheet_sessions_source_date_idx
  ON public.manual_white_sheet_sessions (source_id, business_date);

CREATE OR REPLACE FUNCTION public.set_manual_white_sheet_session_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_manual_white_sheet_sessions_updated_at
  BEFORE UPDATE ON public.manual_white_sheet_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_manual_white_sheet_session_updated_at();

ALTER TABLE public.manual_white_sheet_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role server client (which bypasses RLS)
-- reads/writes this table — same posture as digital_white_sheet_cash_entries.
