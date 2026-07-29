DO $$
DECLARE
  v_row public.line_menu_states%ROWTYPE;
  v_hash text := encode(extensions.digest('gm51-result-conflict', 'sha256'), 'hex');
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.gm51_sync WHERE k = 'result_conflict_blocker_observed' AND v = '1'
  ) THEN
    RAISE EXCEPTION 'guided_menu_0051_result_conflict FAIL: B was not observed blocked';
  END IF;

  SELECT * INTO v_row FROM public.line_menu_states WHERE token_hash = v_hash;
  IF v_row.result IS DISTINCT FROM jsonb_build_object('screen', 'first') THEN
    RAISE EXCEPTION
      'guided_menu_0051_result_conflict FAIL: first result not retained (%)',
      v_row.result;
  END IF;

  v_result := public.record_line_menu_state_result(
    v_hash, 'evt-result-conflict', 'U-race', 'user', 'U-race', 'dm:race-1',
    jsonb_build_object('screen', 'second')
  );
  IF v_result->>'status' IS DISTINCT FROM 'result_conflict' THEN
    RAISE EXCEPTION
      'guided_menu_0051_result_conflict FAIL: expected result_conflict got %',
      v_result;
  END IF;
  IF v_result->'result'->>'screen' IS DISTINCT FROM 'first' THEN
    RAISE EXCEPTION 'guided_menu_0051_result_conflict FAIL: conflict leaked second result';
  END IF;

  RAISE NOTICE 'guided_menu_0051_result_conflict: ALL CHECKS PASSED';
END
$$;
