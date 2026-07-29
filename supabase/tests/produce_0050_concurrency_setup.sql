-- Fixtures for deterministic two-connection 0050 races + crash recovery.
-- Never Production. Requires produce stubs from produce_0050_verification.sql.

CREATE TABLE IF NOT EXISTS public.p50_sync (
  k text PRIMARY KEY,
  v text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION pg_temp.p50c_open(
  p_key text, p_user text, p_event text
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.open_or_rotate_produce_structured_session(
    p_key, 'user', p_user, p_user, p_event, 1800000100000, 1,
    DATE '2026-07-28', '09:15', 'operator_declared', 'พี่ดำ', 'วิหาร',
    'main', 'เบิก', NULL, NULL, NULL, 'structured_menu'
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.p50c_seed_held(
  p_key text, p_user text, p_open text, p_close text, p_item text, p_ts bigint
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
  v_gen uuid;
BEGIN
  v_result := pg_temp.p50c_open(p_key, p_user, p_open);
  v_gen := (v_result->>'session_generation')::uuid;
  PERFORM public.close_produce_structured_session(
    p_key, p_user, p_close, p_ts + 5000, v_gen, NULL
  );
  INSERT INTO public.pending_session_admission
    (session_key, session_generation, line_event_id, line_timestamp_ms)
  VALUES (p_key, v_gen, p_item, p_ts + 4000)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.pending_session_ingest
    (session_key, session_generation, line_event_id, line_timestamp_ms, raw_text)
  VALUES (p_key, v_gen, p_item, p_ts + 4000, '1.มะละกอ10บาท')
  ON CONFLICT DO NOTHING;
  UPDATE public.pending_sessions
     SET next_attempt_at = now() - interval '1 second'
   WHERE session_key = p_key;
  RETURN v_gen;
END;
$$;

DO $$
DECLARE
  v_gen uuid;
BEGIN
  DELETE FROM public.p50_sync;

  -- Ordering A: finalizer acquires row lock first (held + ready).
  PERFORM pg_temp.p50c_seed_held(
    'dm:U-fin1', 'U-fin1', 'evt-open-fin1', 'evt-close-fin1', 'fin1-item', 1800000200000
  );

  -- Ordering B: confirm acquires row lock first (held + ready).
  PERFORM pg_temp.p50c_seed_held(
    'dm:U-cfm1', 'U-cfm1', 'evt-open-cfm1', 'evt-close-cfm1', 'cfm1-item', 1800000210000
  );

  -- Twin finalize after confirm (exactly-once).
  v_gen := pg_temp.p50c_seed_held(
    'dm:U-once2', 'U-once2', 'evt-open-once2', 'evt-close-once2', 'once2-1', 1800000220000
  );
  PERFORM public.confirm_produce_structured_finalization(
    'dm:U-once2', 'U-once2', 'evt-confirm-once2', v_gen
  );
  INSERT INTO public.raw_messages(id)
  VALUES
    ('00000000-0000-4000-8000-000000000050'),
    ('00000000-0000-4000-8000-000000000062')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'produce_0050_concurrency_setup: ready';
END
$$;
