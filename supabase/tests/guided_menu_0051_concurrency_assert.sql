-- Assert deterministic consume concurrency outcomes. Never Production.
DO $$
DECLARE
  v_row    public.line_menu_states%ROWTYPE;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.gm51_sync WHERE k = 'race_blocker_observed' AND v = '1'
  ) THEN
    RAISE EXCEPTION 'guided_menu_0051_concurrency FAIL: B was not observed blocked';
  END IF;

  SELECT * INTO v_row FROM public.line_menu_states WHERE token_hash = 'gm51-race-token';

  IF v_row.consumed_at IS NULL THEN
    RAISE EXCEPTION 'guided_menu_0051_concurrency FAIL: token not consumed';
  END IF;

  IF v_row.consumed_line_event_id IS DISTINCT FROM 'evt-race-a' THEN
    RAISE EXCEPTION
      'guided_menu_0051_concurrency FAIL: winner event % not evt-race-a',
      v_row.consumed_line_event_id;
  END IF;

  v_result := public.consume_line_menu_state(
    'gm51-race-token', 'evt-race-b', 'U-race', 'user', 'U-race', 'dm:race-1'
  );
  IF v_result->>'status' IS DISTINCT FROM 'already_consumed' THEN
    RAISE EXCEPTION
      'guided_menu_0051_concurrency FAIL: B replay status % not already_consumed',
      v_result->>'status';
  END IF;

  v_result := public.consume_line_menu_state(
    'gm51-race-token', 'evt-race-a', 'U-race', 'user', 'U-race', 'dm:race-1'
  );
  IF v_result->>'status' IS DISTINCT FROM 'replay' THEN
    RAISE EXCEPTION
      'guided_menu_0051_concurrency FAIL: A replay status % not replay', v_result->>'status';
  END IF;

  RAISE NOTICE 'guided_menu_0051_concurrency: ALL CHECKS PASSED';
END
$$;
