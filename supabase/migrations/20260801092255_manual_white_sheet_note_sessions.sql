-- LINE Manual White Sheet entry session: temporary session state for
-- multi-message LINE entry of White Sheet figures. On close, the entered
-- values are saved into digital_white_sheet_cash_entries (see
-- src/lib/line/white-sheet-note-canonical-save.ts) — this table is not the
-- final record. Not coupled to produce, slips, transfers, reconciliation,
-- settlement, or work rounds. One open session per LINE source at a time.

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
    ),
  CONSTRAINT manual_white_sheet_note_sessions_lifecycle_chk
    CHECK (
      (status = 'open'
        AND closed_at IS NULL AND closed_line_event_id IS NULL AND closed_by_line_user_id IS NULL)
      OR (status IN ('closed', 'cancelled')
        AND closed_at IS NOT NULL AND closed_line_event_id IS NOT NULL)
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

-- ── close_manual_white_sheet_note_session ────────────────────────────────────
-- Atomic close: locks the open session row, reads its entered field values
-- from inside the transaction (never trusts application-memory values),
-- merges only the entered fields into digital_white_sheet_cash_entries
-- (preserving every canonical field the session never touched), and marks
-- the session closed only after that canonical write succeeds. Any error
-- anywhere rolls back everything in this call — no partial state.
--
-- No produce/slip/settlement/reconciliation logic. Identity for the
-- canonical row is source_id + market_label_normalized + business_date,
-- matching digital_white_sheet_cash_entries_identity_key (0038).
--
-- Returns jsonb: { outcome, session, cash_entry }. outcome is one of
-- 'closed' | 'already_closed' | 'already_cancelled' | 'empty' | 'finalized'
-- | 'not_found'. Only 'closed' sets cash_entry.
CREATE OR REPLACE FUNCTION public.close_manual_white_sheet_note_session(
  p_session_id              uuid,
  p_source_id               text,
  p_closed_by_line_user_id  text,
  p_closed_line_event_id    text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.manual_white_sheet_note_sessions;
  v_cash    public.digital_white_sheet_cash_entries;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION '0059: session_id is required';
  END IF;
  IF p_source_id IS NULL OR btrim(p_source_id) = '' THEN
    RAISE EXCEPTION '0059: source_id is required';
  END IF;
  IF p_closed_line_event_id IS NULL OR btrim(p_closed_line_event_id) = '' THEN
    RAISE EXCEPTION '0059: closed_line_event_id is required';
  END IF;

  SELECT * INTO v_session
    FROM public.manual_white_sheet_note_sessions
   WHERE id = p_session_id
     AND source_id = p_source_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'session', NULL, 'cash_entry', NULL);
  END IF;

  IF v_session.status = 'closed' THEN
    RETURN jsonb_build_object('outcome', 'already_closed', 'session', to_jsonb(v_session), 'cash_entry', NULL);
  END IF;
  IF v_session.status = 'cancelled' THEN
    RETURN jsonb_build_object('outcome', 'already_cancelled', 'session', to_jsonb(v_session), 'cash_entry', NULL);
  END IF;

  -- status = 'open' here. Nothing entered — refuse without mutating anything.
  IF v_session.labor IS NULL AND v_session.location_fee IS NULL AND v_session.bag IS NULL
     AND v_session.snack IS NULL AND v_session.other_amount IS NULL AND v_session.actual_cash IS NULL
  THEN
    RETURN jsonb_build_object('outcome', 'empty', 'session', to_jsonb(v_session), 'cash_entry', NULL);
  END IF;

  -- Lock any existing canonical row for this identity so a concurrent close
  -- (or any other writer touching this exact row) serializes against us.
  PERFORM 1
    FROM public.digital_white_sheet_cash_entries
   WHERE source_id = v_session.source_id
     AND market_label_normalized = v_session.market_label_normalized
     AND business_date = v_session.business_date
   FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.digital_white_sheet_cash_entries
     WHERE source_id = v_session.source_id
       AND market_label_normalized = v_session.market_label_normalized
       AND business_date = v_session.business_date
       AND finalized_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('outcome', 'finalized', 'session', to_jsonb(v_session), 'cash_entry', NULL);
  END IF;

  INSERT INTO public.digital_white_sheet_cash_entries (
    source_id, market_label_normalized, business_date,
    labor, location_fee, bag, snack, other, other_note, actual_cash_submitted
  ) VALUES (
    v_session.source_id, v_session.market_label_normalized, v_session.business_date,
    COALESCE(v_session.labor, 0), COALESCE(v_session.location_fee, 0), COALESCE(v_session.bag, 0),
    COALESCE(v_session.snack, 0), COALESCE(v_session.other_amount, 0), v_session.other_note,
    COALESCE(v_session.actual_cash, 0)
  )
  ON CONFLICT (source_id, market_label_normalized, business_date)
  DO UPDATE SET
    labor = CASE WHEN v_session.labor IS NOT NULL
              THEN v_session.labor ELSE digital_white_sheet_cash_entries.labor END,
    location_fee = CASE WHEN v_session.location_fee IS NOT NULL
              THEN v_session.location_fee ELSE digital_white_sheet_cash_entries.location_fee END,
    bag = CASE WHEN v_session.bag IS NOT NULL
              THEN v_session.bag ELSE digital_white_sheet_cash_entries.bag END,
    snack = CASE WHEN v_session.snack IS NOT NULL
              THEN v_session.snack ELSE digital_white_sheet_cash_entries.snack END,
    other = CASE WHEN v_session.other_amount IS NOT NULL
              THEN v_session.other_amount ELSE digital_white_sheet_cash_entries.other END,
    other_note = CASE WHEN v_session.other_amount IS NOT NULL
              THEN v_session.other_note ELSE digital_white_sheet_cash_entries.other_note END,
    actual_cash_submitted = CASE WHEN v_session.actual_cash IS NOT NULL
              THEN v_session.actual_cash ELSE digital_white_sheet_cash_entries.actual_cash_submitted END,
    updated_at = now()
  RETURNING * INTO v_cash;

  UPDATE public.manual_white_sheet_note_sessions
     SET status = 'closed',
         closed_at = now(),
         closed_by_line_user_id = p_closed_by_line_user_id,
         closed_line_event_id = p_closed_line_event_id
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object('outcome', 'closed', 'session', to_jsonb(v_session), 'cash_entry', to_jsonb(v_cash));
END;
$fn$;

REVOKE ALL ON FUNCTION public.close_manual_white_sheet_note_session(
  uuid, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_manual_white_sheet_note_session(
  uuid, text, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_manual_white_sheet_note_session(
  uuid, text, text, text
) TO service_role;
