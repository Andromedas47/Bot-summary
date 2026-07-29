SELECT public.record_line_menu_state_result(
  encode(extensions.digest('gm51-result-same', 'sha256'), 'hex'),
  'evt-result-same',
  'U-race',
  'user',
  'U-race',
  'dm:race-1',
  jsonb_build_object('screen', 'same', 'n', 1)
) AS record_b_result;
