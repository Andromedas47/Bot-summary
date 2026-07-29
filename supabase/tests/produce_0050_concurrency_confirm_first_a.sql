-- Conn A ordering B: confirm first, then wait on advisory gate held by monitor.
BEGIN;

SELECT public.confirm_produce_structured_finalization(
  'dm:U-cfm1',
  'U-cfm1',
  'evt-confirm-cfm1',
  (SELECT session_generation FROM public.pending_sessions WHERE session_key = 'dm:U-cfm1')
) AS confirm_first_result;

SELECT pg_advisory_lock(9100502);

COMMIT;
