-- Atomic all-in-one Manual White Sheet submission from a single LINE message.
-- Does not rewrite migration 0059. Reuses the same canonical identity and
-- FINALIZED protection as close_manual_white_sheet_note_session, but never
-- leaves an open session and never does open → N updates → close across
-- separate webhook events.
--
-- Identity for digital_white_sheet_cash_entries remains
-- source_id + market_label_normalized + business_date (0038).
-- Omitted (NULL) field args preserve an existing SUBMITTED row's values;
-- brand-new rows COALESCE omitted money fields to 0 (same as 0059 close).

CREATE OR REPLACE FUNCTION public.submit_manual_white_sheet_note_all_in_one(
  p_source_id                 text,
  p_market_label              text,
  p_market_label_normalized   text,
  p_business_date             date,
  p_labor                     numeric,
  p_location_fee              numeric,
  p_bag                       numeric,
  p_snack                     numeric,
  p_other_amount              numeric,
  p_other_note                text,
  p_actual_cash               numeric,
  p_opened_by_line_user_id    text,
  p_opened_line_event_id      text,
  p_closed_by_line_user_id    text,
  p_closed_line_event_id      text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_open     public.manual_white_sheet_note_sessions;
  v_session  public.manual_white_sheet_note_sessions;
  v_cash     public.digital_white_sheet_cash_entries;
  v_dup      public.manual_white_sheet_note_sessions;
  v_has_open boolean := false;
BEGIN
  IF p_source_id IS NULL OR btrim(p_source_id) = '' THEN
    RAISE EXCEPTION '0060: source_id is required';
  END IF;
  IF p_market_label IS NULL OR btrim(p_market_label) = '' THEN
    RAISE EXCEPTION '0060: market_label is required';
  END IF;
  IF p_market_label_normalized IS NULL OR btrim(p_market_label_normalized) = '' THEN
    RAISE EXCEPTION '0060: market_label_normalized is required';
  END IF;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION '0060: business_date is required';
  END IF;
  IF p_opened_line_event_id IS NULL OR btrim(p_opened_line_event_id) = '' THEN
    RAISE EXCEPTION '0060: opened_line_event_id is required';
  END IF;
  IF p_closed_line_event_id IS NULL OR btrim(p_closed_line_event_id) = '' THEN
    RAISE EXCEPTION '0060: closed_line_event_id is required';
  END IF;

  -- Duplicate webhook delivery of the same close event: return the prior
  -- closed session + its canonical row without writing again.
  SELECT * INTO v_dup
    FROM public.manual_white_sheet_note_sessions
   WHERE source_id = p_source_id
     AND closed_line_event_id = p_closed_line_event_id
     AND status = 'closed'
   FOR UPDATE;

  IF FOUND THEN
    SELECT * INTO v_cash
      FROM public.digital_white_sheet_cash_entries
     WHERE source_id = v_dup.source_id
       AND market_label_normalized = v_dup.market_label_normalized
       AND business_date = v_dup.business_date;
    RETURN jsonb_build_object(
      'outcome', 'already_closed',
      'session', to_jsonb(v_dup),
      'cash_entry', to_jsonb(v_cash)
    );
  END IF;

  -- Serialize against any open session for this LINE source.
  SELECT * INTO v_open
    FROM public.manual_white_sheet_note_sessions
   WHERE source_id = p_source_id
     AND status = 'open'
   FOR UPDATE;

  v_has_open := FOUND;

  IF v_has_open THEN
    IF v_open.market_label_normalized IS DISTINCT FROM p_market_label_normalized
       OR v_open.business_date IS DISTINCT FROM p_business_date
    THEN
      RETURN jsonb_build_object(
        'outcome', 'open_conflict',
        'session', to_jsonb(v_open),
        'cash_entry', NULL
      );
    END IF;
  END IF;

  IF p_labor IS NULL AND p_location_fee IS NULL AND p_bag IS NULL
     AND p_snack IS NULL AND p_other_amount IS NULL AND p_actual_cash IS NULL
  THEN
    RETURN jsonb_build_object('outcome', 'empty', 'session', NULL, 'cash_entry', NULL);
  END IF;

  -- Lock any existing canonical row for this identity.
  PERFORM 1
    FROM public.digital_white_sheet_cash_entries
   WHERE source_id = p_source_id
     AND market_label_normalized = p_market_label_normalized
     AND business_date = p_business_date
   FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.digital_white_sheet_cash_entries
     WHERE source_id = p_source_id
       AND market_label_normalized = p_market_label_normalized
       AND business_date = p_business_date
       AND finalized_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'finalized',
      'session', CASE WHEN v_has_open THEN to_jsonb(v_open) ELSE NULL END,
      'cash_entry', NULL
    );
  END IF;

  IF v_has_open THEN
    -- Same-identity open session: apply provided fields (last-wins already
    -- collapsed by the caller), then close after the canonical write.
    UPDATE public.manual_white_sheet_note_sessions
       SET labor = CASE WHEN p_labor IS NOT NULL THEN p_labor ELSE labor END,
           location_fee = CASE WHEN p_location_fee IS NOT NULL THEN p_location_fee ELSE location_fee END,
           bag = CASE WHEN p_bag IS NOT NULL THEN p_bag ELSE bag END,
           snack = CASE WHEN p_snack IS NOT NULL THEN p_snack ELSE snack END,
           other_amount = CASE WHEN p_other_amount IS NOT NULL THEN p_other_amount ELSE other_amount END,
           other_note = CASE WHEN p_other_amount IS NOT NULL THEN p_other_note ELSE other_note END,
           actual_cash = CASE WHEN p_actual_cash IS NOT NULL THEN p_actual_cash ELSE actual_cash END
     WHERE id = v_open.id
    RETURNING * INTO v_session;
  ELSE
    -- No open session: insert a closed session in one step — never leave open.
    INSERT INTO public.manual_white_sheet_note_sessions (
      source_id, market_label, market_label_normalized, business_date,
      status, labor, location_fee, bag, snack, other_amount, other_note, actual_cash,
      opened_by_line_user_id, opened_line_event_id,
      closed_by_line_user_id, closed_line_event_id, closed_at
    ) VALUES (
      p_source_id, p_market_label, p_market_label_normalized, p_business_date,
      'closed', p_labor, p_location_fee, p_bag, p_snack, p_other_amount, p_other_note, p_actual_cash,
      p_opened_by_line_user_id, p_opened_line_event_id,
      p_closed_by_line_user_id, p_closed_line_event_id, now()
    )
    RETURNING * INTO v_session;
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

  IF v_session.status = 'open' THEN
    UPDATE public.manual_white_sheet_note_sessions
       SET status = 'closed',
           closed_at = now(),
           closed_by_line_user_id = p_closed_by_line_user_id,
           closed_line_event_id = p_closed_line_event_id
     WHERE id = v_session.id
    RETURNING * INTO v_session;
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'closed',
    'session', to_jsonb(v_session),
    'cash_entry', to_jsonb(v_cash)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.submit_manual_white_sheet_note_all_in_one(
  text, text, text, date,
  numeric, numeric, numeric, numeric, numeric, text, numeric,
  text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_manual_white_sheet_note_all_in_one(
  text, text, text, date,
  numeric, numeric, numeric, numeric, numeric, text, numeric,
  text, text, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_manual_white_sheet_note_all_in_one(
  text, text, text, date,
  numeric, numeric, numeric, numeric, numeric, text, numeric,
  text, text, text, text
) TO service_role;
