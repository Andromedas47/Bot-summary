-- Priced House Stock stays inside Physical Inventory. Old observations remain
-- readable with a null price; new priced-parser observations require satang.

ALTER TABLE public.physical_inventory_items
  ADD COLUMN unit_price_satang bigint,
  ADD CONSTRAINT physical_inventory_items_unit_price_positive
    CHECK (unit_price_satang IS NULL OR unit_price_satang > 0);

COMMENT ON COLUMN public.physical_inventory_items.unit_price_satang IS
  'Observed unit price in integer satang. Null only for legacy Physical Inventory rows.';

-- Reuse 0047 atomic finalization unchanged. This insert trigger copies the
-- already-validated structured price from the wrapper RPC into each immutable
-- item while the original function performs its normal insert transaction.
CREATE OR REPLACE FUNCTION public.physical_inventory_set_unit_price()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_items jsonb;
  v_price text;
BEGIN
  v_items := nullif(current_setting('bot_summary.priced_house_stock_items', true), '')::jsonb;
  IF v_items IS NULL THEN
    RETURN NEW;
  END IF;
  v_price := v_items -> (NEW.item_ordinal - 1) ->> 'unit_price_satang';
  NEW.unit_price_satang := nullif(v_price, '')::bigint;
  RETURN NEW;
END;
$$;

CREATE TRIGGER physical_inventory_items_set_unit_price
  BEFORE INSERT ON public.physical_inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.physical_inventory_set_unit_price();

REVOKE ALL ON FUNCTION public.physical_inventory_set_unit_price() FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) RENAME TO finalize_physical_inventory_session_base;

REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session_base(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finalize_physical_inventory_session(
  p_session_id               uuid,
  p_expected_generation      uuid,
  p_expected_ingest_revision bigint,
  p_expected_ingest_hash     text,
  p_business_date            date,
  p_parser_version           text,
  p_warnings                 jsonb,
  p_items                    jsonb,
  p_fail_closed              boolean,
  p_fail_reason              text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_parser_version = 'house-stock-priced-1.0.0'
     AND NOT coalesce(p_fail_closed, false)
     AND (
       p_items IS NULL
       OR jsonb_typeof(p_items) <> 'array'
       OR jsonb_array_length(p_items) = 0
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(p_items) item
         WHERE coalesce(item->>'unit_price_satang', '') !~ '^[0-9]+$'
            OR (item->>'unit_price_satang')::numeric <= 0
            OR (item->>'unit_price_satang')::numeric > 9223372036854775807
       )
     ) THEN
    RAISE EXCEPTION 'priced_house_stock_unit_price_required';
  END IF;

  PERFORM set_config(
    'bot_summary.priced_house_stock_items',
    CASE WHEN p_parser_version = 'house-stock-priced-1.0.0' THEN coalesce(p_items, '[]'::jsonb)::text ELSE '' END,
    true
  );

  v_result := public.finalize_physical_inventory_session_base(
    p_session_id,
    p_expected_generation,
    p_expected_ingest_revision,
    p_expected_ingest_hash,
    p_business_date,
    p_parser_version,
    p_warnings,
    p_items,
    p_fail_closed,
    p_fail_reason
  );
  PERFORM set_config('bot_summary.priced_house_stock_items', '', true);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) TO service_role;

-- One LINE event can contain header, all items, and close. The open RPC already
-- owns that event id, so close the same persisted ingest without duplicating it.
CREATE OR REPLACE FUNCTION public.close_physical_inventory_open_event(
  p_session_id uuid,
  p_expected_generation uuid,
  p_opened_line_event_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.physical_inventory_sessions%ROWTYPE;
  v_ingest public.physical_inventory_session_ingests%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_session
  FROM public.physical_inventory_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'physical inventory session not found'; END IF;
  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;
  IF v_session.opened_line_event_id IS DISTINCT FROM btrim(coalesce(p_opened_line_event_id, '')) THEN
    RAISE EXCEPTION 'line_event_conflict';
  END IF;
  IF v_session.status IN ('closing', 'finalized', 'failed_closed') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'session_id', v_session.id,
      'status', v_session.status
    );
  END IF;
  IF v_session.status IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;

  SELECT * INTO STRICT v_ingest
  FROM public.physical_inventory_session_ingests
  WHERE session_id = v_session.id
    AND line_event_id = v_session.opened_line_event_id
    AND kind = 'header';

  UPDATE public.physical_inventory_sessions
  SET status = 'closing',
      close_requested_at = v_now,
      close_event_timestamp_ms = v_ingest.line_timestamp_ms,
      close_quiet_until = v_now + interval '8 seconds',
      close_deadline_at = v_now + interval '30 seconds',
      close_line_event_id = v_ingest.line_event_id,
      close_raw_message_id = v_ingest.raw_message_id,
      updated_at = v_now
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'session_id', v_session.id,
    'status', v_session.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.close_physical_inventory_open_event(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_physical_inventory_open_event(uuid, uuid, text)
  TO service_role;
