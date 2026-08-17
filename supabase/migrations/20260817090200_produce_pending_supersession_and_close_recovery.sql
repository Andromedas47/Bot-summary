-- Two ways a plain-text produce generation can stop making progress forever,
-- and the bounded terminal state each of them must reach instead.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- P1-A. A pending attempt that a later successful document has replaced
-- ─────────────────────────────────────────────────────────────────────────────
-- Production 2026-08-16 holds open, non-terminal pending generations for จิ้ว,
-- ขวัญ, เมย์ and มิ้น whose business was afterwards recorded by a different
-- generation. Each of them also holds an EMPTY accountability round open, which
-- is what later makes an otherwise unique round ambiguous.
--
-- `supersede_pending_generation` terminalizes exactly one such generation, and
-- only when the caller has already PROVEN the replacement (see
-- src/lib/produce/pending-supersession.ts: identical business identity, base
-- transaction type, strict ordering, and the older document's canonical item
-- multiset provably represented by the successor's). This function does not
-- decide supersession; it records it, refuses anything already terminal, and
-- preserves accumulated_text, generation identity, timestamps and every review
-- artefact. Nothing is ever deleted.
--
-- The terminal representation is the smallest auditable one that already exists:
-- `finalization_status = 'failed_closed'` with
-- `finalization_error->>'reason' = 'superseded'` plus the successor's produce
-- session id. No new status value, no new CHECK constraint.
--
-- The empty round it owned is retired with the SAME guards
-- `cancel_duplicate_plain_text_round` uses: no produce session, no produce
-- transaction, no other pending generation. A populated round is never cancelled
-- by this path, and no round is rebound — `prevent_accountability_round_rebind`
-- and every other write-once accountability guard remain untouched.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- P1-B. A valid close that was refused and then simply forgotten
-- ─────────────────────────────────────────────────────────────────────────────
-- Production evidence, pending 313eaa61-473d-4041-a6b4-00710fb72c58, seller จิ้ว,
-- market ราชพฤก, business date 2026-08-16:
--
--     header + items, then the exact close `จบรายการชั่งคืน` at 09:58:39 +07
--     produce_entry_validation_reviews: presented 02:58:41.9Z, confirmed_at NULL
--     pending_sessions:                 updated  02:58:42.1Z
--       terminalized=false  finalization_status=pending
--       close_requested_at=NULL  close_deadline_at=NULL
--       close_event_timestamp_ms=NULL  next_attempt_at=NULL
--       accumulated_text CONTAINS the close line
--     pending_produce_deferred_events:  no unresolved row
--
-- Root cause: the plain-text close gate (webhook-service.runPlainTextCloseGate)
-- answers a refusal by setting `markClose = false`. The close message is then
-- appended as ordinary content — which is deliberate, so the operator can
-- correct the document in place — but NOTHING records that a valid close was
-- received, nothing schedules a retry, and nothing bounds the wait. If the
-- operator never resolves the review, or the refusal reply never reaches them,
-- the generation is stranded permanently: pending, closed in the operator's
-- mind, invisible to every sweep.
--
-- The fix does not force the close through. Forcing it would write the immutable
-- close boundary and destroy the very correction window the refusal exists to
-- give. Instead the refusal itself becomes durable state with a deadline:
--
--   `mark_plain_text_close_refused`  stamps the generation
--   `recover_stranded_plain_text_closes`  fails it closed once the grace period
--   has elapsed with no close scheduled and no further operator activity
--
-- The stamp is generation-scoped, so a rotation to a new generation makes it
-- inert with no cleanup, and the sweep keys off `updated_at`, so an operator who
-- is still adding corrections keeps extending their own window.
--
-- PR #52 is untouched: no deferred event, stream lock, admission/ingest ledger,
-- close boundary or line_event_id identity is read or written here. A generation
-- with an unresolved reorder window still reaches the finalizer through the
-- existing guard trigger, and this sweep only ever acts on generations that have
-- NO close scheduled at all.
--
-- Forward-only. Additive columns, new functions, no backfill, no historical row
-- rewritten.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.pending_sessions') IS NULL
     OR to_regclass('public.accountability_rounds') IS NULL THEN
    RAISE EXCEPTION 'pending session / accountability round baseline is missing';
  END IF;
  IF to_regprocedure('public.cancel_duplicate_plain_text_round(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'cancel_duplicate_plain_text_round is missing (migration 20260815090000 is not applied)';
  END IF;
END;
$preflight$;

-- ── P1-B state ──────────────────────────────────────────────────────────────

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS close_refused_at timestamptz,
  ADD COLUMN IF NOT EXISTS close_refused_session_generation uuid;

COMMENT ON COLUMN public.pending_sessions.close_refused_at IS
  'When a VALID plain-text close was received and refused by the entry gate '
  'without scheduling finalization. Bounds the correction window; NULL means no '
  'close has been refused for the stamped generation.';
COMMENT ON COLUMN public.pending_sessions.close_refused_session_generation IS
  'Generation the refusal belongs to. A rotation changes session_generation and '
  'silently retires the stamp — no cleanup write is needed.';

CREATE INDEX IF NOT EXISTS pending_sessions_close_refused_idx
  ON public.pending_sessions (runtime_environment, close_refused_at)
  WHERE terminalized = false
    AND close_refused_at IS NOT NULL
    AND close_requested_at IS NULL;

CREATE OR REPLACE FUNCTION public.mark_plain_text_close_refused(
  p_session_key         text,
  p_session_generation  uuid,
  p_close_line_event_id text,
  p_reason              text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
BEGIN
  IF p_session_key IS NULL OR btrim(p_session_key) = '' OR p_session_generation IS NULL THEN
    RAISE EXCEPTION 'close refusal requires a session key and generation';
  END IF;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'not_found');
  END IF;
  IF v_row.session_generation IS DISTINCT FROM p_session_generation THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'generation_conflict');
  END IF;
  IF v_row.terminalized THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'terminalized');
  END IF;
  -- A close that DID schedule is not stranded and must never be stamped: the
  -- finalizer owns it from here.
  IF v_row.close_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'close_already_scheduled');
  END IF;

  UPDATE public.pending_sessions
  SET close_refused_at = clock_timestamp(),
      close_refused_session_generation = p_session_generation,
      finalization_error = jsonb_build_object(
        'reason', 'close_refused',
        'close_refused_reason', p_reason,
        'close_line_event_id', p_close_line_event_id,
        'close_refused_at', clock_timestamp()
      )
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;

  RETURN jsonb_build_object('marked', true, 'reason', COALESCE(p_reason, 'unknown'));
END;
$$;

COMMENT ON FUNCTION public.mark_plain_text_close_refused(text, uuid, text, text) IS
  'Records that a valid plain-text close was received and refused without '
  'scheduling finalization, so the generation cannot wait indefinitely. Refuses '
  'when the generation is terminal or a close is already scheduled. Writes no '
  'close boundary and appends no text.';

-- Bounded recovery. A generation whose valid close was refused reaches a
-- terminal, explained state instead of waiting forever.
--
-- Deliberately conservative:
--   * only rows still carrying the stamp for their CURRENT generation
--   * only rows with NO close scheduled — a scheduled close belongs to the
--     finalizer and is never touched here
--   * only rows untouched for the whole grace period, so an operator still
--     correcting the document keeps extending their own window
--   * environment-scoped exactly like the finalizer sweep, including the
--     legacy-NULL exception that belongs to production alone
CREATE OR REPLACE FUNCTION public.recover_stranded_plain_text_closes(
  p_limit               integer,
  p_runtime_environment text,
  p_grace               interval DEFAULT interval '30 minutes'
) RETURNS TABLE (
  session_key             text,
  session_generation      uuid,
  source_id               text,
  accountability_round_id uuid,
  round_outcome           text,
  close_refused_at        timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     public.pending_sessions%ROWTYPE;
  v_outcome text;
BEGIN
  IF p_runtime_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'invalid runtime_environment: %', p_runtime_environment;
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.pending_sessions p
    WHERE p.terminalized = false
      AND p.close_requested_at IS NULL
      AND p.close_event_timestamp_ms IS NULL
      AND p.close_refused_at IS NOT NULL
      AND p.close_refused_session_generation = p.session_generation
      AND p.updated_at <= clock_timestamp() - p_grace
      AND p.close_refused_at <= clock_timestamp() - p_grace
      AND (
        (p_runtime_environment = 'production'
         AND (p.runtime_environment = 'production' OR p.runtime_environment IS NULL))
        OR p.runtime_environment = p_runtime_environment
      )
    ORDER BY p.close_refused_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  LOOP
    UPDATE public.pending_sessions AS ps
    SET terminalized = true,
        next_attempt_at = NULL,
        finalized_at = clock_timestamp(),
        finalization_status = 'failed_closed',
        finalization_error =
          COALESCE(ps.finalization_error, '{}'::jsonb)
          || jsonb_build_object('reason', 'close_refused_unresolved')
    WHERE ps.session_key = v_row.session_key
      AND ps.session_generation = v_row.session_generation;

    v_outcome := public.retire_empty_round_of_generation(
      v_row.session_key, v_row.session_generation, 'close_refused_unresolved'
    );

    session_key             := v_row.session_key;
    session_generation      := v_row.session_generation;
    source_id               := v_row.source_id;
    accountability_round_id := v_row.accountability_round_id;
    round_outcome           := v_outcome;
    close_refused_at        := v_row.close_refused_at;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.recover_stranded_plain_text_closes(integer, text, interval) IS
  'Fails closed the generations whose valid plain-text close was refused and never '
  'resolved, so none can sit pending with no close scheduling and no terminal state. '
  'Never touches a generation with a scheduled close, and retires only a provably '
  'empty accountability round.';

-- ── Shared empty-round retirement ───────────────────────────────────────────

-- The `cancel_duplicate_plain_text_round` guards, reusable by any terminal
-- outcome. It cancels ONE round — the one the given generation is bound to —
-- and only when that round demonstrably holds nothing. A populated round is
-- never cancelled, and no round the generation does not own is looked at.
CREATE OR REPLACE FUNCTION public.retire_empty_round_of_generation(
  p_session_key        text,
  p_session_generation uuid,
  p_reason             text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_round_id uuid;
  v_status   text;
BEGIN
  SELECT accountability_round_id INTO v_round_id
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;

  IF v_round_id IS NULL THEN
    RETURN 'no_round';
  END IF;

  SELECT status INTO v_status
  FROM public.accountability_rounds
  WHERE id = v_round_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'no_round';
  END IF;
  IF v_status <> 'open' THEN
    RETURN 'not_open';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.produce_sessions s WHERE s.accountability_round_id = v_round_id
  ) THEN
    RETURN 'has_produce_sessions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.produce_transactions t WHERE t.accountability_round_id = v_round_id
  ) THEN
    RETURN 'has_transactions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pending_sessions p
    WHERE p.accountability_round_id = v_round_id
      AND NOT (p.session_key = p_session_key
               AND p.session_generation = p_session_generation)
  ) THEN
    RETURN 'shared_with_other_generation';
  END IF;

  UPDATE public.accountability_rounds
  SET status = 'cancelled',
      closed_at = now(),
      closed_line_event_id =
        'plaintext:' || btrim(p_session_key) || ':' || p_session_generation::text
        || ':' || COALESCE(NULLIF(btrim(p_reason), ''), 'retired')
  WHERE id = v_round_id;

  RETURN 'cancelled';
END;
$$;

COMMENT ON FUNCTION public.retire_empty_round_of_generation(text, uuid, text) IS
  'Cancels the accountability round a terminal pending generation is bound to, and '
  'only when it holds no produce session, no produce transaction and no other '
  'pending generation. Never cancels a populated round; never rebinds anything.';

-- ── P1-A supersession ───────────────────────────────────────────────────────

-- An older 4-argument form would become an ambiguous overload of the 5-argument
-- one below, because every added parameter carries a default. This migration has
-- never been applied anywhere, so this only matters for a scratch database that
-- ran an earlier draft of it.
DROP FUNCTION IF EXISTS public.supersede_pending_generation(text, uuid, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.supersede_pending_generation(
  p_session_key         text,
  p_session_generation  uuid,
  p_superseded_by       uuid,
  p_evidence            jsonb DEFAULT '{}'::jsonb,
  p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     public.pending_sessions%ROWTYPE;
  v_outcome text;
BEGIN
  IF p_session_key IS NULL OR btrim(p_session_key) = ''
     OR p_session_generation IS NULL
     OR p_superseded_by IS NULL THEN
    RAISE EXCEPTION 'supersession requires a session key, generation and successor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.produce_sessions
    WHERE id = p_superseded_by AND voided_at IS NULL
  ) THEN
    -- The successor must be a live produce session. A voided or missing one is
    -- no proof at all.
    RETURN jsonb_build_object('superseded', false, 'reason', 'successor_not_found');
  END IF;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'not_found');
  END IF;
  IF v_row.session_generation IS DISTINCT FROM p_session_generation THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'generation_conflict');
  END IF;
  -- Idempotent under retry and concurrency: whoever gets here second sees a
  -- terminal row and reports it without writing.
  IF v_row.terminalized THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'already_terminal');
  END IF;
  -- A generation actively closing belongs to the finalizer. Superseding it here
  -- would race the authoritative RPC for the same document.
  IF v_row.close_requested_at IS NOT NULL AND v_row.finalization_status = 'processing' THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'finalization_in_progress');
  END IF;
  -- Optimistic concurrency, checked HERE and nowhere earlier: the row lock is
  -- held, so from this point to the UPDATE nothing else can move the row.
  --
  -- The generation check above is not sufficient. An operator appending a
  -- correction does NOT rotate the generation — it advances updated_at and
  -- changes accumulated_text in place. Between the caller's read and this call
  -- the proven document C1 can therefore have become an unproven C2 under the
  -- same generation, and terminalizing it would destroy input the caller never
  -- examined.
  --
  -- A NULL expectation is refused rather than waved through: a caller that
  -- cannot name the snapshot it proved has not proven this row. That also makes
  -- the migration safe ahead of the application — an older build calling the
  -- 4-argument form supersedes nothing instead of superseding blindly.
  IF p_expected_updated_at IS NULL THEN
    RETURN jsonb_build_object('superseded', false, 'reason', 'expected_updated_at_required');
  END IF;
  IF v_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    -- No automatic retry: the old proof is void, and a fresh sweep must read
    -- and prove the new content on its own terms.
    RETURN jsonb_build_object('superseded', false, 'reason', 'candidate_changed');
  END IF;

  UPDATE public.pending_sessions
  SET terminalized = true,
      next_attempt_at = NULL,
      finalized_at = clock_timestamp(),
      finalization_status = 'failed_closed',
      finalization_error =
        COALESCE(p_evidence, '{}'::jsonb)
        || jsonb_build_object(
             'reason', 'superseded',
             'superseded_by_produce_session_id', p_superseded_by,
             'superseded_at', clock_timestamp()
           )
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;

  v_outcome := public.retire_empty_round_of_generation(
    p_session_key, p_session_generation, 'superseded'
  );

  RETURN jsonb_build_object(
    'superseded', true,
    'accountability_round_id', v_row.accountability_round_id,
    'round_outcome', v_outcome
  );
END;
$$;

COMMENT ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz) IS
  'Terminalizes ONE pending generation the caller has already proven replaced by a '
  'live produce session. p_expected_updated_at is the pending_sessions.updated_at the '
  'proof was made against and is required: under the row lock a different value '
  'answers candidate_changed and writes nothing, so a correction that arrived after '
  'the proof is never destroyed. Preserves accumulated_text, generation identity, '
  'timestamps and review artefacts; deletes nothing. Retires the generation''s '
  'accountability round only when it is provably empty.';

REVOKE ALL ON FUNCTION public.mark_plain_text_close_refused(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_plain_text_close_refused(text, uuid, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.recover_stranded_plain_text_closes(integer, text, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stranded_plain_text_closes(integer, text, interval)
  TO service_role;

REVOKE ALL ON FUNCTION public.retire_empty_round_of_generation(text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retire_empty_round_of_generation(text, uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_pending_generation(text, uuid, uuid, jsonb, timestamptz)
  TO service_role;

COMMIT;
