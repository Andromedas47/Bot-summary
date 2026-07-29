-- Conn B ordering B: lock row first (blocks while confirm holds), then finalize
-- with the post-confirm revision so the concurrent try_finalize path is real.
WITH locked AS (
  SELECT session_generation, ingest_revision
  FROM public.pending_sessions
  WHERE session_key = 'dm:U-cfm1'
  FOR UPDATE
)
SELECT public.try_finalize_pending_generation(
  'dm:U-cfm1',
  locked.session_generation,
  'U-cfm1',
  locked.ingest_revision,
  'hash-cfm1',
  '1.มะละกอ10บาท',
  jsonb_build_object(
    'raw_message_id', '00000000-0000-4000-8000-000000000062',
    'staff_name', 'พี่ดำ',
    'session_date', '2026-07-28',
    'session_title', 'วิหาร',
    'session_kind', 'main',
    'validation_errors', '[]'::jsonb,
    'ingest_idempotency_key',
      'dm:U-cfm1:' || locked.session_generation::text,
    'ingest_source', 'line_webhook'
  ),
  jsonb_build_array(
    jsonb_build_object(
      'item_number', '1',
      'product_name', 'มะละกอ',
      'price_per_unit', '10',
      'quantity', '1',
      'unit', 'โล',
      'section', 'main',
      'transaction_type', 'เบิก',
      'item_hash', 'item-cfm1-1'
    )
  )
) AS finalize_after_confirm_lock
FROM locked;
