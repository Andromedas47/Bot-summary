-- Pending produce session identity isolation by sender.
--
-- Context: this repo's committed migration history never captured the
-- generation/ingest/admission barrier schema that src/lib/line/
-- pending-session-service.ts already depends on (session_generation,
-- pending_session_ingest, pending_session_admission,
-- admit_pending_session_event, append_pending_session,
-- register_pending_session_ingest, check_pending_close_ready,
-- claim_pending_close_finalize). That schema was applied to production
-- directly, outside of a committed migration, during now-diverged work
-- (confirmed against origin/backup/main-before-legacy's
-- 0042_pending_close_ingest.sql, which matches current call sites exactly).
--
-- Section 1 re-declares that baseline idempotently (ADD COLUMN IF NOT
-- EXISTS / CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE) so this
-- migration is safe to run against production (no-ops on what already
-- exists) and also safe against a fresh database. Section 2 onward is the
-- actual Release A change: sender-scoped session identity.
--
-- Release A bug fixed here: session_key was the bare LINE source id
-- (groupId/roomId/userId), so every sender in the same LINE group shared
-- one pending_sessions row. Application code (src/lib/line/verify.ts
-- getPendingSessionKey) now builds a composite key instead:
--   group:{groupId}:user:{userId}
--   room:{roomId}:user:{userId}
--   dm:{userId}
-- That composite value is ONLY a lookup key. The original LINE source id
-- is preserved separately in the new source_id column for replies/push and
-- for scoping raw-message reconstruction.

-- ── 1. Re-declare the pre-existing (undocumented) barrier schema ────────────

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS session_generation       uuid        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS close_event_timestamp_ms bigint,
  ADD COLUMN IF NOT EXISTS close_requested_at        timestamptz,
  ADD COLUMN IF NOT EXISTS close_line_event_id       text,
  ADD COLUMN IF NOT EXISTS close_finalize_started_at timestamptz;

CREATE TABLE IF NOT EXISTS public.pending_session_ingest (
  session_key         text        NOT NULL REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE,
  session_generation  uuid        NOT NULL,
  line_event_id       text        NOT NULL,
  line_timestamp_ms   bigint      NOT NULL,
  raw_text            text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);

CREATE INDEX IF NOT EXISTS pending_session_ingest_session_key_idx
  ON public.pending_session_ingest (session_key, session_generation, line_timestamp_ms);

CREATE TABLE IF NOT EXISTS public.pending_session_admission (
  session_key         text        NOT NULL REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE,
  session_generation  uuid        NOT NULL,
  line_event_id       text        NOT NULL,
  line_timestamp_ms   bigint      NOT NULL,
  admitted_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);

CREATE INDEX IF NOT EXISTS pending_session_admission_session_key_idx
  ON public.pending_session_admission (session_key, session_generation, line_timestamp_ms);

CREATE OR REPLACE FUNCTION public.register_pending_session_ingest(
  p_session_key         text,
  p_line_event_id       text,
  p_line_timestamp_ms   bigint,
  p_raw_text            text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_generation uuid;
BEGIN
  SELECT session_generation INTO v_generation
  FROM public.pending_sessions
  WHERE session_key = p_session_key;

  IF NOT FOUND OR p_raw_text IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.pending_session_ingest (
    session_key, session_generation, line_event_id, line_timestamp_ms, raw_text
  )
  VALUES (p_session_key, v_generation, p_line_event_id, p_line_timestamp_ms, p_raw_text)
  ON CONFLICT (session_generation, line_event_id) DO UPDATE SET
    raw_text          = EXCLUDED.raw_text,
    line_timestamp_ms = EXCLUDED.line_timestamp_ms;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_pending_close_ready(p_session_key text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_session public.pending_sessions%ROWTYPE;
  v_admission_count int;
  v_ingest_count int;
  v_straggler_count int;
BEGIN
  SELECT * INTO v_session
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_session.close_event_timestamp_ms IS NULL
     OR v_session.close_requested_at IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'not_closing');
  END IF;

  SELECT COUNT(*)::int INTO v_admission_count
  FROM public.pending_session_admission a
  WHERE a.session_key = p_session_key
    AND a.session_generation = v_session.session_generation
    AND a.line_timestamp_ms <= v_session.close_event_timestamp_ms;

  SELECT COUNT(*)::int INTO v_ingest_count
  FROM public.pending_session_ingest i
  WHERE i.session_key = p_session_key
    AND i.session_generation = v_session.session_generation
    AND i.line_timestamp_ms <= v_session.close_event_timestamp_ms
    AND i.raw_text IS NOT NULL
    AND btrim(i.raw_text) <> '';

  SELECT COUNT(*)::int INTO v_straggler_count
  FROM public.pending_session_admission a
  WHERE a.session_key = p_session_key
    AND a.session_generation = v_session.session_generation
    AND a.line_timestamp_ms <= v_session.close_event_timestamp_ms
    AND a.admitted_at > v_session.close_requested_at
    AND NOT EXISTS (
      SELECT 1
      FROM public.pending_session_ingest i
      WHERE i.session_generation = a.session_generation
        AND i.line_event_id = a.line_event_id
        AND i.raw_text IS NOT NULL
        AND btrim(i.raw_text) <> ''
    );

  IF v_admission_count = 0
     AND btrim(v_session.accumulated_text) <> ''
     AND (
       SELECT COUNT(*)::int
       FROM regexp_split_to_table(btrim(v_session.accumulated_text), E'\n') AS t(line)
       WHERE btrim(line) <> ''
     ) >= 3
  THEN
    RETURN jsonb_build_object(
      'ready',           true,
      'reason',          'legacy_accumulated',
      'admission_count', v_admission_count,
      'ingest_count',    v_ingest_count,
      'straggler_count', v_straggler_count,
      'session_generation', v_session.session_generation,
      'close_event_timestamp_ms', v_session.close_event_timestamp_ms
    );
  END IF;

  RETURN jsonb_build_object(
    'ready',           (v_admission_count = v_ingest_count AND v_straggler_count = 0 AND v_admission_count > 0),
    'reason',          CASE
                         WHEN v_admission_count = 0 THEN 'no_admissions'
                         WHEN v_admission_count <> v_ingest_count THEN 'awaiting_ingest'
                         WHEN v_straggler_count > 0 THEN 'stragglers'
                         ELSE 'ready'
                       END,
    'admission_count', v_admission_count,
    'ingest_count',    v_ingest_count,
    'straggler_count', v_straggler_count,
    'session_generation', v_session.session_generation,
    'close_event_timestamp_ms', v_session.close_event_timestamp_ms
  );
END;
$$;

-- ── 2. Sender-scoped identity: preserve the original LINE source id ────────

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS source_id text;

-- One-time cutover: session_key now always carries a "group:"/"room:"/"dm:"
-- prefix (see getPendingSessionKey). Any row that predates this rollout uses
-- the old bare-source-id key format and can never be matched by a new
-- composite-key lookup again — it is unreachable, not migrated. Rather than
-- leave it to rot indefinitely (or, worse, attempt to guess which sender it
-- belonged to), delete it outright. This is a deliberate one-time purge, not
-- a silent re-keying: nothing here renames a legacy row into the new
-- identity space. Cascades to pending_session_ingest/pending_session_admission
-- via the existing ON DELETE CASCADE foreign keys.
--
-- Operator impact: any produce session that was mid-accumulation in a group,
-- room, or DM at the exact moment this migration runs is dropped. The next
-- message from that same sender after deploy simply starts a brand new
-- pending session under the new composite key — the sender needs to resend
-- the header, but no cross-sender contamination or partial/misattributed
-- data is possible.
DELETE FROM public.pending_sessions
WHERE session_key !~ '^(group|room):[^:]+:user:[^:]+$'
  AND session_key !~ '^dm:[^:]+$';

ALTER TABLE public.pending_sessions
  ALTER COLUMN source_id SET NOT NULL;

-- ── 3. Generation-pinned mutations ──────────────────────────────────────────
--
-- admit_pending_session_event's return type changes (void → boolean) so a
-- generation conflict can be reported explicitly instead of a silent no-op.
-- CREATE OR REPLACE cannot change a function's return type, so this one
-- requires DROP + CREATE. IF EXISTS makes this safe whether or not the
-- out-of-band production copy is present.
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
-- pending_sessions), so the new trailing DEFAULT parameter is safe via
-- CREATE OR REPLACE. On a generation mismatch it returns an empty set,
-- mirroring the existing "session not found" empty-set signal so callers
-- already handling that case correctly reject the write.
CREATE OR REPLACE FUNCTION public.append_pending_session(
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

-- claim_pending_close_finalize keeps its jsonb return type, so the new
-- trailing DEFAULT parameter is safe via CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.claim_pending_close_finalize(
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

REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_pending_session_event(text, text, bigint, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) TO service_role;

REVOKE ALL ON FUNCTION public.check_pending_close_ready(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_pending_close_ready(text) TO service_role;

REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_close_finalize(text, uuid) TO service_role;
