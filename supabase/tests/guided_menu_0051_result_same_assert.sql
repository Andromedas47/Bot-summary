DO $$
DECLARE
  v_row public.line_menu_states%ROWTYPE;
  v_hash text := encode(extensions.digest('gm51-result-same', 'sha256'), 'hex');
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.gm51_sync WHERE k = 'result_same_blocker_observed' AND v = '1'
  ) THEN
    RAISE EXCEPTION 'guided_menu_0051_result_same FAIL: B was not observed blocked';
  END IF;

  SELECT * INTO v_row FROM public.line_menu_states WHERE token_hash = v_hash;
  IF v_row.result IS NULL THEN
    RAISE EXCEPTION 'guided_menu_0051_result_same FAIL: no result stored';
  END IF;
  IF v_row.result <> jsonb_build_object('screen', 'same', 'n', 1) THEN
    RAISE EXCEPTION 'guided_menu_0051_result_same FAIL: unexpected result %', v_row.result;
  END IF;

  v_result := public.record_line_menu_state_result(
    v_hash, 'evt-result-same', 'U-race', 'user', 'U-race', 'dm:race-1',
    jsonb_build_object('screen', 'same', 'n', 1)
  );
  IF v_result->>'status' IS DISTINCT FROM 'replay' THEN
    RAISE EXCEPTION 'guided_menu_0051_result_same FAIL: expected replay got %', v_result;
  END IF;

  RAISE NOTICE 'guided_menu_0051_result_same: ALL CHECKS PASSED';
END
$$;
