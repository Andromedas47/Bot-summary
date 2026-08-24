-- Task 4 (Daily Financial Settlement): adds the two genuinely missing inputs
-- the operating-result formula needs that no existing table captures —
--   white_sheet_sales : the hand-written ใบขาว sales total (source of truth;
--                        NEVER the produce-derived expectedSales in
--                        calculateDigitalWhiteSheet)
--   owner_cash         : เงินให้เจ้า — cash handed directly to the owner,
--                        distinct from an operating expense
--
-- Both are NULLABLE on purpose, matching the existing convention on
-- manual_white_sheet_note_sessions (0059): NULL means "not yet entered",
-- never a false zero. digital_white_sheet_cash_entries keeps its existing
-- NOT NULL DEFAULT 0 columns unchanged — only these two new financial
-- inputs are nullable, because their absence must be distinguishable from a
-- genuine zero (see src/lib/settlement/daily-financial-settlement.ts, which
-- refuses to report "ปิดตรง" when either is NULL).
--
-- Captured through the SAME LINE "ใบขาวมือ" multi-message session already
-- used for labor/locationFee/bag/snack/other/actualCash (see
-- src/lib/line/white-sheet-note-command.ts) — no new session table, no new
-- close RPC, no new LINE command surface.

ALTER TABLE public.digital_white_sheet_cash_entries
  ADD COLUMN white_sheet_sales numeric(12,2),
  ADD COLUMN owner_cash        numeric(12,2);

ALTER TABLE public.digital_white_sheet_cash_entries
  ADD CONSTRAINT digital_white_sheet_cash_entries_white_sheet_sales_nonneg
    CHECK (white_sheet_sales IS NULL OR white_sheet_sales >= 0),
  ADD CONSTRAINT digital_white_sheet_cash_entries_owner_cash_nonneg
    CHECK (owner_cash IS NULL OR owner_cash >= 0);

COMMENT ON COLUMN public.digital_white_sheet_cash_entries.white_sheet_sales IS
  'Hand-written ใบขาว sales total (financial source of truth). NULL = not '
  'yet entered. Never derived from produce_transactions.';
COMMENT ON COLUMN public.digital_white_sheet_cash_entries.owner_cash IS
  'เงินให้เจ้า — cash handed directly to the owner. NULL = not yet entered.';

ALTER TABLE public.manual_white_sheet_note_sessions
  ADD COLUMN white_sheet_sales numeric(12,2),
  ADD COLUMN owner_cash        numeric(12,2);

ALTER TABLE public.manual_white_sheet_note_sessions
  DROP CONSTRAINT manual_white_sheet_note_sessions_money_nonneg,
  ADD CONSTRAINT manual_white_sheet_note_sessions_money_nonneg
    CHECK (
      (labor IS NULL OR labor >= 0)
      AND (location_fee IS NULL OR location_fee >= 0)
      AND (bag IS NULL OR bag >= 0)
      AND (snack IS NULL OR snack >= 0)
      AND (other_amount IS NULL OR other_amount >= 0)
      AND (actual_cash IS NULL OR actual_cash >= 0)
      AND (white_sheet_sales IS NULL OR white_sheet_sales >= 0)
      AND (owner_cash IS NULL OR owner_cash >= 0)
    );

-- Re-create the close RPC (0059) to carry the two new fields through the
-- SAME atomic "lock session -> merge into canonical -> mark closed"
-- transaction, preserving every existing guarantee (idempotent re-close,
-- FINALIZED rejection, partial-field preservation via CASE WHEN).
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
     AND v_session.white_sheet_sales IS NULL AND v_session.owner_cash IS NULL
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
    labor, location_fee, bag, snack, other, other_note, actual_cash_submitted,
    white_sheet_sales, owner_cash
  ) VALUES (
    v_session.source_id, v_session.market_label_normalized, v_session.business_date,
    COALESCE(v_session.labor, 0), COALESCE(v_session.location_fee, 0), COALESCE(v_session.bag, 0),
    COALESCE(v_session.snack, 0), COALESCE(v_session.other_amount, 0), v_session.other_note,
    COALESCE(v_session.actual_cash, 0),
    v_session.white_sheet_sales, v_session.owner_cash
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
    white_sheet_sales = CASE WHEN v_session.white_sheet_sales IS NOT NULL
              THEN v_session.white_sheet_sales ELSE digital_white_sheet_cash_entries.white_sheet_sales END,
    owner_cash = CASE WHEN v_session.owner_cash IS NOT NULL
              THEN v_session.owner_cash ELSE digital_white_sheet_cash_entries.owner_cash END,
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
