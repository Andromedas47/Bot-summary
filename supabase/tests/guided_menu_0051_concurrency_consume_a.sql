-- Conn A: first consume wins, then wait on advisory gate 9100511 while holding row lock.
BEGIN;

SELECT public.consume_line_menu_state(
  encode(extensions.digest('gm51-race-token', 'sha256'), 'hex'),
  'evt-race-a',
  'U-race',
  'user',
  'U-race',
  'dm:race-1'
) AS consume_a_result;

-- Blocks until harness unlocks 9100511. Waiting here proves consume finished
-- the UPDATE while this transaction still holds the line_menu_states row lock.
SELECT pg_advisory_lock(9100511);

COMMIT;
