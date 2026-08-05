-- P2B Purchase Capture — Slice A: durable session + ingest/close barrier.
--
-- Slice A only: additive schema + open/admit/close/candidate/cancel RPCs.
-- Does NOT parse purchase documents, does NOT write purchase_receipts drafts,
-- does NOT transition to awaiting_confirmation/confirming/posted, does NOT
-- touch physical_inventory_* / produce_sessions / pending_sessions.
--
-- Design reference: docs/plans/p2b-line-intake-first-posting.md §6-§9, §16, §21
-- (Slice A). Directly adapted from the Physical Inventory session/barrier
-- pattern (0047_physical_inventory_capture.sql, extended by the inline
-- close_physical_inventory_open_event RPC in 20260803122757_priced_house_stock.sql),
-- which is the closest existing precedent for a durable multi-message LINE
-- capture session with the same 8s quiet / 30s deadline close barrier.
--
-- Migration id note: 0054 is reserved for P2D and is deliberately not used
-- here; this repo's migration ledger uses the timestamped convention for
-- everything after 0050 (see plan §3, §16).
--
-- Close barrier (same mechanism as 0047, dedicated tables, DB clock authority):
--   first close freezes close_event_timestamp_ms (LINE event time)
--   quiet = 8s, deadline = 30s from clock_timestamp() at first close (fixed)
--   late arrivals with line_timestamp_ms <= boundary may still admit until deadline
--   line_timestamp_ms > boundary is rejected on admit after boundary exists
--   duplicate close does not move boundary / quiet / deadline
--   get_purchase_capture_finalize_candidate: one SQL statement / one snapshot
--
-- The `status` CHECK below permits the complete seven-state future list
-- (open, closing, awaiting_confirmation, confirming, posted, failed_closed,
-- cancelled) because the schema is defined once; only Slice A's RPCs exist
-- in this migration, so only open/closing/cancelled are actually reachable
-- here. awaiting_confirmation/confirming/posted are written by RPCs that
-- Slice B/C migrations add later.
--
-- Privilege model (matches 0052/0053's newer convention, preferred for new
-- code per plan §17): SECURITY DEFINER, fixed search_path
-- (public, extensions, pg_temp), REVOKE PUBLIC/anon/authenticated,
-- GRANT EXECUTE TO service_role only. Tables: service_role SELECT only,
-- mutation only via these RPCs.
--
-- Identity hardening (plan §6.4/§17): every mutating RPC below re-verifies
-- (source_type, source_id, sender_line_user_id, session_generation) against
-- the locked session row before making any change, refusing
-- `ownership_mismatch` otherwise — a caller cannot mutate a session it does
-- not already know the full identity of, even if it somehow learned the raw
-- session_id/session_generation. get_purchase_capture_finalize_candidate (a
-- read) is included for the same reason, since it returns the session's full
-- ingest content.
--
-- Redelivery hardening: a repeated line_event_id is treated as idempotent
-- ONLY when its immutable fingerprint (session identity, timestamp, kind,
-- raw_text, LINE message/raw-message ids) matches the original admission
-- exactly. Any differing field raises `line_event_conflict` rather than
-- silently accepting or overwriting different content under a reused id —
-- see purchase_capture_ingest_fingerprint_matches /
-- purchase_capture_open_fingerprint_matches below.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Sessions ─────────────────────────────────────────────────────────────────

CREATE TABLE public.purchase_capture_sessions (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type                text        NOT NULL
    CHECK (source_type IN ('user', 'group', 'room')),
  source_id                  text        NOT NULL
    CHECK (length(btrim(source_id)) > 0),
  sender_line_user_id        text        NOT NULL
    CHECK (length(btrim(sender_line_user_id)) > 0),
  -- Immutable open identity for header redelivery / concurrent open idempotency.
  opened_line_event_id       text        NOT NULL
    CHECK (length(btrim(opened_line_event_id)) > 0),
  session_generation         uuid        NOT NULL DEFAULT gen_random_uuid(),
  status                     text        NOT NULL DEFAULT 'open'
    CHECK (status IN (
      'open', 'closing', 'awaiting_confirmation', 'confirming',
      'posted', 'failed_closed', 'cancelled'
    )),
  -- Immutable LINE close boundary (ms since epoch). Set once; never moved.
  close_event_timestamp_ms   bigint,
  close_quiet_until          timestamptz,
  close_deadline_at          timestamptz,
  ingest_revision            bigint      NOT NULL DEFAULT 0,
  -- Stays NULL through all of Slice A; first set by Slice B's
  -- finalize_purchase_capture_session, updated by every later ตรวจใบซื้อใหม่.
  receipt_id                 uuid        REFERENCES public.purchase_receipts(id),
  draft_revision             bigint,
  -- Stays NULL through all of Slice A and B; first set by Slice C's
  -- complete_purchase_capture_posting.
  movement_id                uuid        REFERENCES public.inventory_movements(id),
  fail_reason                text,
  warnings                   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, sender_line_user_id, session_generation),
  UNIQUE (opened_line_event_id),
  CONSTRAINT purchase_capture_sessions_open_no_boundary
    CHECK (status <> 'open' OR close_event_timestamp_ms IS NULL),
  CONSTRAINT purchase_capture_sessions_closing_has_boundary
    CHECK (
      status <> 'closing'
      OR (
        close_event_timestamp_ms IS NOT NULL
        AND close_quiet_until IS NOT NULL
        AND close_deadline_at IS NOT NULL
      )
    ),
  CONSTRAINT purchase_capture_sessions_receipt_required_from_awaiting
    CHECK (
      status NOT IN ('awaiting_confirmation', 'confirming', 'posted')
      OR (receipt_id IS NOT NULL AND draft_revision IS NOT NULL)
    ),
  CONSTRAINT purchase_capture_sessions_movement_required_when_posted
    CHECK (status <> 'posted' OR movement_id IS NOT NULL),
  CONSTRAINT purchase_capture_sessions_failed_closed_no_receipt
    CHECK (status <> 'failed_closed' OR receipt_id IS NULL)
);

COMMENT ON TABLE public.purchase_capture_sessions IS
  'P2B durable LINE purchase-capture sessions. Slice A: open/closing/cancelled '
  'only. awaiting_confirmation/confirming/posted are written by Slice B/C RPCs '
  'added in later migrations, never by anything in this file.';

COMMENT ON COLUMN public.purchase_capture_sessions.close_event_timestamp_ms IS
  'Immutable first-close LINE event timestamp (ms). Out-of-order items with '
  'timestamp <= this value may still admit until close_deadline_at.';

COMMENT ON COLUMN public.purchase_capture_sessions.opened_line_event_id IS
  'LINE event id that opened the session. Globally unique for header redelivery '
  'idempotency; concurrent identical opens collapse to one session.';

-- At most one active (non-terminal) session per source + sender (plan §6.2).
CREATE UNIQUE INDEX purchase_capture_sessions_one_active_per_sender_idx
  ON public.purchase_capture_sessions (source_id, sender_line_user_id)
  WHERE status IN ('open', 'closing', 'awaiting_confirmation', 'confirming');

CREATE INDEX purchase_capture_sessions_source_sender_idx
  ON public.purchase_capture_sessions (source_id, sender_line_user_id, created_at DESC);

CREATE INDEX purchase_capture_sessions_closing_due_idx
  ON public.purchase_capture_sessions (close_quiet_until, close_deadline_at)
  WHERE status = 'closing';

-- ── Ingest ledger (global LINE event idempotency within purchase capture) ────

CREATE TABLE public.purchase_capture_session_ingests (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid        NOT NULL
    REFERENCES public.purchase_capture_sessions(id),
  session_generation uuid        NOT NULL,
  line_event_id      text        NOT NULL
    CHECK (length(btrim(line_event_id)) > 0),
  line_message_id    text,
  line_timestamp_ms  bigint      NOT NULL
    CHECK (line_timestamp_ms > 0),
  raw_message_id     uuid        REFERENCES public.raw_messages(id),
  kind               text        NOT NULL
    CHECK (kind IN ('header', 'item', 'costs', 'close', 'other')),
  raw_text           text        NOT NULL
    CHECK (length(btrim(raw_text)) > 0),
  -- Admission-order/audit-only counter (plan §8.2/§16.1). Never read by the
  -- parser adapter to determine document order — that is always derived by
  -- sorting on (line_timestamp_ms, line_event_id) at query time, and the
  -- authoritative hash below is computed in that same canonical order, never
  -- in admission order.
  ingest_ordinal     bigint      NOT NULL
    CHECK (ingest_ordinal > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- A LINE event belongs to at most one purchase-capture session, globally.
  UNIQUE (line_event_id),
  UNIQUE (session_id, ingest_ordinal)
);

CREATE INDEX purchase_capture_session_ingests_session_ordinal_idx
  ON public.purchase_capture_session_ingests (session_id, ingest_ordinal);

COMMENT ON TABLE public.purchase_capture_session_ingests IS
  'Immutable P2B purchase-capture ingest evidence. INSERT only via open/admit '
  'RPCs. line_event_id is globally unique inside this ingest domain.';

COMMENT ON COLUMN public.purchase_capture_session_ingests.ingest_ordinal IS
  'Admission-order/audit-only. The parser adapter (Slice B) derives document '
  'order by sorting on (line_timestamp_ms, line_event_id), never on this value '
  '— the authoritative ingest-set hash is computed in that same canonical '
  'order, so it is independent of the order events happened to be admitted in.';

-- ── Lifecycle audit (append-only) ────────────────────────────────────────────

CREATE TABLE public.purchase_capture_lifecycle_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid        NOT NULL
    REFERENCES public.purchase_capture_sessions(id),
  event        text        NOT NULL
    CHECK (event IN (
      'opened', 'closing', 'awaiting_confirmation', 'confirming',
      'posted', 'failed_closed', 'cancelled'
    )),
  actor        text,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.purchase_capture_lifecycle_events IS
  'Append-only audit of purchase-capture session state transitions. Slice A '
  'writes opened/closing/cancelled only; awaiting_confirmation/confirming/'
  'posted/failed_closed are written by Slice B/C RPCs added later.';

CREATE INDEX purchase_capture_lifecycle_events_session_idx
  ON public.purchase_capture_lifecycle_events (session_id, created_at);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.purchase_capture_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_capture_session_ingests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_capture_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- ── Immutability triggers (service_role bypasses RLS) ────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_capture_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'purchase capture %.% is append-only and immutable after write',
    TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER purchase_capture_session_ingests_immutable
  BEFORE UPDATE OR DELETE ON public.purchase_capture_session_ingests
  FOR EACH ROW EXECUTE FUNCTION public.purchase_capture_forbid_mutation();

CREATE TRIGGER purchase_capture_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.purchase_capture_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.purchase_capture_forbid_mutation();

CREATE OR REPLACE FUNCTION public.purchase_capture_forbid_terminal_session_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_capture_sessions rows must not be deleted';
  END IF;
  IF OLD.status IN ('posted', 'failed_closed', 'cancelled') THEN
    RAISE EXCEPTION
      'purchase_capture_sessions status=% is terminal and immutable', OLD.status;
  END IF;
  IF OLD.close_event_timestamp_ms IS NOT NULL
     AND NEW.close_event_timestamp_ms IS DISTINCT FROM OLD.close_event_timestamp_ms THEN
    RAISE EXCEPTION 'close_event_timestamp_ms is immutable once set';
  END IF;
  IF OLD.close_quiet_until IS NOT NULL
     AND NEW.close_quiet_until IS DISTINCT FROM OLD.close_quiet_until THEN
    RAISE EXCEPTION 'close_quiet_until is immutable once set';
  END IF;
  IF OLD.close_deadline_at IS NOT NULL
     AND NEW.close_deadline_at IS DISTINCT FROM OLD.close_deadline_at THEN
    RAISE EXCEPTION 'close_deadline_at is immutable once set';
  END IF;
  IF OLD.opened_line_event_id IS DISTINCT FROM NEW.opened_line_event_id THEN
    RAISE EXCEPTION 'opened_line_event_id is immutable';
  END IF;
  IF OLD.session_generation IS DISTINCT FROM NEW.session_generation THEN
    RAISE EXCEPTION 'session_generation is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_capture_sessions_terminal_guard
  BEFORE UPDATE OR DELETE ON public.purchase_capture_sessions
  FOR EACH ROW EXECUTE FUNCTION public.purchase_capture_forbid_terminal_session_mutation();

-- ── Ingest set hash (deterministic, ordered, close-boundary eligible only) ───
-- Ordered by (line_timestamp_ms ASC, line_event_id ASC) — the same canonical
-- document order the parser adapter (Slice B) will use — NEVER by
-- ingest_ordinal (admission order). Two sessions admitting the identical
-- logical set of events in different arrival orders must produce the same
-- hash; ingest_ordinal only ever affects the audit trail, never this value.

CREATE OR REPLACE FUNCTION public.purchase_capture_compute_ingest_set_hash(
  p_session_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(
    extensions.digest(
      coalesce(
        (
          SELECT string_agg(
            i.line_event_id
              || E'\x1f' || i.line_timestamp_ms::text
              || E'\x1f' || i.kind
              || E'\x1f' || i.raw_text,
            E'\n'
            ORDER BY i.line_timestamp_ms ASC, i.line_event_id ASC
          )
          FROM public.purchase_capture_session_ingests i
          JOIN public.purchase_capture_sessions s ON s.id = i.session_id
          WHERE i.session_id = p_session_id
            AND (
              s.close_event_timestamp_ms IS NULL
              OR i.kind = 'close'
              OR i.line_timestamp_ms <= s.close_event_timestamp_ms
            )
        ),
        ''
      ),
      'sha256'
    ),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION public.purchase_capture_compute_ingest_set_hash(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_capture_compute_ingest_set_hash(uuid)
  TO service_role;

-- ── Duplicate LINE-event fingerprint comparison ──────────────────────────────
-- A repeated line_event_id is idempotent ONLY when every immutable field of
-- the redelivered event matches the originally-admitted row exactly. Any
-- differing field is a conflicting reuse of the same line_event_id — should
-- be impossible (LINE event ids are immutable) but guarded defensively,
-- exactly as the Physical Inventory precedent guards line_event_conflict.

CREATE OR REPLACE FUNCTION public.purchase_capture_ingest_fingerprint_matches(
  p_existing            public.purchase_capture_session_ingests,
  p_session_id          uuid,
  p_session_generation  uuid,
  p_line_timestamp_ms   bigint,
  p_kind                text,
  p_raw_text            text,
  p_line_message_id     text,
  p_raw_message_id      uuid
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_existing.session_id IS NOT DISTINCT FROM p_session_id
    AND p_existing.session_generation IS NOT DISTINCT FROM p_session_generation
    AND p_existing.line_timestamp_ms IS NOT DISTINCT FROM p_line_timestamp_ms
    AND p_existing.kind IS NOT DISTINCT FROM p_kind
    AND p_existing.raw_text IS NOT DISTINCT FROM p_raw_text
    AND p_existing.line_message_id IS NOT DISTINCT FROM p_line_message_id
    AND p_existing.raw_message_id IS NOT DISTINCT FROM p_raw_message_id;
$$;

REVOKE ALL ON FUNCTION public.purchase_capture_ingest_fingerprint_matches(
  public.purchase_capture_session_ingests, uuid, uuid, bigint, text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_capture_ingest_fingerprint_matches(
  public.purchase_capture_session_ingests, uuid, uuid, bigint, text, text, text, uuid
) TO service_role;

-- Same idea for the opening (header) event, where the caller has no
-- session_id/session_generation to compare against yet — the identity to
-- verify is the owning session's (source_type, source_id, sender_line_user_id)
-- instead, plus kind='header' fixed.

CREATE OR REPLACE FUNCTION public.purchase_capture_open_fingerprint_matches(
  p_existing_ingest      public.purchase_capture_session_ingests,
  p_existing_source_type text,
  p_existing_source_id   text,
  p_existing_sender      text,
  p_source_type          text,
  p_source_id            text,
  p_sender_line_user_id  text,
  p_line_timestamp_ms    bigint,
  p_raw_text             text,
  p_line_message_id      text,
  p_raw_message_id       uuid
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_existing_ingest.kind IS NOT DISTINCT FROM 'header'
    AND p_existing_ingest.line_timestamp_ms IS NOT DISTINCT FROM p_line_timestamp_ms
    AND p_existing_ingest.raw_text IS NOT DISTINCT FROM p_raw_text
    AND p_existing_ingest.line_message_id IS NOT DISTINCT FROM p_line_message_id
    AND p_existing_ingest.raw_message_id IS NOT DISTINCT FROM p_raw_message_id
    AND p_existing_source_type IS NOT DISTINCT FROM p_source_type
    AND p_existing_source_id IS NOT DISTINCT FROM p_source_id
    AND p_existing_sender IS NOT DISTINCT FROM p_sender_line_user_id;
$$;

REVOKE ALL ON FUNCTION public.purchase_capture_open_fingerprint_matches(
  public.purchase_capture_session_ingests, text, text, text, text, text, text, bigint, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_capture_open_fingerprint_matches(
  public.purchase_capture_session_ingests, text, text, text, text, text, text, bigint, text, text, uuid
) TO service_role;

-- ── Open session (atomic + header idempotent) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.open_purchase_capture_session(
  p_source_type          text,
  p_source_id            text,
  p_sender_line_user_id  text,
  p_opened_line_event_id text,
  p_line_timestamp_ms    bigint,
  p_raw_text             text,
  p_line_message_id      text DEFAULT NULL,
  p_raw_message_id       uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_sender     text;
  v_source_id  text;
  v_event      text;
  v_session    public.purchase_capture_sessions%ROWTYPE;
  v_ingest     public.purchase_capture_session_ingests%ROWTYPE;
  v_now        timestamptz := clock_timestamp();
BEGIN
  IF p_source_type IS NULL OR p_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid source_type';
  END IF;
  IF p_source_id IS NULL OR length(btrim(p_source_id)) = 0 THEN
    RAISE EXCEPTION 'source_id required';
  END IF;
  v_source_id := btrim(p_source_id);
  v_sender := btrim(coalesce(p_sender_line_user_id, ''));
  IF length(v_sender) = 0 THEN
    RAISE EXCEPTION 'sender_line_user_id required';
  END IF;
  v_event := btrim(coalesce(p_opened_line_event_id, ''));
  IF length(v_event) = 0 THEN
    RAISE EXCEPTION 'opened_line_event_id required';
  END IF;
  IF p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION 'line_timestamp_ms must be positive';
  END IF;
  IF p_raw_text IS NULL OR length(btrim(p_raw_text)) = 0 THEN
    RAISE EXCEPTION 'raw_text required';
  END IF;

  -- Global LINE event identity first (idempotent redelivery after terminal).
  -- Idempotent ONLY when the redelivered event's fingerprint matches exactly.
  SELECT * INTO v_ingest
  FROM public.purchase_capture_session_ingests
  WHERE line_event_id = v_event;

  IF FOUND THEN
    SELECT * INTO v_session
    FROM public.purchase_capture_sessions
    WHERE id = v_ingest.session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase capture session not found';
    END IF;
    IF NOT public.purchase_capture_open_fingerprint_matches(
      v_ingest, v_session.source_type, v_session.source_id, v_session.sender_line_user_id,
      p_source_type, v_source_id, v_sender, p_line_timestamp_ms, p_raw_text,
      p_line_message_id, p_raw_message_id
    ) THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    RETURN jsonb_build_object(
      'opened', false,
      'idempotent', true,
      'reason', 'duplicate_open_event',
      'session_id', v_session.id,
      'session_generation', v_session.session_generation,
      'status', v_session.status,
      'ingest_revision', v_session.ingest_revision
    );
  END IF;

  SELECT * INTO v_session
  FROM public.purchase_capture_sessions
  WHERE opened_line_event_id = v_event;

  IF FOUND THEN
    IF v_session.source_type IS DISTINCT FROM p_source_type
       OR v_session.source_id IS DISTINCT FROM v_source_id
       OR v_session.sender_line_user_id IS DISTINCT FROM v_sender THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    RETURN jsonb_build_object(
      'opened', false,
      'idempotent', true,
      'reason', 'duplicate_open_event',
      'session_id', v_session.id,
      'session_generation', v_session.session_generation,
      'status', v_session.status,
      'ingest_revision', v_session.ingest_revision
    );
  END IF;

  BEGIN
    INSERT INTO public.purchase_capture_sessions (
      source_type,
      source_id,
      sender_line_user_id,
      opened_line_event_id,
      status,
      ingest_revision,
      created_at,
      updated_at
    ) VALUES (
      p_source_type,
      v_source_id,
      v_sender,
      v_event,
      'open',
      1,
      v_now,
      v_now
    )
    RETURNING * INTO v_session;
  EXCEPTION
    WHEN unique_violation THEN
      -- Same event redelivered and lost a race, or a different sender/source
      -- session is already active (the partial unique index this open would
      -- have violated). Distinguish the two rather than merging them.
      SELECT * INTO v_ingest
      FROM public.purchase_capture_session_ingests
      WHERE line_event_id = v_event;
      IF FOUND THEN
        SELECT * INTO v_session
        FROM public.purchase_capture_sessions
        WHERE id = v_ingest.session_id;
        IF NOT FOUND THEN
          RAISE;
        END IF;
        IF NOT public.purchase_capture_open_fingerprint_matches(
          v_ingest, v_session.source_type, v_session.source_id, v_session.sender_line_user_id,
          p_source_type, v_source_id, v_sender, p_line_timestamp_ms, p_raw_text,
          p_line_message_id, p_raw_message_id
        ) THEN
          RAISE EXCEPTION 'line_event_conflict';
        END IF;
        RETURN jsonb_build_object(
          'opened', false,
          'idempotent', true,
          'reason', 'duplicate_open_event',
          'session_id', v_session.id,
          'session_generation', v_session.session_generation,
          'status', v_session.status,
          'ingest_revision', v_session.ingest_revision
        );
      END IF;

      SELECT * INTO v_session
      FROM public.purchase_capture_sessions
      WHERE opened_line_event_id = v_event;
      IF FOUND THEN
        IF v_session.source_type IS DISTINCT FROM p_source_type
           OR v_session.source_id IS DISTINCT FROM v_source_id
           OR v_session.sender_line_user_id IS DISTINCT FROM v_sender THEN
          RAISE EXCEPTION 'line_event_conflict';
        END IF;
        RETURN jsonb_build_object(
          'opened', false,
          'idempotent', true,
          'reason', 'duplicate_open_event',
          'session_id', v_session.id,
          'session_generation', v_session.session_generation,
          'status', v_session.status,
          'ingest_revision', v_session.ingest_revision
        );
      END IF;

      SELECT * INTO v_session
      FROM public.purchase_capture_sessions
      WHERE source_id = v_source_id
        AND sender_line_user_id = v_sender
        AND status IN ('open', 'closing', 'awaiting_confirmation', 'confirming')
      LIMIT 1;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      RETURN jsonb_build_object(
        'opened', false,
        'idempotent', true,
        'reason', 'already_open',
        'session_id', v_session.id,
        'session_generation', v_session.session_generation,
        'status', v_session.status,
        'ingest_revision', v_session.ingest_revision
      );
  END;

  INSERT INTO public.purchase_capture_session_ingests (
    session_id, session_generation, line_event_id, line_message_id,
    line_timestamp_ms, raw_message_id, kind, raw_text, ingest_ordinal, created_at
  ) VALUES (
    v_session.id, v_session.session_generation, v_event, p_line_message_id,
    p_line_timestamp_ms, p_raw_message_id, 'header', p_raw_text, 1, v_now
  );

  INSERT INTO public.purchase_capture_lifecycle_events (
    session_id, event, actor, detail
  ) VALUES (
    v_session.id, 'opened', 'system',
    jsonb_build_object('opened_line_event_id', v_event)
  );

  RETURN jsonb_build_object(
    'opened', true,
    'idempotent', false,
    'reason', 'opened',
    'session_id', v_session.id,
    'session_generation', v_session.session_generation,
    'status', v_session.status,
    'ingest_revision', v_session.ingest_revision
  );
END;
$$;

COMMENT ON FUNCTION public.open_purchase_capture_session(
  text, text, text, text, bigint, text, text, uuid
) IS
  'SECURITY DEFINER. Atomically open a purchase-capture session for a header '
  'LINE event. Same opened_line_event_id with an identical fingerprint is '
  'idempotent (duplicate_open_event); a differing fingerprint under the same '
  'event id is refused (line_event_conflict); a second sender/source active '
  'session for a different event is refused distinctly (already_open).';

REVOKE ALL ON FUNCTION public.open_purchase_capture_session(
  text, text, text, text, bigint, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_purchase_capture_session(
  text, text, text, text, bigint, text, text, uuid
) TO service_role;

-- ── Admit event with close barrier (DB clock) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.admit_purchase_capture_event(
  p_session_id                    uuid,
  p_expected_generation           uuid,
  p_expected_source_type          text,
  p_expected_source_id            text,
  p_expected_sender_line_user_id  text,
  p_line_event_id                 text,
  p_line_timestamp_ms             bigint,
  p_kind                          text,
  p_raw_text                      text,
  p_line_message_id               text DEFAULT NULL,
  p_raw_message_id                uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session             public.purchase_capture_sessions%ROWTYPE;
  v_existing            public.purchase_capture_session_ingests%ROWTYPE;
  v_expected_source_id  text;
  v_expected_sender     text;
  v_next_ord            bigint;
  v_now                 timestamptz := clock_timestamp();
  v_event                text;
  v_excluded             int := 0;
  v_reason               text := 'admitted';
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_expected_source_type IS NULL OR p_expected_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid expected_source_type';
  END IF;
  IF p_expected_source_id IS NULL OR length(btrim(p_expected_source_id)) = 0 THEN
    RAISE EXCEPTION 'expected_source_id required';
  END IF;
  v_expected_source_id := btrim(p_expected_source_id);
  v_expected_sender := btrim(coalesce(p_expected_sender_line_user_id, ''));
  IF length(v_expected_sender) = 0 THEN
    RAISE EXCEPTION 'expected_sender_line_user_id required';
  END IF;
  v_event := btrim(coalesce(p_line_event_id, ''));
  IF length(v_event) = 0 THEN
    RAISE EXCEPTION 'line_event_id required';
  END IF;
  IF p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION 'line_timestamp_ms must be positive';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('header', 'item', 'costs', 'close', 'other') THEN
    RAISE EXCEPTION 'invalid kind';
  END IF;
  IF p_raw_text IS NULL OR length(btrim(p_raw_text)) = 0 THEN
    RAISE EXCEPTION 'raw_text required';
  END IF;

  -- Global identity BEFORE terminal rejection (redelivery after terminal).
  SELECT * INTO v_existing
  FROM public.purchase_capture_session_ingests
  WHERE line_event_id = v_event;

  IF FOUND THEN
    IF v_existing.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    SELECT * INTO v_session
    FROM public.purchase_capture_sessions
    WHERE id = p_session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase capture session not found';
    END IF;
    IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
      RAISE EXCEPTION 'generation_conflict';
    END IF;
    IF v_session.source_type IS DISTINCT FROM p_expected_source_type
       OR v_session.source_id IS DISTINCT FROM v_expected_source_id
       OR v_session.sender_line_user_id IS DISTINCT FROM v_expected_sender THEN
      RAISE EXCEPTION 'ownership_mismatch';
    END IF;
    IF NOT public.purchase_capture_ingest_fingerprint_matches(
      v_existing, p_session_id, p_expected_generation, p_line_timestamp_ms, p_kind,
      p_raw_text, p_line_message_id, p_raw_message_id
    ) THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    RETURN jsonb_build_object(
      'accepted', true,
      'inserted', false,
      'reason', 'duplicate_event',
      'session_id', v_session.id,
      'ingest_revision', v_session.ingest_revision,
      'status', v_session.status,
      'close_event_timestamp_ms', v_session.close_event_timestamp_ms,
      'post_boundary_excluded_count', 0
    );
  END IF;

  SELECT * INTO v_session
  FROM public.purchase_capture_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase capture session not found';
  END IF;

  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;

  IF v_session.source_type IS DISTINCT FROM p_expected_source_type
     OR v_session.source_id IS DISTINCT FROM v_expected_source_id
     OR v_session.sender_line_user_id IS DISTINCT FROM v_expected_sender THEN
    RAISE EXCEPTION 'ownership_mismatch';
  END IF;

  IF v_session.status NOT IN ('open', 'closing') THEN
    RAISE EXCEPTION 'session_closed';
  END IF;

  -- Re-check identity under session lock (concurrent identical delivery).
  SELECT * INTO v_existing
  FROM public.purchase_capture_session_ingests
  WHERE line_event_id = v_event;

  IF FOUND THEN
    IF v_existing.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    IF NOT public.purchase_capture_ingest_fingerprint_matches(
      v_existing, p_session_id, p_expected_generation, p_line_timestamp_ms, p_kind,
      p_raw_text, p_line_message_id, p_raw_message_id
    ) THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    RETURN jsonb_build_object(
      'accepted', true,
      'inserted', false,
      'reason', 'duplicate_event',
      'session_id', v_session.id,
      'ingest_revision', v_session.ingest_revision,
      'status', v_session.status,
      'close_event_timestamp_ms', v_session.close_event_timestamp_ms,
      'post_boundary_excluded_count', 0
    );
  END IF;

  -- Duplicate close without a new ingest row: do not move the boundary.
  IF v_session.close_event_timestamp_ms IS NOT NULL AND p_kind = 'close' THEN
    RETURN jsonb_build_object(
      'accepted', true,
      'inserted', false,
      'reason', 'close_already_requested',
      'session_id', v_session.id,
      'ingest_revision', v_session.ingest_revision,
      'status', v_session.status,
      'close_event_timestamp_ms', v_session.close_event_timestamp_ms,
      'post_boundary_excluded_count', 0
    );
  END IF;

  IF v_session.close_event_timestamp_ms IS NOT NULL THEN
    IF v_now >= v_session.close_deadline_at THEN
      RAISE EXCEPTION 'deadline_elapsed';
    END IF;
    IF p_line_timestamp_ms > v_session.close_event_timestamp_ms THEN
      RAISE EXCEPTION 'after_close_boundary';
    END IF;
  END IF;

  -- First close: count already-admitted post-boundary non-close evidence.
  -- Those rows stay immutable; hash/candidate exclude them from the
  -- authoritative finalizable set (never silently include).
  IF p_kind = 'close' AND v_session.close_event_timestamp_ms IS NULL THEN
    SELECT count(*)::int INTO v_excluded
    FROM public.purchase_capture_session_ingests i
    WHERE i.session_id = p_session_id
      AND i.kind IS DISTINCT FROM 'close'
      AND i.line_timestamp_ms > p_line_timestamp_ms;
    IF v_excluded > 0 THEN
      v_reason := 'admitted_close_with_post_boundary_exclusions';
    END IF;
  END IF;

  v_next_ord := v_session.ingest_revision + 1;

  BEGIN
    INSERT INTO public.purchase_capture_session_ingests (
      session_id, session_generation, line_event_id, line_message_id,
      line_timestamp_ms, raw_message_id, kind, raw_text, ingest_ordinal, created_at
    ) VALUES (
      p_session_id, v_session.session_generation, v_event, p_line_message_id,
      p_line_timestamp_ms, p_raw_message_id, p_kind, p_raw_text, v_next_ord, v_now
    );
  EXCEPTION
    WHEN unique_violation THEN
      -- Concurrent identical delivery lost the race after lock serialization
      -- edge cases (or ordinal collision). Preserve idempotent semantics —
      -- but only when the row that won the race is a genuine fingerprint match.
      SELECT * INTO v_existing
      FROM public.purchase_capture_session_ingests
      WHERE line_event_id = v_event;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      IF v_existing.session_id IS DISTINCT FROM p_session_id THEN
        RAISE EXCEPTION 'line_event_conflict';
      END IF;
      IF NOT public.purchase_capture_ingest_fingerprint_matches(
        v_existing, p_session_id, p_expected_generation, p_line_timestamp_ms, p_kind,
        p_raw_text, p_line_message_id, p_raw_message_id
      ) THEN
        RAISE EXCEPTION 'line_event_conflict';
      END IF;
      SELECT * INTO v_session
      FROM public.purchase_capture_sessions
      WHERE id = p_session_id;
      RETURN jsonb_build_object(
        'accepted', true,
        'inserted', false,
        'reason', 'duplicate_event',
        'session_id', v_session.id,
        'ingest_revision', v_session.ingest_revision,
        'status', v_session.status,
        'close_event_timestamp_ms', v_session.close_event_timestamp_ms,
        'post_boundary_excluded_count', 0
      );
  END;

  UPDATE public.purchase_capture_sessions
  SET ingest_revision = v_next_ord,
      updated_at = v_now,
      status = CASE WHEN p_kind = 'close' THEN 'closing' ELSE status END,
      close_event_timestamp_ms = CASE
        WHEN p_kind = 'close' AND close_event_timestamp_ms IS NULL THEN p_line_timestamp_ms
        ELSE close_event_timestamp_ms
      END,
      close_quiet_until = CASE
        WHEN p_kind = 'close' AND close_quiet_until IS NULL
          THEN v_now + interval '8 seconds'
        ELSE close_quiet_until
      END,
      close_deadline_at = CASE
        WHEN p_kind = 'close' AND close_deadline_at IS NULL
          THEN v_now + interval '30 seconds'
        ELSE close_deadline_at
      END
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'accepted', true,
    'inserted', true,
    'reason', v_reason,
    'session_id', v_session.id,
    'ingest_revision', v_session.ingest_revision,
    'status', v_session.status,
    'close_event_timestamp_ms', v_session.close_event_timestamp_ms,
    'post_boundary_excluded_count', v_excluded
  );
END;
$$;

COMMENT ON FUNCTION public.admit_purchase_capture_event(
  uuid, uuid, text, text, text, text, bigint, text, text, text, uuid
) IS
  'SECURITY DEFINER. Admit a purchase-capture LINE event with DB-clock close '
  'barrier. Re-verifies (source_type, source_id, sender_line_user_id, '
  'session_generation) against the locked session before any mutation, '
  'refusing ownership_mismatch otherwise. Global line_event_id uniqueness; '
  'concurrent identical-fingerprint delivery is idempotent (re-check under '
  'session lock + unique_violation handler); a differing fingerprint under '
  'the same event id is refused (line_event_conflict). First close excludes '
  'already-admitted post-boundary non-close evidence from the authoritative '
  'finalizable set without deleting ingest rows.';

REVOKE ALL ON FUNCTION public.admit_purchase_capture_event(
  uuid, uuid, text, text, text, text, bigint, text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_purchase_capture_event(
  uuid, uuid, text, text, text, text, bigint, text, text, text, uuid
) TO service_role;

-- ── Close the already-persisted opening event (one-message documents) ───────
-- One LINE event can contain header + all items + costs + close (plan §8.4).
-- The open RPC already owns that event id; close the same persisted ingest
-- without duplicating it. Mirrors close_physical_inventory_open_event
-- (20260803122757_priced_house_stock.sql).

CREATE OR REPLACE FUNCTION public.close_purchase_capture_open_event(
  p_session_id                    uuid,
  p_expected_generation           uuid,
  p_expected_source_type          text,
  p_expected_source_id            text,
  p_expected_sender_line_user_id  text,
  p_opened_line_event_id          text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session             public.purchase_capture_sessions%ROWTYPE;
  v_ingest              public.purchase_capture_session_ingests%ROWTYPE;
  v_now                 timestamptz := clock_timestamp();
  v_expected_source_id  text;
  v_expected_sender     text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_expected_source_type IS NULL OR p_expected_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid expected_source_type';
  END IF;
  IF p_expected_source_id IS NULL OR length(btrim(p_expected_source_id)) = 0 THEN
    RAISE EXCEPTION 'expected_source_id required';
  END IF;
  v_expected_source_id := btrim(p_expected_source_id);
  v_expected_sender := btrim(coalesce(p_expected_sender_line_user_id, ''));
  IF length(v_expected_sender) = 0 THEN
    RAISE EXCEPTION 'expected_sender_line_user_id required';
  END IF;

  SELECT * INTO v_session
  FROM public.purchase_capture_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'purchase capture session not found'; END IF;
  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;
  IF v_session.source_type IS DISTINCT FROM p_expected_source_type
     OR v_session.source_id IS DISTINCT FROM v_expected_source_id
     OR v_session.sender_line_user_id IS DISTINCT FROM v_expected_sender THEN
    RAISE EXCEPTION 'ownership_mismatch';
  END IF;
  IF v_session.opened_line_event_id IS DISTINCT FROM btrim(coalesce(p_opened_line_event_id, '')) THEN
    RAISE EXCEPTION 'line_event_conflict';
  END IF;
  IF v_session.status IN (
    'closing', 'awaiting_confirmation', 'confirming', 'posted', 'failed_closed', 'cancelled'
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'session_id', v_session.id,
      'status', v_session.status
    );
  END IF;
  IF v_session.status IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;

  SELECT * INTO STRICT v_ingest
  FROM public.purchase_capture_session_ingests
  WHERE session_id = v_session.id
    AND line_event_id = v_session.opened_line_event_id
    AND kind = 'header';

  UPDATE public.purchase_capture_sessions
  SET status = 'closing',
      close_event_timestamp_ms = v_ingest.line_timestamp_ms,
      close_quiet_until = v_now + interval '8 seconds',
      close_deadline_at = v_now + interval '30 seconds',
      updated_at = v_now
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.purchase_capture_lifecycle_events (
    session_id, event, actor, detail
  ) VALUES (
    v_session.id, 'closing', 'system',
    jsonb_build_object('closed_via', 'close_purchase_capture_open_event')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'session_id', v_session.id,
    'status', v_session.status
  );
END;
$$;

COMMENT ON FUNCTION public.close_purchase_capture_open_event(uuid, uuid, text, text, text, text) IS
  'SECURITY DEFINER. Re-verifies (source_type, source_id, sender_line_user_id, '
  'session_generation) against the locked session before any mutation, '
  'refusing ownership_mismatch otherwise. Sets the close boundary from the '
  'already-persisted opening ingest row for the one-message case, without '
  'inserting a second ingest row for the same line_event_id. Idempotent on '
  'redelivery (boundary fields are immutable once set).';

REVOKE ALL ON FUNCTION public.close_purchase_capture_open_event(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_purchase_capture_open_event(uuid, uuid, text, text, text, text)
  TO service_role;

-- ── Finalize candidate (one SQL statement = one snapshot) ────────────────────

CREATE OR REPLACE FUNCTION public.get_purchase_capture_finalize_candidate(
  p_session_id                    uuid,
  p_expected_generation           uuid,
  p_expected_source_type          text,
  p_expected_source_id            text,
  p_expected_sender_line_user_id  text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_result              jsonb;
  v_expected_source_id  text;
  v_expected_sender     text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_expected_source_type IS NULL OR p_expected_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid expected_source_type';
  END IF;
  IF p_expected_source_id IS NULL OR length(btrim(p_expected_source_id)) = 0 THEN
    RAISE EXCEPTION 'expected_source_id required';
  END IF;
  v_expected_source_id := btrim(p_expected_source_id);
  v_expected_sender := btrim(coalesce(p_expected_sender_line_user_id, ''));
  IF length(v_expected_sender) = 0 THEN
    RAISE EXCEPTION 'expected_sender_line_user_id required';
  END IF;

  -- Single SQL statement → one PostgreSQL snapshot for generation, revision,
  -- ordered eligible ingests, hash, and quiet/deadline eligibility. No long
  -- locks; the caller (finalize RPC, added in Slice B) re-verifies. Ownership
  -- is part of the WHERE clause itself, not a separate post-check, so a
  -- mismatched caller sees no row at all — the NULL-handling below then
  -- distinguishes not-found / generation_conflict / ownership_mismatch.
  SELECT jsonb_build_object(
    'session_id', s.id,
    'session_generation', s.session_generation,
    'status', s.status,
    'ingest_revision', s.ingest_revision,
    'ingest_set_hash', encode(
      extensions.digest(
        coalesce(
          (
            SELECT string_agg(
              i.line_event_id
                || E'\x1f' || i.line_timestamp_ms::text
                || E'\x1f' || i.kind
                || E'\x1f' || i.raw_text,
              E'\n'
              ORDER BY i.line_timestamp_ms ASC, i.line_event_id ASC
            )
            FROM public.purchase_capture_session_ingests i
            WHERE i.session_id = s.id
              AND (
                s.close_event_timestamp_ms IS NULL
                OR i.kind = 'close'
                OR i.line_timestamp_ms <= s.close_event_timestamp_ms
              )
          ),
          ''
        ),
        'sha256'
      ),
      'hex'
    ),
    'close_event_timestamp_ms', s.close_event_timestamp_ms,
    'close_quiet_until', s.close_quiet_until,
    'close_deadline_at', s.close_deadline_at,
    'quiet_elapsed', s.close_quiet_until IS NOT NULL AND clock_timestamp() >= s.close_quiet_until,
    'deadline_elapsed', s.close_deadline_at IS NOT NULL AND clock_timestamp() >= s.close_deadline_at,
    'eligible_for_finalize', s.status = 'closing' AND (
      (s.close_quiet_until IS NOT NULL AND clock_timestamp() >= s.close_quiet_until)
      OR (s.close_deadline_at IS NOT NULL AND clock_timestamp() >= s.close_deadline_at)
    ),
    -- Canonical (line_timestamp_ms, line_event_id) order — the same order the
    -- hash above is computed in — never ingest_ordinal (admission order).
    -- Slice B's parser adapter must still sort defensively rather than trust
    -- this ordering as a contract (plan §8.2/§9.1).
    'ingests', coalesce(
      (
        SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.line_timestamp_ms, x.line_event_id)
        FROM (
          SELECT
            i.line_event_id,
            i.line_timestamp_ms,
            i.kind,
            i.raw_text,
            i.ingest_ordinal,
            i.line_message_id,
            i.raw_message_id
          FROM public.purchase_capture_session_ingests i
          WHERE i.session_id = s.id
            AND (
              s.close_event_timestamp_ms IS NULL
              OR i.kind = 'close'
              OR i.line_timestamp_ms <= s.close_event_timestamp_ms
            )
          ORDER BY i.line_timestamp_ms ASC, i.line_event_id ASC
        ) x
      ),
      '[]'::jsonb
    )
  )
  INTO v_result
  FROM public.purchase_capture_sessions s
  WHERE s.id = p_session_id
    AND s.session_generation = p_expected_generation
    AND s.source_type = p_expected_source_type
    AND s.source_id = v_expected_source_id
    AND s.sender_line_user_id = v_expected_sender;

  IF v_result IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.purchase_capture_sessions WHERE id = p_session_id
    ) THEN
      RAISE EXCEPTION 'purchase capture session not found';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.purchase_capture_sessions
      WHERE id = p_session_id AND session_generation = p_expected_generation
    ) THEN
      RAISE EXCEPTION 'generation_conflict';
    END IF;
    RAISE EXCEPTION 'ownership_mismatch';
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_purchase_capture_finalize_candidate(uuid, uuid, text, text, text) IS
  'SECURITY DEFINER. Re-verifies (source_type, source_id, sender_line_user_id, '
  'session_generation) as part of the lookup itself, refusing ownership_mismatch '
  'otherwise. One SQL-statement snapshot of generation/revision/hash/ordered '
  'close-boundary-eligible ingests (canonical timestamp/event order, never '
  'admission order) plus quiet/deadline eligibility, for the caller (parser '
  'adapter + finalize RPC, added in Slice B) to act on.';

REVOKE ALL ON FUNCTION public.get_purchase_capture_finalize_candidate(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_purchase_capture_finalize_candidate(uuid, uuid, text, text, text)
  TO service_role;

-- ── Cancel (open/closing/awaiting_confirmation → cancelled) ──────────────────
-- The awaiting_confirmation branch below only becomes reachable once Slice B
-- exists (nothing in Slice A ever writes that status); the RPC signature and
-- CHECK-guarded transition table are defined once, here (plan §16.4).

CREATE OR REPLACE FUNCTION public.cancel_purchase_capture_session(
  p_session_id                    uuid,
  p_expected_generation           uuid,
  p_expected_source_type          text,
  p_expected_source_id            text,
  p_expected_sender_line_user_id  text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session             public.purchase_capture_sessions%ROWTYPE;
  v_now                 timestamptz := clock_timestamp();
  v_expected_source_id  text;
  v_expected_sender     text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_expected_source_type IS NULL OR p_expected_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid expected_source_type';
  END IF;
  IF p_expected_source_id IS NULL OR length(btrim(p_expected_source_id)) = 0 THEN
    RAISE EXCEPTION 'expected_source_id required';
  END IF;
  v_expected_source_id := btrim(p_expected_source_id);
  v_expected_sender := btrim(coalesce(p_expected_sender_line_user_id, ''));
  IF length(v_expected_sender) = 0 THEN
    RAISE EXCEPTION 'expected_sender_line_user_id required';
  END IF;

  SELECT * INTO v_session
  FROM public.purchase_capture_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'purchase capture session not found'; END IF;
  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;
  IF v_session.source_type IS DISTINCT FROM p_expected_source_type
     OR v_session.source_id IS DISTINCT FROM v_expected_source_id
     OR v_session.sender_line_user_id IS DISTINCT FROM v_expected_sender THEN
    RAISE EXCEPTION 'ownership_mismatch';
  END IF;

  IF v_session.status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'session_id', v_session.id,
      'status', v_session.status
    );
  END IF;

  IF v_session.status NOT IN ('open', 'closing', 'awaiting_confirmation') THEN
    RAISE EXCEPTION 'invalid_state';
  END IF;

  UPDATE public.purchase_capture_sessions
  SET status = 'cancelled',
      updated_at = v_now
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.purchase_capture_lifecycle_events (
    session_id, event, actor, detail
  ) VALUES (
    v_session.id, 'cancelled', 'system', '{}'::jsonb
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'session_id', v_session.id,
    'status', v_session.status
  );
END;
$$;

COMMENT ON FUNCTION public.cancel_purchase_capture_session(uuid, uuid, text, text, text) IS
  'SECURITY DEFINER. Re-verifies (source_type, source_id, sender_line_user_id, '
  'session_generation) against the locked session before any mutation, '
  'refusing ownership_mismatch otherwise. Cancels an open/closing/'
  'awaiting_confirmation session. Idempotent if already cancelled; refuses '
  'invalid_state from any other status (confirming/posted/failed_closed are '
  'never cancellable).';

REVOKE ALL ON FUNCTION public.cancel_purchase_capture_session(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_capture_session(uuid, uuid, text, text, text)
  TO service_role;

-- ── Explicit table privileges ────────────────────────────────────────────────
-- Deny broad client access; service_role reads via SELECT; mutations via DEFINER RPCs.

REVOKE ALL ON TABLE public.purchase_capture_sessions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.purchase_capture_session_ingests FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.purchase_capture_lifecycle_events FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.purchase_capture_sessions TO service_role;
GRANT SELECT ON TABLE public.purchase_capture_session_ingests TO service_role;
GRANT SELECT ON TABLE public.purchase_capture_lifecycle_events TO service_role;
