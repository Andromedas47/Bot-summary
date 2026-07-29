SELECT public.record_line_menu_state_result(
  encode(extensions.digest('gm51-result-conflict', 'sha256'), 'hex'),
  'evt-result-conflict',
  'U-race',
  'user',
  'U-race',
  'dm:race-1',
  jsonb_build_object('screen', 'second')
) AS record_b_result;
