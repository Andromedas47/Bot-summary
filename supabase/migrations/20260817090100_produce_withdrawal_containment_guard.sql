-- A resent withdrawal that CONTAINS an already-recorded one is a duplicate too.
--
-- Production evidence, business date 2026-08-16, seller โด้, market ตลาด72
-- ----------------------------------------------------------------------
-- First document, persisted:
--
--     4 rows of หมอนทอง @ 100 — 3.9 / 23.2 / 26.5 / 26.6 kg = 80.2 kg, 8,020 THB
--
-- Resent later, also persisted:
--
--     the SAME four rows, PLUS 12 dry-good rows — 16 rows, 13,620 THB
--
-- PR #51 blocks whole-document duplicates on the canonical business fingerprint,
-- and the two documents genuinely have different fingerprints, so both landed.
-- The day then carried the 8,020 THB durian twice.
--
-- What this migration adds
-- ------------------------
-- An exact multiset containment guard for PLAIN base withdrawals, evaluated
-- inside the authoritative finalizer BEFORE any produce row is written.
--
-- The comparison is the item multiset the fingerprint already uses — canonical
-- product identity, canonical unit, quantity at fixed scale, effective price,
-- pricing basis, base transaction type — supplied by the application as
-- `p_session -> 'canonical_withdrawal_item_lines'`. It is exact: no similarity
-- score, no fuzzy product matching, no alias invention. Order does not matter
-- (the lines are compared as a multiset); multiplicity DOES matter (a document
-- listing กระชาย 6 แพค @20 twice is not contained by one listing it once).
--
-- Outcomes for a candidate plain withdrawal against an existing one of the same
-- business identity:
--
--     equal multiset        already handled by the fingerprint duplicate path
--     existing ⊂ candidate  suspicious superset resend  -> FAIL CLOSED
--     candidate ⊂ existing  suspicious subset resend    -> FAIL CLOSED
--
-- Nothing is deleted, no delta is computed and persisted, and operator intent is
-- never guessed. The operator is told to send only the new rows with `เบิกเพิ่ม`
-- or to correct and resend.
--
-- False-positive boundary
-- -----------------------
-- `เบิกเพิ่ม` is an INTENTIONAL append and is excluded entirely — the
-- application supplies the array only for a main session whose every item is a
-- base `เบิก`, so an additional batch neither triggers the guard nor is compared
-- against. A seller who genuinely withdraws a second identical batch expresses
-- that with the explicit append contract, which is exactly what it is for.
--
-- Business identity is the SAME four-part identity the accountability round
-- contract uses: LINE source, business date, normalized seller, reviewed market
-- identity (`accountability_round_same_market`). A different seller, date,
-- genuinely different market or different source is never compared.
--
-- The source belongs in the key. Containment is a much more aggressive verdict
-- than the PR #51 whole-document fingerprint — it refuses a document that is
-- merely a superset of another, not an identical one — and two LINE groups are
-- two independent business streams that may legitimately record overlapping
-- withdrawals. Exact cross-source duplicates remain blocked by the fingerprint,
-- which is deliberately source-independent; this guard is not.
--
-- `produce_sessions` carries no source, so the source is recovered the only way
-- it can be proven: through the session's own `raw_message_id` into
-- `raw_messages.source_id`. A session with no resolvable source is not a
-- candidate, because an unprovable source is "cannot compare", never "matches".
--
-- Compatibility
-- -------------
-- The function signature is UNCHANGED — the new input rides inside the existing
-- `p_session` jsonb, so an older application build simply omits the key and the
-- guard is inert for it, and a newer build against an older database has its
-- extra key ignored. No rollout ordering hazard in either direction.
--
-- Historical sessions carry NULL in the new column and are never containment
-- candidates. No backfill, no rewrite of `imported_sessions`, no change to the
-- V0/V1/V2 fingerprint ledger.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb,text[])') IS NULL THEN
    RAISE EXCEPTION 'try_finalize_pending_generation is missing (migration 20260815150000 is not applied)';
  END IF;
  IF to_regprocedure('public.accountability_round_same_market(text,text)') IS NULL THEN
    RAISE EXCEPTION 'reviewed market identity functions are missing';
  END IF;
  -- The guard scopes containment by LINE source, and the only proof of a
  -- persisted session's source is its raw message. Fail the migration rather
  -- than silently widening the comparison across sources.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'raw_messages' AND column_name = 'source_id'
  ) THEN
    RAISE EXCEPTION 'raw_messages.source_id is missing; containment cannot be source-scoped';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions' AND column_name = 'source_id'
  ) THEN
    RAISE EXCEPTION 'pending_sessions.source_id is missing; containment cannot be source-scoped';
  END IF;
END;
$preflight$;

-- The canonical withdrawal multiset of a persisted session.
--
-- Written only for a plain main withdrawal; NULL everywhere else, including
-- every row that predates this migration. NULL means "not comparable", never
-- "empty".
ALTER TABLE public.produce_sessions
  ADD COLUMN IF NOT EXISTS canonical_withdrawal_item_lines text[];

COMMENT ON COLUMN public.produce_sessions.canonical_withdrawal_item_lines IS
  'Canonical item multiset of a PLAIN base withdrawal document, in the same form '
  'the business fingerprint hashes. NULL for returns, additional batches and every '
  'pre-guard row. Compared as a multiset for subset/superset resend detection.';

-- Exact multiset containment: every distinct line in p_subset appears in
-- p_superset at least as many times. Not a similarity measure.
CREATE OR REPLACE FUNCTION public.produce_item_multiset_contains(
  p_superset text[],
  p_subset   text[]
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_superset IS NOT NULL
     AND p_subset IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM (
         SELECT line, count(*) AS n
         FROM unnest(p_subset) AS line
         GROUP BY line
       ) sub
       LEFT JOIN (
         SELECT line, count(*) AS n
         FROM unnest(p_superset) AS line
         GROUP BY line
       ) sup USING (line)
       WHERE COALESCE(sup.n, 0) < sub.n
     )
$$;

COMMENT ON FUNCTION public.produce_item_multiset_contains(text[], text[]) IS
  'True when every canonical item line of p_subset occurs in p_superset with at '
  'least the same multiplicity. Order-insensitive, multiplicity-preserving, exact.';

-- Reissued in full from 20260815150000 — Postgres replaces a function as a whole
-- unit — with exactly two changes, both marked below: the containment guard, and
-- the new column on the produce_sessions insert.
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
  v_contained_session_id    uuid;
  v_contained_count         integer;
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
  -- retry that already produced a session terminates without new rows.
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

    SELECT s.id, cardinality(s.canonical_withdrawal_item_lines)
      INTO v_contained_session_id, v_contained_count
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
      AND (
        -- existing ⊂ candidate: the resend carries everything already recorded
        (cardinality(s.canonical_withdrawal_item_lines) < cardinality(v_withdrawal_lines)
         AND public.produce_item_multiset_contains(
               v_withdrawal_lines, s.canonical_withdrawal_item_lines))
        OR
        -- candidate ⊂ existing: a fragment of an already-recorded document
        (cardinality(v_withdrawal_lines) < cardinality(s.canonical_withdrawal_item_lines)
         AND public.produce_item_multiset_contains(
               s.canonical_withdrawal_item_lines, v_withdrawal_lines))
      )
    ORDER BY s.finalized_at, s.id
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
    'notification_id', v_notification_id
  );
END;
$fn$;

COMMENT ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[]
) IS
  'Authoritative produce finalizer. Reserves the document''s compatibility '
  'fingerprints (previous-generation identities of the same business content) '
  'and then its own session_hash on the UNIQUE imported_sessions index; a main '
  'session that cannot take every one of them is a duplicate. A plain base '
  'withdrawal is additionally refused when its canonical item multiset strictly '
  'contains, or is strictly contained by, an already-recorded plain withdrawal of '
  'the same business identity. A session''s own identity is always the '
  'current-generation hash in p_session_hash.';

REVOKE ALL ON FUNCTION public.produce_item_multiset_contains(text[], text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.produce_item_multiset_contains(text[], text[])
  TO service_role;

REVOKE ALL ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[]
) TO service_role;

COMMIT;
