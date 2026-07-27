-- P2A Physical Inventory Snapshot — session + immutable capture persistence.
--
-- Slice B only: additive schema + finalize RPC. Does NOT post inventory ledger
-- movements. Does NOT touch produce_sessions / pending_sessions / P0 / P1.
--
-- Migration id 0047: Production highest applied is 0045; 0042 reserved;
-- 0046 reserved/frozen purchase prototype — do not resurrect.
--
-- Security posture matches 0045: RLS enabled, no anon/authenticated policies,
-- mutation RPC EXECUTE granted to service_role only.

-- ── Sessions (dedicated; not produce pending_sessions) ───────────────────────

CREATE TABLE public.physical_inventory_sessions (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type            text        NOT NULL,
  source_id              text        NOT NULL,
  sender_line_user_id    text        NOT NULL,
  session_generation     uuid        NOT NULL DEFAULT gen_random_uuid(),
  business_date          date,
  warehouse_code         text        NOT NULL DEFAULT 'MAIN'
    CHECK (warehouse_code = 'MAIN'),
  status                 text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closing', 'finalized', 'failed_closed', 'voided')),
  parser_version         text,
  opened_at              timestamptz NOT NULL DEFAULT now(),
  close_requested_at     timestamptz,
  closed_at              timestamptz,
  failed_closed_at       timestamptz,
  fail_reason            text,
  ingest_revision        bigint      NOT NULL DEFAULT 0,
  snapshot_id            uuid,
  header_raw_message_id  uuid        REFERENCES public.raw_messages(id),
  close_raw_message_id   uuid        REFERENCES public.raw_messages(id),
  close_line_event_id    text,
  warnings               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, sender_line_user_id, session_generation)
);

COMMENT ON TABLE public.physical_inventory_sessions IS
  'P2A Physical Stock capture sessions. Separate from produce pending_sessions. '
  'Finalizing never writes inventory ledger movements.';

-- At most one active (open/closing) session per source + sender.
CREATE UNIQUE INDEX physical_inventory_sessions_one_active_per_sender_idx
  ON public.physical_inventory_sessions (source_id, sender_line_user_id)
  WHERE status IN ('open', 'closing');

CREATE INDEX physical_inventory_sessions_source_sender_idx
  ON public.physical_inventory_sessions (source_id, sender_line_user_id, opened_at DESC);

-- ── Ingest ledger (LINE event idempotency) ───────────────────────────────────

CREATE TABLE public.physical_inventory_session_ingests (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid        NOT NULL
    REFERENCES public.physical_inventory_sessions(id),
  line_event_id    text        NOT NULL,
  line_message_id  text,
  raw_message_id   uuid        REFERENCES public.raw_messages(id),
  kind             text        NOT NULL
    CHECK (kind IN ('header', 'item', 'close', 'other')),
  raw_text         text        NOT NULL,
  ingest_revision  bigint      NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
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
  counted_at                 timestamptz NOT NULL DEFAULT now(),
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
  'void/supersede columns reserved; admin void API is a later slice.';

CREATE INDEX physical_inventory_snapshots_business_date_idx
  ON public.physical_inventory_snapshots (business_date DESC, source_id);

-- Back-fill FK from sessions.snapshot_id now that snapshots exist.
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

-- ── Lifecycle audit (finalize / fail_closed; void later) ─────────────────────

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
  p_fail_reason              text DEFAULT NULL
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
BEGIN
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

  -- Idempotent redelivery of a successful finalize
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

  -- Fail closed: terminal session, no snapshot rows
  IF coalesce(p_fail_closed, false) THEN
    UPDATE public.physical_inventory_sessions
    SET status = 'failed_closed',
        failed_closed_at = now(),
        closed_at = now(),
        fail_reason = coalesce(nullif(btrim(p_fail_reason), ''), 'failed_closed'),
        warnings = coalesce(p_warnings, '[]'::jsonb),
        parser_version = p_parser_version,
        updated_at = now()
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
    now(),
    btrim(p_parser_version),
    v_acc_norm,
    v_acc_raw,
    v_rejected,
    v_item_count,
    coalesce(p_warnings, '[]'::jsonb),
    'finalized',
    v_key,
    now()
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
      closed_at = now(),
      business_date = p_business_date,
      parser_version = btrim(p_parser_version),
      snapshot_id = v_snapshot.id,
      warnings = coalesce(p_warnings, '[]'::jsonb),
      updated_at = now()
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
      'rejected_count', v_rejected
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'status', 'finalized',
    'snapshot_id', v_snapshot.id,
    'session_id', v_session.id,
    'item_count', v_item_count
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, date, text, jsonb, jsonb, boolean, text
) IS
  'Atomically finalize or fail-close a Physical Stock session. '
  'Creates snapshot+items+lifecycle in one transaction, or marks failed_closed '
  'with zero snapshot rows. Never posts inventory ledger movements. '
  'Idempotent on redelivery after terminal success.';

REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, date, text, jsonb, jsonb, boolean, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, date, text, jsonb, jsonb, boolean, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_physical_inventory_session(
  uuid, uuid, bigint, date, text, jsonb, jsonb, boolean, text
) TO service_role;
