-- Fixtures for deterministic two-connection 0051 consume races.
-- Never Production. Requires guided_menu_0051_verification tables/RPCs.

CREATE TABLE IF NOT EXISTS public.gm51_sync (
  k text PRIMARY KEY,
  v text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $$
BEGIN
  DELETE FROM public.gm51_sync;

  INSERT INTO public.line_operator_identities (line_user_id, staff_label, active)
  VALUES ('U-race', 'Race Staff', true)
  ON CONFLICT (line_user_id) DO UPDATE
    SET staff_label = EXCLUDED.staff_label, active = EXCLUDED.active;

  INSERT INTO public.line_menu_states (
    token_hash, action_type, line_user_id, source_type, source_id,
    session_key, payload, expires_at
  ) VALUES (
    'gm51-race-token',
    'menu_root',
    'U-race',
    'user',
    'U-race',
    'dm:race-1',
    '{}'::jsonb,
    now() + interval '1 hour'
  )
  ON CONFLICT (token_hash) DO UPDATE
    SET consumed_at = NULL,
        consumed_line_event_id = NULL,
        result = NULL,
        expires_at = now() + interval '1 hour',
        updated_at = now();

  RAISE NOTICE 'guided_menu_0051_concurrency_setup: ready';
END
$$;
