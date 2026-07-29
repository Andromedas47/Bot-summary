-- Conn B: consume with different event while Conn A holds the row lock.
SELECT public.consume_line_menu_state(
  encode(extensions.digest('gm51-race-token', 'sha256'), 'hex'),
  'evt-race-b',
  'U-race',
  'user',
  'U-race',
  'dm:race-1'
) AS consume_b_result;
