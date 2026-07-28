-- 0049: Produce Structured Session Foundation.
--
-- WHAT THIS IS
-- ------------
-- The database half of the frozen Produce Structured Session contract: typed
-- session metadata on public.pending_sessions, one atomic open-or-rotate RPC,
-- and the entry_origin restriction on the legacy_accumulated readiness escape
-- hatch that 0048's header deferred to this migration.
--
-- 0048 captured the live baseline of check_pending_close_ready(text) verbatim
-- and explicitly deferred the structured-session exclusion to 0049. This file
-- is where that behavioral change lands. 0042 (reserved/empty), 0044 and 0048
-- are not modified, replayed or renumbered.
--
-- WHAT THIS IS NOT
-- ----------------
--   * no Guided Menu surface (Quick Reply / Flex / LIFF) — foundation only;
--   * no line_operator_identities, no line_menu_states, no 0050;
--   * no purchase persistence or routing (P2B is a separate slice);
--   * no cancel command and no hard-delete surface;
--   * no change to computeSessionHash inputs, item hashes or Produce tables;
--   * no backfill: every historical row keeps entry_origin IS NULL;
--   * no hardening or rewrite of the rest of the Produce RPC family — the
--     legacy append/admit/ingest/claim/finalize functions are untouched.
--
-- LIMITATION (unchanged from 0048)
-- --------------------------------
-- This does NOT make a clean migration chain build. The chain still fails at
-- 0032 because the 0042-era baseline is absent from version control. Repairing
-- that is a separate baseline migration and is deliberately not attempted here;
-- the assertions below fail closed rather than create anything.

-- ── 0) Preconditions ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION '0049: required table public.pending_sessions is missing';
  END IF;
  IF to_regclass('public.pending_session_ingest') IS NULL THEN
    RAISE EXCEPTION
      '0049: required table public.pending_session_ingest is missing (0042-era baseline absent)';
  END IF;
  IF to_regclass('public.pending_session_admission') IS NULL THEN
    RAISE EXCEPTION
      '0049: required table public.pending_session_admission is missing (0042-era baseline absent)';
  END IF;

  -- 0048 must already own the captured baseline: 0049 replaces
  -- check_pending_close_ready and must not run against an unversioned copy.
  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'check_pending_close_ready';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0049: public.check_pending_close_ready(text) is missing; apply 0048 first';
  END IF;
END $$;

-- ── 1) Typed structured metadata ─────────────────────────────────────────────
-- Nullable, no DEFAULT, no backfill. A legacy or historical row therefore ends
-- this migration exactly as it started: entry_origin IS NULL and every typed
-- column NULL. Adding a DEFAULT here would silently assert structured origin
-- for every pre-existing row, which is the one thing this contract forbids.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS entry_origin              text,
  ADD COLUMN IF NOT EXISTS command_contract_version  integer,
  ADD COLUMN IF NOT EXISTS business_date             date,
  ADD COLUMN IF NOT EXISTS transaction_time          text,
  ADD COLUMN IF NOT EXISTS transaction_time_source   text,
  ADD COLUMN IF NOT EXISTS staff_label               text,
  ADD COLUMN IF NOT EXISTS market_label              text,
  ADD COLUMN IF NOT EXISTS session_kind              text,
  ADD COLUMN IF NOT EXISTS initial_transaction_type  text,
  ADD COLUMN IF NOT EXISTS declared_transaction_type text,
  ADD COLUMN IF NOT EXISTS additional_opener         text,
  ADD COLUMN IF NOT EXISTS opened_line_event_id      text;

COMMENT ON COLUMN public.pending_sessions.entry_origin IS
  'NULL = legacy operator-text session (the only historical value). Non-NULL marks a '
  'structured session opened by a typed domain command. Never defaulted, never backfilled.';
COMMENT ON COLUMN public.pending_sessions.opened_line_event_id IS
  'Immutable LINE event id of the typed open for the CURRENT generation. Rotation '
  'overwrites it with the rotating event; redelivery of the same id is a no-op.';
COMMENT ON COLUMN public.pending_sessions.initial_transaction_type IS
  'The transaction type this session''s items start in. Required for BOTH kinds: a guided '
  'main session may be ชั่งคืน or คืนเสีย and has no textual section marker to recover that '
  'from. For an additional batch it must equal declared_transaction_type.';
COMMENT ON COLUMN public.pending_sessions.transaction_time_source IS
  'operator_declared = the operator stated the time; line_event = derived from the '
  'LINE event timestamp. Seeded into the parser so a structured session never has to '
  'recover the time from a TIME_PREFIX that a typed command never produced.';

-- ── 2) Database-enforced completeness ────────────────────────────────────────
-- A structured row may not be partially typed. Either every structured field is
-- NULL (legacy), or the full required set is present and internally consistent.
-- These are CHECK constraints, not application invariants, so a future writer
-- that forgets a field fails at the database rather than producing a row that
-- the structured finalization path would then trust.

ALTER TABLE public.pending_sessions
  ADD CONSTRAINT pending_sessions_entry_origin_domain
    CHECK (entry_origin IS NULL OR entry_origin IN ('structured_menu')),

  ADD CONSTRAINT pending_sessions_structured_metadata_complete
    CHECK (
      (
        entry_origin              IS NULL
        AND command_contract_version  IS NULL
        AND business_date             IS NULL
        AND transaction_time          IS NULL
        AND transaction_time_source   IS NULL
        AND staff_label               IS NULL
        AND market_label              IS NULL
        AND session_kind              IS NULL
        AND initial_transaction_type  IS NULL
        AND declared_transaction_type IS NULL
        AND additional_opener         IS NULL
        AND opened_line_event_id      IS NULL
      )
      OR (
        entry_origin              IS NOT NULL
        AND command_contract_version  IS NOT NULL
        AND business_date             IS NOT NULL
        AND transaction_time          IS NOT NULL
        AND transaction_time_source   IS NOT NULL
        AND session_kind              IS NOT NULL
        AND initial_transaction_type  IS NOT NULL
        AND btrim(staff_label)           <> ''
        AND btrim(market_label)          <> ''
        AND btrim(opened_line_event_id)  <> ''
      )
    ),

  ADD CONSTRAINT pending_sessions_structured_session_kind
    CHECK (session_kind IS NULL OR session_kind IN ('main', 'additional')),

  -- Main carries no declared type/opener; additional must carry both, and an
  -- additional batch's initial type must be the type it declared. This is the
  -- service-level main/additional invariant made non-bypassable.
  ADD CONSTRAINT pending_sessions_structured_additional_pair
    CHECK (
      session_kind IS NULL
      OR (session_kind = 'main'
          AND declared_transaction_type IS NULL
          AND additional_opener IS NULL)
      OR (session_kind = 'additional'
          AND declared_transaction_type IS NOT NULL
          AND additional_opener IS NOT NULL
          AND initial_transaction_type = declared_transaction_type)
    ),

  ADD CONSTRAINT pending_sessions_structured_declared_type
    CHECK (
      declared_transaction_type IS NULL
      OR declared_transaction_type IN ('เบิก', 'คืน', 'คืนเสีย')
    ),

  -- Domain, not a default. A guided main ชั่งคืน / คืนเสีย session is expressed
  -- ONLY here, so an out-of-domain value must never reach the parser seed.
  ADD CONSTRAINT pending_sessions_structured_initial_type
    CHECK (
      initial_transaction_type IS NULL
      OR initial_transaction_type IN ('เบิก', 'คืน', 'คืนเสีย')
    ),

  -- The opener keyword and the base type it declares must agree, matching
  -- ADDITIONAL_TYPE_MAP in the weigh-session parser.
  ADD CONSTRAINT pending_sessions_structured_additional_opener
    CHECK (
      additional_opener IS NULL
      OR (additional_opener = 'เบิกเพิ่ม'    AND declared_transaction_type = 'เบิก')
      OR (additional_opener = 'ชั่งคืนเพิ่ม' AND declared_transaction_type = 'คืน')
      OR (additional_opener = 'คืนเสียเพิ่ม' AND declared_transaction_type = 'คืนเสีย')
    ),

  ADD CONSTRAINT pending_sessions_structured_time_source
    CHECK (
      transaction_time_source IS NULL
      OR transaction_time_source IN ('operator_declared', 'line_event')
    ),

  ADD CONSTRAINT pending_sessions_structured_transaction_time_format
    CHECK (transaction_time IS NULL OR transaction_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),

  ADD CONSTRAINT pending_sessions_structured_contract_version
    CHECK (command_contract_version IS NULL OR command_contract_version >= 1);

-- Redelivery lookup for the open/rotate RPC.
CREATE INDEX IF NOT EXISTS pending_sessions_opened_line_event_id_idx
  ON public.pending_sessions (opened_line_event_id)
  WHERE opened_line_event_id IS NOT NULL;

-- ── 3) Atomic open-or-rotate ─────────────────────────────────────────────────
--
-- The first SECURITY DEFINER function in the Produce family, and deliberately
-- narrow: it writes structured metadata for ONE session key and nothing else.
-- It is not a generic privileged write surface — it cannot append text, cannot
-- close, cannot finalize, cannot delete, and cannot touch produce_sessions or
-- produce_items. DEFINER is required because the row it rotates must be
-- mutated atomically under a single lock together with the full clear of the
-- previous generation's metadata; a caller doing this in several statements
-- could interleave with a concurrent open and leave a half-rotated row.
--
-- Postback control-event rule: this function creates NO pending_session_ingest
-- row and NO pending_session_admission row, and writes no synthetic Thai text.
-- A typed open is a control event, not parser-consumable content, so it must
-- not enter admission/ingest parity accounting. Parity for the freshly rotated
-- generation therefore legitimately starts at 0 admissions / 0 ingests, and
-- readiness comes only from real operator item text admitted later.
--
-- Ledger rows belonging to previous generations are never deleted: they are
-- immutable evidence, and they are already scoped out by session_generation.
CREATE OR REPLACE FUNCTION public.open_or_rotate_produce_structured_session(
  p_session_key               text,
  p_source_type              text,
  p_source_id                text,
  p_line_user_id             text,
  p_opened_line_event_id     text,
  p_line_timestamp_ms        bigint,
  p_command_contract_version integer,
  p_business_date            date,
  p_transaction_time         text,
  p_transaction_time_source  text,
  p_staff_label              text,
  p_market_label             text,
  p_session_kind             text,
  p_initial_transaction_type text,
  p_declared_transaction_type text DEFAULT NULL,
  p_additional_opener         text DEFAULT NULL,
  p_expected_session_generation uuid DEFAULT NULL,
  p_entry_origin              text DEFAULT 'structured_menu'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row          public.pending_sessions%ROWTYPE;
  v_generation   uuid := gen_random_uuid();
  v_user         text;
  v_event        text;
  v_source       text;
  v_expected_key text;
  v_now          timestamptz := now();
BEGIN
  -- 1) Validate the typed command before taking any lock. A menu command with
  --    no LINE user identity fails closed: a group/room source is shared by
  --    every member, so an unattributable structured open must never be
  --    allowed to claim a session key.
  v_user := btrim(coalesce(p_line_user_id, ''));
  IF length(v_user) = 0 THEN
    RAISE EXCEPTION '0049: line_user_id is required for a structured session command';
  END IF;

  v_event := btrim(coalesce(p_opened_line_event_id, ''));
  IF length(v_event) = 0 THEN
    RAISE EXCEPTION '0049: opened_line_event_id is required';
  END IF;

  IF p_session_key IS NULL OR length(btrim(p_session_key)) = 0 THEN
    RAISE EXCEPTION '0049: session_key is required';
  END IF;
  IF p_source_type IS NULL OR p_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION '0049: source_type must be one of user, group, room';
  END IF;
  IF p_source_id IS NULL OR length(btrim(p_source_id)) = 0 THEN
    RAISE EXCEPTION '0049: source_id is required';
  END IF;
  IF p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION '0049: line_timestamp_ms must be positive';
  END IF;
  IF p_entry_origin IS NULL OR p_entry_origin <> 'structured_menu' THEN
    RAISE EXCEPTION '0049: unsupported entry_origin %', p_entry_origin;
  END IF;
  IF p_session_kind IS NULL OR p_session_kind NOT IN ('main', 'additional') THEN
    RAISE EXCEPTION '0049: session_kind must be main or additional';
  END IF;
  IF p_session_kind = 'additional'
     AND (p_declared_transaction_type IS NULL OR p_additional_opener IS NULL) THEN
    RAISE EXCEPTION
      '0049: an additional session requires declared_transaction_type and additional_opener';
  END IF;
  IF p_session_kind = 'main'
     AND (p_declared_transaction_type IS NOT NULL OR p_additional_opener IS NOT NULL) THEN
    RAISE EXCEPTION
      '0049: a main session must not declare a transaction type or additional opener';
  END IF;
  IF p_initial_transaction_type IS NULL
     OR p_initial_transaction_type NOT IN ('เบิก', 'คืน', 'คืนเสีย') THEN
    RAISE EXCEPTION
      '0049: initial_transaction_type is required for every structured session';
  END IF;
  IF p_session_kind = 'additional'
     AND p_initial_transaction_type IS DISTINCT FROM p_declared_transaction_type THEN
    RAISE EXCEPTION
      '0049: an additional session''s initial_transaction_type must equal declared_transaction_type';
  END IF;

  -- The caller does not get to name an arbitrary session key. Derive the
  -- canonical key from the source triple and refuse anything else, so a
  -- mismatched source_id/user_id pair can never reach another key's row.
  -- This mirrors getPendingSessionKey in src/lib/line/verify.ts exactly.
  v_source := btrim(p_source_id);
  v_expected_key := CASE p_source_type
    WHEN 'group' THEN 'group:' || v_source || ':user:' || v_user
    WHEN 'room'  THEN 'room:'  || v_source || ':user:' || v_user
    ELSE 'dm:' || v_user
  END;
  IF p_source_type = 'user' AND v_source IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION '0049: a user source must have source_id equal to line_user_id';
  END IF;
  IF btrim(p_session_key) IS DISTINCT FROM v_expected_key THEN
    RAISE EXCEPTION
      '0049: session_key does not match the canonical key for this source';
  END IF;

  -- Serialize concurrent opens for this session key even when no row exists
  -- yet, so two simultaneous typed opens cannot both insert.
  PERFORM pg_advisory_xact_lock(hashtext(p_session_key));

  -- 2) Lock the existing row and validate ownership.
  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF FOUND THEN
    -- 3a) Ownership is validated BEFORE the redelivery shortcut. A duplicate
    --     open_line_event_id carried by the wrong source or the wrong user is
    --     not a retry of this session's open — answering 'idempotent' there
    --     would leak the current generation to a caller that does not own the
    --     row. Both checks are pure reads; nothing has been mutated yet.
    IF v_row.source_id IS DISTINCT FROM v_source THEN
      RETURN jsonb_build_object(
        'outcome',            'ownership_conflict',
        'rotated',            false,
        'reason',             'source_mismatch',
        'session_key',        v_row.session_key,
        'session_generation', v_row.session_generation
      );
    END IF;

    -- A session key already owned by a different LINE user is never taken over.
    IF v_row.line_user_id IS NOT NULL AND v_row.line_user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object(
        'outcome',            'ownership_conflict',
        'rotated',            false,
        'reason',             'user_mismatch',
        'session_key',        v_row.session_key,
        'session_generation', v_row.session_generation
      );
    END IF;

    -- 3b) Idempotent redelivery is still checked BEFORE any mutation: LINE
    --     retries the same webhook event, and a retry must not rotate the
    --     generation.
    IF v_row.opened_line_event_id IS NOT NULL
       AND v_row.opened_line_event_id = v_event THEN
      RETURN jsonb_build_object(
        'outcome',            'idempotent',
        'rotated',            false,
        'reason',             'duplicate_open_event',
        'session_key',        v_row.session_key,
        'session_generation', v_row.session_generation,
        'entry_origin',       v_row.entry_origin,
        'session_kind',       v_row.session_kind,
        'opened_line_event_id', v_row.opened_line_event_id
      );
    END IF;

    -- 4) Optimistic-concurrency check when the caller states what it saw.
    IF p_expected_session_generation IS NOT NULL
       AND v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
      RETURN jsonb_build_object(
        'outcome',            'generation_conflict',
        'rotated',            false,
        'reason',             'stale_generation',
        'session_key',        v_row.session_key,
        'session_generation', v_row.session_generation
      );
    END IF;

    -- 5/6/7) Rotate atomically and clear EVERY previous-generation structured
    -- field explicitly. Listing each column (rather than relying on the ones
    -- being overwritten) is deliberate: a field added to the contract later
    -- must be added here too, and the completeness CHECK makes a forgotten one
    -- fail loudly instead of leaking across a rotation.
    UPDATE public.pending_sessions
    SET
      session_generation        = v_generation,
      source_id                 = v_source,
      line_user_id              = v_user,
      accumulated_text          = '',
      latest_reply_token        = NULL,
      created_at                = v_now,
      updated_at                = v_now,
      close_event_timestamp_ms  = NULL,
      close_requested_at        = NULL,
      close_line_event_id       = NULL,
      close_finalize_started_at = NULL,
      close_session_generation  = NULL,
      close_deadline_at         = NULL,
      terminalized              = false,
      next_attempt_at           = NULL,
      expected_item_count       = NULL,
      ingest_revision           = 0,
      finalization_started_at      = NULL,
      finalized_at                 = NULL,
      finalization_status          = 'pending',
      finalization_error           = NULL,
      finalized_produce_session_id = NULL,
      -- previous-generation structured metadata, cleared then rewritten
      entry_origin              = p_entry_origin,
      command_contract_version  = p_command_contract_version,
      business_date             = p_business_date,
      transaction_time          = p_transaction_time,
      transaction_time_source   = p_transaction_time_source,
      staff_label               = btrim(p_staff_label),
      market_label              = btrim(p_market_label),
      session_kind              = p_session_kind,
      initial_transaction_type  = p_initial_transaction_type,
      declared_transaction_type = p_declared_transaction_type,
      additional_opener         = p_additional_opener,
      opened_line_event_id      = v_event
    WHERE session_key = p_session_key
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'outcome',            'rotated',
      'rotated',            true,
      'reason',             'rotated',
      'session_key',        v_row.session_key,
      'session_generation', v_row.session_generation,
      'entry_origin',       v_row.entry_origin,
      'session_kind',       v_row.session_kind,
      'opened_line_event_id', v_row.opened_line_event_id
    );
  END IF;

  -- 8) First open for this session key.
  INSERT INTO public.pending_sessions (
    session_key, source_id, accumulated_text, latest_reply_token, line_user_id,
    created_at, updated_at, session_generation,
    close_event_timestamp_ms, close_requested_at, close_line_event_id,
    close_finalize_started_at, close_session_generation, close_deadline_at,
    terminalized, next_attempt_at, expected_item_count, ingest_revision,
    finalization_started_at, finalized_at, finalization_status,
    finalization_error, finalized_produce_session_id,
    entry_origin, command_contract_version, business_date, transaction_time,
    transaction_time_source, staff_label, market_label, session_kind,
    initial_transaction_type, declared_transaction_type, additional_opener,
    opened_line_event_id
  ) VALUES (
    p_session_key, v_source, '', NULL, v_user,
    v_now, v_now, v_generation,
    NULL, NULL, NULL,
    NULL, NULL, NULL,
    false, NULL, NULL, 0,
    NULL, NULL, 'pending',
    NULL, NULL,
    p_entry_origin, p_command_contract_version, p_business_date, p_transaction_time,
    p_transaction_time_source, btrim(p_staff_label), btrim(p_market_label), p_session_kind,
    p_initial_transaction_type, p_declared_transaction_type, p_additional_opener,
    v_event
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'outcome',            'opened',
    'rotated',            false,
    'reason',             'opened',
    'session_key',        v_row.session_key,
    'session_generation', v_row.session_generation,
    'entry_origin',       v_row.entry_origin,
    'session_kind',       v_row.session_kind,
    'opened_line_event_id', v_row.opened_line_event_id
  );
END;
$fn$;

COMMENT ON FUNCTION public.open_or_rotate_produce_structured_session(
  text, text, text, text, text, bigint, integer, date, text, text, text, text,
  text, text, text, text, uuid, text
) IS
  'SECURITY DEFINER, pinned search_path. Atomically opens or rotates ONE structured '
  'produce pending session and writes the full typed metadata set. Idempotent on a '
  'redelivered opened_line_event_id. Creates no admission row, no ingest row and no '
  'synthetic text: a typed open is a control event, not parser-consumable content.';

-- Narrow privilege: the proven server caller only. anon/authenticated hold no
-- EXECUTE, and PUBLIC's implicit default grant is revoked.
REVOKE ALL ON FUNCTION public.open_or_rotate_produce_structured_session(
  text, text, text, text, text, bigint, integer, date, text, text, text, text,
  text, text, text, text, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_or_rotate_produce_structured_session(
  text, text, text, text, text, bigint, integer, date, text, text, text, text,
  text, text, text, text, uuid, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_or_rotate_produce_structured_session(
  text, text, text, text, text, bigint, integer, date, text, text, text, text,
  text, text, text, text, uuid, text
) TO service_role;

-- ── 4) Structured close (control event) ──────────────────────────────────────
--
-- SECURITY INVOKER, matching every other function in the Produce family. Only
-- the open/rotate function above needs DEFINER; adding a second privileged
-- surface for a plain conditional UPDATE would widen the blast radius for no
-- gain. Every object it touches is schema-qualified.
--
-- Sets the immutable close boundary and close_line_event_id from the real
-- postback evidence, and creates NO admission row and NO ingest row. A repeated
-- close is a status request: the first boundary, deadline and quiet window are
-- immutable, exactly as in append_pending_session.
CREATE OR REPLACE FUNCTION public.close_produce_structured_session(
  p_session_key                 text,
  p_line_user_id                text,
  p_close_line_event_id         text,
  p_line_timestamp_ms           bigint,
  p_expected_session_generation uuid DEFAULT NULL,
  p_expected_item_count         integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_row  public.pending_sessions%ROWTYPE;
  v_user text;
BEGIN
  v_user := btrim(coalesce(p_line_user_id, ''));
  IF length(v_user) = 0 THEN
    RAISE EXCEPTION '0049: line_user_id is required for a structured session command';
  END IF;
  IF p_close_line_event_id IS NULL OR length(btrim(p_close_line_event_id)) = 0 THEN
    RAISE EXCEPTION '0049: close_line_event_id is required';
  END IF;
  IF p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION '0049: line_timestamp_ms must be positive';
  END IF;

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  -- Structured commands never drive a legacy row: that would close a session
  -- whose metadata the structured finalization path is not entitled to trust.
  IF v_row.entry_origin IS NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_structured');
  END IF;

  IF v_row.line_user_id IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'ownership_conflict');
  END IF;

  IF p_expected_session_generation IS NOT NULL
     AND v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object(
      'accepted', false, 'reason', 'terminalized', 'session', to_jsonb(v_row)
    );
  END IF;

  -- Redelivery of the same close postback, and any repeat close, are status
  -- requests. The boundary set by the first close is immutable.
  IF v_row.close_event_timestamp_ms IS NOT NULL THEN
    RETURN jsonb_build_object(
      'accepted', true, 'reason', 'close_already_requested', 'session', to_jsonb(v_row)
    );
  END IF;

  IF p_expected_item_count IS NOT NULL AND p_expected_item_count < 1 THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'invalid_expected_item_count');
  END IF;

  UPDATE public.pending_sessions
  SET
    close_event_timestamp_ms = p_line_timestamp_ms,
    close_requested_at       = now(),
    close_line_event_id      = btrim(p_close_line_event_id),
    close_session_generation = session_generation,
    close_deadline_at        = now() + interval '30 seconds',
    next_attempt_at          = now() + interval '8 seconds',
    expected_item_count      = p_expected_item_count,
    updated_at               = now(),
    ingest_revision          = ingest_revision + 1
  WHERE session_key = p_session_key
    AND session_generation = v_row.session_generation
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  RETURN jsonb_build_object(
    'accepted', true, 'reason', 'first_close', 'session', to_jsonb(v_row)
  );
END;
$fn$;

COMMENT ON FUNCTION public.close_produce_structured_session(
  text, text, text, bigint, uuid, integer
) IS
  'SECURITY INVOKER. Sets the immutable close boundary for a structured produce session '
  'from real postback evidence. Creates no admission row, no ingest row and no synthetic '
  'close text. Repeat close is a status request; refuses legacy (entry_origin IS NULL) rows.';

REVOKE ALL ON FUNCTION public.close_produce_structured_session(
  text, text, text, bigint, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_produce_structured_session(
  text, text, text, bigint, uuid, integer
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_produce_structured_session(
  text, text, text, bigint, uuid, integer
) TO service_role;

-- ── 5) Readiness: restrict the legacy_accumulated escape hatch ───────────────
--
-- This is the one behavioral change 0048 deferred here, and the ONLY difference
-- from the baseline 0048 captured: the pre-0042 compatibility branch now also
-- requires entry_origin IS NULL.
--
-- Why it matters: a structured session starts with accumulated_text = '' and
-- takes no admission row from its typed open. Without this guard, any structured
-- session whose accumulated_text happened to reach three non-blank lines would
-- report ready with zero admissions and be finalized on text that never passed
-- the admission ledger. Legacy rows keep the escape hatch unchanged.
--
-- Everything else — the three counts, the straggler predicate, the readiness
-- expression, the result keys, SECURITY INVOKER, proconfig NULL — is byte-for-byte
-- the 0048 baseline.
CREATE OR REPLACE FUNCTION public.check_pending_close_ready(
  p_session_key text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
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

  -- Pre-0042 rows: accumulated_text already holds items but no admission ledger yet.
  -- 0049: legacy rows only. A structured session (entry_origin IS NOT NULL) must
  -- never become ready from accumulated_text alone.
  IF v_session.entry_origin IS NULL
     AND v_admission_count = 0
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
$fn$;

COMMENT ON FUNCTION public.check_pending_close_ready(text) IS
  'SECURITY INVOKER. Reports whether a closing pending session has admission/ingest parity. '
  '0049 restricts the legacy_accumulated compatibility path to entry_origin IS NULL rows; '
  'a structured session with zero admissions can no longer become ready from accumulated_text.';

REVOKE ALL ON FUNCTION public.check_pending_close_ready(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_pending_close_ready(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pending_close_ready(text) TO service_role;

-- ── 6) Post-conditions ───────────────────────────────────────────────────────

DO $$
DECLARE
  v_secdef boolean;
  v_config text[];
BEGIN
  -- No historical row may have been marked structured by this migration.
  PERFORM 1 FROM public.pending_sessions WHERE entry_origin IS NOT NULL;
  IF FOUND THEN
    RAISE EXCEPTION
      '0049: entry_origin was populated during migration; structured origin must never be backfilled';
  END IF;

  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
    FROM pg_proc p
   WHERE p.oid = 'public.open_or_rotate_produce_structured_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,uuid,text)'::regprocedure;
  IF NOT v_secdef THEN
    RAISE EXCEPTION '0049: open_or_rotate_produce_structured_session must be SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT ('search_path=public' = ANY (v_config)) THEN
    RAISE EXCEPTION
      '0049: open_or_rotate_produce_structured_session must pin search_path, found %', v_config;
  END IF;

  -- The rest of the Produce family stays SECURITY INVOKER: this slice hardens
  -- exactly one function and must not silently escalate its siblings.
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p WHERE p.oid = 'public.check_pending_close_ready(text)'::regprocedure;
  IF v_secdef THEN
    RAISE EXCEPTION '0049: check_pending_close_ready must remain SECURITY INVOKER';
  END IF;

  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p
   WHERE p.oid = 'public.close_produce_structured_session(text,text,text,bigint,uuid,integer)'::regprocedure;
  IF v_secdef THEN
    RAISE EXCEPTION '0049: close_produce_structured_session must remain SECURITY INVOKER';
  END IF;
END $$;
