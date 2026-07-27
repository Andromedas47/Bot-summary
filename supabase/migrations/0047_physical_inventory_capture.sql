-- P2A Physical Inventory Snapshot — session + immutable capture persistence.
--
-- Slice B only: additive schema + admit/finalize RPCs. Does NOT post inventory
-- ledger movements. Does NOT touch produce_sessions / pending_sessions / P0 / P1.
--
-- Migration id 0047: Production highest applied is 0045; 0042 reserved;
-- 0046 reserved/frozen purchase prototype — do not resurrect.
--
-- Security posture matches 0045: RLS enabled, no anon/authenticated policies,
-- mutation RPC EXECUTE granted to service_role only.
--
-- Close barrier (Produce concept, dedicated tables):
--   first close freezes close_event_timestamp_ms (LINE event time)
--   late arrivals with line_timestamp_ms <= boundary may still admit during quiet
--   line_timestamp_ms > boundary is rejected
--   duplicate close does not move the boundary
--
-- counted_at on snapshots = timestamptz of close_event_timestamp_ms
-- (staff close/count-completion instant), NOT server receipt time.

-- ── Sessions (dedicated; not produce pending_sessions) ───────────────────────

CREATE TABLE public.physical_inventory_sessions (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type                text        NOT NULL,
  source_id                  text        NOT NULL,
  -- NOT NULL + non-blank: Postgres UNIQUE treats NULL as distinct; empty must fail closed.
  sender_line_user_id        text        NOT NULL
    CHECK (length(btrim(sender_line_user_id)) > 0),
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
  UNIQUE (source_id, sender_line_user_id, session_generation)
);

COMMENT ON TABLE public.physical_inventory_sessions IS
  'P2A Physical Stock capture sessions. Separate from produce pending_sessions. '
  'Finalizing never writes inventory ledger movements.';

COMMENT ON COLUMN public.physical_inventory_sessions.close_event_timestamp_ms IS
  'Immutable first-close LINE event timestamp (ms). Out-of-order items with '
  'timestamp <= this value may still admit during the quiet window.';

-- At most one active (open/closing) session per source + sender.
CREATE UNIQUE INDEX physical_inventory_sessions_one_active_per_sender_idx
  ON public.physical_inventory_sessions (source_id, sender_line_user_id)
  WHERE status IN ('open', 'closing');

CREATE INDEX physical_inventory_sessions_source_sender_idx
  ON public.physical_inventory_sessions (source_id, sender_line_user_id, opened_at DESC);

-- ── Ingest ledger (LINE event idempotency) ───────────────────────────────────

CREATE TABLE public.physical_inventory_session_ingests (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid        NOT NULL
    REFERENCES public.physical_inventory_sessions(id),
  line_event_id      text        NOT NULL,
  line_message_id    text,
  line_timestamp_ms  bigint      NOT NULL,
  raw_message_id     uuid        REFERENCES public.raw_messages(id),
  kind               text        NOT NULL
    CHECK (kind IN ('header', 'item', 'close', 'other')),
  raw_text           text        NOT NULL,
  ingest_revision    bigint      NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, line_event_id)
);

CREATE INDEX physical_inventory_session_ingests_session_rev_idx
  ON public.physical_inventory_session_ingests (session_id, ingest_revision);

-- ── Immutable finalized snapshot ─────────────────────────────────────────────

CREATE TABLE public.physical_inventory_snapshots (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                 uuid        NOT NULL
    REFERENCES public.physical_inventory_sessions(id),
  warehouse_code             text        NOT NULL DEFAULT 'MAIN'
    CHECK (warehouse_code = 'MAIN'),
  source_type                text        NOT NULL,
  source_id                  text        NOT NULL,
  sender_line_user_id        text        NOT NULL,
  business_date              date        NOT NULL,
  -- Staff close/count-completion instant (= close_event_timestamp_ms), not receipt time.
  counted_at                 timestamptz NOT NULL,
  parser_version             text        NOT NULL,
  accepted_normalized_count  int         NOT NULL DEFAULT 0,
  accepted_raw_count         int         NOT NULL DEFAULT 0,
  rejected_count             int         NOT NULL DEFAULT 0,
  item_count                 int         NOT NULL DEFAULT 0,
  warnings                   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status                     text        NOT NULL DEFAULT 'finalized'
    CHECK (status IN ('finalized', 'voided', 'superseded')),
  ingest_idempotency_key     text        NOT NULL,
  finalized_at               timestamptz NOT NULL DEFAULT now(),
  voided_at                  timestamptz,
  voided_by                  text,
  void_reason                text,
  replacement_snapshot_id    uuid        REFERENCES public.physical_inventory_snapshots(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id),
  UNIQUE (ingest_idempotency_key),
  CONSTRAINT physical_inventory_snapshots_void_requires_reason
    CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND voided_by IS NOT NULL)),
  CONSTRAINT physical_inventory_snapshots_replacement_not_self
    CHECK (replacement_snapshot_id IS NULL OR replacement_snapshot_id <> id)
);

COMMENT ON TABLE public.physical_inventory_snapshots IS
  'Immutable P2A physical observation header. Capture-only — never a ledger posting. '
  'In-place UPDATE/DELETE forbidden (triggers). Correction = void/supersede (Slice E).';

COMMENT ON COLUMN public.physical_inventory_snapshots.counted_at IS
  'Count-completion timestamp derived from the immutable close_event_timestamp_ms '
  '(LINE close event). Not the server finalize/receipt clock.';

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
  item_ordinal             int            NOT NULL,
  staff_sequence           int,
  raw_text                 text           NOT NULL,
  raw_product_description  text,
  normalized_product       text,
  quantity                 numeric(18,6),
  raw_unit                 text,
  normalized_unit          text,
  resolution_status        text           NOT NULL
    CHECK (resolution_status IN ('ACCEPTED_NORMALIZED', 'ACCEPTED_RAW', 'REJECTED')),
  reason                   text,
  created_at               timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, item_ordinal)
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
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX physical_inventory_lifecycle_events_session_idx
  ON public.physical_inventory_lifecycle_events (session_id, created_at);

-- ── RLS: service_role bypass only (no anon/authenticated policies) ───────────

ALTER TABLE public.physical_inventory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_session_ingests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- ── DB-enforced immutability (service_role bypasses RLS — triggers required) ─

CREATE OR REPLACE FUNCTION public.physical_inventory_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'physical inventory %.% is immutable after write (use void/supersede, never in-place edit/delete)',
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
  -- First close boundary must never move once set.
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER physical_inventory_sessions_terminal_guard
  BEFORE UPDATE OR DELETE ON public.physical_inventory_sessions
  FOR EACH ROW EXECUTE FUNCTION public.physical_inventory_forbid_terminal_session_mutation();

-- ── Admit event with close barrier (atomic) ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.admit_physical_inventory_event(
  p_session_id            uuid,
  p_expected_generation   uuid,
  p_line_event_id         text,
  p_line_timestamp_ms     bigint,
  p_kind                  text,
  p_raw_text              text,
  p_line_message_id       text DEFAULT NULL,
  p_raw_message_id        uuid DEFAULT NULL,
  p_quiet_ms              integer DEFAULT 8000,
  p_deadline_ms           integer DEFAULT 30000,
  p_as_of                 timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_session   public.physical_inventory_sessions%ROWTYPE;
  v_existing  uuid;
  v_next_rev  bigint;
  v_quiet_ms  integer;
  v_dead_ms   integer;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_line_event_id IS NULL OR btrim(p_line_event_id) = '' THEN
    RAISE EXCEPTION 'line_event_id required';
  END IF;
  IF p_line_timestamp_ms IS NULL THEN
    RAISE EXCEPTION 'line_timestamp_ms required';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('header', 'item', 'close', 'other') THEN
    RAISE EXCEPTION 'invalid kind';
  END IF;

  v_quiet_ms := GREATEST(coalesce(p_quiet_ms, 8000), 0);
  v_dead_ms  := GREATEST(coalesce(p_deadline_ms, 30000), v_quiet_ms);

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

  SELECT id INTO v_existing
  FROM public.physical_inventory_session_ingests
  WHERE session_id = p_session_id AND line_event_id = p_line_event_id;

  IF FOUND THEN
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

  -- Duplicate close: accept as no-op; do not move boundary / quiet / deadline.
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
    IF p_as_of >= v_session.close_deadline_at THEN
      RAISE EXCEPTION 'deadline_elapsed';
    END IF;
    IF p_line_timestamp_ms > v_session.close_event_timestamp_ms THEN
      RAISE EXCEPTION 'after_close_boundary';
    END IF;
  END IF;

  v_next_rev := v_session.ingest_revision + 1;

  INSERT INTO public.physical_inventory_session_ingests (
    session_id, line_event_id, line_message_id, line_timestamp_ms,
    raw_message_id, kind, raw_text, ingest_revision
  ) VALUES (
    p_session_id, p_line_event_id, p_line_message_id, p_line_timestamp_ms,
    p_raw_message_id, p_kind, p_raw_text, v_next_rev
  );

  UPDATE public.physical_inventory_sessions
  SET ingest_revision = v_next_rev,
      updated_at = p_as_of,
      header_raw_message_id = CASE
        WHEN p_kind = 'header' AND p_raw_message_id IS NOT NULL THEN p_raw_message_id
        ELSE header_raw_message_id
      END,
      status = CASE WHEN p_kind = 'close' THEN 'closing' ELSE status END,
      close_requested_at = CASE
        WHEN p_kind = 'close' AND close_event_timestamp_ms IS NULL THEN p_as_of
        ELSE close_requested_at
      END,
      close_event_timestamp_ms = CASE
        WHEN p_kind = 'close' AND close_event_timestamp_ms IS NULL THEN p_line_timestamp_ms
        ELSE close_event_timestamp_ms
      END,
      close_quiet_until = CASE
        WHEN p_kind = 'close' AND close_quiet_until IS NULL
          THEN p_as_of + make_interval(secs => v_quiet_ms / 1000.0)
        ELSE close_quiet_until
      END,
      close_deadline_at = CASE
        WHEN p_kind = 'close' AND close_deadline_at IS NULL
          THEN p_as_of + make_interval(secs => v_dead_ms / 1000.0)
        ELSE close_deadline_at
      END,
      close_line_event_id = CASE
        WHEN p_kind = 'close' AND close_line_event_id IS NULL THEN p_line_event_id
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
  uuid, uuid, text, bigint, text, text, text, uuid, integer, integer, timestamptz
) IS
  'Atomically admit a Physical Stock LINE event with close-boundary rules. '
  'First close freezes LINE timestamp boundary; later events after that LINE '
  'time are rejected; pre-boundary late arrivals admit during quiet window.';

REVOKE ALL ON FUNCTION public.admit_physical_inventory_event(
  uuid, uuid, text, bigint, text, text, text, uuid, integer, integer, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_physical_inventory_event(
  uuid, uuid, text, bigint, text, text, text, uuid, integer, integer, timestamptz
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_physical_inventory_event(
  uuid, uuid, text, bigint, text, text, text, uuid, integer, integer, timestamptz
) TO service_role;

-- ── Atomic finalize / fail-closed RPC ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.finalize_physical_inventory_session(
  p_session_id               uuid,
  p_expected_generation      uuid,
  p_expected_ingest_revision bigint,
  p_business_date            date,
  p_parser_version           text,
  p_warnings                 jsonb,
  p_items                    jsonb,
  p_fail_closed              boolean,
  p_fail_reason              text DEFAULT NULL,
  p_as_of                    timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
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
  v_as_of       timestamptz;
BEGIN
  v_as_of := coalesce(p_as_of, now());

  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session_id required';
  END IF;
  IF p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'expected_generation required';
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
      'session_id', v_session.id
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

  IF v_session.status NOT IN ('open', 'closing') THEN
    RAISE EXCEPTION 'session_not_finalizable status=%', v_session.status;
  END IF;

  IF v_session.ingest_revision IS DISTINCT FROM p_expected_ingest_revision THEN
    RAISE EXCEPTION 'stale_ingest_revision';
  END IF;

  -- Successful finalize waits for quiet window so late pre-boundary events can land.
  IF NOT coalesce(p_fail_closed, false) THEN
    IF v_session.close_event_timestamp_ms IS NULL THEN
      RAISE EXCEPTION 'close_boundary_required';
    END IF;
    IF v_as_of < v_session.close_quiet_until THEN
      RAISE EXCEPTION 'close_quiet_window';
    END IF;
  END IF;

  IF coalesce(p_fail_closed, false) THEN
    UPDATE public.physical_inventory_sessions
    SET status = 'failed_closed',
        failed_closed_at = v_as_of,
        closed_at = v_as_of,
        fail_reason = coalesce(nullif(btrim(p_fail_reason), ''), 'failed_closed'),
        warnings = coalesce(p_warnings, '[]'::jsonb),
        parser_version = p_parser_version,
        updated_at = v_as_of
    WHERE id = v_session.id;

    INSERT INTO public.physical_inventory_lifecycle_events (
      session_id, event, actor, detail
    ) VALUES (
      v_session.id,
      'failed_closed',
      'system',
      jsonb_build_object('fail_reason', coalesce(p_fail_reason, 'failed_closed'))
    );

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', false,
      'status', 'failed_closed',
      'snapshot_id', NULL,
      'session_id', v_session.id,
      'fail_reason', coalesce(p_fail_reason, 'failed_closed')
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
    v_as_of
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
      closed_at = v_as_of,
      business_date = p_business_date,
      parser_version = btrim(p_parser_version),
      snapshot_id = v_snapshot.id,
      warnings = coalesce(p_warnings, '[]'::jsonb),
      updated_at = v_as_of
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
      'counted_at', v_counted_at
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'status', 'finalized',
    'snapshot_id', v_snapshot.id,
    'session_id', v_session.id,
    'item_count', v_item_count,
    'counted_at', v_counted_at
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, date, text, jsonb, jsonb, boolean, text, timestamptz
) IS
  'Atomically finalize or fail-close a Physical Stock session after the close '
  'quiet window. Snapshot counted_at uses close_event_timestamp_ms. Never posts '
  'inventory ledger movements. Idempotent on terminal redelivery.';

REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, date, text, jsonb, jsonb, boolean, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, date, text, jsonb, jsonb, boolean, text, timestamptz
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, date, text, jsonb, jsonb, boolean, text, timestamptz
) TO service_role;
