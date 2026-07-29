-- Connection A: hold the pending row lock, then release.
BEGIN;
SELECT session_key
  FROM public.pending_sessions
 WHERE session_key = 'dm:U-conc'
 FOR UPDATE;
SELECT pg_sleep(2);
COMMIT;
