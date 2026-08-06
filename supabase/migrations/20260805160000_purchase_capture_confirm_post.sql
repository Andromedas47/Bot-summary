-- P2B/P2C Purchase Capture — Slice C1: confirm gate + posting completion.
--
-- Adds begin_purchase_capture_confirmation and complete_purchase_capture_posting.
-- Does NOT wire LINE webhooks, confirm-flow.ts, or cron recovery.
-- Does NOT modify 0052, 0053, or Slice A/B migrations.
--
-- Lock order (begin + replace_purchase_capture_draft share this order — no deadlock):
--   purchase_capture_sessions FOR UPDATE → purchase_receipts FOR UPDATE
--
-- Requires: Slice A/B (purchase_capture_sessions), 0052 (purchase_receipts),
--           Slice B outbox (purchase_capture_create_notification_parts_internal),
--           0053 (inventory_movements) for complete_* movement validation.

-- ── Internal: blocking blocker evaluation (authoritative, under receipt lock) ─

CREATE OR REPLACE FUNCTION public.purchase_capture_evaluate_blocking_blockers(
  p_receipt_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_unresolved_prod integer;
  v_unresolved_unit integer;
  v_unresolved_pu   integer;
  v_missing_cost    integer;
  v_ordinals        jsonb;
BEGIN
  SELECT
    count(*) FILTER (WHERE i.product_identity_status <> 'RESOLVED'),
    count(*) FILTER (WHERE i.unit_identity_status <> 'RESOLVED'),
    count(*) FILTER (WHERE i.price_unit_status = 'UNRESOLVED'),
    count(*) FILTER (WHERE i.unit_cost IS NULL)
    INTO v_unresolved_prod, v_unresolved_unit, v_unresolved_pu, v_missing_cost
    FROM public.purchase_receipt_items i
   WHERE i.receipt_id = p_receipt_id;

  IF v_unresolved_prod + v_unresolved_unit + v_unresolved_pu + v_missing_cost = 0 THEN
    RETURN jsonb_build_object(
      'has_blocking_blockers', false,
      'blockers', '[]'::jsonb
    );
  END IF;

  v_ordinals := '[]'::jsonb;

  IF v_unresolved_prod > 0 THEN
    v_ordinals := v_ordinals || jsonb_build_array(jsonb_build_object(
      'code', 'UNRESOLVED_PRODUCT_IDENTITY',
      'item_ordinals', (
        SELECT coalesce(jsonb_agg(i.item_ordinal ORDER BY i.item_ordinal), '[]'::jsonb)
          FROM public.purchase_receipt_items i
         WHERE i.receipt_id = p_receipt_id
           AND i.product_identity_status <> 'RESOLVED'
      )
    ));
  END IF;

  IF v_unresolved_unit > 0 THEN
    v_ordinals := v_ordinals || jsonb_build_array(jsonb_build_object(
      'code', 'UNRESOLVED_UNIT_IDENTITY',
      'item_ordinals', (
        SELECT coalesce(jsonb_agg(i.item_ordinal ORDER BY i.item_ordinal), '[]'::jsonb)
          FROM public.purchase_receipt_items i
         WHERE i.receipt_id = p_receipt_id
           AND i.unit_identity_status <> 'RESOLVED'
      )
    ));
  END IF;

  IF v_unresolved_pu > 0 THEN
    v_ordinals := v_ordinals || jsonb_build_array(jsonb_build_object(
      'code', 'UNRESOLVED_PRICE_UNIT',
      'item_ordinals', (
        SELECT coalesce(jsonb_agg(i.item_ordinal ORDER BY i.item_ordinal), '[]'::jsonb)
          FROM public.purchase_receipt_items i
         WHERE i.receipt_id = p_receipt_id
           AND i.price_unit_status = 'UNRESOLVED'
      )
    ));
  END IF;

  IF v_missing_cost > 0 THEN
    v_ordinals := v_ordinals || jsonb_build_array(jsonb_build_object(
      'code', 'MISSING_UNIT_COST',
      'item_ordinals', (
        SELECT coalesce(jsonb_agg(i.item_ordinal ORDER BY i.item_ordinal), '[]'::jsonb)
          FROM public.purchase_receipt_items i
         WHERE i.receipt_id = p_receipt_id
           AND i.unit_cost IS NULL
      )
    ));
  END IF;

  RETURN jsonb_build_object(
    'has_blocking_blockers', true,
    'blockers', v_ordinals
  );
END;
$$;

COMMENT ON FUNCTION public.purchase_capture_evaluate_blocking_blockers(uuid) IS
  'Authoritative blocking-blocker scan on locked purchase_receipt_items. Used by '
  'begin_purchase_capture_confirmation; never trusts application-side reads.';

-- ── begin_purchase_capture_confirmation ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.begin_purchase_capture_confirmation(
  p_session_id                    uuid,
  p_expected_generation           uuid,
  p_expected_receipt_id           uuid,
  p_expected_draft_revision         bigint,
  p_expected_source_type          text,
  p_expected_source_id            text,
  p_expected_sender_line_user_id  text,
  p_actor                         text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session         public.purchase_capture_sessions%ROWTYPE;
  v_receipt         public.purchase_receipts%ROWTYPE;
  v_blockers        jsonb;
  v_source_id       text;
  v_sender          text;
  v_now             timestamptz := clock_timestamp();
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_expected_receipt_id IS NULL OR p_expected_draft_revision IS NULL THEN
    RAISE EXCEPTION 'expected_receipt_id and expected_draft_revision required';
  END IF;
  IF p_expected_source_type IS NULL
     OR p_expected_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid expected_source_type';
  END IF;
  IF p_expected_source_id IS NULL OR length(btrim(p_expected_source_id)) = 0 THEN
    RAISE EXCEPTION 'expected_source_id required';
  END IF;
  v_source_id := btrim(p_expected_source_id);
  v_sender := btrim(coalesce(p_expected_sender_line_user_id, ''));
  IF length(v_sender) = 0 THEN
    RAISE EXCEPTION 'expected_sender_line_user_id required';
  END IF;

  -- 1. Lock session first (same order as replace_purchase_capture_draft).
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

  -- Recovery path skips begin_* when already confirming; never re-run the gate.
  IF v_session.status IS DISTINCT FROM 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'invalid_state';
  END IF;

  IF v_session.receipt_id IS NULL OR v_session.draft_revision IS NULL THEN
    RAISE EXCEPTION 'invalid_state';
  END IF;

  IF v_session.receipt_id IS DISTINCT FROM p_expected_receipt_id
     OR v_session.draft_revision IS DISTINCT FROM p_expected_draft_revision THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;

  -- 2. Lock receipt (after session — shared lock order with replace_*).
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
    RAISE EXCEPTION 'ownership_mismatch';
  END IF;

  IF v_receipt.document_namespace IS DISTINCT FROM 'line-text'
     OR v_receipt.document_key IS DISTINCT FROM v_session.opened_line_event_id THEN
    RAISE EXCEPTION 'receipt_binding_mismatch';
  END IF;

  -- Fail closed before confirming: empty drafts cannot enter confirming (0052
  -- would refuse confirm; this gate avoids a stuck confirming session).
  IF v_receipt.item_count = 0 OR NOT EXISTS (
    SELECT 1 FROM public.purchase_receipt_items i WHERE i.receipt_id = v_receipt.id
  ) THEN
    RAISE EXCEPTION 'empty_receipt';
  END IF;

  v_blockers := public.purchase_capture_evaluate_blocking_blockers(v_receipt.id);
  IF coalesce((v_blockers ->> 'has_blocking_blockers')::boolean, false) THEN
    RAISE EXCEPTION 'blocking_blocker_present: %', v_blockers->'blockers';
  END IF;

  UPDATE public.purchase_capture_sessions
     SET status = 'confirming',
         updated_at = v_now
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.purchase_capture_lifecycle_events (
    session_id, event, actor, detail
  ) VALUES (
    v_session.id,
    'confirming',
    p_actor,
    jsonb_build_object(
      'receipt_id', v_receipt.id::text,
      'draft_revision', v_receipt.draft_revision::text
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'session_id', v_session.id::text,
    'status', v_session.status,
    'receipt_id', v_receipt.id::text,
    'draft_revision', v_receipt.draft_revision::text
  );
END;
$$;

COMMENT ON FUNCTION public.begin_purchase_capture_confirmation IS
  'Authoritative confirm gate: awaiting_confirmation → confirming under session-then-'
  'receipt lock. Refusal codes: ownership_mismatch, generation_conflict, '
  'invalid_state, stale_revision, receipt_not_draft, receipt_binding_mismatch, '
  'empty_receipt, blocking_blocker_present. Never calls confirm_purchase_receipt. '
  'Recovery from confirming must skip this RPC.';

-- ── complete_purchase_capture_posting ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.complete_purchase_capture_posting(
  p_session_id                     uuid,
  p_expected_generation            uuid,
  p_movement_id                    uuid,
  p_posted_success_payload_texts   text[],
  p_actor                          text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session       public.purchase_capture_sessions%ROWTYPE;
  v_movement      public.inventory_movements%ROWTYPE;
  v_parts_result  jsonb;
  v_now           timestamptz := clock_timestamp();
  v_version       text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  IF p_movement_id IS NULL THEN
    RAISE EXCEPTION 'movement_id required';
  END IF;
  IF p_posted_success_payload_texts IS NULL
     OR array_length(p_posted_success_payload_texts, 1) IS NULL THEN
    RAISE EXCEPTION 'posted_success_payload_texts must be a non-empty text array';
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

  v_version := p_movement_id::text;

  -- Idempotent replay: already posted under the same movement.
  IF v_session.status = 'posted' THEN
    IF v_session.movement_id IS DISTINCT FROM p_movement_id THEN
      RAISE EXCEPTION 'invalid_state';
    END IF;

    v_parts_result := public.purchase_capture_create_notification_parts_internal(
      v_session.id,
      'posted_success',
      v_version,
      p_posted_success_payload_texts,
      false
    );

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'session_id', v_session.id::text,
      'status', v_session.status,
      'movement_id', v_session.movement_id::text,
      'notification', v_parts_result
    );
  END IF;

  IF v_session.status IS DISTINCT FROM 'confirming' THEN
    RAISE EXCEPTION 'invalid_state';
  END IF;

  IF v_session.receipt_id IS NULL THEN
    RAISE EXCEPTION 'invalid_state';
  END IF;

  SELECT * INTO v_movement
    FROM public.inventory_movements
   WHERE id = p_movement_id
     AND movement_type = 'PURCHASE_RECEIPT'
     AND source_document_type = 'purchase_receipt'
     AND source_document_id = v_session.receipt_id
     AND reversal_of_movement_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_movement';
  END IF;

  v_parts_result := public.purchase_capture_create_notification_parts_internal(
    v_session.id,
    'posted_success',
    v_version,
    p_posted_success_payload_texts,
    false
  );

  UPDATE public.purchase_capture_sessions
     SET status = 'posted',
         movement_id = p_movement_id,
         updated_at = v_now
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.purchase_capture_lifecycle_events (
    session_id, event, actor, detail
  ) VALUES (
    v_session.id,
    'posted',
    p_actor,
    jsonb_build_object(
      'movement_id', p_movement_id::text,
      'receipt_id', v_session.receipt_id::text
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'session_id', v_session.id::text,
    'status', v_session.status,
    'movement_id', v_session.movement_id::text,
    'notification', v_parts_result
  );
END;
$$;

COMMENT ON FUNCTION public.complete_purchase_capture_posting IS
  'Atomic posting completion: creates posted_success outbox parts and transitions '
  'confirming → posted with movement_id in one transaction. Idempotent replay when '
  'already posted with the same movement_id and byte-identical payload texts.';

-- ── Privileges ───────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.purchase_capture_evaluate_blocking_blockers(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.begin_purchase_capture_confirmation(
  uuid, uuid, uuid, bigint, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_purchase_capture_confirmation(
  uuid, uuid, uuid, bigint, text, text, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.complete_purchase_capture_posting(
  uuid, uuid, uuid, text[], text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_purchase_capture_posting(
  uuid, uuid, uuid, text[], text
) TO service_role;
