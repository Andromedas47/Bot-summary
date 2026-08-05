-- Contract hardening assertions (run after 20260805150000 migration).
-- Includes real concurrency scenarios for claim ordering and multipart creation.

CREATE OR REPLACE FUNCTION pg_temp.pc_b_assert(cond boolean, msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT cond THEN
    RAISE EXCEPTION 'purchase_capture_slice_b_contract_hardening FAIL: %', msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_b_expect_error(p_sql text, p_needle text, p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_err text;
  v_raised boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION
    WHEN OTHERS THEN
      v_raised := true;
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'purchase_capture_slice_b_contract_hardening FAIL: % (expected error containing "%")', p_msg, p_needle;
  END IF;
  IF position(lower(p_needle) IN lower(v_err)) = 0 THEN
    RAISE EXCEPTION 'purchase_capture_slice_b_contract_hardening FAIL: % — got "%" (wanted "%")', p_msg, v_err, p_needle;
  END IF;
END;
$$;

-- ── 8. Concurrent claim: active lease on part 0 blocks part 1 ────────────────
DO $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  r0 jsonb;
  r1 jsonb;
BEGIN
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-conc-claim', 'U-b-conc-claim', 'evt-b-conc-claim', 60000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;

  PERFORM public.create_purchase_capture_notification_parts(
    v_sid, 'preview_ready', 'conc-claim', ARRAY['part-0', 'part-1']
  );

  r0 := public.claim_next_purchase_capture_notification_part(
    v_sid, 'preview_ready', 'conc-claim', 120
  );
  PERFORM pg_temp.pc_b_assert(COALESCE((r0->>'claimed')::boolean, false), '8: claim part 0');
  PERFORM pg_temp.pc_b_assert((r0->>'part_index')::int = 0, '8: first claim is part 0');

  r1 := public.claim_next_purchase_capture_notification_part(
    v_sid, 'preview_ready', 'conc-claim', 120
  );
  PERFORM pg_temp.pc_b_assert(NOT COALESCE((r1->>'claimed')::boolean, true), '8: second claim blocked');
  PERFORM pg_temp.pc_b_assert((r1->>'reason') = 'lease_active', '8: lease_active not part 1');
  PERFORM pg_temp.pc_b_assert((r1->>'part_index')::int = 0, '8: blocked on part 0');

  PERFORM public.mark_purchase_capture_notification_part_delivered(
    (r0->>'id')::uuid, (r0->>'claim_token')::uuid
  );

  r1 := public.claim_next_purchase_capture_notification_part(
    v_sid, 'preview_ready', 'conc-claim', 120
  );
  PERFORM pg_temp.pc_b_assert(COALESCE((r1->>'claimed')::boolean, false), '8: claim part 1 after part 0 delivered');
  PERFORM pg_temp.pc_b_assert((r1->>'part_index')::int = 1, '8: second physical part');
END;
$$;

-- ── 9. finalize ownership_mismatch before transition ─────────────────────────
DO $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  v_gen uuid;
  v_hash text;
  v_rev bigint;
  v_receipt uuid;
  v_draft_rev bigint;
  n_lifecycle int;
  n_notify int;
  n_bad_events int;
BEGIN
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-own', 'U-b-own', 'evt-b-own-open', 70000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-b-own', 'U-b-own',
    'evt-b-own-close', 70100, 'close', 'ปิดซื้อ 0 รายการ', NULL, NULL
  );
  PERFORM pg_sleep(9);
  SELECT ingest_revision, public.purchase_capture_compute_ingest_set_hash(v_sid)
    INTO v_rev, v_hash FROM public.purchase_capture_sessions WHERE id = v_sid;

  SELECT (public.upsert_purchase_receipt_draft(
    'line-text', 'evt-b-own-open', 'p2b-slice-a-v1', '2026-07-29',
    '[{"product_key":"p","raw_product_text":"p","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_cost":"1"}]'::jsonb,
    p_source_type => 'group', p_source_id => 'G-b-own', p_sender_line_user_id => 'U-b-own'
  )->>'receipt_id')::uuid INTO v_receipt;
  SELECT draft_revision INTO v_draft_rev FROM public.purchase_receipts WHERE id = v_receipt;

  PERFORM pg_temp.pc_b_expect_error(
    format(
      $q$SELECT public.finalize_purchase_capture_session(
        %L::uuid, %L::uuid, 'group', 'WRONG', 'U-b-own',
        %s, %L, 'success', %L::uuid, %s, ARRAY['x'], NULL)$q$,
      v_sid, v_gen, v_rev, v_hash, v_receipt, v_draft_rev
    ),
    'ownership_mismatch',
    '9: wrong source_id refused'
  );

  SELECT count(*) INTO n_lifecycle
    FROM public.purchase_capture_lifecycle_events WHERE session_id = v_sid;
  SELECT count(*) INTO n_notify
    FROM public.purchase_capture_notifications WHERE session_id = v_sid;
  SELECT count(*) INTO n_bad_events
    FROM public.purchase_capture_lifecycle_events
   WHERE session_id = v_sid
     AND event IN ('awaiting_confirmation', 'failed_closed');
  PERFORM pg_temp.pc_b_assert(n_bad_events = 0, '9: no finalize lifecycle on ownership mismatch');
  PERFORM pg_temp.pc_b_assert(n_notify = 0, '9: no notifications on ownership mismatch');
  PERFORM pg_temp.pc_b_assert(
    (SELECT status FROM public.purchase_capture_sessions WHERE id = v_sid) = 'closing',
    '9: session stays closing'
  );
END;
$$;

-- ── 10. replace refuses wrong document key before receipt mutation ───────────
DO $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  v_gen uuid;
  v_hash text;
  v_rev bigint;
  v_receipt uuid;
  v_draft_rev bigint;
  v_items_before int;
  v_items_after int;
BEGIN
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-replace-bind', 'U-b-replace-bind', 'evt-b-rb-open', 80000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-b-replace-bind', 'U-b-replace-bind',
    'evt-b-rb-close', 80100, 'close', 'ปิดซื้อ 0 รายการ', NULL, NULL
  );
  PERFORM pg_sleep(9);
  SELECT ingest_revision, public.purchase_capture_compute_ingest_set_hash(v_sid)
    INTO v_rev, v_hash FROM public.purchase_capture_sessions WHERE id = v_sid;

  SELECT (public.upsert_purchase_receipt_draft(
    'line-text', 'evt-b-rb-open', 'p2b-slice-a-v1', '2026-07-29',
    '[{"product_key":"p","raw_product_text":"p","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_cost":"1"}]'::jsonb,
    p_source_type => 'group', p_source_id => 'G-b-replace-bind', p_sender_line_user_id => 'U-b-replace-bind'
  )->>'receipt_id')::uuid INTO v_receipt;
  SELECT draft_revision INTO v_draft_rev FROM public.purchase_receipts WHERE id = v_receipt;

  PERFORM public.finalize_purchase_capture_session(
    v_sid, v_gen, 'group', 'G-b-replace-bind', 'U-b-replace-bind',
    v_rev, v_hash, 'success', v_receipt, v_draft_rev, ARRAY['preview'], NULL
  );

  SELECT count(*) INTO v_items_before FROM public.purchase_receipt_items WHERE receipt_id = v_receipt;

  PERFORM pg_temp.pc_b_expect_error(
    format(
      $q$SELECT public.replace_purchase_capture_draft(
        %L::uuid, %L::uuid, %L::uuid, %s,
        'group', 'G-b-replace-bind', 'U-b-replace-bind',
        '{"document_namespace":"line-text","document_key":"WRONG-KEY","contract_version":"p2b-slice-a-v1","business_date":"2026-07-29","items":[]}'::jsonb,
        ARRAY['x'])::text$q$,
      v_sid, v_gen, v_receipt, v_draft_rev
    ),
    'draft_document_key_mismatch',
    '10: payload document_key mismatch refused'
  );

  SELECT count(*) INTO v_items_after FROM public.purchase_receipt_items WHERE receipt_id = v_receipt;
  PERFORM pg_temp.pc_b_assert(v_items_before = v_items_after, '10: receipt items unchanged on failure');
  PERFORM pg_temp.pc_b_assert(
    (SELECT draft_revision FROM public.purchase_capture_sessions WHERE id = v_sid) = v_draft_rev,
    '10: session revision unchanged on failure'
  );
END;
$$;

DO $$ BEGIN RAISE NOTICE 'purchase_capture_slice_b_contract_hardening PASS'; END $$;
