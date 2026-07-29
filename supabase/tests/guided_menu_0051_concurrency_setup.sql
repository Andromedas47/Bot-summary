-- Fixtures for deterministic two-connection 0051 consume races.
-- Never Production. Requires guided_menu_0051_verification tables/RPCs.

CREATE TABLE IF NOT EXISTS public.gm51_sync (
  k text PRIMARY KEY,
  v text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $$
DECLARE
  v_hash text := encode(extensions.digest('gm51-race-token', 'sha256'), 'hex');
BEGIN
  DELETE FROM public.gm51_sync;
  DELETE FROM public.line_menu_states WHERE token_hash = v_hash;

  INSERT INTO public.line_operator_identities (line_user_id, staff_label, active)
  VALUES ('U-race', 'Race Staff', true)
  ON CONFLICT (line_user_id) DO UPDATE
    SET staff_label = EXCLUDED.staff_label, active = EXCLUDED.active;

  PERFORM public.create_line_menu_state(
    v_hash,
    'menu_root',
    'U-race',
    'user',
    'U-race',
    'dm:race-1',
    '{}'::jsonb
  );

  RAISE NOTICE 'guided_menu_0051_concurrency_setup: ready hash=%', v_hash;
END
$$;
