-- Cancel the ONE produce draft an operator is currently filling in.
--
-- Forward-only. No existing migration is modified, no historical row is
-- rewritten, nothing is backfilled and nothing is deleted.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What this is
-- ─────────────────────────────────────────────────────────────────────────────
-- The exact operator command `ยกเลิกรายการ` abandons the unfinished pending
-- generation the same message would otherwise have been appended to. Until now
-- there was no such contract at all: the guided "ออกจากเมนู" dismisses the
-- controls and leaves the session open on purpose, and the copy told operators
-- to call an administrator.
--
-- It is NOT a delete, NOT an undo of a finalized produce session, and NOT a way
-- to close or void an accountability round that holds business data. The
-- terminal representation is the smallest auditable one that already exists —
-- `finalization_status = 'failed_closed'` with
-- `finalization_error->>'reason' = 'user_cancelled'` — exactly as `superseded`
-- (20260817090300) and `close_refused_unresolved` (20260817090200) do. The
-- status CHECK from migration 0034 is closed at
-- ('pending','processing','failed_closed','duplicate','finalized') and both
-- downstream consumers fail closed on an unknown value, so adding a value there
-- would be a silent, cross-cutting behaviour change. No new status is added.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why a close in flight is REFUSED rather than raced
-- ─────────────────────────────────────────────────────────────────────────────
-- Guard 8 refuses any generation that has begun closing (close boundary,
-- close request, finalize start, or status 'processing'). That belongs to the
-- finalizer, which is the sole accounting authority.
--
-- It also has a second, load-bearing consequence. `src/lib/reconciliation.ts`
-- treats a terminalized `failed_closed` row with a NON-NULL
-- close_event_timestamp_ms as a failed close for its business date. Because a
-- cancellable row provably has that column NULL, a cancelled row can never
-- enter that path. The primary UX case is safe by construction: a plain-text
-- close refused by the P4A gate goes through `mark_plain_text_close_refused`,
-- which writes NO close boundary (20260817090200), so all four fields are still
-- NULL/non-processing and the draft is still cancellable.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why p_expected_updated_at is required
-- ─────────────────────────────────────────────────────────────────────────────
-- Same precedent as supersession. An operator appending a correction does NOT
-- rotate session_generation — it advances updated_at and changes
-- accumulated_text in place. The generation check alone therefore cannot see a
-- concurrent append, and cancelling a draft the caller never read would destroy
-- input the operator had just typed. A caller that cannot name the snapshot it
-- acted on has not resolved this row.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotency
-- ─────────────────────────────────────────────────────────────────────────────
-- The webhook's primary defence against a redelivered LINE event is the UNIQUE
-- constraint on raw_messages.line_event_id, which short-circuits the whole
-- event before any handler runs. The replay branch here is the database-level
-- backstop: the SAME line_event_id against the SAME generation of an already
-- user-cancelled row replays `cancelled: true` and writes nothing. A DIFFERENT
-- event id does not match, and a rotated generation answers
-- generation_conflict — so a delayed duplicate can never cancel a draft the
-- operator opened afterwards.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION 'pending_sessions is missing';
  END IF;
  IF to_regprocedure('public.retire_empty_round_of_generation(text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'retire_empty_round_of_generation is missing (20260817090200 is not applied)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions'
      AND column_name IN (
        'session_generation', 'source_id', 'runtime_environment', 'terminalized',
        'updated_at', 'next_attempt_at', 'finalized_at', 'finalization_status',
        'finalization_error', 'close_event_timestamp_ms', 'close_requested_at',
        'close_finalize_started_at'
      )
    GROUP BY table_name
    HAVING count(*) = 12
  ) THEN
    RAISE EXCEPTION 'pending_sessions lifecycle columns are missing (0031/0034/0061 are not applied)';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.cancel_active_pending_produce_draft(
  p_session_key         text,
  p_session_generation  uuid,
  p_expected_updated_at timestamptz,
  p_source_id           text,
  p_line_event_id       text,
  p_runtime_environment text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row   public.pending_sessions%ROWTYPE;
  v_env   text := btrim(COALESCE(p_runtime_environment, ''));
  v_round text;
BEGIN
  -- 0. Programming errors, not operator outcomes.
  IF p_session_key IS NULL OR btrim(p_session_key) = ''
     OR p_session_generation IS NULL
     OR p_line_event_id IS NULL OR btrim(p_line_event_id) = '' THEN
    RAISE EXCEPTION 'draft cancellation requires a session key, generation and line event id';
  END IF;

  -- 1. An unrecognised environment is refused rather than guessed. Nothing here
  --    derives the environment from the row, the source or a deployment URL.
  IF v_env NOT IN ('production', 'preview', 'development') THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'invalid_runtime_environment');
  END IF;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  -- 2.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- 3. Idempotent replay, checked BEFORE the terminal refusal below: the same
  --    LINE event cancelling the same generation a second time is a success
  --    replay, not a failure. A DIFFERENT event id is not this cancellation and
  --    falls through to already_terminal.
  IF v_row.terminalized
     AND v_row.session_generation IS NOT DISTINCT FROM p_session_generation
     AND v_row.finalization_error->>'reason' = 'user_cancelled'
     AND v_row.finalization_error->>'cancel_line_event_id' = p_line_event_id THEN
    RETURN jsonb_build_object('cancelled', true, 'reason', 'already_cancelled');
  END IF;

  -- 4. Anything else already terminal is never re-terminalized.
  IF v_row.terminalized THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'already_terminal');
  END IF;

  -- 5. The draft the operator is looking at must be the draft on the row.
  IF v_row.session_generation IS DISTINCT FROM p_session_generation THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'generation_conflict');
  END IF;

  -- 6. Source ownership. source_id is nullable with no backfill (0031), and a
  --    legacy NULL row is still source-safe because session_key itself embeds
  --    the source (see src/lib/line/verify.ts getPendingSessionKey) — so a NULL
  --    is not treated as a mismatch, and it is never a wildcard the other way.
  IF v_row.source_id IS NOT NULL AND v_row.source_id IS DISTINCT FROM p_source_id THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'source_mismatch');
  END IF;

  -- 7. Environment ownership, re-checked HERE under the row lock. The 0061
  --    contract: production alone inherits legacy NULL; every other environment
  --    must match exactly and NULL is never "mine". Written with
  --    IS NOT DISTINCT FROM because `NULL = 'preview'` is NULL, not false, and
  --    three-valued logic must not decide ownership.
  IF NOT (
    CASE
      WHEN v_env = 'production'
        THEN v_row.runtime_environment IS NOT DISTINCT FROM 'production'
             OR v_row.runtime_environment IS NULL
      ELSE v_row.runtime_environment IS NOT DISTINCT FROM v_env
    END
  ) THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'environment_mismatch');
  END IF;

  -- 8. A generation that has begun closing belongs to the finalizer. Refusing
  --    also keeps every cancelled row permanently outside the reconciliation
  --    failed-close path, which requires close_event_timestamp_ms IS NOT NULL.
  IF v_row.close_event_timestamp_ms IS NOT NULL
     OR v_row.close_requested_at IS NOT NULL
     OR v_row.close_finalize_started_at IS NOT NULL
     OR v_row.finalization_status = 'processing' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'close_in_progress');
  END IF;

  -- 9. Optimistic concurrency on the content snapshot the caller resolved.
  IF p_expected_updated_at IS NULL THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'expected_updated_at_required');
  END IF;
  IF v_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'draft_changed');
  END IF;

  -- 10. One decision statement. Nothing is deleted: accumulated_text,
  --     raw_messages, the admission/ingest ledgers, every event id and every
  --     previously finalized produce session all survive.
  UPDATE public.pending_sessions
  SET terminalized = true,
      next_attempt_at = NULL,
      finalized_at = now(),
      finalization_status = 'failed_closed',
      finalization_error = jsonb_build_object(
        'reason', 'user_cancelled',
        'cancelled_at', now(),
        'cancel_line_event_id', p_line_event_id
      ),
      updated_at = now()
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;

  -- 11. Round cleanup reuses the existing primitive and adds no new rule. It
  --     already proves no produce session, no produce transaction and no other
  --     pending generation own the round. A populated round MUST survive, and
  --     does: it answers has_produce_sessions / has_transactions and is left
  --     open.
  v_round := public.retire_empty_round_of_generation(
    p_session_key, p_session_generation, 'user_cancelled'
  );

  -- 12.
  RETURN jsonb_build_object(
    'cancelled', true,
    'reason', 'cancelled',
    'accountability_round_id', v_row.accountability_round_id,
    'round_outcome', v_round
  );
END;
$$;

COMMENT ON FUNCTION public.cancel_active_pending_produce_draft(text, uuid, timestamptz, text, text, text) IS
  'Terminalizes ONE unfinished pending produce generation at the operator''s exact '
  '"ยกเลิกรายการ" request. Refuses anything already terminal, any generation whose '
  'close or finalization has begun (close_in_progress), a rotated generation '
  '(generation_conflict), a draft that changed since the caller''s snapshot '
  '(draft_changed), another source (source_mismatch) and another runtime environment '
  '(environment_mismatch); p_runtime_environment is REQUIRED and legacy NULL belongs '
  'to production only. Re-delivering the SAME p_line_event_id against the same '
  'already-cancelled generation replays cancelled=true and writes nothing. Deletes '
  'nothing — accumulated_text, event ids, ledgers and finalized sessions all survive '
  '— and retires the generation''s accountability round only when it is provably empty.';

REVOKE ALL ON FUNCTION public.cancel_active_pending_produce_draft(text, uuid, timestamptz, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_active_pending_produce_draft(text, uuid, timestamptz, text, text, text)
  TO service_role;

COMMIT;
