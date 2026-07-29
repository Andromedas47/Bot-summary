-- Conn A ordering A: real try_finalize, then wait on advisory gate held by monitor.
BEGIN;

SELECT public.try_finalize_pending_generation(
  'dm:U-fin1',
  (SELECT session_generation FROM public.pending_sessions WHERE session_key = 'dm:U-fin1'),
  'U-fin1',
  (SELECT ingest_revision FROM public.pending_sessions WHERE session_key = 'dm:U-fin1'),
  'hash-fin1',
  '1.มะละกอ10บาท',
  jsonb_build_object(
    'raw_message_id', '00000000-0000-4000-8000-000000000061',
    'staff_name', 'พี่ดำ',
    'session_kind', 'main',
    'validation_errors', '[]'::jsonb,
    'ingest_idempotency_key',
      'dm:U-fin1:' || (
        SELECT session_generation::text FROM public.pending_sessions WHERE session_key = 'dm:U-fin1'
      ),
    'ingest_source', 'line_webhook'
  ),
  '[]'::jsonb
) AS fin_first_result;

-- Blocks until monitor unlocks 9100501. Waiting here proves try_finalize finished
-- while this transaction still holds the pending_sessions row lock.
SELECT pg_advisory_lock(9100501);

COMMIT;
