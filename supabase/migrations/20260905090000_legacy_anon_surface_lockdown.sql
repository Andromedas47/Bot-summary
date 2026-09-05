-- Forward-only ACL/RLS repair; no data changes. Business reads use service_role,
-- including raw_messages/parse_errors, so their old PUBLIC policies need no replacement.
-- Keep authenticated defaults and unrelated authenticated policies unchanged.
-- supabase_admin defaults are deliberately excluded: managed-role membership is
-- not portable. Objects created by that owner require a separate privileged audit.
-- PostgreSQL's built-in PUBLIC EXECUTE default cannot be revoked per schema.
-- Intentionally fail closed for FUTURE postgres-created functions in every schema;
-- existing functions and other owners' defaults are unaffected.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon;

DO $$
DECLARE
  relation_name text;
  relation_id regclass;
  legacy_policy record;
  rpc regprocedure;
  signature text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'raw_messages', 'parse_errors', 'daily_summaries', 'line_groups',
    'produce_items', 'produce_round_events', 'produce_sessions',
    'settlement_draft_history', 'settlement_drafts', 'work_round_selections',
    'work_rounds', 'produce_transactions', 'produce_transactions_all'
  ] LOOP
    relation_id := to_regclass(format('public.%I', relation_name));
    IF relation_id IS NULL THEN CONTINUE; END IF;

    -- Match role/command rather than policy names, which differ in production.
    FOR legacy_policy IN
      SELECT polname FROM pg_policy
      WHERE polrelid = relation_id AND polcmd = 'r' AND polpermissive
        AND (0::oid = ANY(polroles)
          OR 'anon'::regrole::oid = ANY(polroles))
    LOOP
      EXECUTE format('DROP POLICY %I ON %s', legacy_policy.polname, relation_id);
    END LOOP;
    EXECUTE format('REVOKE SELECT ON TABLE %s FROM anon', relation_id);
  END LOOP;

  FOREACH signature IN ARRAY ARRAY[
    'public.claim_work_round_selection(uuid,text,text,integer,text[])',
    'public.insert_produce_round_events_ignore(jsonb)'
  ] LOOP
    rpc := to_regprocedure(signature);
    IF rpc IS NULL THEN CONTINUE; END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', rpc);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', rpc);
  END LOOP;
END
$$;
