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

-- ── 3. Generation-pinned mutations — backward-compatible rollout ───────────
--
-- Deployed origin/main still calls the OLD signatures (3/6/1-arg) at the
-- moment this migration runs — code deploy and migration apply are two
-- separate events with no guaranteed ordering. This migration must
-- therefore leave every old signature callable:
--
--   1. The new generation-pinned signature is created first (distinct
--      arity — a new overload, not a replacement).
--   2. The old signature is re-created (CREATE OR REPLACE; return type is
--      unchanged for append/claim, so this is a true in-place replace, not
--      a new overload) as a thin wrapper that forwards to the new
--      signature with expected_generation = NULL — i.e. "don't check",
--      identical to the new function's own behavior when NULL is passed.
--   3. Nothing is DROPped in this migration. Both old and new signatures
--      are simultaneously live and grants are re-applied to both, so
--      whichever code (old, pre-deploy or new, post-deploy) happens to be
--      running at any point mid-rollout keeps working.
--   4. A follow-up cleanup migration (after this release) will DROP the
--      old signatures once production is confirmed fully on the new code
--      and no old caller remains — not part of this migration.
--
-- Every call site in the repository was grepped
-- (src/lib/line/pending-session-service.ts is the only caller of all three;
-- no other .ts/.sql file invokes them), and the new application code always
-- passes the full new argument list (including expected_generation, even
-- when NULL) — so it always resolves to the new overload, never the old
-- wrapper. Old, already-deployed code passes the old, shorter argument
-- list — so it always resolves to the old wrapper.

-- admit_pending_session_event: new 4-arg boolean signature first. No
-- DEFAULT on p_expected_session_generation: a default here would make this
-- 4-arg signature callable with only 3 supplied arguments, which is
-- ambiguous against the old 3-arg wrapper below (PostgreSQL cannot pick
-- between "exact 3-arg match" and "4-arg match with 1 default filled" in
-- all call shapes) — keeping it required means only a call that explicitly
-- supplies all 4 arguments resolves here.
CREATE FUNCTION public.admit_pending_session_event(
  p_session_key                  text,
  p_line_event_id                text,
  p_line_timestamp_ms            bigint,
  p_expected_session_generation  uuid
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

-- Old 3-arg void wrapper: forwards to the new 4-arg function with
-- expected_generation = NULL (unconditional admit, matching the old
-- behavior exactly) and discards the boolean result so the return type
-- (void) — and therefore old callers' contract — is unchanged.
CREATE OR REPLACE FUNCTION public.admit_pending_session_event(
  p_session_key       text,
  p_line_event_id     text,
  p_line_timestamp_ms bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.admit_pending_session_event(
    p_session_key, p_line_event_id, p_line_timestamp_ms, NULL::uuid
  );
END;
$$;

-- append_pending_session: new 7-arg signature first. Same return type
-- (SETOF pending_sessions) as every prior version of this function. On a
-- generation mismatch it returns an empty set, mirroring the existing
-- "session not found" empty-set signal so callers already handling that
-- case correctly reject the write.
-- No DEFAULT on p_expected_session_generation (same ambiguity reason as
-- admit_pending_session_event above). PostgreSQL requires defaulted
-- parameters to be a trailing group — once the last parameter has no
-- default, none of the parameters before it may have one either — so
-- p_line_event_id/p_line_timestamp_ms/p_mark_close also drop their DEFAULTs
-- here. This is a compile-validity consequence of the trailing-uuid fix,
-- not a scope change: the application (pending-session-service.ts) already
-- supplies all 7 named arguments on every call, so this signature is always
-- called fully populated regardless.
CREATE FUNCTION public.append_pending_session(
  p_session_key                  text,
  p_new_text                     text,
  p_reply_token                  text,
  p_line_event_id                text,
  p_line_timestamp_ms            bigint,
  p_mark_close                   boolean,
  p_expected_session_generation  uuid
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

-- Old 6-arg wrapper (the barrier-aware version deployed on origin/main —
-- see file header re: out-of-band application). Same return type
-- (SETOF pending_sessions), so CREATE OR REPLACE is a true in-place
-- replace here, not a new overload. Forwards to the new 7-arg function
-- with expected_generation = NULL (unconditional append, matching the old
-- behavior exactly).
--
-- NOTE: the original (text, text, text) 3-arg signature from
-- 0012_append_pending_session_rpc.sql is NOT touched by this migration
-- either way — nothing in the currently deployed code calls it, and
-- leaving it exactly as-is (whatever state it is in on production today)
-- is strictly more conservative than modifying it. It is left for the
-- follow-up cleanup migration to assess and drop alongside the other old
-- signatures once production history is reconciled.
CREATE OR REPLACE FUNCTION public.append_pending_session(
  p_session_key       text,
  p_new_text          text,
  p_reply_token       text,
  p_line_event_id     text    DEFAULT NULL,
  p_line_timestamp_ms bigint  DEFAULT NULL,
  p_mark_close        boolean DEFAULT false
)
RETURNS SETOF public.pending_sessions
LANGUAGE sql
AS $$
  SELECT * FROM public.append_pending_session(
    p_session_key, p_new_text, p_reply_token,
    p_line_event_id, p_line_timestamp_ms, p_mark_close,
    NULL::uuid
  );
$$;

-- claim_pending_close_finalize: new 2-arg signature first. Same jsonb
-- return type as every prior version. No DEFAULT on
-- p_expected_session_generation (same ambiguity reason as
-- admit_pending_session_event above) — p_session_key already has no
-- default, so this doesn't affect it.
CREATE FUNCTION public.claim_pending_close_finalize(
  p_session_key                  text,
  p_expected_session_generation  uuid
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

-- Old 1-arg wrapper. Same jsonb return type, so CREATE OR REPLACE is a true
-- in-place replace here. Forwards to the new 2-arg function with
-- expected_generation = NULL (unconditional claim, matching the old
-- behavior exactly).
CREATE OR REPLACE FUNCTION public.claim_pending_close_finalize(
  p_session_key text
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.claim_pending_close_finalize(p_session_key, NULL::uuid);
$$;

-- ── 4. Grants ────────────────────────────────────────────────────────────────
--
-- Every signature that is live during the rollout window — old wrapper AND
-- new generation-pinned function — gets an explicit grant, since a brand
-- new overload (the three "new" signatures created above) does not inherit
-- grants from a same-named function with a different argument list.
-- register_pending_session_ingest and check_pending_close_ready are
-- untouched by this migration, so their existing grants (from whatever
-- applied the out-of-band baseline) are left alone here.
REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_pending_session_event(text, text, bigint) TO service_role;
REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_pending_session(text, text, text, text, bigint, boolean, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_close_finalize(text) TO service_role;
REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_close_finalize(text, uuid) TO service_role;
