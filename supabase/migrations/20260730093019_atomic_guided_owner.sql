-- 0057: Atomic source-wide Guided Menu owner.
--
-- The 0049 open RPC serializes by per-operator session_key. Guided Menu needs
-- one owner across the wider (source, normalized market, business date) tuple,
-- so this wrapper takes that tuple lock before reading owners and then calls
-- 0049 in the same transaction. PostgreSQL function calls do not start a new
-- transaction, therefore the tuple lock remains held through open/rotation.

DO $$
BEGIN
  IF to_regprocedure(
    'public.open_or_rotate_produce_structured_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION
      '0057: required function public.open_or_rotate_produce_structured_session is missing';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.open_or_rotate_guided_produce_structured_session(
  p_session_key                    text,
  p_source_type                    text,
  p_source_id                      text,
  p_line_user_id                   text,
  p_opened_line_event_id           text,
  p_line_timestamp_ms              bigint,
  p_command_contract_version       integer,
  p_business_date                  date,
  p_transaction_time               text,
  p_transaction_time_source        text,
  p_staff_label                    text,
  p_market_label                   text,
  p_market_label_normalized        text,
  p_session_kind                   text,
  p_initial_transaction_type       text,
  p_declared_transaction_type      text DEFAULT NULL,
  p_additional_opener              text DEFAULT NULL,
  p_expected_session_generation    uuid DEFAULT NULL,
  p_entry_origin                   text DEFAULT 'structured_menu'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_source             text := btrim(coalesce(p_source_id, ''));
  v_user               text := btrim(coalesce(p_line_user_id, ''));
  v_market             text := btrim(normalize(
    btrim(coalesce(p_market_label_normalized, '')),
    NFC
  ));
  v_raw_market         text := btrim(normalize(
    btrim(coalesce(p_market_label, '')),
    NFC
  ));
  v_matching_rows      integer;
  v_distinct_owners    integer;
  v_has_invalid_owner  boolean;
  v_owner              text;
  v_lock_key           bigint;
BEGIN
  IF v_source = '' THEN
    RAISE EXCEPTION '0057: source_id is required';
  END IF;
  IF v_user = '' THEN
    RAISE EXCEPTION '0057: line_user_id is required';
  END IF;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION '0057: business_date is required';
  END IF;
  IF v_market = '' THEN
    RAISE EXCEPTION '0057: market_label_normalized is required';
  END IF;
  IF v_raw_market IS DISTINCT FROM v_market THEN
    RAISE EXCEPTION
      '0057: market_label_normalized must match normalized market_label';
  END IF;
  IF p_entry_origin IS DISTINCT FROM 'structured_menu' THEN
    RAISE EXCEPTION '0057: guided open requires structured_menu entry_origin';
  END IF;

  -- Exact key: hashtextextended(jsonb_build_array(
  --   'guided-owner-v1', source_id, normalized market, business_date)::text, 0).
  v_lock_key := hashtextextended(
    jsonb_build_array(
      'guided-owner-v1',
      v_source,
      v_market,
      p_business_date::text
    )::text,
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT
    count(*)::integer,
    count(DISTINCT nullif(btrim(line_user_id), ''))::integer,
    coalesce(bool_or(nullif(btrim(line_user_id), '') IS NULL), false),
    max(nullif(btrim(line_user_id), ''))
  INTO
    v_matching_rows,
    v_distinct_owners,
    v_has_invalid_owner,
    v_owner
  FROM public.pending_sessions
  WHERE source_id = v_source
    AND business_date = p_business_date
    AND entry_origin = 'structured_menu'
    AND btrim(normalize(btrim(market_label), NFC)) = v_market;

  IF v_matching_rows > 0
     AND (v_has_invalid_owner OR v_distinct_owners <> 1) THEN
    RETURN jsonb_build_object(
      'outcome', 'ownership_conflict',
      'rotated', false,
      'reason', 'ambiguous',
      'session_key', p_session_key,
      'session_generation', NULL
    );
  END IF;

  IF v_matching_rows > 0 AND v_owner IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object(
      'outcome', 'ownership_conflict',
      'rotated', false,
      'reason', 'other_operator',
      'session_key', p_session_key,
      'session_generation', NULL
    );
  END IF;

  RETURN public.open_or_rotate_produce_structured_session(
    p_session_key                    => p_session_key,
    p_source_type                    => p_source_type,
    p_source_id                      => p_source_id,
    p_line_user_id                   => p_line_user_id,
    p_opened_line_event_id           => p_opened_line_event_id,
    p_line_timestamp_ms              => p_line_timestamp_ms,
    p_command_contract_version       => p_command_contract_version,
    p_business_date                  => p_business_date,
    p_transaction_time               => p_transaction_time,
    p_transaction_time_source        => p_transaction_time_source,
    p_staff_label                    => p_staff_label,
    p_market_label                   => p_market_label,
    p_session_kind                   => p_session_kind,
    p_initial_transaction_type       => p_initial_transaction_type,
    p_declared_transaction_type      => p_declared_transaction_type,
    p_additional_opener              => p_additional_opener,
    p_expected_session_generation    => p_expected_session_generation,
    p_entry_origin                   => p_entry_origin
  );
END;
$fn$;

COMMENT ON FUNCTION public.open_or_rotate_guided_produce_structured_session(
  text, text, text, text, text, bigint, integer, date, text, text, text, text,
  text, text, text, text, text, uuid, text
) IS
  'Atomically enforces one structured Guided Menu owner per source, normalized '
  'market and business date, then delegates unchanged open/rotate semantics to '
  'the 0049 RPC in the same transaction. Creates no work_round; work_round_id '
  'remains NULL.';

REVOKE ALL ON FUNCTION public.open_or_rotate_guided_produce_structured_session(
  text, text, text, text, text, bigint, integer, date, text, text, text, text,
  text, text, text, text, text, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_or_rotate_guided_produce_structured_session(
  text, text, text, text, text, bigint, integer, date, text, text, text, text,
  text, text, text, text, text, uuid, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_or_rotate_guided_produce_structured_session(
  text, text, text, text, text, bigint, integer, date, text, text, text, text,
  text, text, text, text, text, uuid, text
) TO service_role;
