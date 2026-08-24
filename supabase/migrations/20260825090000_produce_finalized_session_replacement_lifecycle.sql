-- Finalized Produce replacement / void lineage (Task 2).
--
-- Problem: once a Produce session has finalized, the only remedy for a
-- discovered mistake was manual DB repair or a full re-entry. This migration
-- closes that gap by teaching the existing 0037 void/supersede columns
-- (voided_at / voided_by / void_reason / replacement_session_id) how to be
-- set atomically by the SAME transaction that finalizes the correcting
-- session — never by a separate app-level step.
--
-- Contract enforced here:
--   ORIGINAL FINALIZED SESSION -> explicit replacement draft (seeded from the
--   effective prior contents, corrected with the EXISTING แก้ข้อ N / ลบข้อ N
--   grammar) -> replacement finalizes through the SAME
--   try_finalize_pending_generation RPC every other session uses -> if (and
--   only if) that finalize succeeds, the SAME function call also supersedes
--   the predecessor. One plpgsql function invocation is one Postgres
--   transaction, so there is no window where both sessions are live, and no
--   window where neither is: either the whole thing commits (new session +
--   items + predecessor voided) or the whole thing rolls back (predecessor
--   untouched, nothing new persisted).
--
-- Downstream reads need no changes: produce_transactions (0037) is already
-- `SELECT * FROM produce_transactions_all WHERE voided_at IS NULL`, and every
-- financial/report consumer already reads that view. A superseded predecessor
-- disappears from every one of them the instant this transaction commits.
--
-- Forward-only. Additive columns, one redefined function (signature
-- unchanged), one new function. No backfill, no historical row rewritten,
-- nothing deleted.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.produce_sessions') IS NULL
     OR to_regclass('public.pending_sessions') IS NULL
     OR to_regclass('public.produce_items') IS NULL THEN
    RAISE EXCEPTION 'produce_sessions / pending_sessions / produce_items baseline is missing';
  END IF;
  IF to_regprocedure(
    'public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb,text[])'
  ) IS NULL THEN
    RAISE EXCEPTION 'try_finalize_pending_generation is missing (20260817090100 is not applied)';
  END IF;
  IF to_regprocedure('public.accountability_round_same_market(text,text)') IS NULL THEN
    RAISE EXCEPTION 'accountability_round_same_market is missing (20260815160000 is not applied)';
  END IF;
END;
$preflight$;

-- ── Void columns, restated idempotently ─────────────────────────────────────
--
-- Identical to 0037_produce_session_void.sql's own DDL. Production already has
-- these; this restatement only matters for a database (for example this
-- migration's own isolated test fixture) where 0037 was never applied on its
-- own. Every statement is a guaranteed no-op wherever 0037 already ran.

ALTER TABLE public.produce_sessions
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by text,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS replacement_session_id uuid
    REFERENCES public.produce_sessions(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'produce_sessions_void_requires_reason'
  ) THEN
    ALTER TABLE public.produce_sessions
      ADD CONSTRAINT produce_sessions_void_requires_reason
      CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND voided_by IS NOT NULL));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'produce_sessions_replacement_not_self'
  ) THEN
    ALTER TABLE public.produce_sessions
      ADD CONSTRAINT produce_sessions_replacement_not_self
      CHECK (replacement_session_id IS NULL OR replacement_session_id <> id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS produce_sessions_voided_at_idx
  ON public.produce_sessions (voided_at) WHERE voided_at IS NOT NULL;

-- ── New: the pending-draft side of the link ─────────────────────────────────
--
-- Set once, by the operator UX (src/lib/produce/replacement-draft.ts), on a
-- freshly opened plain-text draft before any item lines are appended to it.
-- The finalizer reads it back (pending-session-finalizer.ts) and forwards it
-- to try_finalize_pending_generation as p_session->>'replaces_produce_session_id'.
-- It is never interpreted before finalize time — the RPC below is the sole
-- place that decides whether the predecessor may actually be superseded.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS replaces_produce_session_id uuid
    REFERENCES public.produce_sessions(id);

COMMENT ON COLUMN public.pending_sessions.replaces_produce_session_id IS
  'Set by the finalized-session replacement UX on a fresh draft: the finalized '
  'produce_sessions.id this draft is meant to supersede once IT finalizes '
  'successfully. NULL for every ordinary session. Read only by '
  'try_finalize_pending_generation, which re-validates the predecessor under '
  'its own row lock before trusting this pointer.';

CREATE INDEX IF NOT EXISTS pending_sessions_replaces_produce_session_id_idx
  ON public.pending_sessions (replaces_produce_session_id)
  WHERE replaces_produce_session_id IS NOT NULL;

-- ── Stamping helper ──────────────────────────────────────────────────────────
--
-- Deliberately thin: it only records intent on the draft. It never touches
-- produce_sessions and never decides supersession — that stays exclusively
-- inside try_finalize_pending_generation, under the row lock, at the only
-- moment the predecessor's current state is trustworthy. Idempotent under
-- retry: stamping the same target twice succeeds; stamping a second, different
-- target after the first is refused rather than silently overwritten.
CREATE OR REPLACE FUNCTION public.stamp_pending_session_replacement_target(
  p_session_key        text,
  p_session_generation uuid,
  p_produce_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
BEGIN
  IF p_session_key IS NULL OR btrim(p_session_key) = ''
     OR p_session_generation IS NULL
     OR p_produce_session_id IS NULL THEN
    RAISE EXCEPTION 'replacement stamping requires a session key, generation and target session';
  END IF;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('stamped', false, 'reason', 'not_found');
  END IF;
  IF v_row.session_generation IS DISTINCT FROM p_session_generation THEN
    RETURN jsonb_build_object('stamped', false, 'reason', 'generation_conflict');
  END IF;
  IF v_row.terminalized THEN
    RETURN jsonb_build_object('stamped', false, 'reason', 'terminalized');
  END IF;
  IF v_row.replaces_produce_session_id IS NOT NULL THEN
    IF v_row.replaces_produce_session_id = p_produce_session_id THEN
      RETURN jsonb_build_object('stamped', true, 'reason', 'already_stamped');
    END IF;
    RETURN jsonb_build_object('stamped', false, 'reason', 'already_targets_different_session');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.produce_sessions
    WHERE id = p_produce_session_id AND voided_at IS NULL
  ) THEN
    RETURN jsonb_build_object('stamped', false, 'reason', 'target_not_replaceable');
  END IF;

  UPDATE public.pending_sessions
  SET replaces_produce_session_id = p_produce_session_id
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;

  RETURN jsonb_build_object('stamped', true, 'reason', 'stamped');
END;
$$;

COMMENT ON FUNCTION public.stamp_pending_session_replacement_target(text, uuid, uuid) IS
  'Records, on a fresh plain-text draft, which finalized produce_session it is '
  'meant to replace. Bookkeeping only: never voids anything and never decides '
  'supersession, which is try_finalize_pending_generation''s job alone.';

REVOKE ALL ON FUNCTION public.stamp_pending_session_replacement_target(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_pending_session_replacement_target(text, uuid, uuid)
  TO service_role;

-- ── try_finalize_pending_generation, extended ───────────────────────────────
--
-- Identical to 20260817090400's body, plus exactly two additions:
--   1. Right before the produce_sessions INSERT: if the closing generation
--      names a predecessor, lock and validate it (exists, not already voided,
--      same business identity). Any failure fails the WHOLE finalize closed —
--      nothing is inserted — exactly like every other pre-insert guard already
--      in this function.
--   2. Right after the produce_items INSERT: if a predecessor was named and
--      validated, void it and point it at the new session. Same transaction,
--      same row lock taken above, so nothing can have moved it in between; the
--      UPDATE is guaranteed to affect exactly one row, and if it somehow did
--      not, the RAISE EXCEPTION rolls back the entire finalize rather than
--      leaving a new session live with its predecessor still active.
CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation(
  p_session_key             text,
  p_expected_generation     uuid,
  p_expected_line_user_id   text,
  p_snapshot_revision       integer,
  p_session_hash            text,
  p_raw_text                text,
  p_session                 jsonb,
  p_items                   jsonb,
  p_compatibility_hashes    text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_row                     public.pending_sessions%ROWTYPE;
  v_missing                 integer[];
  v_validation              jsonb;
  v_session_id              uuid;
  v_notification_id         uuid;
  v_imported_id             uuid;
  v_inserted_items          integer;
  v_item_count              integer;
  v_raw_message_id          uuid;
  v_finalization_started_at timestamptz;
  v_finalized_at            timestamptz;
  v_notification_payload    text;
  v_notification_source_id  text;
  v_correlation_id          text;
  v_session_kind            text;
  v_declared_tx_type        text;
  v_idempotency_key         text;
  v_ingest_source           text;
  v_existing_session_id     uuid;
  v_compatibility           text[];
  v_reserved                integer;
  v_withdrawal_lines        text[];
  v_historical_candidates   jsonb;
  v_contained_session_id    uuid;
  v_contained_count         integer;
  -- Finalized-session replacement (Task 2)
  v_replaces_session_id     uuid;
  v_predecessor_staff       text;
  v_predecessor_market      text;
  v_predecessor_date        date;
  v_predecessor_voided_at   timestamptz;
BEGIN
  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_row.session_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'generation_conflict');
  END IF;

  IF v_row.line_user_id IS DISTINCT FROM p_expected_line_user_id THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'sender_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'already_terminalized');
  END IF;

  IF v_row.close_event_timestamp_ms IS NULL
     OR v_row.close_requested_at IS NULL
     OR v_row.close_deadline_at IS NULL
     OR v_row.close_session_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'not_closing');
  END IF;

  IF now() < v_row.next_attempt_at AND now() < v_row.close_deadline_at THEN
    RETURN jsonb_build_object(
      'status', 'pending',
      'reason', 'quiet_window',
      'next_attempt_at', v_row.next_attempt_at
    );
  END IF;

  -- 0050: structured review hold. A structured session that has been closed for
  -- review must not persist until the operator confirms. Legacy rows never carry
  -- a hold (CHECK pending_sessions_finalize_hold_structured_only), so this block
  -- is unreachable for them.
  IF v_row.finalize_hold_until IS NOT NULL THEN
    IF now() < v_row.finalize_hold_until THEN
      UPDATE public.pending_sessions
         SET next_attempt_at = v_row.finalize_hold_until
       WHERE session_key = p_session_key
         AND session_generation = p_expected_generation;
      RETURN jsonb_build_object(
        'status', 'pending',
        'reason', 'awaiting_confirmation',
        'next_attempt_at', v_row.finalize_hold_until
      );
    END IF;

    -- expired unconfirmed: fail closed, write nothing
    UPDATE public.pending_sessions
       SET terminalized = true,
           next_attempt_at = NULL,
           finalized_at = clock_timestamp(),
           finalization_status = 'failed_closed',
           finalization_error = jsonb_build_object('reason', 'review_not_confirmed')
     WHERE session_key = p_session_key
       AND session_generation = p_expected_generation;
    RETURN jsonb_build_object(
      'status', 'failed_closed',
      'reason', 'review_not_confirmed'
    );
  END IF;

  -- 0050 H-1: a structured session that is closing without a hold and without
  -- confirmation (for example plain-text "จบรายการ" via append markClose) must
  -- never persist. Legacy rows (entry_origin IS NULL) skip this guard.
  -- Confirmed structured rows (finalize_confirmed_at IS NOT NULL) continue.
  IF v_row.entry_origin IS NOT NULL
     AND v_row.finalize_confirmed_at IS NULL THEN
    UPDATE public.pending_sessions
       SET terminalized = true,
           next_attempt_at = NULL,
           finalized_at = clock_timestamp(),
           finalization_status = 'failed_closed',
           finalization_error = jsonb_build_object(
             'reason', 'unconfirmed_structured_close'
           )
     WHERE session_key = p_session_key
       AND session_generation = p_expected_generation;
    RETURN jsonb_build_object(
      'status', 'failed_closed',
      'reason', 'unconfirmed_structured_close'
    );
  END IF;

  IF v_row.ingest_revision IS DISTINCT FROM p_snapshot_revision THEN
    RETURN jsonb_build_object(
      'status', 'stale_snapshot',
      'current_revision', v_row.ingest_revision
    );
  END IF;

  v_finalization_started_at := COALESCE(
    NULLIF(p_session->>'finalization_started_at', '')::timestamptz,
    clock_timestamp()
  );

  UPDATE public.pending_sessions
  SET finalization_started_at = v_finalization_started_at,
      finalization_status = 'processing',
      finalization_error = NULL
  WHERE session_key = p_session_key
    AND session_generation = p_expected_generation;

  v_session_kind    := COALESCE(NULLIF(btrim(p_session->>'session_kind'), ''), 'main');
  v_declared_tx_type := NULLIF(btrim(p_session->>'declared_transaction_type'), '');
  v_idempotency_key := NULLIF(btrim(p_session->>'ingest_idempotency_key'), '');
  v_ingest_source   := NULLIF(btrim(p_session->>'ingest_source'), '');
  v_replaces_session_id := NULLIF(p_session->>'replaces_produce_session_id', '')::uuid;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    v_validation := jsonb_build_array('items payload is not an array');
    v_item_count := 0;
  ELSE
    v_item_count := jsonb_array_length(p_items);
    v_validation := COALESCE(p_session->'validation_errors', '[]'::jsonb);
  END IF;

  IF jsonb_typeof(v_validation) IS DISTINCT FROM 'array' THEN
    v_validation := jsonb_build_array('validation_errors payload is not an array');
  END IF;

  IF v_item_count = 0 THEN
    v_validation := v_validation || jsonb_build_array('session has no items');
  END IF;

  IF COALESCE(btrim(p_session->>'staff_name'), '') = '' THEN
    v_validation := v_validation || jsonb_build_array('staff_name is required');
  END IF;

  IF v_session_kind NOT IN ('main', 'additional') THEN
    v_validation := v_validation || jsonb_build_array('invalid session_kind');
    v_session_kind := 'main';
  END IF;

  -- Additional sessions require explicit provenance — no fallbacks.
  IF v_session_kind = 'additional' THEN
    IF v_declared_tx_type IS NULL
       OR v_declared_tx_type NOT IN ('เบิก', 'คืน', 'คืนเสีย') THEN
      v_validation := v_validation
        || jsonb_build_array('additional session requires a declared base transaction type');
    END IF;
    IF COALESCE(btrim(p_session->>'session_date'), '') = '' THEN
      v_validation := v_validation
        || jsonb_build_array('additional session requires an explicit date');
    END IF;
    IF COALESCE(btrim(p_session->>'session_title'), '') = '' THEN
      v_validation := v_validation
        || jsonb_build_array('additional session requires an explicit market');
    END IF;
    IF jsonb_typeof(p_items) = 'array' AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_items) AS item
      WHERE COALESCE(btrim(item->>'transaction_type'), '')
              NOT IN ('เบิก', 'คืน', 'คืนเสีย')
    ) THEN
      v_validation := v_validation
        || jsonb_build_array('additional session items must use base transaction types');
    END IF;
  END IF;

  IF jsonb_typeof(p_items) = 'array' THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_items) AS item
      WHERE CASE
        WHEN COALESCE(item->>'item_number', '') !~ '^[0-9]+$' THEN true
        WHEN COALESCE(btrim(item->>'product_name'), '') = '' THEN true
        WHEN COALESCE(item->>'price_per_unit', '') !~ '^[0-9]+([.][0-9]+)?$' THEN true
        WHEN COALESCE(item->>'quantity', '') !~ '^[0-9]+([.][0-9]+)?$' THEN true
        WHEN (item->>'quantity')::numeric <= 0 THEN true
        WHEN COALESCE(btrim(item->>'unit'), '') = '' THEN true
        WHEN COALESCE(btrim(item->>'transaction_type'), '') = '' THEN true
        ELSE false
      END
    ) THEN
      v_validation := v_validation || jsonb_build_array('one or more items are invalid');
    END IF;
  END IF;

  IF v_row.expected_item_count IS NOT NULL THEN
    IF jsonb_typeof(p_items) = 'array' THEN
      SELECT array_agg(n ORDER BY n) INTO v_missing
      FROM generate_series(1, v_row.expected_item_count) AS n
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS item
        WHERE COALESCE(item->>'item_number', '') ~ '^[0-9]+$'
          AND (item->>'item_number')::integer = n
      );
    ELSE
      SELECT array_agg(n ORDER BY n) INTO v_missing
      FROM generate_series(1, v_row.expected_item_count) AS n;
    END IF;
  END IF;

  IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
    IF now() < v_row.close_deadline_at THEN
      UPDATE public.pending_sessions
      SET next_attempt_at = close_deadline_at,
          finalization_status = 'pending'
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'pending', 'reason', 'missing_items', 'missing', to_jsonb(v_missing)
      );
    END IF;

    v_finalized_at := clock_timestamp();
    UPDATE public.pending_sessions
    SET terminalized = true,
        next_attempt_at = NULL,
        finalized_at = v_finalized_at,
        finalization_status = 'failed_closed',
        finalization_error = jsonb_build_object(
          'reason', 'missing_items',
          'missing', to_jsonb(v_missing)
        )
    WHERE session_key = p_session_key
      AND session_generation = p_expected_generation;

    RETURN jsonb_build_object(
      'status', 'failed_closed', 'reason', 'missing_items', 'missing', to_jsonb(v_missing)
    );
  END IF;

  IF jsonb_array_length(v_validation) > 0 THEN
    v_finalized_at := clock_timestamp();
    UPDATE public.pending_sessions
    SET terminalized = true,
        next_attempt_at = NULL,
        finalized_at = v_finalized_at,
        finalization_status = 'failed_closed',
        finalization_error = jsonb_build_object(
          'reason', 'validation_failed',
          'validation_errors', v_validation
        )
    WHERE session_key = p_session_key
      AND session_generation = p_expected_generation;

    RETURN jsonb_build_object(
      'status', 'failed_closed', 'reason', 'validation_failed',
      'validation_errors', v_validation
    );
  END IF;

  IF COALESCE(btrim(p_session_hash), '') = '' THEN
    RAISE EXCEPTION 'session_hash is required';
  END IF;

  v_raw_message_id := NULLIF(p_session->>'raw_message_id', '')::uuid;
  IF v_raw_message_id IS NULL THEN
    RAISE EXCEPTION 'raw_message_id is required';
  END IF;

  -- Authoritative idempotency: the immutable ingest/generation identity. A
  -- retry that already produced a session terminates without new rows. This is
  -- also what makes a replacement's finalize retry-safe end to end: if the
  -- first attempt already committed (new session persisted AND predecessor
  -- superseded, atomically — see below), a retry short-circuits HERE, before
  -- ever re-examining the predecessor, and reports the same session id.
  IF v_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_session_id
    FROM public.produce_sessions
    WHERE ingest_idempotency_key = v_idempotency_key;

    IF v_existing_session_id IS NOT NULL THEN
      v_finalized_at := clock_timestamp();
      UPDATE public.pending_sessions
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = v_finalized_at,
          finalization_status = 'duplicate'
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'duplicate',
        'reason', 'idempotency_key',
        'session_id', v_existing_session_id
      );
    END IF;
  END IF;

  -- ── CHANGE 1: plain-withdrawal containment guard ─────────────────────────
  --
  -- Runs before any reservation or produce write, and only for a document the
  -- application has declared a PLAIN base withdrawal. `เบิกเพิ่ม` and every
  -- return never supply the array and are neither guarded nor compared against.
  --
  -- The advisory lock serializes this decision per business identity, which is
  -- what makes it hold under concurrency: an initial withdrawal and its strict
  -- superset resend arriving together would otherwise each read a snapshot
  -- without the other and both persist. The loser blocks until the winner
  -- commits and then sees the committed session. Reviewed market spellings fold
  -- onto one key through accountability_round_market_code.
  IF jsonb_typeof(p_session->'canonical_withdrawal_item_lines') = 'array' THEN
    SELECT array_agg(line)
      INTO v_withdrawal_lines
    FROM jsonb_array_elements_text(p_session->'canonical_withdrawal_item_lines') AS line;
  END IF;

  -- A document with no business date, or a generation with no authoritative
  -- source, has no identity to compare within and is never a containment
  -- candidate. NULL is "cannot prove", never a wildcard.
  IF COALESCE(array_length(v_withdrawal_lines, 1), 0) > 0
     AND NULLIF(btrim(p_session->>'session_date'), '') IS NOT NULL
     AND NULLIF(btrim(v_row.source_id), '') IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'produce_withdrawal_containment:'
        || btrim(v_row.source_id)
        || ':' || COALESCE(NULLIF(btrim(p_session->>'session_date'), ''), '')
        || ':' || public.accountability_round_normalize(p_session->>'staff_name')
        || ':' || COALESCE(
             public.accountability_round_market_code(p_session->>'session_title'),
             public.accountability_round_normalize(p_session->>'session_title')
           ),
      0
    ));

    IF jsonb_typeof(p_session->'historical_withdrawal_candidates') = 'array' THEN
      v_historical_candidates := p_session->'historical_withdrawal_candidates';
    ELSE
      v_historical_candidates := '[]'::jsonb;
    END IF;

    WITH stored AS (
      -- Sessions recorded since 20260817090100: their canonical lines are the
      -- database's own, written at ingest.
      SELECT s.id, s.finalized_at, s.canonical_withdrawal_item_lines AS lines
      FROM public.produce_sessions s
      WHERE s.voided_at IS NULL
        AND s.canonical_withdrawal_item_lines IS NOT NULL
        AND s.session_date = NULLIF(btrim(p_session->>'session_date'), '')::date
        AND public.accountability_round_normalize(s.staff_name)
            = public.accountability_round_normalize(p_session->>'staff_name')
        AND public.accountability_round_same_market(s.session_title, p_session->>'session_title')
        -- Same LINE source, proven through the session's own raw message. A
        -- session whose raw message is gone or carries no source cannot be
        -- compared at all.
        AND EXISTS (
          SELECT 1
          FROM public.raw_messages rm
          WHERE rm.id = s.raw_message_id
            AND rm.source_id = btrim(v_row.source_id)
        )
    ),
    supplied AS (
      -- Sessions recorded BEFORE the column existed. The caller computed these
      -- lines with the same canonicalizer the stored ones came from; this
      -- function decides, under the lock, whether each one is still eligible.
      SELECT s.id, s.finalized_at, c.lines
      FROM jsonb_to_recordset(v_historical_candidates)
             AS c(produce_session_id uuid, lines text[], item_count integer)
      JOIN public.produce_sessions s ON s.id = c.produce_session_id
      WHERE c.produce_session_id IS NOT NULL
        AND c.lines IS NOT NULL
        AND COALESCE(array_length(c.lines, 1), 0) > 0
        AND s.voided_at IS NULL
        -- Still column-less, so a session can never arrive through both arms
        -- and no supplied array can override a stored one.
        AND s.canonical_withdrawal_item_lines IS NULL
        AND s.session_date = NULLIF(btrim(p_session->>'session_date'), '')::date
        AND public.accountability_round_normalize(s.staff_name)
            = public.accountability_round_normalize(p_session->>'staff_name')
        AND public.accountability_round_same_market(s.session_title, p_session->>'session_title')
        AND EXISTS (
          SELECT 1
          FROM public.raw_messages rm
          WHERE rm.id = s.raw_message_id
            AND rm.source_id = btrim(v_row.source_id)
        )
        -- The supplied content must still describe the persisted row. Items of
        -- a finalized session do not change, so a mismatch means the supply is
        -- stale and is dropped rather than trusted.
        AND cardinality(c.lines) = c.item_count
        AND (
          SELECT count(*) FROM public.produce_items i WHERE i.session_id = s.id
        ) = c.item_count
    ),
    candidates AS (
      SELECT * FROM stored
      UNION ALL
      SELECT * FROM supplied
    )
    SELECT c.id, cardinality(c.lines)
      INTO v_contained_session_id, v_contained_count
    FROM candidates c
    WHERE
      -- existing ⊂ candidate: the resend carries everything already recorded
      (cardinality(c.lines) < cardinality(v_withdrawal_lines)
       AND public.produce_item_multiset_contains(v_withdrawal_lines, c.lines))
      OR
      -- candidate ⊂ existing: a fragment of an already-recorded document
      (cardinality(v_withdrawal_lines) < cardinality(c.lines)
       AND public.produce_item_multiset_contains(c.lines, v_withdrawal_lines))
    ORDER BY c.finalized_at, c.id
    LIMIT 1;

    IF v_contained_session_id IS NOT NULL THEN
      v_finalized_at := clock_timestamp();
      UPDATE public.pending_sessions
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = v_finalized_at,
          finalization_status = 'failed_closed',
          finalization_error = jsonb_build_object(
            'reason', 'withdrawal_containment',
            'existing_produce_session_id', v_contained_session_id,
            'existing_item_count', v_contained_count,
            'candidate_item_count', cardinality(v_withdrawal_lines)
          )
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'failed_closed',
        'reason', 'withdrawal_containment',
        'session_id', v_contained_session_id
      );
    END IF;
  END IF;

  v_notification_payload := p_session->>'notification_payload';
  v_notification_source_id := p_session->>'notification_source_id';
  v_correlation_id := COALESCE(
    NULLIF(p_session->>'correlation_id', ''),
    p_session_key || ':' || p_expected_generation::text
  );

  -- ── Compatibility reservation ────────────────────────────────────────────
  --
  -- Taken BEFORE the V2 reservation, and it decides the outcome, because that
  -- is the only ordering that is safe while two application builds coexist.
  --
  -- Reading the V1 hashes instead of reserving them would leave a race: the
  -- previous build still writes V1 directly, so two concurrent submissions of
  -- one document — old build hashing พาซีโอ้ as V1, new build hashing it as V2
  -- — would each find nothing and each persist. Reserving puts both builds on
  -- the same UNIQUE index.
  --
  -- Case by case, for one document submitted twice:
  --   old commits first  -> new fails to reserve V1  -> new is duplicate
  --   new commits first  -> old's own V1 INSERT conflicts -> old is duplicate
  --   truly concurrent   -> the index serializes the V1 row; the loser blocks
  --                         until the winner commits, then sees the conflict
  --   both on the new    -> identical V2, so the V2 reservation below decides
  --
  -- Exactly one produce session persists in every case.
  --
  -- Additional sessions are exempt from the verdict for the same reason they
  -- are exempt from the V2 verdict below: two intentional additional batches
  -- with identical content must both persist. They still take the rows, so a
  -- main session cannot slip past afterwards.
  v_compatibility := ARRAY(
    SELECT DISTINCT h
    FROM unnest(COALESCE(p_compatibility_hashes, ARRAY[]::text[])) AS h
    WHERE COALESCE(btrim(h), '') <> ''
      AND h <> p_session_hash
  );

  IF array_length(v_compatibility, 1) IS NOT NULL THEN
    WITH reserved AS (
      INSERT INTO public.imported_sessions (
        session_hash, transaction_date, staff_name, market_name,
        transaction_type, raw_text, reserved_by_generation
      )
      SELECT
        h,
        NULLIF(p_session->>'session_date', '')::date,
        p_session->>'staff_name',
        COALESCE(p_session->>'session_title', ''),
        COALESCE(p_session->>'transaction_types', ''),
        p_raw_text,
        p_expected_generation
      FROM unnest(v_compatibility) AS h
      ON CONFLICT (session_hash) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_reserved FROM reserved;

    IF v_reserved < array_length(v_compatibility, 1) AND v_session_kind = 'main' THEN
      v_finalized_at := clock_timestamp();
      UPDATE public.pending_sessions
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = v_finalized_at,
          finalization_status = 'duplicate'
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'duplicate',
        'reason', 'compatibility_fingerprint'
      );
    END IF;
  END IF;

  INSERT INTO public.imported_sessions (
    session_hash, transaction_date, staff_name, market_name,
    transaction_type, raw_text, reserved_by_generation
  )
  VALUES (
    p_session_hash,
    NULLIF(p_session->>'session_date', '')::date,
    p_session->>'staff_name',
    COALESCE(p_session->>'session_title', ''),
    COALESCE(p_session->>'transaction_types', ''),
    p_raw_text,
    p_expected_generation
  )
  ON CONFLICT (session_hash) DO NOTHING
  RETURNING id INTO v_imported_id;

  -- Content hash is a global duplicate blocker for main sessions only. For
  -- additional sessions it is a best-effort audit fingerprint: two
  -- intentional additional batches with identical content but different
  -- generation identities must both persist.
  IF v_imported_id IS NULL AND v_session_kind = 'main' THEN
    v_finalized_at := clock_timestamp();
    UPDATE public.pending_sessions
    SET terminalized = true,
        next_attempt_at = NULL,
        finalized_at = v_finalized_at,
        finalization_status = 'duplicate'
    WHERE session_key = p_session_key
      AND session_generation = p_expected_generation;

    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  -- ── Finalized-session replacement: predecessor validation, under lock ────
  --
  -- Runs after every duplicate/containment gate and before the produce write,
  -- so a replacement draft that turns out to be a duplicate or contained
  -- resend is refused exactly like any other document — never reaching here.
  --
  -- FOR UPDATE is what makes concurrent replacement safe: two closing drafts
  -- naming the same predecessor serialize on this row. The loser blocks until
  -- the winner's transaction commits (predecessor voided) and then observes
  -- voided_at IS NOT NULL, so it fails closed instead of superseding twice.
  IF v_replaces_session_id IS NOT NULL THEN
    SELECT staff_name, session_title, session_date, voided_at
      INTO v_predecessor_staff, v_predecessor_market, v_predecessor_date,
           v_predecessor_voided_at
    FROM public.produce_sessions
    WHERE id = v_replaces_session_id
    FOR UPDATE;

    IF NOT FOUND THEN
      v_finalized_at := clock_timestamp();
      UPDATE public.pending_sessions
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = v_finalized_at,
          finalization_status = 'failed_closed',
          finalization_error = jsonb_build_object(
            'reason', 'replacement_predecessor_not_found',
            'replaces_produce_session_id', v_replaces_session_id
          )
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'failed_closed',
        'reason', 'replacement_predecessor_not_found'
      );
    END IF;

    IF v_predecessor_voided_at IS NOT NULL THEN
      v_finalized_at := clock_timestamp();
      UPDATE public.pending_sessions
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = v_finalized_at,
          finalization_status = 'failed_closed',
          finalization_error = jsonb_build_object(
            'reason', 'replacement_predecessor_already_superseded',
            'replaces_produce_session_id', v_replaces_session_id
          )
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'failed_closed',
        'reason', 'replacement_predecessor_already_superseded'
      );
    END IF;

    -- Defense in depth: the operator UX already proves the exact predecessor
    -- before seeding the draft (src/lib/produce/replacement-draft.ts), but the
    -- RPC never trusts an application-level proof it cannot re-check itself.
    IF public.accountability_round_normalize(v_predecessor_staff)
         IS DISTINCT FROM public.accountability_round_normalize(p_session->>'staff_name')
       OR NOT public.accountability_round_same_market(v_predecessor_market, p_session->>'session_title')
       OR v_predecessor_date IS DISTINCT FROM NULLIF(p_session->>'session_date', '')::date
    THEN
      v_finalized_at := clock_timestamp();
      UPDATE public.pending_sessions
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = v_finalized_at,
          finalization_status = 'failed_closed',
          finalization_error = jsonb_build_object(
            'reason', 'replacement_predecessor_identity_mismatch',
            'replaces_produce_session_id', v_replaces_session_id
          )
      WHERE session_key = p_session_key
        AND session_generation = p_expected_generation;

      RETURN jsonb_build_object(
        'status', 'failed_closed',
        'reason', 'replacement_predecessor_identity_mismatch'
      );
    END IF;
  END IF;

  v_finalized_at := clock_timestamp();
  -- CHANGE 2: the canonical withdrawal multiset is stored with the session so a
  -- later resend can be compared against it. NULL for everything that is not a
  -- plain base withdrawal.
  INSERT INTO public.produce_sessions (
    raw_message_id, line_user_id, staff_name, sender_name,
    transaction_time, session_date, session_title, total_items, parser_errors,
    finalization_started_at, finalized_at,
    session_kind, declared_transaction_type,
    ingest_idempotency_key, ingest_source,
    canonical_withdrawal_item_lines
  )
  VALUES (
    v_raw_message_id,
    p_expected_line_user_id,
    p_session->>'staff_name',
    NULLIF(p_session->>'sender_name', ''),
    NULLIF(p_session->>'transaction_time', ''),
    NULLIF(p_session->>'session_date', '')::date,
    NULLIF(p_session->>'session_title', ''),
    v_item_count,
    NULL,
    v_finalization_started_at,
    v_finalized_at,
    v_session_kind,
    v_declared_tx_type,
    v_idempotency_key,
    v_ingest_source,
    NULLIF(v_withdrawal_lines, ARRAY[]::text[])
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.produce_items (
    session_id, item_number, product_name, price_per_unit,
    quantity, unit, section, transaction_type, item_hash,
    basis_quantity, basis_unit, basis_price
  )
  SELECT
    v_session_id,
    (item->>'item_number')::integer,
    item->>'product_name',
    (item->>'price_per_unit')::numeric,
    (item->>'quantity')::numeric,
    item->>'unit',
    COALESCE(item->>'section', 'main'),
    item->>'transaction_type',
    NULLIF(item->>'item_hash', ''),
    NULLIF(item->>'basis_quantity', '')::numeric,
    NULLIF(item->>'basis_unit', ''),
    NULLIF(item->>'basis_price', '')::numeric
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_inserted_items = ROW_COUNT;
  IF v_inserted_items IS DISTINCT FROM v_item_count THEN
    RAISE EXCEPTION
      'produce item insert count mismatch: expected %, inserted %',
      v_item_count, v_inserted_items;
  END IF;

  -- Atomic supersede: same transaction as the INSERTs above. Either both the
  -- new session (with its items) and this UPDATE commit together, or a crash
  -- anywhere in this function rolls back everything and the predecessor stays
  -- exactly as it was — never a state where both are live, never one where
  -- neither is.
  IF v_replaces_session_id IS NOT NULL THEN
    UPDATE public.produce_sessions
    SET voided_at = v_finalized_at,
        voided_by = COALESCE(
          NULLIF(p_session->>'replacement_actor_id', ''),
          'system:replacement'
        ),
        void_reason = COALESCE(
          NULLIF(p_session->>'replacement_reason', ''),
          'superseded_by_replacement_session'
        ),
        replacement_session_id = v_session_id
    WHERE id = v_replaces_session_id
      AND voided_at IS NULL;

    IF NOT FOUND THEN
      -- Cannot happen given the FOR UPDATE lock and the voided_at check taken
      -- above in this same transaction — this is a belt-and-suspenders guard,
      -- not a reachable branch. Failing hard here rolls back the new session
      -- too, which is exactly the "neither counted twice, never both" contract.
      RAISE EXCEPTION
        'replacement predecessor % changed state during finalize', v_replaces_session_id;
    END IF;
  END IF;

  IF COALESCE(v_notification_payload, '') <> ''
     AND COALESCE(v_notification_source_id, '') <> '' THEN
  INSERT INTO public.produce_session_notifications (
    produce_session_id,
    session_key,
    session_generation,
    source_id,
    correlation_id,
    notification_payload,
    runtime_environment
  )
  VALUES (
    v_session_id,
    p_session_key,
    p_expected_generation,
    v_notification_source_id,
    v_correlation_id,
    v_notification_payload,
    v_row.runtime_environment
  )
  RETURNING id INTO v_notification_id;
  END IF;

  UPDATE public.raw_messages
  SET is_processed = true, processed_at = now()
  WHERE id = v_raw_message_id;

  UPDATE public.pending_sessions
  SET terminalized = true,
      next_attempt_at = NULL,
      finalized_at = v_finalized_at,
      finalization_status = 'finalized',
      finalized_produce_session_id = v_session_id
  WHERE session_key = p_session_key
    AND session_generation = p_expected_generation;

  RETURN jsonb_build_object(
    'status', 'finalized',
    'session_id', v_session_id,
    'notification_id', v_notification_id,
    'replaced_produce_session_id', v_replaces_session_id
  );
END;
$fn$;

COMMENT ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[]
) IS
  'Sole accounting authority for a plain-text produce generation. Signature unchanged since 20260817090100. Adds one atomic capability (20260825090000): when p_session->>''replaces_produce_session_id'' names a live, identity-matching predecessor, that predecessor is voided and pointed at the new session in the SAME transaction that inserts it — no state where both count, no state where neither does. Every earlier guard (duplicate/idempotency/containment/compatibility) still runs first and still refuses the whole finalize before either write happens.';

REVOKE ALL ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[]
) TO service_role;

COMMIT;
