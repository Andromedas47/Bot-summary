-- P2B Purchase Capture — Slice B: draft finalization, intake registries, notification outbox.
--
-- Slice B only: additive schema + finalize/replace draft RPCs + notification delivery RPCs.
-- Does NOT implement begin_purchase_capture_confirmation / complete_purchase_capture_posting
-- (Slice C). Does NOT wire LINE webhooks.
--
-- Design reference: docs/plans/p2b-line-intake-first-posting.md §10.3, §16.2, §16.3, §16.4
-- (Slice B RPCs only). Builds on Slice A (20260805130000_purchase_capture_sessions.sql)
-- and reuses 0052's upsert_purchase_receipt_draft plus
-- purchase_capture_compute_ingest_set_hash from Slice A.
--
-- Privilege model (matches Slice A / 0052): SECURITY DEFINER,
-- search_path = public, extensions, pg_temp, REVOKE PUBLIC/anon/authenticated,
-- GRANT EXECUTE TO service_role only. Tables: service_role SELECT only.

-- ── Registry text normalization (§10.3) — before tables that CHECK it ───────

CREATE OR REPLACE FUNCTION public.purchase_capture_normalize_registry_text(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT nullif(btrim(regexp_replace(normalize(p_text, NFC), '\s+', ' ', 'g')), '');
$$;

COMMENT ON FUNCTION public.purchase_capture_normalize_registry_text(text) IS
  'Canonical registry lookup key: NFC + collapsed internal whitespace + trim.';

REVOKE ALL ON FUNCTION public.purchase_capture_normalize_registry_text(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_capture_normalize_registry_text(text)
  TO service_role;

-- ── Intake product registry (§10.3) ───────────────────────────────────────────

CREATE TABLE public.purchase_intake_product_registry (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_product_text  text        NOT NULL UNIQUE,
  product_key       text        NOT NULL CHECK (length(btrim(product_key)) > 0),
  active            boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_intake_product_registry_raw_normalized
    CHECK (raw_product_text = public.purchase_capture_normalize_registry_text(raw_product_text))
);

COMMENT ON TABLE public.purchase_intake_product_registry IS
  'P2B manually-curated product name → canonical product_key lookup (§10.3). '
  'raw_product_text is stored normalized (NFC + collapsed whitespace).';

-- ── Intake unit alias registry (§10.3) ──────────────────────────────────────

CREATE TABLE public.purchase_intake_unit_alias_registry (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_unit_text  text        NOT NULL UNIQUE,
  unit_key       text        NOT NULL CHECK (length(btrim(unit_key)) > 0),
  active         boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_intake_unit_alias_registry_raw_normalized
    CHECK (raw_unit_text = public.purchase_capture_normalize_registry_text(raw_unit_text))
);

COMMENT ON TABLE public.purchase_intake_unit_alias_registry IS
  'P2B manually-curated unit alias → canonical unit_key lookup (§10.3). '
  'Queried independently for quantity unit and price unit per item.';

-- ── Notification outbox — one row per physical LINE push (§16.3) ────────────

CREATE TABLE public.purchase_capture_notifications (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid        NOT NULL
    REFERENCES public.purchase_capture_sessions(id),
  notification_kind     text        NOT NULL
    CHECK (notification_kind IN ('preview_ready', 'posted_success', 'stuck_escalation')),
  notification_version  text        NOT NULL
    CHECK (length(btrim(notification_version)) > 0),
  part_index            integer     NOT NULL CHECK (part_index >= 0),
  part_count            integer     NOT NULL CHECK (part_count >= 1),
  payload_text          text        NOT NULL,
  payload_hash          text        NOT NULL
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  retry_key             uuid        NOT NULL DEFAULT gen_random_uuid(),
  delivery_status       text        NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sending', 'delivered', 'failed', 'superseded')),
  claim_token           uuid,
  claim_expires_at      timestamptz,
  attempt_count         integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at       timestamptz,
  delivered_at          timestamptz,
  superseded_at         timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, notification_kind, notification_version, part_index),
  CONSTRAINT purchase_capture_notifications_sending_claim_paired
    CHECK (
      (
        delivery_status = 'sending'
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
      )
      OR (
        delivery_status <> 'sending'
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
      )
    ),
  CONSTRAINT purchase_capture_notifications_part_index_in_range
    CHECK (part_index < part_count)
);

COMMENT ON TABLE public.purchase_capture_notifications IS
  'P2B durable notification outbox: one row per physical LINE Push API message (§16.3). '
  'Logical notification = (session_id, notification_kind, notification_version); '
  'physical parts are ordered by part_index (0-based).';

CREATE INDEX purchase_capture_notifications_claim_idx
  ON public.purchase_capture_notifications (
    session_id,
    notification_kind,
    notification_version,
    part_index
  )
  WHERE delivery_status NOT IN ('delivered', 'superseded');

CREATE INDEX purchase_capture_notifications_preview_supersede_idx
  ON public.purchase_capture_notifications (session_id, notification_kind, notification_version)
  WHERE notification_kind = 'preview_ready'
    AND delivery_status IN ('pending', 'failed');

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.purchase_intake_product_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_intake_unit_alias_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_capture_notifications ENABLE ROW LEVEL SECURITY;

-- ── Notification payload hash ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_capture_notification_payload_hash(p_payload_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(
    extensions.digest(convert_to(coalesce(p_payload_text, ''), 'UTF8'), 'sha256'),
    'hex'
  );
$$;

COMMENT ON FUNCTION public.purchase_capture_notification_payload_hash(text) IS
  'Server-computed sha256 hex of exact notification payload_text (§16.3).';

REVOKE ALL ON FUNCTION public.purchase_capture_notification_payload_hash(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_capture_notification_payload_hash(text)
  TO service_role;

-- ── Registry identity immutability ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_intake_product_registry_forbid_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_intake_product_registry rows must not be deleted';
  END IF;
  IF OLD.raw_product_text IS DISTINCT FROM NEW.raw_product_text THEN
    RAISE EXCEPTION 'raw_product_text is immutable after insert';
  END IF;
  IF OLD.product_key IS DISTINCT FROM NEW.product_key THEN
    RAISE EXCEPTION 'product_key is immutable after insert';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_intake_product_registry_identity_guard
  BEFORE UPDATE OR DELETE ON public.purchase_intake_product_registry
  FOR EACH ROW EXECUTE FUNCTION public.purchase_intake_product_registry_forbid_identity_mutation();

CREATE OR REPLACE FUNCTION public.purchase_intake_unit_alias_registry_forbid_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_intake_unit_alias_registry rows must not be deleted';
  END IF;
  IF OLD.raw_unit_text IS DISTINCT FROM NEW.raw_unit_text THEN
    RAISE EXCEPTION 'raw_unit_text is immutable after insert';
  END IF;
  IF OLD.unit_key IS DISTINCT FROM NEW.unit_key THEN
    RAISE EXCEPTION 'unit_key is immutable after insert';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_intake_unit_alias_registry_identity_guard
  BEFORE UPDATE OR DELETE ON public.purchase_intake_unit_alias_registry
  FOR EACH ROW EXECUTE FUNCTION public.purchase_intake_unit_alias_registry_forbid_identity_mutation();

-- ── Notification identity immutability (§16.3) ───────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_capture_notifications_forbid_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_capture_notifications rows must not be deleted';
  END IF;
  IF OLD.session_id IS DISTINCT FROM NEW.session_id THEN
    RAISE EXCEPTION 'session_id is immutable';
  END IF;
  IF OLD.notification_kind IS DISTINCT FROM NEW.notification_kind THEN
    RAISE EXCEPTION 'notification_kind is immutable';
  END IF;
  IF OLD.notification_version IS DISTINCT FROM NEW.notification_version THEN
    RAISE EXCEPTION 'notification_version is immutable';
  END IF;
  IF OLD.part_index IS DISTINCT FROM NEW.part_index THEN
    RAISE EXCEPTION 'part_index is immutable';
  END IF;
  IF OLD.payload_text IS DISTINCT FROM NEW.payload_text THEN
    RAISE EXCEPTION 'payload_text is immutable';
  END IF;
  IF OLD.payload_hash IS DISTINCT FROM NEW.payload_hash THEN
    RAISE EXCEPTION 'payload_hash is immutable';
  END IF;
  IF OLD.retry_key IS DISTINCT FROM NEW.retry_key THEN
    RAISE EXCEPTION 'retry_key is immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_capture_notifications_identity_guard
  BEFORE UPDATE OR DELETE ON public.purchase_capture_notifications
  FOR EACH ROW EXECUTE FUNCTION public.purchase_capture_notifications_forbid_identity_mutation();

-- ── UAT seeds (§10.3, §20 — only these rows) ─────────────────────────────────
-- Product: หมอนทอง → durian-monthong, ส้มไต้หวัน → orange-taiwan
-- Unit alias: โล → kg
-- raw_* columns stored normalized via purchase_capture_normalize_registry_text.

INSERT INTO public.purchase_intake_product_registry (raw_product_text, product_key) VALUES
  (public.purchase_capture_normalize_registry_text('หมอนทอง'), 'durian-monthong'),
  (public.purchase_capture_normalize_registry_text('ส้มไต้หวัน'), 'orange-taiwan');

INSERT INTO public.purchase_intake_unit_alias_registry (raw_unit_text, unit_key) VALUES
  (public.purchase_capture_normalize_registry_text('โล'), 'kg');

-- ── Atomic multipart notification creation (internal, §16.3/§18.3) ────────────

CREATE OR REPLACE FUNCTION public.purchase_capture_create_notification_parts_internal(
  p_session_id           uuid,
  p_notification_kind    text,
  p_notification_version text,
  p_payload_texts        text[],
  p_supersede_preview    boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_now           timestamptz := clock_timestamp();
  v_part_count    integer;
  v_existing      jsonb;
  v_existing_cnt  integer;
  v_idx           integer;
  v_payload       text;
  v_hash          text;
  v_parts         jsonb := '[]'::jsonb;
  v_row           public.purchase_capture_notifications%ROWTYPE;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session_id required';
  END IF;
  IF p_notification_kind IS NULL
     OR p_notification_kind NOT IN ('preview_ready', 'posted_success', 'stuck_escalation') THEN
    RAISE EXCEPTION 'invalid notification_kind';
  END IF;
  IF p_notification_version IS NULL OR length(btrim(p_notification_version)) = 0 THEN
    RAISE EXCEPTION 'notification_version required';
  END IF;
  IF p_payload_texts IS NULL OR array_length(p_payload_texts, 1) IS NULL THEN
    RAISE EXCEPTION 'payload_texts must be a non-empty text array';
  END IF;

  v_part_count := array_length(p_payload_texts, 1);
  IF v_part_count < 1 THEN
    RAISE EXCEPTION 'payload_texts must contain at least one message';
  END IF;

  FOR v_idx IN 1..v_part_count LOOP
    v_payload := p_payload_texts[v_idx];
    IF v_payload IS NULL OR length(v_payload) = 0 THEN
      RAISE EXCEPTION 'payload_texts[%] must not be blank', v_idx - 1;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM public.purchase_capture_sessions WHERE id = p_session_id
  ) THEN
    RAISE EXCEPTION 'purchase capture session not found';
  END IF;

  SELECT count(*)::int,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'part_index', n.part_index,
               'payload_hash', n.payload_hash
             )
             ORDER BY n.part_index
           ),
           '[]'::jsonb
         )
    INTO v_existing_cnt, v_existing
    FROM public.purchase_capture_notifications n
   WHERE n.session_id = p_session_id
     AND n.notification_kind = p_notification_kind
     AND n.notification_version = btrim(p_notification_version);

  IF v_existing_cnt > 0 THEN
    IF v_existing_cnt <> v_part_count THEN
      RAISE EXCEPTION 'notification_identity_conflict';
    END IF;

    FOR v_idx IN 0..(v_part_count - 1) LOOP
      v_payload := p_payload_texts[v_idx + 1];
      v_hash := public.purchase_capture_notification_payload_hash(v_payload);
      IF (v_existing->v_idx->>'payload_hash') IS DISTINCT FROM v_hash THEN
        RAISE EXCEPTION 'notification_identity_conflict';
      END IF;
    END LOOP;

    SELECT coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'id', n.id,
                 'part_index', n.part_index,
                 'part_count', n.part_count,
                 'retry_key', n.retry_key::text,
                 'delivery_status', n.delivery_status,
                 'payload_text', n.payload_text
               )
               ORDER BY n.part_index
             ),
             '[]'::jsonb
           )
      INTO v_parts
      FROM public.purchase_capture_notifications n
     WHERE n.session_id = p_session_id
       AND n.notification_kind = p_notification_kind
       AND n.notification_version = btrim(p_notification_version);

    RETURN jsonb_build_object(
      'created', false,
      'idempotent', true,
      'parts', v_parts
    );
  END IF;

  FOR v_idx IN 0..(v_part_count - 1) LOOP
    v_payload := p_payload_texts[v_idx + 1];
    v_hash := public.purchase_capture_notification_payload_hash(v_payload);

    INSERT INTO public.purchase_capture_notifications (
      session_id,
      notification_kind,
      notification_version,
      part_index,
      part_count,
      payload_text,
      payload_hash,
      retry_key,
      delivery_status,
      created_at,
      updated_at
    ) VALUES (
      p_session_id,
      p_notification_kind,
      btrim(p_notification_version),
      v_idx,
      v_part_count,
      v_payload,
      v_hash,
      gen_random_uuid(),
      'pending',
      v_now,
      v_now
    )
    RETURNING * INTO v_row;

    v_parts := v_parts || jsonb_build_array(
      jsonb_build_object(
        'id', v_row.id,
        'part_index', v_row.part_index,
        'part_count', v_row.part_count,
        'retry_key', v_row.retry_key::text,
        'delivery_status', v_row.delivery_status,
        'payload_text', v_row.payload_text
      )
    );
  END LOOP;

  IF p_supersede_preview
     AND p_notification_kind = 'preview_ready' THEN
    UPDATE public.purchase_capture_notifications
       SET delivery_status = 'superseded',
           superseded_at = v_now,
           updated_at = v_now
     WHERE session_id = p_session_id
       AND notification_kind = 'preview_ready'
       AND notification_version IS DISTINCT FROM btrim(p_notification_version)
       AND delivery_status IN ('pending', 'failed');
  END IF;

  RETURN jsonb_build_object(
    'created', true,
    'idempotent', false,
    'parts', v_parts
  );
END;
$$;

COMMENT ON FUNCTION public.purchase_capture_create_notification_parts_internal(
  uuid, text, text, text[], boolean
) IS
  'Internal atomic multipart notification creation with identity-conflict detection '
  'and optional preview_ready supersession of pending/failed older preview parts.';

REVOKE ALL ON FUNCTION public.purchase_capture_create_notification_parts_internal(
  uuid, text, text, text[], boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_capture_create_notification_parts_internal(
  uuid, text, text, text[], boolean
) TO service_role;

-- ── create_purchase_capture_notification_parts (§16.4) ────────────────────────

CREATE OR REPLACE FUNCTION public.create_purchase_capture_notification_parts(
  p_session_id           uuid,
  p_notification_kind    text,
  p_notification_version text,
  p_payload_texts        text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  RETURN public.purchase_capture_create_notification_parts_internal(
    p_session_id,
    p_notification_kind,
    p_notification_version,
    p_payload_texts,
    p_notification_kind = 'preview_ready'
  );
END;
$$;

COMMENT ON FUNCTION public.create_purchase_capture_notification_parts(
  uuid, text, text, text[]
) IS
  'SECURITY DEFINER. Atomically creates a dense ordered multipart notification set. '
  'preview_ready also supersedes older pending/failed preview parts for the session.';

REVOKE ALL ON FUNCTION public.create_purchase_capture_notification_parts(
  uuid, text, text, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_purchase_capture_notification_parts(
  uuid, text, text, text[]
) TO service_role;

-- ── claim_next_purchase_capture_notification_part (§16.4, 60s default lease) ─

CREATE OR REPLACE FUNCTION public.claim_next_purchase_capture_notification_part(
  p_session_id            uuid,
  p_notification_kind     text,
  p_notification_version  text,
  p_claim_lease_seconds   integer DEFAULT 60
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_now       timestamptz := clock_timestamp();
  v_candidate public.purchase_capture_notifications%ROWTYPE;
  v_claim     uuid;
  v_expires   timestamptz;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session_id required';
  END IF;
  IF p_notification_kind IS NULL
     OR p_notification_kind NOT IN ('preview_ready', 'posted_success', 'stuck_escalation') THEN
    RAISE EXCEPTION 'invalid notification_kind';
  END IF;
  IF p_notification_version IS NULL OR length(btrim(p_notification_version)) = 0 THEN
    RAISE EXCEPTION 'notification_version required';
  END IF;
  IF p_claim_lease_seconds IS NULL OR p_claim_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'claim_lease_seconds must be positive';
  END IF;

  SELECT * INTO v_candidate
    FROM public.purchase_capture_notifications n
   WHERE n.session_id = p_session_id
     AND n.notification_kind = p_notification_kind
     AND n.notification_version = btrim(p_notification_version)
     AND n.delivery_status NOT IN ('delivered', 'superseded')
   ORDER BY n.part_index ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'nothing_eligible'
    );
  END IF;

  IF v_candidate.delivery_status = 'sending'
     AND v_candidate.claim_expires_at IS NOT NULL
     AND v_now < v_candidate.claim_expires_at THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'lease_active',
      'part_index', v_candidate.part_index
    );
  END IF;

  v_claim := gen_random_uuid();
  v_expires := v_now + make_interval(secs => p_claim_lease_seconds);

  UPDATE public.purchase_capture_notifications
     SET delivery_status = 'sending',
         claim_token = v_claim,
         claim_expires_at = v_expires,
         updated_at = v_now
   WHERE id = v_candidate.id
   RETURNING * INTO v_candidate;

  RETURN jsonb_build_object(
    'claimed', true,
    'id', v_candidate.id,
    'part_index', v_candidate.part_index,
    'part_count', v_candidate.part_count,
    'retry_key', v_candidate.retry_key::text,
    'payload_text', v_candidate.payload_text,
    'claim_token', v_candidate.claim_token::text
  );
END;
$$;

COMMENT ON FUNCTION public.claim_next_purchase_capture_notification_part(
  uuid, text, text, integer
) IS
  'SECURITY DEFINER. Claims the smallest eligible part_index for delivery. '
  'Reclaims sending rows with an expired lease. Never skips undelivered lower parts.';

REVOKE ALL ON FUNCTION public.claim_next_purchase_capture_notification_part(
  uuid, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_purchase_capture_notification_part(
  uuid, text, text, integer
) TO service_role;

-- ── record_purchase_capture_notification_part_attempt (§16.4) ───────────────

CREATE OR REPLACE FUNCTION public.record_purchase_capture_notification_part_attempt(
  p_notification_part_id uuid,
  p_claim_token          uuid,
  p_error_or_null        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_row public.purchase_capture_notifications%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_notification_part_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'notification_part_id and claim_token required';
  END IF;

  SELECT * INTO v_row
    FROM public.purchase_capture_notifications
   WHERE id = p_notification_part_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'notification part not found';
  END IF;

  IF v_row.delivery_status IS DISTINCT FROM 'sending' THEN
    RAISE EXCEPTION 'invalid_delivery_state';
  END IF;

  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'claim_token_mismatch';
  END IF;

  IF v_row.claim_expires_at IS NULL OR v_now > v_row.claim_expires_at THEN
    RAISE EXCEPTION 'claim_expired';
  END IF;

  UPDATE public.purchase_capture_notifications
     SET delivery_status = 'failed',
         attempt_count = attempt_count + 1,
         last_attempt_at = v_now,
         last_error = p_error_or_null,
         claim_token = NULL,
         claim_expires_at = NULL,
         updated_at = v_now
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'delivery_status', v_row.delivery_status,
    'attempt_count', v_row.attempt_count
  );
END;
$$;

COMMENT ON FUNCTION public.record_purchase_capture_notification_part_attempt(
  uuid, uuid, text
) IS
  'SECURITY DEFINER. Records a failed delivery attempt and releases the claim lease.';

REVOKE ALL ON FUNCTION public.record_purchase_capture_notification_part_attempt(
  uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_purchase_capture_notification_part_attempt(
  uuid, uuid, text
) TO service_role;

-- ── mark_purchase_capture_notification_part_delivered (§16.4) ───────────────

CREATE OR REPLACE FUNCTION public.mark_purchase_capture_notification_part_delivered(
  p_notification_part_id uuid,
  p_claim_token          uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_row public.purchase_capture_notifications%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_notification_part_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'notification_part_id and claim_token required';
  END IF;

  SELECT * INTO v_row
    FROM public.purchase_capture_notifications
   WHERE id = p_notification_part_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'notification part not found';
  END IF;

  IF v_row.delivery_status = 'delivered' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'id', v_row.id,
      'delivery_status', v_row.delivery_status
    );
  END IF;

  IF v_row.delivery_status = 'superseded' THEN
    RAISE EXCEPTION 'notification_part_superseded';
  END IF;

  IF v_row.delivery_status IS DISTINCT FROM 'sending' THEN
    RAISE EXCEPTION 'invalid_delivery_state';
  END IF;

  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'claim_token_mismatch';
  END IF;

  IF v_row.claim_expires_at IS NULL OR v_now > v_row.claim_expires_at THEN
    RAISE EXCEPTION 'claim_expired';
  END IF;

  UPDATE public.purchase_capture_notifications
     SET delivery_status = 'delivered',
         delivered_at = v_now,
         claim_token = NULL,
         claim_expires_at = NULL,
         updated_at = v_now
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'id', v_row.id,
    'delivery_status', v_row.delivery_status,
    'delivered_at', v_row.delivered_at
  );
END;
$$;

COMMENT ON FUNCTION public.mark_purchase_capture_notification_part_delivered(uuid, uuid) IS
  'SECURITY DEFINER. Marks a claimed part delivered after Push API success or 409.';

REVOKE ALL ON FUNCTION public.mark_purchase_capture_notification_part_delivered(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_purchase_capture_notification_part_delivered(uuid, uuid)
  TO service_role;

-- ── finalize_purchase_capture_session (§16.4) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.finalize_purchase_capture_session(
  p_session_id                    uuid,
  p_expected_generation           uuid,
  p_expected_ingest_revision      bigint,
  p_expected_ingest_hash          text,
  p_assembly_status               text,
  p_receipt_id_or_null            uuid DEFAULT NULL,
  p_draft_revision_or_null        bigint DEFAULT NULL,
  p_preview_payload_texts_or_null text[] DEFAULT NULL,
  p_fail_reason_or_null           text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session        public.purchase_capture_sessions%ROWTYPE;
  v_receipt        public.purchase_receipts%ROWTYPE;
  v_now            timestamptz := clock_timestamp();
  v_hash_in        text;
  v_hash           text;
  v_parts_result   jsonb;
  v_fail_reason    text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_expected_ingest_revision IS NULL THEN
    RAISE EXCEPTION 'expected_ingest_revision required';
  END IF;
  v_hash_in := btrim(coalesce(p_expected_ingest_hash, ''));
  IF length(v_hash_in) = 0 THEN
    RAISE EXCEPTION 'expected_ingest_hash required';
  END IF;
  IF p_assembly_status IS NULL OR p_assembly_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'invalid assembly_status';
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

  IF v_session.status = 'awaiting_confirmation'
     AND v_session.receipt_id IS NOT NULL
     AND v_session.draft_revision IS NOT NULL THEN
    IF p_assembly_status = 'success'
       AND p_receipt_id_or_null IS NOT NULL
       AND v_session.receipt_id = p_receipt_id_or_null
       AND v_session.draft_revision = p_draft_revision_or_null THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'status', v_session.status,
        'session_id', v_session.id,
        'receipt_id', v_session.receipt_id::text,
        'draft_revision', v_session.draft_revision::text
      );
    END IF;
  END IF;

  IF v_session.status = 'failed_closed' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'status', 'failed_closed',
      'session_id', v_session.id,
      'fail_reason', v_session.fail_reason
    );
  END IF;

  IF v_session.status IS DISTINCT FROM 'closing' THEN
    RAISE EXCEPTION 'invalid_state';
  END IF;

  IF v_session.close_event_timestamp_ms IS NULL
     OR v_session.close_quiet_until IS NULL
     OR v_session.close_deadline_at IS NULL THEN
    RAISE EXCEPTION 'close_boundary_required';
  END IF;

  IF v_session.ingest_revision IS DISTINCT FROM p_expected_ingest_revision THEN
    RAISE EXCEPTION 'stale_ingest_revision';
  END IF;

  v_hash := public.purchase_capture_compute_ingest_set_hash(p_session_id);
  IF v_hash IS DISTINCT FROM v_hash_in THEN
    RAISE EXCEPTION 'stale_ingest_hash';
  END IF;

  IF NOT (
    v_now >= v_session.close_quiet_until
    OR v_now >= v_session.close_deadline_at
  ) THEN
    RAISE EXCEPTION 'close_quiet_window';
  END IF;

  IF p_assembly_status = 'failed' OR p_receipt_id_or_null IS NULL THEN
    IF p_assembly_status = 'success' AND p_receipt_id_or_null IS NULL THEN
      RAISE EXCEPTION 'receipt_id required for successful assembly';
    END IF;

    v_fail_reason := coalesce(
      nullif(btrim(p_fail_reason_or_null), ''),
      CASE WHEN p_assembly_status = 'failed' THEN 'assembly_failed' ELSE 'failed_closed' END
    );

    UPDATE public.purchase_capture_sessions
       SET status = 'failed_closed',
           fail_reason = v_fail_reason,
           updated_at = v_now
     WHERE id = v_session.id
     RETURNING * INTO v_session;

    INSERT INTO public.purchase_capture_lifecycle_events (
      session_id, event, actor, detail
    ) VALUES (
      v_session.id, 'failed_closed', 'system',
      jsonb_build_object(
        'fail_reason', v_fail_reason,
        'finalized_ingest_revision', v_session.ingest_revision,
        'finalized_ingest_hash', v_hash
      )
    );

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', false,
      'status', 'failed_closed',
      'session_id', v_session.id,
      'fail_reason', v_fail_reason,
      'finalized_ingest_revision', v_session.ingest_revision,
      'finalized_ingest_hash', v_hash
    );
  END IF;

  IF p_draft_revision_or_null IS NULL THEN
    RAISE EXCEPTION 'draft_revision required for successful assembly';
  END IF;
  IF p_preview_payload_texts_or_null IS NULL
     OR array_length(p_preview_payload_texts_or_null, 1) IS NULL THEN
    RAISE EXCEPTION 'preview_payload_texts required for successful assembly';
  END IF;

  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE id = p_receipt_id_or_null;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt not found';
  END IF;

  IF v_receipt.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'receipt_not_draft';
  END IF;

  IF v_receipt.draft_revision IS DISTINCT FROM p_draft_revision_or_null THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;

  UPDATE public.purchase_capture_sessions
     SET status = 'awaiting_confirmation',
         receipt_id = p_receipt_id_or_null,
         draft_revision = p_draft_revision_or_null,
         updated_at = v_now
   WHERE id = v_session.id
   RETURNING * INTO v_session;

  INSERT INTO public.purchase_capture_lifecycle_events (
    session_id, event, actor, detail
  ) VALUES (
    v_session.id, 'awaiting_confirmation', 'system',
    jsonb_build_object(
      'receipt_id', p_receipt_id_or_null::text,
      'draft_revision', p_draft_revision_or_null,
      'finalized_ingest_revision', v_session.ingest_revision,
      'finalized_ingest_hash', v_hash
    )
  );

  v_parts_result := public.purchase_capture_create_notification_parts_internal(
    v_session.id,
    'preview_ready',
    p_draft_revision_or_null::text,
    p_preview_payload_texts_or_null,
    false
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'status', 'awaiting_confirmation',
    'session_id', v_session.id,
    'receipt_id', v_session.receipt_id::text,
    'draft_revision', v_session.draft_revision::text,
    'finalized_ingest_revision', v_session.ingest_revision,
    'finalized_ingest_hash', v_hash,
    'notification', v_parts_result
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_purchase_capture_session(
  uuid, uuid, bigint, text, text, uuid, bigint, text[], text
) IS
  'SECURITY DEFINER. Atomically finalize closing→awaiting_confirmation with an '
  'already-written receipt draft, or closing→failed_closed. Re-verifies ingest '
  'revision/hash and close quiet/deadline. Creates first preview_ready parts.';

REVOKE ALL ON FUNCTION public.finalize_purchase_capture_session(
  uuid, uuid, bigint, text, text, uuid, bigint, text[], text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_purchase_capture_session(
  uuid, uuid, bigint, text, text, uuid, bigint, text[], text
) TO service_role;

-- ── replace_purchase_capture_draft (§12.2, §16.4) ───────────────────────────

CREATE OR REPLACE FUNCTION public.replace_purchase_capture_draft(
  p_session_id                 uuid,
  p_expected_generation        uuid,
  p_expected_receipt_id        uuid,
  p_expected_draft_revision    bigint,
  p_source_type                text,
  p_source_id                  text,
  p_sender_line_user_id        text,
  p_draft_payload              jsonb,
  p_preview_payload_texts      text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session            public.purchase_capture_sessions%ROWTYPE;
  v_receipt            public.purchase_receipts%ROWTYPE;
  v_upsert             jsonb;
  v_new_revision       bigint;
  v_parts_result       jsonb;
  v_now                timestamptz := clock_timestamp();
  v_source_id          text;
  v_sender             text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_expected_receipt_id IS NULL OR p_expected_draft_revision IS NULL THEN
    RAISE EXCEPTION 'expected_receipt_id and expected_draft_revision required';
  END IF;
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
  IF p_draft_payload IS NULL OR jsonb_typeof(p_draft_payload) <> 'object' THEN
    RAISE EXCEPTION 'draft_payload must be a JSON object';
  END IF;
  IF p_preview_payload_texts IS NULL
     OR array_length(p_preview_payload_texts, 1) IS NULL THEN
    RAISE EXCEPTION 'preview_payload_texts must be a non-empty text array';
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

  IF v_session.source_type IS DISTINCT FROM p_source_type
     OR v_session.source_id IS DISTINCT FROM v_source_id
     OR v_session.sender_line_user_id IS DISTINCT FROM v_sender THEN
    RAISE EXCEPTION 'ownership_mismatch';
  END IF;

  IF v_session.status IS DISTINCT FROM 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'invalid_state';
  END IF;

  IF v_session.receipt_id IS DISTINCT FROM p_expected_receipt_id
     OR v_session.draft_revision IS DISTINCT FROM p_expected_draft_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;

  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE id = p_expected_receipt_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt not found';
  END IF;

  IF v_receipt.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'receipt_not_draft';
  END IF;

  IF v_receipt.draft_revision IS DISTINCT FROM p_expected_draft_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;

  v_upsert := public.upsert_purchase_receipt_draft(
    p_draft_payload->>'document_namespace',
    p_draft_payload->>'document_key',
    p_draft_payload->>'contract_version',
    (p_draft_payload->>'business_date')::date,
    coalesce(p_draft_payload->'items', '[]'::jsonb),
    NULLIF(p_draft_payload->>'purchase_time', '')::time,
    NULLIF(p_draft_payload->>'supplier_key', ''),
    NULLIF(p_draft_payload->>'supplier_raw', ''),
    NULLIF(p_draft_payload->>'supplier_ref', ''),
    NULLIF(p_draft_payload->>'reference_text', ''),
    coalesce(NULLIF(p_draft_payload->>'freight_satang', '')::bigint, 0),
    coalesce(NULLIF(p_draft_payload->>'handling_satang', '')::bigint, 0),
    coalesce(NULLIF(p_draft_payload->>'discount_satang', '')::bigint, 0),
    coalesce(NULLIF(p_draft_payload->>'vat_kind', ''), 'NONE'),
    NULLIF(p_draft_payload->>'vat_satang', '')::bigint,
    CASE
      WHEN p_draft_payload ? 'vat_included_in_item_prices'
      THEN (p_draft_payload->>'vat_included_in_item_prices')::boolean
      ELSE NULL
    END,
    CASE
      WHEN p_draft_payload ? 'vat_recoverable'
      THEN (p_draft_payload->>'vat_recoverable')::boolean
      ELSE NULL
    END,
    p_source_type,
    v_source_id,
    v_sender,
    NULLIF(p_draft_payload->>'source_line_event_id', ''),
    NULLIF(p_draft_payload->>'source_raw_message_id', '')::uuid,
    coalesce(p_draft_payload->'source_evidence', '{}'::jsonb),
    coalesce(p_draft_payload->'review_flags', '[]'::jsonb),
    NULLIF(p_draft_payload->>'supersedes_receipt_id', '')::uuid,
    NULLIF(p_draft_payload->>'actor', '')
  );

  v_new_revision := (v_upsert->>'draft_revision')::bigint;

  UPDATE public.purchase_capture_sessions
     SET draft_revision = v_new_revision,
         updated_at = v_now
   WHERE id = v_session.id
   RETURNING * INTO v_session;

  v_parts_result := public.purchase_capture_create_notification_parts_internal(
    v_session.id,
    'preview_ready',
    v_new_revision::text,
    p_preview_payload_texts,
    true
  );

  RETURN jsonb_build_object(
    'ok', true,
    'session_id', v_session.id,
    'status', v_session.status,
    'receipt_id', v_session.receipt_id::text,
    'draft_revision', v_session.draft_revision::text,
    'receipt', v_upsert,
    'notification', v_parts_result
  );
END;
$$;

COMMENT ON FUNCTION public.replace_purchase_capture_draft(
  uuid, uuid, uuid, bigint, text, text, text, jsonb, text[]
) IS
  'SECURITY DEFINER. Atomic ตรวจใบซื้อใหม่: session lock first, receipt lock '
  'second, upsert_purchase_receipt_draft from p_draft_payload, advance session '
  'draft_revision, create superseding preview_ready notification parts.';

REVOKE ALL ON FUNCTION public.replace_purchase_capture_draft(
  uuid, uuid, uuid, bigint, text, text, text, jsonb, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_purchase_capture_draft(
  uuid, uuid, uuid, bigint, text, text, text, jsonb, text[]
) TO service_role;

-- ── Explicit table privileges ────────────────────────────────────────────────

REVOKE ALL ON TABLE public.purchase_intake_product_registry FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.purchase_intake_unit_alias_registry FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.purchase_capture_notifications FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.purchase_intake_product_registry TO service_role;
GRANT SELECT ON TABLE public.purchase_intake_unit_alias_registry TO service_role;
GRANT SELECT ON TABLE public.purchase_capture_notifications TO service_role;
