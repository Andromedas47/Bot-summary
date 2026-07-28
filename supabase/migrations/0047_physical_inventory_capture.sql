-- P2A Physical Inventory Snapshot — session + immutable capture persistence.
--
-- Slice B only: additive schema + open/admit/candidate/finalize RPCs.
-- Does NOT post inventory ledger movements.
-- Does NOT touch produce_sessions / pending_sessions / P0 / P1.
--
-- Migration id 0047: Production highest applied is 0045; 0042 reserved;
-- 0046 reserved/frozen purchase prototype — do not resurrect.
--
-- Close barrier (Produce concept, dedicated tables; DB clock authority):
--   first close freezes close_event_timestamp_ms (LINE event time)
--   quiet = 8s, deadline = 30s from clock_timestamp() at first close (fixed)
--   late arrivals with line_timestamp_ms <= boundary may still admit until deadline
--   line_timestamp_ms > boundary is rejected
--   duplicate close does not move boundary / quiet / deadline
--   BOTH finalize and failed_closed require CLOSING + barrier elapsed
--
-- counted_at on snapshots = timestamptz of close_event_timestamp_ms
-- (staff close/count-completion instant), NOT server receipt time.
--
-- Void/supersede: 0047 intentionally keeps hard UPDATE lock on finalized
-- snapshots/items/lifecycle. Slice E will add the narrow audited transition
-- FINALIZED → VOIDED/SUPERSEDED with actor/reason/replacement + lifecycle.
--
-- Privilege model:
--   anon / authenticated: no table DML/SELECT; no RPC EXECUTE
--   service_role: SELECT on tables; mutation only via SECURITY DEFINER RPCs
--   RPCs: SECURITY DEFINER, fixed search_path, REVOKE PUBLIC/anon/authenticated,
--         GRANT EXECUTE TO service_role only
--   Why DEFINER: so service_role can be denied direct INSERT/UPDATE/DELETE on
--   evidence tables while open/admit/finalize still mutate atomically.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Fixed Production barrier (matches Produce 0032). Not caller-tunable.
-- Quiet: 8 seconds. Hard deadline: 30 seconds.

-- ── Sessions ─────────────────────────────────────────────────────────────────

CREATE TABLE public.physical_inventory_sessions (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type                text        NOT NULL
    CHECK (source_type IN ('user', 'group', 'room')),
  source_id                  text        NOT NULL
    CHECK (length(btrim(source_id)) > 0),
  -- NOT NULL + non-blank: Postgres UNIQUE treats NULL as distinct; empty must fail closed.
  sender_line_user_id        text        NOT NULL
    CHECK (length(btrim(sender_line_user_id)) > 0),
  -- Immutable open identity for header redelivery / concurrent open idempotency.
  opened_line_event_id       text        NOT NULL
    CHECK (length(btrim(opened_line_event_id)) > 0),
  session_generation         uuid        NOT NULL DEFAULT gen_random_uuid(),
  business_date              date,
  warehouse_code             text        NOT NULL DEFAULT 'MAIN'
    CHECK (warehouse_code = 'MAIN'),
  status                     text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closing', 'finalized', 'failed_closed', 'voided')),
  parser_version             text,
  opened_at                  timestamptz NOT NULL DEFAULT now(),
  close_requested_at         timestamptz,
  -- Immutable LINE close boundary (ms since epoch). Set once; never moved.
  close_event_timestamp_ms   bigint,
  close_quiet_until          timestamptz,
  close_deadline_at          timestamptz,
  closed_at                  timestamptz,
  failed_closed_at           timestamptz,
  fail_reason                text,
  ingest_revision            bigint      NOT NULL DEFAULT 0,
  snapshot_id                uuid,
  header_raw_message_id      uuid        REFERENCES public.raw_messages(id),
  close_raw_message_id       uuid        REFERENCES public.raw_messages(id),
  close_line_event_id        text,
  warnings                   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, sender_line_user_id, session_generation),
  UNIQUE (opened_line_event_id),
  CONSTRAINT physical_inventory_sessions_finalized_has_snapshot
    CHECK (status <> 'finalized' OR snapshot_id IS NOT NULL),
  CONSTRAINT physical_inventory_sessions_failed_closed_no_snapshot
    CHECK (status <> 'failed_closed' OR snapshot_id IS NULL),
  CONSTRAINT physical_inventory_sessions_closing_has_boundary
    CHECK (
      status <> 'closing'
      OR (
        close_event_timestamp_ms IS NOT NULL
        AND close_quiet_until IS NOT NULL
        AND close_deadline_at IS NOT NULL
      )
    ),
  CONSTRAINT physical_inventory_sessions_open_no_boundary
    CHECK (status <> 'open' OR close_event_timestamp_ms IS NULL)
);

COMMENT ON TABLE public.physical_inventory_sessions IS
  'P2A Physical Stock capture sessions. Separate from produce pending_sessions. '
  'Finalizing never writes inventory ledger movements.';

COMMENT ON COLUMN public.physical_inventory_sessions.close_event_timestamp_ms IS
  'Immutable first-close LINE event timestamp (ms). Out-of-order items with '
  'timestamp <= this value may still admit until close_deadline_at.';

COMMENT ON COLUMN public.physical_inventory_sessions.opened_line_event_id IS
  'LINE event id that opened the session. Globally unique for header redelivery '
  'idempotency; concurrent identical opens create exactly one session.';

-- At most one active (open/closing) session per source + sender.
CREATE UNIQUE INDEX physical_inventory_sessions_one_active_per_sender_idx
  ON public.physical_inventory_sessions (source_id, sender_line_user_id)
  WHERE status IN ('open', 'closing');

CREATE INDEX physical_inventory_sessions_source_sender_idx
  ON public.physical_inventory_sessions (source_id, sender_line_user_id, opened_at DESC);

-- ── Ingest ledger (global LINE event idempotency within P2A) ─────────────────

CREATE TABLE public.physical_inventory_session_ingests (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid        NOT NULL
    REFERENCES public.physical_inventory_sessions(id),
  line_event_id      text        NOT NULL
    CHECK (length(btrim(line_event_id)) > 0),
  line_message_id    text,
  line_timestamp_ms  bigint      NOT NULL
    CHECK (line_timestamp_ms > 0),
  raw_message_id     uuid        REFERENCES public.raw_messages(id),
  kind               text        NOT NULL
    CHECK (kind IN ('header', 'item', 'close', 'other')),
  raw_text           text        NOT NULL
    CHECK (length(btrim(raw_text)) > 0),
  ingest_revision    bigint      NOT NULL
    CHECK (ingest_revision > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- A LINE event belongs to at most one Physical Inventory session.
  UNIQUE (line_event_id),
  UNIQUE (session_id, ingest_revision)
);

CREATE INDEX physical_inventory_session_ingests_session_rev_idx
  ON public.physical_inventory_session_ingests (session_id, ingest_revision);

COMMENT ON TABLE public.physical_inventory_session_ingests IS
  'Immutable P2A ingest evidence. INSERT only via open/admit RPCs. '
  'line_event_id is globally unique inside the P2A ingest domain.';

-- ── Immutable finalized snapshot ─────────────────────────────────────────────

CREATE TABLE public.physical_inventory_snapshots (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                 uuid        NOT NULL
    REFERENCES public.physical_inventory_sessions(id),
  warehouse_code             text        NOT NULL DEFAULT 'MAIN'
    CHECK (warehouse_code = 'MAIN'),
  source_type                text        NOT NULL
    CHECK (source_type IN ('user', 'group', 'room')),
  source_id                  text        NOT NULL
    CHECK (length(btrim(source_id)) > 0),
  sender_line_user_id        text        NOT NULL
    CHECK (length(btrim(sender_line_user_id)) > 0),
  business_date              date        NOT NULL,
  -- Staff close/count-completion instant (= close_event_timestamp_ms), not receipt time.
  counted_at                 timestamptz NOT NULL,
  parser_version             text        NOT NULL
    CHECK (length(btrim(parser_version)) > 0),
  accepted_normalized_count  int         NOT NULL DEFAULT 0
    CHECK (accepted_normalized_count >= 0),
  accepted_raw_count         int         NOT NULL DEFAULT 0
    CHECK (accepted_raw_count >= 0),
  rejected_count             int         NOT NULL DEFAULT 0
    CHECK (rejected_count >= 0),
  item_count                 int         NOT NULL
    CHECK (item_count > 0),
  warnings                   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status                     text        NOT NULL DEFAULT 'finalized'
    CHECK (status IN ('finalized', 'voided', 'superseded')),
  ingest_idempotency_key     text        NOT NULL,
  finalized_ingest_revision  bigint      NOT NULL
    CHECK (finalized_ingest_revision > 0),
  finalized_ingest_hash      text        NOT NULL
    CHECK (length(btrim(finalized_ingest_hash)) > 0),
  finalized_at               timestamptz NOT NULL DEFAULT now(),
  voided_at                  timestamptz,
  voided_by                  text,
  void_reason                text,
  replacement_snapshot_id    uuid        REFERENCES public.physical_inventory_snapshots(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id),
  UNIQUE (ingest_idempotency_key),
  CONSTRAINT physical_inventory_snapshots_count_sum
    CHECK (
      accepted_normalized_count + accepted_raw_count + rejected_count = item_count
    ),
  CONSTRAINT physical_inventory_snapshots_void_requires_reason
    CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND voided_by IS NOT NULL)),
  CONSTRAINT physical_inventory_snapshots_replacement_not_self
    CHECK (replacement_snapshot_id IS NULL OR replacement_snapshot_id <> id),
  -- 0047: void/supersede columns exist for Slice E shape, but status stays
  -- 'finalized' only until Slice E introduces the audited transition.
  CONSTRAINT physical_inventory_snapshots_no_void_supersede_yet
    CHECK (status = 'finalized' AND voided_at IS NULL AND replacement_snapshot_id IS NULL)
);

COMMENT ON TABLE public.physical_inventory_snapshots IS
  'Immutable P2A physical observation header. Capture-only — never a ledger posting. '
  'In-place UPDATE/DELETE forbidden (triggers). Correction = void/supersede (Slice E). '
  '0047 intentionally blocks void/supersede status transitions until Slice E.';

COMMENT ON COLUMN public.physical_inventory_snapshots.counted_at IS
  'Count-completion timestamp derived from the immutable close_event_timestamp_ms '
  '(LINE close event). Not the server finalize/receipt clock.';

COMMENT ON COLUMN public.physical_inventory_snapshots.finalized_ingest_hash IS
  'SHA-256 hex of the authoritative admitted ingest set (ordered by ingest_revision).';

CREATE INDEX physical_inventory_snapshots_business_date_idx
  ON public.physical_inventory_snapshots (business_date DESC, source_id);

ALTER TABLE public.physical_inventory_sessions
  ADD CONSTRAINT physical_inventory_sessions_snapshot_id_fkey
  FOREIGN KEY (snapshot_id) REFERENCES public.physical_inventory_snapshots(id);

-- ── Immutable items (staff sequence is NOT unique) ───────────────────────────

CREATE TABLE public.physical_inventory_items (
  id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id              uuid           NOT NULL
    REFERENCES public.physical_inventory_snapshots(id),
  item_ordinal             int            NOT NULL
    CHECK (item_ordinal > 0),
  staff_sequence           int,
  raw_text                 text           NOT NULL
    CHECK (length(btrim(raw_text)) > 0),
  raw_product_description  text,
  normalized_product       text,
  quantity                 numeric(18,6),
  raw_unit                 text,
  normalized_unit          text,
  resolution_status        text           NOT NULL
    CHECK (resolution_status IN ('ACCEPTED_NORMALIZED', 'ACCEPTED_RAW', 'REJECTED')),
  reason                   text,
  created_at               timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, item_ordinal),
  CONSTRAINT physical_inventory_items_accepted_fields
    CHECK (
      resolution_status = 'REJECTED'
      OR (
        length(btrim(coalesce(raw_product_description, ''))) > 0
        AND quantity IS NOT NULL
        AND quantity > 0
        AND length(btrim(coalesce(raw_unit, ''))) > 0
      )
    )
);

COMMENT ON COLUMN public.physical_inventory_items.staff_sequence IS
  'Staff-entered ordering metadata only. Duplicates are allowed and must both persist.';

COMMENT ON COLUMN public.physical_inventory_items.normalized_product IS
  'Capture-only NFC/whitespace text from Slice A. NOT canonical inventory identity for P2C.';

CREATE INDEX physical_inventory_items_snapshot_idx
  ON public.physical_inventory_items (snapshot_id, item_ordinal);

-- ── Lifecycle audit (append-only) ────────────────────────────────────────────

CREATE TABLE public.physical_inventory_lifecycle_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid        NOT NULL
    REFERENCES public.physical_inventory_sessions(id),
  snapshot_id  uuid        REFERENCES public.physical_inventory_snapshots(id),
  event        text        NOT NULL
    CHECK (event IN ('finalized', 'failed_closed', 'voided', 'superseded')),
  actor        text,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT physical_inventory_lifecycle_finalized_needs_snapshot
    CHECK (event <> 'finalized' OR snapshot_id IS NOT NULL),
  CONSTRAINT physical_inventory_lifecycle_failed_closed_no_snapshot
    CHECK (event <> 'failed_closed' OR snapshot_id IS NULL),
  -- 0047 blocks void/supersede lifecycle until Slice E.
  CONSTRAINT physical_inventory_lifecycle_no_void_supersede_yet
    CHECK (event IN ('finalized', 'failed_closed'))
);

CREATE INDEX physical_inventory_lifecycle_events_session_idx
  ON public.physical_inventory_lifecycle_events (session_id, created_at);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.physical_inventory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_session_ingests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- ── Immutability triggers (service_role bypasses RLS) ────────────────────────

CREATE OR REPLACE FUNCTION public.physical_inventory_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'physical inventory %.% is immutable after write (use void/supersede in Slice E, never in-place edit/delete)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER physical_inventory_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.physical_inventory_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.physical_inventory_forbid_mutation();

CREATE TRIGGER physical_inventory_items_immutable
  BEFORE UPDATE OR DELETE ON public.physical_inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.physical_inventory_forbid_mutation();

CREATE TRIGGER physical_inventory_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.physical_inventory_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.physical_inventory_forbid_mutation();

CREATE TRIGGER physical_inventory_session_ingests_immutable
  BEFORE UPDATE OR DELETE ON public.physical_inventory_session_ingests
  FOR EACH ROW EXECUTE FUNCTION public.physical_inventory_forbid_mutation();

CREATE OR REPLACE FUNCTION public.physical_inventory_forbid_terminal_session_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'physical_inventory_sessions rows must not be deleted';
  END IF;
  IF OLD.status IN ('finalized', 'failed_closed', 'voided') THEN
    RAISE EXCEPTION
      'physical_inventory_sessions status=% is terminal and immutable', OLD.status;
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
  IF NEW.snapshot_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.physical_inventory_snapshots s
      WHERE s.id = NEW.snapshot_id AND s.session_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'snapshot_id must reference a snapshot owned by this session';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER physical_inventory_sessions_terminal_guard
  BEFORE UPDATE OR DELETE ON public.physical_inventory_sessions
  FOR EACH ROW EXECUTE FUNCTION public.physical_inventory_forbid_terminal_session_mutation();

CREATE OR REPLACE FUNCTION public.physical_inventory_lifecycle_session_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.snapshot_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.physical_inventory_snapshots s
      WHERE s.id = NEW.snapshot_id AND s.session_id = NEW.session_id
    ) THEN
      RAISE EXCEPTION 'lifecycle snapshot_id must belong to lifecycle session_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER physical_inventory_lifecycle_session_snapshot_guard
  BEFORE INSERT ON public.physical_inventory_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.physical_inventory_lifecycle_session_snapshot_guard();

-- ── Ingest set hash (deterministic, ordered) ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.physical_inventory_compute_ingest_set_hash(
  p_session_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT encode(
    digest(
      coalesce(
        (
          SELECT string_agg(
            i.line_event_id
              || E'\x1f' || i.line_timestamp_ms::text
              || E'\x1f' || i.kind
              || E'\x1f' || i.raw_text,
            E'\n'
            ORDER BY i.ingest_revision ASC, i.line_event_id ASC
          )
          FROM public.physical_inventory_session_ingests i
          WHERE i.session_id = p_session_id
        ),
        ''
      ),
      'sha256'
    ),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION public.physical_inventory_compute_ingest_set_hash(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.physical_inventory_compute_ingest_set_hash(uuid)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.physical_inventory_compute_ingest_set_hash(uuid)
  TO service_role;

-- ── Open session (atomic + header idempotent) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.open_physical_inventory_session(
  p_source_type          text,
  p_source_id            text,
  p_sender_line_user_id  text,
  p_opened_line_event_id text,
  p_line_timestamp_ms    bigint,
  p_raw_text             text,
  p_line_message_id      text DEFAULT NULL,
  p_raw_message_id       uuid DEFAULT NULL,
  p_business_date        date DEFAULT NULL,
  p_parser_version       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender   text;
  v_event    text;
  v_session  public.physical_inventory_sessions%ROWTYPE;
  v_ingest   public.physical_inventory_session_ingests%ROWTYPE;
  v_now      timestamptz := clock_timestamp();
BEGIN
  IF p_source_type IS NULL OR p_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid source_type';
  END IF;
  IF p_source_id IS NULL OR length(btrim(p_source_id)) = 0 THEN
    RAISE EXCEPTION 'source_id required';
  END IF;
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
  SELECT * INTO v_ingest
  FROM public.physical_inventory_session_ingests
  WHERE line_event_id = v_event;

  IF FOUND THEN
    SELECT * INTO v_session
    FROM public.physical_inventory_sessions
    WHERE id = v_ingest.session_id;
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
  FROM public.physical_inventory_sessions
  WHERE opened_line_event_id = v_event;

  IF FOUND THEN
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
    INSERT INTO public.physical_inventory_sessions (
      source_type,
      source_id,
      sender_line_user_id,
      opened_line_event_id,
      business_date,
      warehouse_code,
      status,
      parser_version,
      opened_at,
      header_raw_message_id,
      ingest_revision,
      created_at,
      updated_at
    ) VALUES (
      p_source_type,
      btrim(p_source_id),
      v_sender,
      v_event,
      p_business_date,
      'MAIN',
      'open',
      nullif(btrim(coalesce(p_parser_version, '')), ''),
      v_now,
      p_raw_message_id,
      1,
      v_now,
      v_now
    )
    RETURNING * INTO v_session;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_ingest
      FROM public.physical_inventory_session_ingests
      WHERE line_event_id = v_event;
      IF FOUND THEN
        SELECT * INTO v_session FROM public.physical_inventory_sessions WHERE id = v_ingest.session_id;
      ELSE
        SELECT * INTO v_session
        FROM public.physical_inventory_sessions
        WHERE source_id = btrim(p_source_id)
          AND sender_line_user_id = v_sender
          AND status IN ('open', 'closing')
        LIMIT 1;
        IF NOT FOUND THEN
          SELECT * INTO v_session
          FROM public.physical_inventory_sessions
          WHERE opened_line_event_id = v_event;
        END IF;
      END IF;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      RETURN jsonb_build_object(
        'opened', false,
        'idempotent', true,
        'reason', 'already_open_or_duplicate',
        'session_id', v_session.id,
        'session_generation', v_session.session_generation,
        'status', v_session.status,
        'ingest_revision', v_session.ingest_revision
      );
  END;

  INSERT INTO public.physical_inventory_session_ingests (
    session_id, line_event_id, line_message_id, line_timestamp_ms,
    raw_message_id, kind, raw_text, ingest_revision, created_at
  ) VALUES (
    v_session.id, v_event, p_line_message_id, p_line_timestamp_ms,
    p_raw_message_id, 'header', p_raw_text, 1, v_now
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

COMMENT ON FUNCTION public.open_physical_inventory_session(
  text, text, text, text, bigint, text, text, uuid, date, text
) IS
  'SECURITY DEFINER. Atomically open a Physical Stock session for a header LINE '
  'event. Same opened_line_event_id is idempotent; concurrent opens collapse to one.';

REVOKE ALL ON FUNCTION public.open_physical_inventory_session(
  text, text, text, text, bigint, text, text, uuid, date, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_physical_inventory_session(
  text, text, text, text, bigint, text, text, uuid, date, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_physical_inventory_session(
  text, text, text, text, bigint, text, text, uuid, date, text
) TO service_role;

-- ── Admit event with close barrier (DB clock) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.admit_physical_inventory_event(
  p_session_id            uuid,
  p_expected_generation   uuid,
  p_line_event_id         text,
  p_line_timestamp_ms     bigint,
  p_kind                  text,
  p_raw_text              text,
  p_line_message_id       text DEFAULT NULL,
  p_raw_message_id        uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session   public.physical_inventory_sessions%ROWTYPE;
  v_existing  public.physical_inventory_session_ingests%ROWTYPE;
  v_next_rev  bigint;
  v_now       timestamptz := clock_timestamp();
  v_event     text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  v_event := btrim(coalesce(p_line_event_id, ''));
  IF length(v_event) = 0 THEN
    RAISE EXCEPTION 'line_event_id required';
  END IF;
  IF p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION 'line_timestamp_ms must be positive';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('header', 'item', 'close', 'other') THEN
    RAISE EXCEPTION 'invalid kind';
  END IF;
  IF p_raw_text IS NULL OR length(btrim(p_raw_text)) = 0 THEN
    RAISE EXCEPTION 'raw_text required';
  END IF;

  -- Global identity BEFORE terminal rejection (redelivery after FINALIZED).
  SELECT * INTO v_existing
  FROM public.physical_inventory_session_ingests
  WHERE line_event_id = v_event;

  IF FOUND THEN
    IF v_existing.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    SELECT * INTO v_session
    FROM public.physical_inventory_sessions
    WHERE id = p_session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'physical inventory session not found';
    END IF;
    IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
      RAISE EXCEPTION 'generation_conflict';
    END IF;
    RETURN jsonb_build_object(
      'accepted', true,
      'inserted', false,
      'reason', 'duplicate_event',
      'session_id', v_session.id,
      'ingest_revision', v_session.ingest_revision,
      'status', v_session.status,
      'close_event_timestamp_ms', v_session.close_event_timestamp_ms
    );
  END IF;

  SELECT * INTO v_session
  FROM public.physical_inventory_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'physical inventory session not found';
  END IF;

  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;

  IF v_session.status IN ('finalized', 'failed_closed', 'voided') THEN
    RAISE EXCEPTION 'session_closed';
  END IF;

  -- Duplicate close without a new ingest row: do not move boundary.
  IF v_session.close_event_timestamp_ms IS NOT NULL AND p_kind = 'close' THEN
    RETURN jsonb_build_object(
      'accepted', true,
      'inserted', false,
      'reason', 'close_already_requested',
      'session_id', v_session.id,
      'ingest_revision', v_session.ingest_revision,
      'status', v_session.status,
      'close_event_timestamp_ms', v_session.close_event_timestamp_ms
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

  v_next_rev := v_session.ingest_revision + 1;

  INSERT INTO public.physical_inventory_session_ingests (
    session_id, line_event_id, line_message_id, line_timestamp_ms,
    raw_message_id, kind, raw_text, ingest_revision, created_at
  ) VALUES (
    p_session_id, v_event, p_line_message_id, p_line_timestamp_ms,
    p_raw_message_id, p_kind, p_raw_text, v_next_rev, v_now
  );

  UPDATE public.physical_inventory_sessions
  SET ingest_revision = v_next_rev,
      updated_at = v_now,
      header_raw_message_id = CASE
        WHEN p_kind = 'header' AND p_raw_message_id IS NOT NULL THEN p_raw_message_id
        ELSE header_raw_message_id
      END,
      status = CASE WHEN p_kind = 'close' THEN 'closing' ELSE status END,
      close_requested_at = CASE
        WHEN p_kind = 'close' AND close_event_timestamp_ms IS NULL THEN v_now
        ELSE close_requested_at
      END,
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
      END,
      close_line_event_id = CASE
        WHEN p_kind = 'close' AND close_line_event_id IS NULL THEN v_event
        ELSE close_line_event_id
      END,
      close_raw_message_id = CASE
        WHEN p_kind = 'close' AND close_raw_message_id IS NULL THEN p_raw_message_id
        ELSE close_raw_message_id
      END
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'accepted', true,
    'inserted', true,
    'reason', 'admitted',
    'session_id', v_session.id,
    'ingest_revision', v_session.ingest_revision,
    'status', v_session.status,
    'close_event_timestamp_ms', v_session.close_event_timestamp_ms
  );
END;
$$;

COMMENT ON FUNCTION public.admit_physical_inventory_event(
  uuid, uuid, text, bigint, text, text, text, uuid
) IS
  'SECURITY DEFINER. Admit a Physical Stock LINE event with DB-clock close barrier. '
  'Global line_event_id uniqueness; terminal redelivery of known events is idempotent.';

REVOKE ALL ON FUNCTION public.admit_physical_inventory_event(
  uuid, uuid, text, bigint, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_physical_inventory_event(
  uuid, uuid, text, bigint, text, text, text, uuid
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_physical_inventory_event(
  uuid, uuid, text, bigint, text, text, text, uuid
) TO service_role;

-- ── Finalize candidate (one consistent read) ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_physical_inventory_finalize_candidate(
  p_session_id          uuid,
  p_expected_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.physical_inventory_sessions%ROWTYPE;
  v_hash    text;
  v_ingests jsonb;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;

  SELECT * INTO v_session
  FROM public.physical_inventory_sessions
  WHERE id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'physical inventory session not found';
  END IF;
  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;

  v_hash := public.physical_inventory_compute_ingest_set_hash(p_session_id);

  SELECT coalesce(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.ingest_revision), '[]'::jsonb)
  INTO v_ingests
  FROM (
    SELECT
      i.line_event_id,
      i.line_timestamp_ms,
      i.kind,
      i.raw_text,
      i.ingest_revision,
      i.line_message_id,
      i.raw_message_id
    FROM public.physical_inventory_session_ingests i
    WHERE i.session_id = p_session_id
    ORDER BY i.ingest_revision ASC
  ) x;

  RETURN jsonb_build_object(
    'session_id', v_session.id,
    'session_generation', v_session.session_generation,
    'status', v_session.status,
    'ingest_revision', v_session.ingest_revision,
    'ingest_set_hash', v_hash,
    'close_event_timestamp_ms', v_session.close_event_timestamp_ms,
    'close_quiet_until', v_session.close_quiet_until,
    'close_deadline_at', v_session.close_deadline_at,
    'ingests', v_ingests
  );
END;
$$;

COMMENT ON FUNCTION public.get_physical_inventory_finalize_candidate(uuid, uuid) IS
  'SECURITY DEFINER. One DB-consistent read of generation/revision/hash/ordered ingests '
  'for parser finalize. Parser stays in application code.';

REVOKE ALL ON FUNCTION public.get_physical_inventory_finalize_candidate(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_physical_inventory_finalize_candidate(uuid, uuid)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_physical_inventory_finalize_candidate(uuid, uuid)
  TO service_role;

-- ── Atomic finalize / fail-closed (both require close barrier) ───────────────

CREATE OR REPLACE FUNCTION public.finalize_physical_inventory_session(
  p_session_id               uuid,
  p_expected_generation      uuid,
  p_expected_ingest_revision bigint,
  p_expected_ingest_hash     text,
  p_business_date            date,
  p_parser_version           text,
  p_warnings                 jsonb,
  p_items                    jsonb,
  p_fail_closed              boolean,
  p_fail_reason              text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session     public.physical_inventory_sessions%ROWTYPE;
  v_snapshot    public.physical_inventory_snapshots%ROWTYPE;
  v_key         text;
  v_item        jsonb;
  v_ord         int := 0;
  v_acc_norm    int := 0;
  v_acc_raw     int := 0;
  v_rejected    int := 0;
  v_item_count  int := 0;
  v_status      text;
  v_counted_at  timestamptz;
  v_now         timestamptz := clock_timestamp();
  v_hash        text;
  v_hash_in     text;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session_id required';
  END IF;
  IF p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'expected_generation required';
  END IF;
  v_hash_in := btrim(coalesce(p_expected_ingest_hash, ''));
  IF length(v_hash_in) = 0 THEN
    RAISE EXCEPTION 'expected_ingest_hash required';
  END IF;
  IF p_parser_version IS NULL OR btrim(p_parser_version) = '' THEN
    RAISE EXCEPTION 'parser_version required';
  END IF;

  SELECT * INTO v_session
  FROM public.physical_inventory_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'physical inventory session not found';
  END IF;

  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;

  v_key := v_session.id::text || ':' || v_session.session_generation::text;

  IF v_session.status = 'finalized' AND v_session.snapshot_id IS NOT NULL THEN
    SELECT * INTO v_snapshot
    FROM public.physical_inventory_snapshots
    WHERE id = v_session.snapshot_id;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'status', 'finalized',
      'snapshot_id', v_snapshot.id,
      'session_id', v_session.id,
      'finalized_ingest_revision', v_snapshot.finalized_ingest_revision,
      'finalized_ingest_hash', v_snapshot.finalized_ingest_hash
    );
  END IF;

  IF v_session.status = 'failed_closed' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'status', 'failed_closed',
      'snapshot_id', NULL,
      'session_id', v_session.id,
      'fail_reason', v_session.fail_reason
    );
  END IF;

  IF v_session.status IS DISTINCT FROM 'closing' THEN
    RAISE EXCEPTION 'close_boundary_required';
  END IF;

  IF v_session.close_event_timestamp_ms IS NULL
     OR v_session.close_quiet_until IS NULL
     OR v_session.close_deadline_at IS NULL THEN
    RAISE EXCEPTION 'close_boundary_required';
  END IF;

  IF v_session.ingest_revision IS DISTINCT FROM p_expected_ingest_revision THEN
    RAISE EXCEPTION 'stale_ingest_revision';
  END IF;

  v_hash := public.physical_inventory_compute_ingest_set_hash(p_session_id);
  IF v_hash IS DISTINCT FROM v_hash_in THEN
    RAISE EXCEPTION 'stale_ingest_hash';
  END IF;

  -- Quiet elapsed OR hard deadline reached (quiet is binding when both set).
  IF NOT (
    v_now >= v_session.close_quiet_until
    OR v_now >= v_session.close_deadline_at
  ) THEN
    RAISE EXCEPTION 'close_quiet_window';
  END IF;

  IF coalesce(p_fail_closed, false) THEN
    UPDATE public.physical_inventory_sessions
    SET status = 'failed_closed',
        failed_closed_at = v_now,
        closed_at = v_now,
        fail_reason = coalesce(nullif(btrim(p_fail_reason), ''), 'failed_closed'),
        warnings = coalesce(p_warnings, '[]'::jsonb),
        parser_version = btrim(p_parser_version),
        updated_at = v_now
    WHERE id = v_session.id;

    INSERT INTO public.physical_inventory_lifecycle_events (
      session_id, event, actor, detail
    ) VALUES (
      v_session.id,
      'failed_closed',
      'system',
      jsonb_build_object(
        'fail_reason', coalesce(p_fail_reason, 'failed_closed'),
        'finalized_ingest_revision', v_session.ingest_revision,
        'finalized_ingest_hash', v_hash
      )
    );

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', false,
      'status', 'failed_closed',
      'snapshot_id', NULL,
      'session_id', v_session.id,
      'fail_reason', coalesce(p_fail_reason, 'failed_closed'),
      'finalized_ingest_revision', v_session.ingest_revision,
      'finalized_ingest_hash', v_hash
    );
  END IF;

  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date_required';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'items_required';
  END IF;

  v_item_count := jsonb_array_length(p_items);
  v_counted_at := to_timestamp(v_session.close_event_timestamp_ms / 1000.0);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_status := v_item->>'resolution_status';
    IF v_status = 'ACCEPTED_NORMALIZED' THEN
      v_acc_norm := v_acc_norm + 1;
    ELSIF v_status = 'ACCEPTED_RAW' THEN
      v_acc_raw := v_acc_raw + 1;
    ELSIF v_status = 'REJECTED' THEN
      v_rejected := v_rejected + 1;
    ELSE
      RAISE EXCEPTION 'invalid_resolution_status';
    END IF;
  END LOOP;

  IF v_acc_norm + v_acc_raw + v_rejected <> v_item_count THEN
    RAISE EXCEPTION 'item_count_mismatch';
  END IF;

  INSERT INTO public.physical_inventory_snapshots (
    session_id,
    warehouse_code,
    source_type,
    source_id,
    sender_line_user_id,
    business_date,
    counted_at,
    parser_version,
    accepted_normalized_count,
    accepted_raw_count,
    rejected_count,
    item_count,
    warnings,
    status,
    ingest_idempotency_key,
    finalized_ingest_revision,
    finalized_ingest_hash,
    finalized_at
  ) VALUES (
    v_session.id,
    'MAIN',
    v_session.source_type,
    v_session.source_id,
    v_session.sender_line_user_id,
    p_business_date,
    v_counted_at,
    btrim(p_parser_version),
    v_acc_norm,
    v_acc_raw,
    v_rejected,
    v_item_count,
    coalesce(p_warnings, '[]'::jsonb),
    'finalized',
    v_key,
    v_session.ingest_revision,
    v_hash,
    v_now
  )
  RETURNING * INTO v_snapshot;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_ord := v_ord + 1;
    INSERT INTO public.physical_inventory_items (
      snapshot_id,
      item_ordinal,
      staff_sequence,
      raw_text,
      raw_product_description,
      normalized_product,
      quantity,
      raw_unit,
      normalized_unit,
      resolution_status,
      reason
    ) VALUES (
      v_snapshot.id,
      v_ord,
      NULLIF(v_item->>'staff_sequence', '')::int,
      coalesce(v_item->>'raw_text', ''),
      v_item->>'raw_product_description',
      v_item->>'normalized_product',
      NULLIF(v_item->>'quantity', '')::numeric,
      v_item->>'raw_unit',
      v_item->>'normalized_unit',
      v_item->>'resolution_status',
      v_item->>'reason'
    );
  END LOOP;

  UPDATE public.physical_inventory_sessions
  SET status = 'finalized',
      closed_at = v_now,
      business_date = p_business_date,
      parser_version = btrim(p_parser_version),
      snapshot_id = v_snapshot.id,
      warnings = coalesce(p_warnings, '[]'::jsonb),
      updated_at = v_now
  WHERE id = v_session.id;

  INSERT INTO public.physical_inventory_lifecycle_events (
    session_id, snapshot_id, event, actor, detail
  ) VALUES (
    v_session.id,
    v_snapshot.id,
    'finalized',
    'system',
    jsonb_build_object(
      'item_count', v_item_count,
      'accepted_normalized_count', v_acc_norm,
      'accepted_raw_count', v_acc_raw,
      'rejected_count', v_rejected,
      'counted_at', v_counted_at,
      'finalized_ingest_revision', v_session.ingest_revision,
      'finalized_ingest_hash', v_hash
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'status', 'finalized',
    'snapshot_id', v_snapshot.id,
    'session_id', v_session.id,
    'item_count', v_item_count,
    'counted_at', v_counted_at,
    'finalized_ingest_revision', v_session.ingest_revision,
    'finalized_ingest_hash', v_hash
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) IS
  'SECURITY DEFINER. Atomically finalize or fail-close after close barrier. '
  'Verifies generation + ingest_revision + ingest_set_hash. Never posts ledger. '
  'Failed_closed cannot skip CLOSING/close barrier.';

REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, text, date, text, jsonb, jsonb, boolean, text
) TO service_role;

-- ── Explicit table privileges ────────────────────────────────────────────────
-- Deny broad client access; service_role reads via SELECT; mutations via DEFINER RPCs.

REVOKE ALL ON TABLE public.physical_inventory_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.physical_inventory_session_ingests FROM PUBLIC;
REVOKE ALL ON TABLE public.physical_inventory_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.physical_inventory_items FROM PUBLIC;
REVOKE ALL ON TABLE public.physical_inventory_lifecycle_events FROM PUBLIC;

REVOKE ALL ON TABLE public.physical_inventory_sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.physical_inventory_session_ingests FROM anon, authenticated;
REVOKE ALL ON TABLE public.physical_inventory_snapshots FROM anon, authenticated;
REVOKE ALL ON TABLE public.physical_inventory_items FROM anon, authenticated;
REVOKE ALL ON TABLE public.physical_inventory_lifecycle_events FROM anon, authenticated;

REVOKE ALL ON TABLE public.physical_inventory_sessions FROM service_role;
REVOKE ALL ON TABLE public.physical_inventory_session_ingests FROM service_role;
REVOKE ALL ON TABLE public.physical_inventory_snapshots FROM service_role;
REVOKE ALL ON TABLE public.physical_inventory_items FROM service_role;
REVOKE ALL ON TABLE public.physical_inventory_lifecycle_events FROM service_role;

GRANT SELECT ON TABLE public.physical_inventory_sessions TO service_role;
GRANT SELECT ON TABLE public.physical_inventory_session_ingests TO service_role;
GRANT SELECT ON TABLE public.physical_inventory_snapshots TO service_role;
GRANT SELECT ON TABLE public.physical_inventory_items TO service_role;
GRANT SELECT ON TABLE public.physical_inventory_lifecycle_events TO service_role;
