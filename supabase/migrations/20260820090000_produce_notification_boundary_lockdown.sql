-- P0 SECURITY LOCKDOWN — produce notification boundary.
--
-- WHAT THIS FIXES
-- ----------------
-- Two tables created by 0034 (produce_session_notifications,
-- produce_notification_attempts) were never given row level security and
-- never had a single GRANT/REVOKE statement issued against them after
-- creation. Two of the four notification RPCs
-- (complete_produce_notification_attempt, requeue_produce_notification) were
-- likewise never revisited after 0034 and still carry only 0034's original
-- `REVOKE ALL ... FROM PUBLIC`, which never reaches a privilege granted
-- directly to a named role.
--
-- ROOT CAUSE — PROVEN, not guessed (read-only introspection of production
-- project apjjsqibavjaitcedavn on 2026-08-20; no writes were issued):
--
--   pg_default_acl for schema public, role postgres:
--     objtype 'r' (tables):    {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
--                                authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--     objtype 'f' (functions): {postgres=X/postgres, anon=X/postgres,
--                                authenticated=X/postgres, service_role=X/postgres}
--   This is a Supabase project-level ALTER DEFAULT PRIVILEGES setting, not
--   anything issued by this repo. Grepping all migration files in this repo
--   confirms zero migrations ever GRANT to anon/authenticated and zero issue
--   ALTER DEFAULT PRIVILEGES or a schema-wide GRANT. Every object created by
--   role postgres in schema public is therefore born with full
--   anon/authenticated/service_role privileges unless a migration explicitly
--   revokes them.
--
--   pg_class.relacl for both notification tables in production matches the
--   table default ACL byte for byte — proof 0034 never issued a single
--   REVOKE/GRANT for either table.
--
--   pg_proc.proacl for complete_produce_notification_attempt and
--   requeue_produce_notification in production matches the function default
--   ACL byte for byte — proof that 0034's `REVOKE ALL ... FROM PUBLIC`
--   (its only statement touching either function) never reached the
--   default-ACL grant made directly to anon/authenticated, and that neither
--   function has been CREATE OR REPLACE'd since.
--
--   claim_due_produce_notifications and try_finalize_pending_generation are
--   clean in production today (postgres=X, service_role=X only) — not
--   because 0034 revoked them correctly (it used the identical, insufficient
--   `FROM PUBLIC` form for all four functions), but because both were later
--   replaced (0050, 0061, 0062, and later produce migrations for
--   try_finalize_pending_generation) by migrations that each additionally
--   issued an explicit `REVOKE ALL ... FROM anon, authenticated`. That
--   defensive pattern is what actually closed their drift.
--
-- This mechanism is already documented in this repo's own history — 0053 and
-- 0054 independently discovered it ("Production carries broad default ACLs.
-- REVOKE FROM service_role BEFORE the intended grant, or an inherited
-- GRANT ALL leaves INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER in
-- place..."). 0034 simply predates that lesson for these two tables, and the
-- two RPCs nobody touched again never inherited the fix.
--
-- SCOPE
-- -----
--   1. Enable AND force row level security on both tables, with ZERO
--      policies added. service_role carries the BYPASSRLS role attribute in
--      every environment this migration checks (see the postcondition
--      block), so FORCE ROW LEVEL SECURITY is a complete no-op for it — the
--      worker's behaviour is byte-for-byte unchanged. FORCE RLS only closes
--      a gap for a hypothetical future non-bypassrls table owner; it costs
--      nothing today.
--   2. Revoke every table privilege from anon and authenticated on both
--      tables. Caller audit (grep of src/app, src/components, and every
--      non-test/non-generated reference to either table name in the repo)
--      found ZERO browser-side or anon/authenticated-key callers of either
--      table. The only consumer is
--      src/lib/line/produce-notification-delivery.ts, invoked exclusively
--      from src/app/api/cron/finalize-pending-produce-sessions/route.ts via
--      createServiceClient() (the service_role key). anon/authenticated
--      therefore get nothing at all — not even SELECT. There is no reader to
--      preserve.
--   3. Re-grant service_role only SELECT, INSERT, UPDATE — the exact verbs
--      the worker (produce-notification-delivery.ts) and
--      try_finalize_pending_generation's notification INSERT use. None of
--      the four notification functions is SECURITY DEFINER (confirmed by
--      grep across every migration touching them), so each runs with the
--      calling role's own table privileges — service_role's grant here is
--      load-bearing, not decorative. DELETE/TRUNCATE/REFERENCES/TRIGGER are
--      dropped even for service_role: nothing in the worker ever issues
--      them.
--   4. Revoke EXECUTE on complete_produce_notification_attempt and
--      requeue_produce_notification from anon/authenticated, walking every
--      existing overload dynamically via pg_proc rather than hardcoding one
--      signature (revoking one overload's EXECUTE privilege does not revoke
--      another). service_role keeps EXECUTE on every overload.
--
-- NOT IN SCOPE
-- ------------
--   * claim_due_produce_notifications, try_finalize_pending_generation: both
--     already service_role-only in production (verified read-only above).
--     Untouched here — re-issuing their grants is unnecessary and this
--     migration's postcondition block only asserts they remain correct.
--   * Any other table's anon SELECT policies. Confidentiality of the wider
--     anon-SELECT read surface across the schema is a separate, later PR.
--   * No RLS policy is added for anon/authenticated here. A future
--     legitimate read/write need must add a scoped, reviewed policy
--     explicitly — never widen this migration to do it implicitly.
--
-- MIXED-VERSION SAFETY
-- ---------------------
--   NEW migration + OLD app: the worker only ever reaches these two tables
--   through supabase.rpc(...) calls issued by a service_role client
--   (createServiceClient()). service_role keeps EXECUTE on every RPC it
--   already used, plus exactly the SELECT/INSERT/UPDATE those RPCs perform
--   internally, and BYPASSRLS makes the new RLS invisible to it. The old app
--   binary is unaffected.
--   OLD migration + NEW app: not applicable. This migration changes no
--   function signature, no RPC contract, and no column. There is no app code
--   in this repo that depends on this migration having landed, so deploy
--   order does not matter functionally — but this migration should land as
--   soon as possible regardless, since it closes a live P0 write/read
--   exposure.
--
-- ROLLBACK (documented per repo convention; nobody should ever run this — it
-- restores the P0). The function grant step is deliberately a dynamic loop
-- over pg_proc, NOT a hardcoded signature: hardcoding one overload is
-- exactly the bug that let claim_due_produce_notifications drift when a
-- second overload was added later (0061/0062). A hardcoded rollback here
-- would silently leave a future overload's EXECUTE grant untouched and the
-- boundary half-restored-half-open.
-- --------
--   ALTER TABLE public.produce_session_notifications NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE public.produce_session_notifications DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.produce_notification_attempts NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE public.produce_notification_attempts DISABLE ROW LEVEL SECURITY;
--   GRANT ALL ON TABLE public.produce_session_notifications, public.produce_notification_attempts
--     TO anon, authenticated, service_role;
--   DO $$
--   DECLARE
--     v_sig text;
--   BEGIN
--     FOR v_sig IN
--       SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public'
--         AND p.proname IN ('complete_produce_notification_attempt', 'requeue_produce_notification')
--     LOOP
--       EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', v_sig);
--     END LOOP;
--   END
--   $$;

-- ── 0) Preconditions ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.produce_session_notifications') IS NULL THEN
    RAISE EXCEPTION '20260820090000: produce_session_notifications is missing; apply 0034 first';
  END IF;
  IF to_regclass('public.produce_notification_attempts') IS NULL THEN
    RAISE EXCEPTION '20260820090000: produce_notification_attempts is missing; apply 0034 first';
  END IF;
END
$$;

-- ── 1) Row level security, no policies ───────────────────────────────────────

ALTER TABLE public.produce_session_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produce_session_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.produce_notification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produce_notification_attempts FORCE ROW LEVEL SECURITY;

-- ── 2) Table privileges ──────────────────────────────────────────────────────
-- Revoke service_role BEFORE the intended re-grant (see 0053/0054): otherwise
-- the inherited default-ACL GRANT ALL survives underneath the narrower grant
-- below and every "narrowed to SELECT/INSERT/UPDATE" claim would be false.

REVOKE ALL ON TABLE public.produce_session_notifications FROM PUBLIC;
REVOKE ALL ON TABLE public.produce_session_notifications FROM anon, authenticated, service_role;
REVOKE ALL ON TABLE public.produce_notification_attempts FROM PUBLIC;
REVOKE ALL ON TABLE public.produce_notification_attempts FROM anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.produce_session_notifications TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.produce_notification_attempts TO service_role;

-- ── 3) Function privileges: close the two drifted RPCs ───────────────────────
-- Signature-agnostic on purpose. Walks every overload pg_proc currently knows
-- about for these two function names instead of hardcoding the one signature
-- that has existed since 0034.

DO $$
DECLARE
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT format(
      '%I.%I(%s)',
      n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
    )
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'complete_produce_notification_attempt',
        'requeue_produce_notification'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END
$$;

-- ── 4) Postconditions ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count      int;
  -- MAINTAIN is new in PG17 (production is 17.6; production relacl for both
  -- tables shows the trailing 'm'). has_table_privilege('...','MAINTAIN')
  -- raises "unrecognized privilege type" on an older server, so this is
  -- gated on the actual running server version rather than assumed.
  v_pg17_plus  boolean := current_setting('server_version_num')::int >= 170000;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('public.produce_session_notifications'::regclass,
                  'public.produce_notification_attempts'::regclass)
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION '20260820090000: RLS must be enabled AND forced on both notification tables';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('produce_session_notifications'), ('produce_notification_attempts')
    ) AS t(tbl)
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role_name)
    CROSS JOIN (
      SELECT p FROM (VALUES
        ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
        ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
      ) AS base(p)
      UNION ALL
      SELECT 'MAINTAIN' WHERE v_pg17_plus
    ) AS priv(p)
    WHERE has_table_privilege(r.role_name, ('public.' || t.tbl)::regclass, priv.p)
  ) THEN
    RAISE EXCEPTION '20260820090000: anon/authenticated must have zero table privileges on the notification tables';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('produce_session_notifications'), ('produce_notification_attempts')
    ) AS t(tbl)
    WHERE NOT has_table_privilege('service_role', ('public.' || t.tbl)::regclass, 'SELECT')
       OR NOT has_table_privilege('service_role', ('public.' || t.tbl)::regclass, 'INSERT')
       OR NOT has_table_privilege('service_role', ('public.' || t.tbl)::regclass, 'UPDATE')
       OR has_table_privilege('service_role', ('public.' || t.tbl)::regclass, 'DELETE')
       OR has_table_privilege('service_role', ('public.' || t.tbl)::regclass, 'TRUNCATE')
       OR (v_pg17_plus
           AND has_table_privilege('service_role', ('public.' || t.tbl)::regclass, 'MAINTAIN'))
  ) THEN
    RAISE EXCEPTION '20260820090000: service_role must have exactly SELECT/INSERT/UPDATE on the notification tables';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('complete_produce_notification_attempt', 'requeue_produce_notification')
    AND (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
    );
  IF v_count <> 0 THEN
    RAISE EXCEPTION '20260820090000: found % notification RPC overload(s) with the wrong EXECUTE grants', v_count;
  END IF;

  -- Canary: if service_role ever loses BYPASSRLS, FORCE RLS above silently
  -- starts blocking the worker. This migration's safety argument depends on
  -- it, so it is asserted here, not just narrated in a comment.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION '20260820090000: service_role must have BYPASSRLS or this migration breaks the notification worker';
  END IF;
END
$$;
