-- Pending produce session identity isolation by sender — Release A.
--
-- Scope of THIS migration only:
--   1. pending_sessions.source_id (new, nullable, no backfill).
--   2. Expected-generation guards on the three RPCs the live fast path
--      actually calls with a generation: admit_pending_session_event,
--      append_pending_session, claim_pending_close_finalize.
--
-- This migration assumes the pre-existing session_generation /
-- pending_session_ingest / pending_session_admission /
-- register_pending_session_ingest / check_pending_close_ready schema
-- already exists in production (applied out-of-band, outside any committed
-- migration — see origin/backup/main-before-legacy's
-- 0042_pending_close_ingest.sql, which matches current call sites exactly).
-- It does NOT re-declare, re-create, or otherwise touch that baseline.
-- Reconciling the missing committed migration history for that baseline is
-- a separate database-history problem and is intentionally not solved here.
--
-- Release A bug fixed here: session_key was the bare LINE source id
-- (groupId/roomId/userId), so every sender in the same LINE group shared one
-- pending_sessions row. Application code (src/lib/line/verify.ts
-- getPendingSessionKey) now builds a composite key instead:
--   group:{groupId}:user:{userId}
--   room:{roomId}:user:{userId}
--   dm:{userId}
-- That composite value is ONLY a lookup key. The original LINE source id is
-- preserved separately in the new source_id column for replies/push and for
-- scoping raw-message reconstruction.

-- ── 1. New column: source_id ────────────────────────────────────────────────
--
-- Nullable, no backfill. Existing (pre-rollout) rows keep source_id = NULL;
-- nothing here derives or guesses a source_id for them.
ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS source_id text;

-- ── 2. Legacy bare-key rows: untouched, not migrated, not deleted ───────────
--
-- This is a hard cutover on session_key FORMAT, not a data migration:
--   - Every new composite key matches '^(group|room):[^:]+:user:[^:]+$' or
--     '^dm:[^:]+$'. A pre-rollout row keyed by a bare groupId/roomId/userId
--     can never collide with or be matched by a new composite-key lookup —
--     by construction, not by any check performed here.
--   - lookup(), append_pending_session, admit_pending_session_event, and
--     claim_pending_close_finalize are only ever invoked by application code
--     with a freshly-computed composite session_key (see webhook-service.ts),
--     so none of them can query, append to, admit into, or finalize a
--     legacy bare-key row.
--   - No DELETE, no TRUNCATE, no CASCADE, no automatic cleanup, and no
--     renaming of a legacy row into the new key space happens in this
--     release. Legacy rows are left exactly as they were and simply become
--     unreachable/inert once composite-key traffic is live.
--
-- Operator procedure: a session that is mid-accumulation (header sent, not
-- yet closed) at the exact moment this deploys is stranded under its old
-- bare key. The sender must manually resend the header message after
-- deploy — that starts a brand-new session under the new composite key.
-- No automated recovery/backfill of stranded legacy rows is performed here;
-- treat that as a manual, per-incident operator action if it comes up.

-- ── 3. Generation-pinned mutations ──────────────────────────────────────────
--
-- All three functions below use DROP FUNCTION IF EXISTS + CREATE (not
-- CREATE OR REPLACE) so exactly one, generation-aware overload of each
-- survives this migration — no unguarded prior signature is left resident
-- in pg_proc. Every call site in the repository was grepped
-- (src/lib/line/pending-session-service.ts is the only caller of all three;
-- no other .ts/.sql file invokes them) and always passes the full current
-- argument list, so dropping the old signatures breaks nothing.
--
-- admit_pending_session_event's return type also changes (void → boolean) so
-- a generation conflict can be reported explicitly instead of a silent
-- no-op — CREATE OR REPLACE cannot change a function's return type either,
-- so DROP + CREATE was already required here regardless of the overload
-- concern.
DROP FUNCTION IF EXISTS public.admit_pending_session_event(text, text, bigint);

CREATE FUNCTION public.admit_pending_session_event(
  p_session_key                  text,
  p_line_event_id                text,
  p_line_timestamp_ms            bigint,
  p_expected_session_generation  uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_generation uuid;
BEGIN
  SELECT session_generation INTO v_generation
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_expected_session_generation IS NOT NULL
     AND v_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN false;
  END IF;

  INSERT INTO public.pending_session_admission (
    session_key, session_generation, line_event_id, line_timestamp_ms
  )
  VALUES (p_session_key, v_generation, p_line_event_id, p_line_timestamp_ms)
  ON CONFLICT (session_generation, line_event_id) DO NOTHING;

  RETURN true;
END;
$$;

-- append_pending_session keeps its existing return type (SETOF
-- pending_sessions), but a trailing parameter still changes the function's
-- argument-type signature — CREATE OR REPLACE would add a new overload
-- alongside the previous one rather than replacing it, leaving an unguarded
-- (no expected-generation param) copy permanently callable. Explicitly drop
-- every prior signature so exactly one, generation-aware overload remains:
--   - (text, text, text) — original 0012_append_pending_session_rpc.sql.
--   - (text, text, text, text, bigint, boolean) — the barrier-aware version
--     src/lib/line/pending-session-service.ts called before this migration
--     (applied out-of-band; see file header). No repository caller invokes
--     either shape (confirmed by grep across src/**), so dropping both is
--     safe. IF EXISTS makes this a no-op on a database missing one of them.
-- On a generation mismatch the surviving function returns an empty set,
-- mirroring the existing "session not found" empty-set signal so callers
-- already handling that case correctly reject the write.
DROP FUNCTION IF EXISTS public.append_pending_session(text, text, text);
DROP FUNCTION IF EXISTS public.append_pending_session(text, text, text, text, bigint, boolean);

CREATE FUNCTION public.append_pending_session(
  p_session_key                  text,
  p_new_text                     text,
  p_reply_token                  text,
  p_line_event_id                text    DEFAULT NULL,
  p_line_timestamp_ms            bigint  DEFAULT NULL,
  p_mark_close                   boolean DEFAULT false,
  p_expected_session_generation  uuid    DEFAULT NULL
)
RETURNS SETOF public.pending_sessions
LANGUAGE plpgsql
AS $$
DECLARE
  v_row        public.pending_sessions%ROWTYPE;
  v_generation uuid;
BEGIN
  SELECT session_generation INTO v_generation
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending session not found for append: %', p_session_key;
  END IF;

  IF p_expected_session_generation IS NOT NULL
     AND v_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN; -- empty set: generation conflict — caller must stop/reload
  END IF;

  UPDATE public.pending_sessions
  SET
    accumulated_text         = accumulated_text || E'\n' || p_new_text,
    latest_reply_token       = p_reply_token,
    updated_at               = now(),
    close_event_timestamp_ms = CASE WHEN p_mark_close THEN p_line_timestamp_ms ELSE close_event_timestamp_ms END,
    close_requested_at       = CASE WHEN p_mark_close THEN now()       ELSE close_requested_at END,
    close_line_event_id      = CASE WHEN p_mark_close THEN p_line_event_id ELSE close_line_event_id END
  WHERE session_key = p_session_key
  RETURNING * INTO v_row;

  IF p_line_event_id IS NOT NULL AND p_line_timestamp_ms IS NOT NULL THEN
    INSERT INTO public.pending_session_ingest (
      session_key, session_generation, line_event_id, line_timestamp_ms, raw_text
    )
    VALUES (p_session_key, v_generation, p_line_event_id, p_line_timestamp_ms, p_new_text)
    ON CONFLICT (session_generation, line_event_id) DO UPDATE SET
      raw_text          = EXCLUDED.raw_text,
      line_timestamp_ms = EXCLUDED.line_timestamp_ms;
  END IF;

  RETURN NEXT v_row;
END;
$$;

-- claim_pending_close_finalize keeps its jsonb return type. Same overload
-- caveat as append_pending_session above: adding a parameter would leave an
-- unguarded 1-argument overload resident in pg_proc under CREATE OR REPLACE.
-- Drop the prior (text) signature explicitly first — no repository caller
-- invokes it (confirmed by grep across src/**) — so exactly one,
-- generation-aware overload survives this migration.
DROP FUNCTION IF EXISTS public.claim_pending_close_finalize(text);

CREATE FUNCTION public.claim_pending_close_finalize(
  p_session_key                  text,
  p_expected_session_generation  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_session public.pending_sessions%ROWTYPE;
  v_ready   jsonb;
BEGIN
  SELECT * INTO v_session
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'gone');
  END IF;

  IF p_expected_session_generation IS NOT NULL
     AND v_session.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'generation_conflict');
  END IF;

  IF v_session.close_event_timestamp_ms IS NULL
     OR v_session.close_requested_at IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_closing');
  END IF;

  IF v_session.close_finalize_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_claimed');
  END IF;

  v_ready := public.check_pending_close_ready(p_session_key);

  IF NOT (v_ready->>'ready')::boolean THEN
    RETURN jsonb_build_object(
      'claimed',         false,
      'reason',          v_ready->>'reason',
      'admission_count', v_ready->'admission_count',
      'ingest_count',    v_ready->'ingest_count',
      'straggler_count', v_ready->'straggler_count'
    );
  END IF;

  UPDATE public.pending_sessions
  SET close_finalize_started_at = now()
  WHERE session_key = p_session_key
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'claimed',         true,
    'session',         to_jsonb(v_session),
    'admission_count', v_ready->'admission_count',
    'ingest_count',    v_ready->'ingest_count'
  );
END;
$$;

-- ── 4. Grants ────────────────────────────────────────────────────────────────
--
-- Only the three new/changed signatures above. register_pending_session_ingest
-- and check_pending_close_ready are untouched by this migration, so their
-- existing grants (from whatever applied the out-of-band baseline) are left
-- alone here.
REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_close_finalize(text, uuid) TO service_role;
