-- Conn B ordering A: confirm while finalizer still holds the row lock.
SELECT public.confirm_produce_structured_finalization(
  'dm:U-fin1',
  'U-fin1',
  'evt-confirm-fin1',
  (SELECT session_generation FROM public.pending_sessions WHERE session_key = 'dm:U-fin1')
) AS confirm_after_fin_lock;
