-- Conn B: consume with different event while Conn A holds the row lock.
SELECT public.consume_line_menu_state(
  'gm51-race-token',
  'evt-race-b',
  'U-race',
  'user',
  'U-race',
  'dm:race-1'
) AS consume_b_result;
