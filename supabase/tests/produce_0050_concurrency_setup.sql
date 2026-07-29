-- Setup for real two-connection 0050 concurrency proof. Never Production.
-- Requires 0050 + produce stubs from produce_0050_verification.sql already applied.

CREATE OR REPLACE FUNCTION pg_temp.p50c_open(
  p_key text, p_user text, p_event text
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.open_or_rotate_produce_structured_session(
    p_key, 'user', p_user, p_user, p_event, 1800000100000, 1,
    DATE '2026-07-28', '09:15', 'operator_declared', 'พี่ดำ', 'วิหาร',
    'main', 'เบิก', NULL, NULL, NULL, 'structured_menu'
  );
$$;

DO $$
DECLARE
  v_result jsonb;
  v_gen uuid;
BEGIN
  -- Race fixture: held + parity ready. Conn A will lock; Conn B will confirm.
  v_result := pg_temp.p50c_open('dm:U-conc','U-conc','evt-open-conc');
  v_gen := (v_result->>'session_generation')::uuid;
  PERFORM public.close_produce_structured_session(
    'dm:U-conc','U-conc','evt-close-conc', 1800000105000, v_gen, NULL
  );
  INSERT INTO public.pending_session_admission
    (session_key, session_generation, line_event_id, line_timestamp_ms)
  VALUES ('dm:U-conc', v_gen, 'conc-1', 1800000104000)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.pending_session_ingest
    (session_key, session_generation, line_event_id, line_timestamp_ms, raw_text)
  VALUES ('dm:U-conc', v_gen, 'conc-1', 1800000104000, '1.มะละกอ10บาท')
  ON CONFLICT DO NOTHING;
  UPDATE public.pending_sessions
     SET next_attempt_at = now() - interval '1 second'
   WHERE session_key = 'dm:U-conc';

  -- Exactly-once fixture: already confirmed, ready for twin try_finalize.
  v_result := pg_temp.p50c_open('dm:U-once2','U-once2','evt-open-once2');
  v_gen := (v_result->>'session_generation')::uuid;
  PERFORM public.close_produce_structured_session(
    'dm:U-once2','U-once2','evt-close-once2', 1800000115000, v_gen, NULL
  );
  INSERT INTO public.pending_session_admission
    (session_key, session_generation, line_event_id, line_timestamp_ms)
  VALUES ('dm:U-once2', v_gen, 'once2-1', 1800000114000)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.pending_session_ingest
    (session_key, session_generation, line_event_id, line_timestamp_ms, raw_text)
  VALUES ('dm:U-once2', v_gen, 'once2-1', 1800000114000, '1.ฝรั่ง10บาท')
  ON CONFLICT DO NOTHING;
  PERFORM public.confirm_produce_structured_finalization(
    'dm:U-once2','U-once2','evt-confirm-once2', v_gen
  );
  INSERT INTO public.raw_messages(id)
  VALUES ('00000000-0000-4000-8000-000000000050')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'produce_0050_concurrency_setup: ready';
END
$$;
