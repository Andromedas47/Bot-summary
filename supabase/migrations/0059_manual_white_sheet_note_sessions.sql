-- Manual White Sheet note session: an independent LINE-only record of
-- operator-entered White Sheet figures. Not connected to produce, slips,
-- transfers, reconciliation, settlement, or the digital White Sheet.
-- One open session per LINE source at a time.

CREATE TABLE public.manual_white_sheet_note_sessions (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                text        NOT NULL,
  market_label             text        NOT NULL,
  market_label_normalized  text        NOT NULL,
  business_date            date        NOT NULL,
  status                   text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  labor                    numeric(12,2),
  location_fee             numeric(12,2),
  bag                      numeric(12,2),
  snack                    numeric(12,2),
  other_amount             numeric(12,2),
  other_note               text,
  actual_cash              numeric(12,2),
  opened_by_line_user_id   text,
  opened_line_event_id     text        NOT NULL,
  closed_by_line_user_id   text,
  closed_line_event_id     text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  closed_at                timestamptz,
  CONSTRAINT manual_white_sheet_note_sessions_market_label_nonblank
    CHECK (btrim(market_label) <> ''),
  CONSTRAINT manual_white_sheet_note_sessions_market_label_normalized_nonblank
    CHECK (btrim(market_label_normalized) <> ''),
  CONSTRAINT manual_white_sheet_note_sessions_source_id_nonblank
    CHECK (btrim(source_id) <> ''),
  CONSTRAINT manual_white_sheet_note_sessions_other_note_length
    CHECK (other_note IS NULL OR length(other_note) <= 1000),
  CONSTRAINT manual_white_sheet_note_sessions_money_nonneg
    CHECK (
      (labor IS NULL OR labor >= 0)
      AND (location_fee IS NULL OR location_fee >= 0)
      AND (bag IS NULL OR bag >= 0)
      AND (snack IS NULL OR snack >= 0)
      AND (other_amount IS NULL OR other_amount >= 0)
      AND (actual_cash IS NULL OR actual_cash >= 0)
    )
);

-- At most one open session per LINE source.
CREATE UNIQUE INDEX manual_white_sheet_note_sessions_one_open_per_source
  ON public.manual_white_sheet_note_sessions (source_id)
  WHERE status = 'open';

CREATE OR REPLACE FUNCTION public.set_manual_white_sheet_note_session_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER manual_white_sheet_note_sessions_set_updated_at
  BEFORE UPDATE ON public.manual_white_sheet_note_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_manual_white_sheet_note_session_updated_at();

ALTER TABLE public.manual_white_sheet_note_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.manual_white_sheet_note_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.manual_white_sheet_note_sessions FROM anon;
REVOKE ALL ON TABLE public.manual_white_sheet_note_sessions FROM authenticated;
REVOKE ALL ON TABLE public.manual_white_sheet_note_sessions FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.manual_white_sheet_note_sessions TO service_role;
