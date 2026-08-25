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

-- labor/location_fee/bag/snack/other/actual_cash_submitted are NOT NULL
-- DEFAULT 0 in Production (0038) and already hold live data — left untouched
-- here on purpose (a bigger blast radius than this fix warrants). That means
-- once close_manual_white_sheet_note_session COALESCEs a never-entered
-- session field to 0 on the first INSERT, the money column alone can no
-- longer distinguish "operator entered 0" from "operator never sent this
-- field" (see the module doc in
-- src/lib/settlement/daily-financial-settlement.ts). The ใบขาวมือ close flow
-- deliberately allows closing with only SOME fields sent — it only refuses a
-- close with ZERO fields at all (see hasAnyValue in
-- src/lib/line/white-sheet-note-session-service.ts and the "empty" guard
-- below, both unchanged) — so tightening the gate to require every field
-- would reject closes that succeed today and is not done here.
--
-- Fix: track, per money field, whether it was EVER explicitly entered by an
-- operator through this RPC, as its own boolean column — never inferred
-- from the amount. DEFAULT true so every already-existing row (production
-- data written before this migration, and any row written by the unrelated
-- "digital" saveWhiteSheetCashEntry path in src/lib/white-sheet/persist.ts,
-- which always supplies real values for all six fields at once) is treated
-- as fully entered, matching current behavior exactly — this is the only
-- reason the two historical fixture days keep closing CLOSED_MATCHED. Only
-- rows touched by close_manual_white_sheet_note_session ever see one of
-- these flip to false, and only for a field whose session value was NULL.
-- Once true, a flag never goes back to false (OR-accumulated in the DO
-- UPDATE below) — you cannot "un-enter" a value, and a later close on the
-- same identity that again leaves the field NULL must not erase provenance
-- a previous close already established.
ALTER TABLE public.digital_white_sheet_cash_entries
  ADD COLUMN labor_entered                 boolean NOT NULL DEFAULT true,
  ADD COLUMN location_fee_entered          boolean NOT NULL DEFAULT true,
  ADD COLUMN bag_entered                   boolean NOT NULL DEFAULT true,
  ADD COLUMN snack_entered                 boolean NOT NULL DEFAULT true,
  ADD COLUMN other_entered                 boolean NOT NULL DEFAULT true,
  ADD COLUMN actual_cash_submitted_entered boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.digital_white_sheet_cash_entries.labor_entered IS
  'true iff labor was ever explicitly sent by an operator through the '
  'ใบขาวมือ close RPC. false means the NOT NULL/DEFAULT 0 value in labor is '
  'a placeholder, never a real zero — see inputsFromCashEntry in '
  'src/lib/settlement/daily-financial-settlement.ts, which reports wages as '
  'a missing input instead of treating the placeholder 0 as entered.';
COMMENT ON COLUMN public.digital_white_sheet_cash_entries.location_fee_entered IS
  'Same contract as labor_entered, for location_fee.';
COMMENT ON COLUMN public.digital_white_sheet_cash_entries.bag_entered IS
  'Same contract as labor_entered, for bag.';
COMMENT ON COLUMN public.digital_white_sheet_cash_entries.snack_entered IS
  'Same contract as labor_entered, for snack.';
COMMENT ON COLUMN public.digital_white_sheet_cash_entries.other_entered IS
  'Same contract as labor_entered, for other.';
COMMENT ON COLUMN public.digital_white_sheet_cash_entries.actual_cash_submitted_entered IS
  'Same contract as labor_entered, for actual_cash_submitted.';

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
    white_sheet_sales, owner_cash,
    labor_entered, location_fee_entered, bag_entered, snack_entered, other_entered,
    actual_cash_submitted_entered
  ) VALUES (
    v_session.source_id, v_session.market_label_normalized, v_session.business_date,
    COALESCE(v_session.labor, 0), COALESCE(v_session.location_fee, 0), COALESCE(v_session.bag, 0),
    COALESCE(v_session.snack, 0), COALESCE(v_session.other_amount, 0), v_session.other_note,
    COALESCE(v_session.actual_cash, 0),
    v_session.white_sheet_sales, v_session.owner_cash,
    v_session.labor IS NOT NULL, v_session.location_fee IS NOT NULL, v_session.bag IS NOT NULL,
    v_session.snack IS NOT NULL, v_session.other_amount IS NOT NULL,
    v_session.actual_cash IS NOT NULL
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
    -- Entered flags only ever accumulate (OR) — never erased by a later
    -- close that leaves the field NULL again.
    labor_entered = digital_white_sheet_cash_entries.labor_entered OR (v_session.labor IS NOT NULL),
    location_fee_entered = digital_white_sheet_cash_entries.location_fee_entered
              OR (v_session.location_fee IS NOT NULL),
    bag_entered = digital_white_sheet_cash_entries.bag_entered OR (v_session.bag IS NOT NULL),
    snack_entered = digital_white_sheet_cash_entries.snack_entered OR (v_session.snack IS NOT NULL),
    other_entered = digital_white_sheet_cash_entries.other_entered OR (v_session.other_amount IS NOT NULL),
    actual_cash_submitted_entered = digital_white_sheet_cash_entries.actual_cash_submitted_entered
              OR (v_session.actual_cash IS NOT NULL),
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
