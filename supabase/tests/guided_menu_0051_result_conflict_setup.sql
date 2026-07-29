CREATE TABLE IF NOT EXISTS public.gm51_sync (
  k text PRIMARY KEY,
  v text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $$
DECLARE
  v_hash text := encode(extensions.digest('gm51-result-conflict', 'sha256'), 'hex');
BEGIN
  DELETE FROM public.gm51_sync;
  DELETE FROM public.line_menu_states WHERE token_hash = v_hash;

  INSERT INTO public.line_operator_identities (line_user_id, staff_label, active)
  VALUES ('U-race', 'Race Staff', true)
  ON CONFLICT (line_user_id) DO UPDATE
    SET staff_label = EXCLUDED.staff_label, active = EXCLUDED.active;

  PERFORM public.create_line_menu_state(
    v_hash, 'menu_root', 'U-race', 'user', 'U-race', 'dm:race-1', '{}'::jsonb
  );
  PERFORM public.consume_line_menu_state(
    v_hash, 'evt-result-conflict', 'U-race', 'user', 'U-race', 'dm:race-1'
  );

  RAISE NOTICE 'guided_menu_0051_result_conflict_setup: ready';
END
$$;
