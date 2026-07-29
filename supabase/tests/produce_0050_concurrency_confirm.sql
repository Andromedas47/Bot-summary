-- Connection B: confirm while Conn A may hold the row lock.
SELECT public.confirm_produce_structured_finalization(
  'dm:U-conc',
  'U-conc',
  'evt-confirm-conc',
  (SELECT session_generation FROM public.pending_sessions WHERE session_key = 'dm:U-conc')
) AS confirm_result;
