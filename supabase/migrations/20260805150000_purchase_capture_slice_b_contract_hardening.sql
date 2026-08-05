-- P2B Purchase Capture Slice B contract hardening (PR #32).
-- Replaces notification claim/create serialization, finalize/replace RPC guards.

-- ── Internal multipart creation — serialized per notification identity ────────

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
  v_lock_key      bigint;
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

  v_lock_key := hashtext(
    p_session_id::text || ':' || p_notification_kind || ':' || btrim(p_notification_version)
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT count(*)::int,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'part_index', n.part_index,
               'payload_hash', n.payload_hash,
               'id', n.id,
               'retry_key', n.retry_key::text
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

  BEGIN
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
  EXCEPTION
    WHEN unique_violation THEN
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
  END;

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

-- ── Strict ordered claim — no SKIP LOCKED skip of lower parts ────────────────

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
  v_lock_key  bigint;
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

  v_lock_key := hashtext(
    p_session_id::text || ':' || p_notification_kind || ':' || btrim(p_notification_version)
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_candidate
    FROM public.purchase_capture_notifications n
   WHERE n.session_id = p_session_id
     AND n.notification_kind = p_notification_kind
     AND n.notification_version = btrim(p_notification_version)
     AND n.delivery_status NOT IN ('delivered', 'superseded')
   ORDER BY n.part_index ASC
   LIMIT 1
   FOR UPDATE;

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

-- ── finalize_purchase_capture_session — ownership + receipt binding ─────────

DROP FUNCTION IF EXISTS public.finalize_purchase_capture_session(
  uuid, uuid, bigint, text, text, uuid, bigint, text[], text
);

CREATE OR REPLACE FUNCTION public.finalize_purchase_capture_session(
  p_session_id                    uuid,
  p_expected_generation           uuid,
  p_expected_source_type          text,
  p_expected_source_id            text,
  p_expected_sender_line_user_id  text,
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
  v_source_id      text;
  v_sender         text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_expected_source_type IS NULL
     OR p_expected_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid source_type';
  END IF;
  IF p_expected_source_id IS NULL OR length(btrim(p_expected_source_id)) = 0 THEN
    RAISE EXCEPTION 'source_id required';
  END IF;
  v_source_id := btrim(p_expected_source_id);
  v_sender := btrim(coalesce(p_expected_sender_line_user_id, ''));
  IF length(v_sender) = 0 THEN
    RAISE EXCEPTION 'sender_line_user_id required';
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

  IF v_session.source_type IS DISTINCT FROM p_expected_source_type
     OR v_session.source_id IS DISTINCT FROM v_source_id
     OR v_session.sender_line_user_id IS DISTINCT FROM v_sender THEN
    RAISE EXCEPTION 'ownership_mismatch';
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

  IF p_assembly_status = 'failed' THEN
    IF p_receipt_id_or_null IS NOT NULL THEN
      RAISE EXCEPTION 'receipt_id forbidden for failed assembly';
    END IF;
    IF p_draft_revision_or_null IS NOT NULL THEN
      RAISE EXCEPTION 'draft_revision forbidden for failed assembly';
    END IF;
    IF p_preview_payload_texts_or_null IS NOT NULL THEN
      RAISE EXCEPTION 'preview_payload_texts forbidden for failed assembly';
    END IF;

    v_fail_reason := coalesce(
      nullif(btrim(p_fail_reason_or_null), ''),
      'assembly_failed'
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

  IF p_receipt_id_or_null IS NULL THEN
    RAISE EXCEPTION 'receipt_id required for successful assembly';
  END IF;
  IF p_draft_revision_or_null IS NULL THEN
    RAISE EXCEPTION 'draft_revision required for successful assembly';
  END IF;
  IF p_preview_payload_texts_or_null IS NULL
     OR array_length(p_preview_payload_texts_or_null, 1) IS NULL THEN
    RAISE EXCEPTION 'preview_payload_texts required for successful assembly';
  END IF;
  IF p_fail_reason_or_null IS NOT NULL AND length(btrim(p_fail_reason_or_null)) > 0 THEN
    RAISE EXCEPTION 'fail_reason forbidden for successful assembly';
  END IF;

  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE id = p_receipt_id_or_null
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt not found';
  END IF;

  IF v_receipt.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'receipt_not_draft';
  END IF;

  IF v_receipt.draft_revision IS DISTINCT FROM p_draft_revision_or_null THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;

  IF v_receipt.document_namespace IS DISTINCT FROM 'line-text' THEN
    RAISE EXCEPTION 'receipt_document_namespace_mismatch';
  END IF;

  IF v_receipt.document_key IS DISTINCT FROM v_session.opened_line_event_id THEN
    RAISE EXCEPTION 'receipt_document_key_mismatch';
  END IF;

  IF v_receipt.source_type IS DISTINCT FROM v_session.source_type
     OR v_receipt.source_id IS DISTINCT FROM v_session.source_id
     OR v_receipt.sender_line_user_id IS DISTINCT FROM v_session.sender_line_user_id THEN
    RAISE EXCEPTION 'receipt_ownership_mismatch';
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

REVOKE ALL ON FUNCTION public.finalize_purchase_capture_session(
  uuid, uuid, text, text, text, bigint, text, text, uuid, bigint, text[], text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_purchase_capture_session(
  uuid, uuid, text, text, text, bigint, text, text, uuid, bigint, text[], text
) TO service_role;

-- ── replace_purchase_capture_draft — exact receipt/document binding ──────────

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
  v_upsert               jsonb;
  v_new_revision         bigint;
  v_parts_result         jsonb;
  v_now                  timestamptz := clock_timestamp();
  v_source_id            text;
  v_sender               text;
  v_payload_namespace    text;
  v_payload_key          text;
  v_upsert_receipt_id    uuid;
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

  v_payload_namespace := btrim(coalesce(p_draft_payload->>'document_namespace', ''));
  v_payload_key := btrim(coalesce(p_draft_payload->>'document_key', ''));

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

  IF v_receipt.source_type IS DISTINCT FROM v_session.source_type
     OR v_receipt.source_id IS DISTINCT FROM v_session.source_id
     OR v_receipt.sender_line_user_id IS DISTINCT FROM v_session.sender_line_user_id THEN
    RAISE EXCEPTION 'receipt_ownership_mismatch';
  END IF;

  IF v_receipt.document_namespace IS DISTINCT FROM 'line-text' THEN
    RAISE EXCEPTION 'receipt_document_namespace_mismatch';
  END IF;

  IF v_receipt.document_key IS DISTINCT FROM v_session.opened_line_event_id THEN
    RAISE EXCEPTION 'receipt_document_key_mismatch';
  END IF;

  IF v_payload_namespace IS DISTINCT FROM v_receipt.document_namespace THEN
    RAISE EXCEPTION 'draft_document_namespace_mismatch';
  END IF;

  IF v_payload_key IS DISTINCT FROM v_receipt.document_key
     OR v_payload_key IS DISTINCT FROM v_session.opened_line_event_id THEN
    RAISE EXCEPTION 'draft_document_key_mismatch';
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

  v_upsert_receipt_id := (v_upsert->>'receipt_id')::uuid;
  IF v_upsert_receipt_id IS DISTINCT FROM p_expected_receipt_id THEN
    RAISE EXCEPTION 'upsert_receipt_id_mismatch';
  END IF;

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
