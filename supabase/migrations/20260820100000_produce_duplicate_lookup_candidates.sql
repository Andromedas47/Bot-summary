-- Historical-compatible duplicate lookup for the pending-session finalizer.
--
-- The gap this closes
-- --------------------
-- `try_finalize_pending_generation` already reserves the document's V2
-- identity and its V1 market-alias compatibility class (20260815150000). But
-- `sessionHashCandidates` in src/lib/line/session-dedup-service.ts has ALWAYS
-- known about a wider LOOKUP set the finalizer never forwarded:
--
--   V0    pre-PR #51. computeLegacySessionHash -- a structurally different
--         algorithm, never written any more.
--   legacy-price   a subunit quantity (ขีด/กรัม/มิลลิลิตร) converted under the
--         pre-PR-#61 arithmetic that also divided price_per_unit by the
--         conversion factor (legacySubunitPricedSession).
--   product/unit alias   PRODUCT_ALIASES / UNIT_ALIASES entries added AFTER a
--         document was first imported change what normalizeProductName /
--         normalizeUnitAlias return for it, so its V1/V2 hash is no longer
--         reproducible from the raw text (weighSessionAliasCompatibilityFingerprints,
--         this change -- see the ไชมัส entry in src/lib/summary/remaining-fruit.ts,
--         which named this exact gap and deferred it to "its own change").
--
-- Direct ingest (webhook-service.ts, via SessionDedupService.findDuplicate)
-- already reads this full set as a plain SELECT before recording. The pending
-- finalizer -- the path most Produce sessions actually take -- never did,
-- so a historical document resent through it could persist a second time:
-- ~90% of imported_sessions predate V1/V2, and an EXACT resend does not even
-- reach the withdrawal containment guard (20260817090100/090400), because
-- containment only compares unequal cardinalities.
--
-- What this migration does
-- -------------------------
-- Adds ONE read-only existence check, sourced from
-- `p_session->'duplicate_lookup_hashes'` -- a new JSONB key inside the
-- EXISTING `p_session` payload, the same technique
-- `canonical_withdrawal_item_lines` and `historical_withdrawal_candidates`
-- already use (20260817090400). The RPC's POSITIONAL SIGNATURE IS UNCHANGED:
-- still `(text,uuid,text,integer,text,text,jsonb,jsonb,text[])`. No DROP, no
-- GRANT/REVOKE reissue -- CREATE OR REPLACE on an unchanged signature keeps
-- the existing ACL.
--
-- Existence only, never reservation. Every hash in `duplicate_lookup_hashes`
-- is a reading this codebase no longer believes is correct arithmetic; a NEW
-- document must never claim identity under it (see business-fingerprint.ts).
-- Nothing is ever INSERTed under these hashes -- contrast the V1 compatibility
-- block below, which DOES reserve, because that class is still a live,
-- currently-correct spelling of the same document (see 20260815150000's own
-- header for why reservation, not lookup, is what rolling-deploy safety for
-- V1 requires).
--
-- A plain SELECT with no advisory lock is safe: every hash checked here is
-- either a frozen historical row nothing writes any more, or a reading no
-- build has ever reserved -- there is nothing to race against. The
-- concurrency guarantee for a genuinely NEW document is unchanged: it still
-- comes entirely from the V2/V1 reservations further down this function.
--
-- Mixed-version behaviour
-- ------------------------
--   OLD app (no 'duplicate_lookup_hashes' key) + NEW db (this migration)
--     The new block sees jsonb_typeof(...) IS DISTINCT FROM 'array' (the key
--     is simply absent) and is a no-op. Byte-for-byte today's behaviour.
--
--   NEW app (sends the key) + OLD db (this migration not yet applied)
--     The deployed function has no code path reading that key. Postgres does
--     not validate unknown jsonb object keys, so the call still succeeds --
--     degraded to pre-migration behaviour (misses the historical match),
--     never an error. Contrast the arity-changing 20260815150000 migration,
--     which DOES have a hard rollout ordering requirement; this one does not.
--
-- No production write, no backfill, no historical row rewritten. Forward-only.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure(
    'public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb,text[])'
  ) IS NULL THEN
    RAISE EXCEPTION
      'try_finalize_pending_generation(...,text[]) is missing (migration 20260817090400 is not applied)';
  END IF;
  IF to_regclass('public.imported_sessions') IS NULL THEN
    RAISE EXCEPTION 'imported_sessions is missing';
  END IF;
END;
$preflight$;

-- Reissued in full -- Postgres replaces a function as a whole unit, not as a
-- diff -- with exactly two changes: the new DECLARE'd v_lookup_hashes, and the
-- historical-compatible lookup block marked below. Signature is unchanged
-- from 20260817090400, so this CREATE OR REPLACE keeps the existing ACL.

CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation(p_session_key text, p_expected_generation uuid, p_expected_line_user_id text, p_snapshot_revision integer, p_session_hash text, p_raw_text text, p_session jsonb, p_items jsonb, p_compatibility_hashes text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
  v_lookup_hashes           text[];
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

  -- Historical-compatible lookup: existence-only check against a fingerprint
  -- an EARLIER algorithm generation -- V0, a retired subunit-price rescaling
  -- reading, or a since-superseded product/unit alias reading -- would have
  -- produced for THIS SAME business document. See duplicateLookupCandidates
  -- in src/lib/line/session-dedup-service.ts.
  --
  -- Existence only. Nothing here is ever INSERTed, unlike the compatibility
  -- reservation below: a new document must never claim identity under
  -- arithmetic this codebase no longer believes (see business-fingerprint.ts
  -- for why V0 and the legacy-price/alias readings are LOOKUP candidates,
  -- never reservations).
  --
  -- A plain SELECT is safe here with no advisory lock. Every hash this checks
  -- is either a frozen historical row that nothing writes any more, or (for
  -- the legacy-price/alias readings) not writable by ANY build -- so there is
  -- nothing to race against. Genuine concurrent duplicates of a NEW document
  -- are still fully serialized by the V2/V1 reservations further down,
  -- unchanged by this block.
  --
  -- Riding inside p_session -- the same technique canonical_withdrawal_item_
  -- lines and historical_withdrawal_candidates already use -- keeps the RPC
  -- SIGNATURE unchanged, so neither deploy order can break: an older
  -- application simply never sends the key, and this whole block is skipped
  -- exactly as it is today. A newer application talking to an older,
  -- not-yet-migrated database sends the key too, but the old function has no
  -- code path that reads it -- an unread jsonb key, not an argument-count
  -- mismatch, so the call still succeeds (degraded to today's behaviour,
  -- never an error).
  IF jsonb_typeof(p_session->'duplicate_lookup_hashes') = 'array' THEN
    SELECT array_agg(h) INTO v_lookup_hashes
    FROM jsonb_array_elements_text(p_session->'duplicate_lookup_hashes') AS h
    WHERE COALESCE(btrim(h), '') <> '';
  END IF;

  IF COALESCE(array_length(v_lookup_hashes, 1), 0) > 0 AND v_session_kind = 'main' THEN
    IF EXISTS (
      SELECT 1 FROM public.imported_sessions
      WHERE session_hash = ANY(v_lookup_hashes)
    ) THEN
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
        'reason', 'historical_fingerprint'
      );
    END IF;
  END IF;

  IF jsonb_typeof(p_session->'canonical_withdrawal_item_lines') = 'array' THEN
    SELECT array_agg(line)
      INTO v_withdrawal_lines
    FROM jsonb_array_elements_text(p_session->'canonical_withdrawal_item_lines') AS line;
  END IF;

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
      SELECT s.id, s.finalized_at, s.canonical_withdrawal_item_lines AS lines
      FROM public.produce_sessions s
      WHERE s.voided_at IS NULL
        AND s.canonical_withdrawal_item_lines IS NOT NULL
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
    ),
    supplied AS (
      SELECT s.id, s.finalized_at, c.lines
      FROM jsonb_to_recordset(v_historical_candidates)
             AS c(produce_session_id uuid, lines text[], item_count integer)
      JOIN public.produce_sessions s ON s.id = c.produce_session_id
      WHERE c.produce_session_id IS NOT NULL
        AND c.lines IS NOT NULL
        AND COALESCE(array_length(c.lines, 1), 0) > 0
        AND s.voided_at IS NULL
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
      (cardinality(c.lines) < cardinality(v_withdrawal_lines)
       AND public.produce_item_multiset_contains(v_withdrawal_lines, c.lines))
      OR
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
$function$;

COMMENT ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[]
) IS
  'Authoritative produce finalizer. Checks p_session.duplicate_lookup_hashes '
  '(read-only, never reserved) for a match against an earlier fingerprint '
  'generation or a since-superseded price/alias reading of this SAME '
  'document, then reserves the document''s compatibility fingerprints '
  '(previous-generation identities of the same business content, still live '
  'spellings) and finally its own session_hash on the UNIQUE '
  'imported_sessions index. A session''s own identity is always the '
  'current-generation hash in p_session_hash.';

COMMIT;
