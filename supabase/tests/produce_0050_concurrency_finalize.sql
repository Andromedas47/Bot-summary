-- Concurrent try_finalize against an already-confirmed structured session.
SELECT public.try_finalize_pending_generation(
  'dm:U-once2',
  (SELECT session_generation FROM public.pending_sessions WHERE session_key = 'dm:U-once2'),
  'U-once2',
  (SELECT ingest_revision FROM public.pending_sessions WHERE session_key = 'dm:U-once2'),
  'hash-conc-once2',
  '1.ฝรั่ง10บาท',
  jsonb_build_object(
    'raw_message_id', '00000000-0000-4000-8000-000000000050',
    'staff_name', 'พี่ดำ',
    'session_date', '2026-07-28',
    'session_title', 'วิหาร',
    'session_kind', 'main',
    'validation_errors', '[]'::jsonb,
    'ingest_idempotency_key',
      'dm:U-once2:' || (
        SELECT session_generation::text
          FROM public.pending_sessions
         WHERE session_key = 'dm:U-once2'
      ),
    'ingest_source', 'line_webhook'
  ),
  jsonb_build_array(
    jsonb_build_object(
      'item_number', '1',
      'product_name', 'ฝรั่ง',
      'price_per_unit', '10',
      'quantity', '1',
      'unit', 'โล',
      'section', 'main',
      'transaction_type', 'เบิก',
      'item_hash', 'item-once2-1'
    )
  )
) AS finalize_result;
