-- P2B purchase-capture Slice B hardening assertions against a disposable local DB.
-- Requires Slice A + 0052 + Slice B migrations already applied.

CREATE OR REPLACE FUNCTION pg_temp.pc_b_assert(cond boolean, msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT cond THEN
    RAISE EXCEPTION 'purchase_capture_slice_b_hardening FAIL: %', msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_b_expect_error(p_sql text, p_needle text, p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_err text;
  v_state text;
  v_raised boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION
    WHEN OTHERS THEN
      v_raised := true;
      GET STACKED DIAGNOSTICS
        v_err = MESSAGE_TEXT,
        v_state = RETURNED_SQLSTATE;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION
      'purchase_capture_slice_b_hardening FAIL: % (expected error containing "%"; statement succeeded)',
      p_msg, p_needle;
  END IF;

  IF position(lower(p_needle) IN lower(v_err)) = 0 THEN
    RAISE EXCEPTION
      'purchase_capture_slice_b_hardening FAIL: % — got "%" sqlstate=% (wanted substring "%")',
      p_msg, v_err, v_state, p_needle;
  END IF;
END;
$$;

-- ── 1. Registry seeds and exact lookup keys ───────────────────────────────────
DO $$
DECLARE
  n_products int;
  n_units int;
BEGIN
  SELECT count(*) INTO n_products
    FROM public.purchase_intake_product_registry
   WHERE product_key IN ('durian-monthong', 'orange-taiwan');
  PERFORM pg_temp.pc_b_assert(n_products = 2, 'seeded product registry rows');

  SELECT count(*) INTO n_units
    FROM public.purchase_intake_unit_alias_registry
   WHERE unit_key = 'kg' AND raw_unit_text = public.purchase_capture_normalize_registry_text('โล');
  PERFORM pg_temp.pc_b_assert(n_units = 1, 'seeded unit alias โล → kg');
END;
$$;

-- ── 2. Notification multipart creation + idempotent replay + conflict ─────────
DO $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  v_gen uuid;
  r1 jsonb;
  r2 jsonb;
  n_parts int;
BEGIN
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-notify', 'U-b-notify', 'evt-b-notify-open', 10000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;

  r1 := public.create_purchase_capture_notification_parts(
    v_sid, 'preview_ready', '1', ARRAY['part-a', 'part-b']
  );
  PERFORM pg_temp.pc_b_assert(COALESCE((r1->>'created')::boolean, false), 'multipart create');

  SELECT count(*) INTO n_parts
    FROM public.purchase_capture_notifications
   WHERE session_id = v_sid
     AND notification_kind = 'preview_ready'
     AND notification_version = '1';
  PERFORM pg_temp.pc_b_assert(n_parts = 2, 'two physical notification rows');

  r2 := public.create_purchase_capture_notification_parts(
    v_sid, 'preview_ready', '1', ARRAY['part-a', 'part-b']
  );
  PERFORM pg_temp.pc_b_assert(COALESCE((r2->>'idempotent')::boolean, false), 'identical replay idempotent');

  PERFORM pg_temp.pc_b_expect_error(
    format(
      $q$SELECT public.create_purchase_capture_notification_parts(
        %L::uuid, 'preview_ready', '1', ARRAY['part-a', 'different'])::text$q$,
      v_sid
    ),
    'notification_identity_conflict',
    'different payload under same identity fails'
  );
END;
$$;

-- ── 3. Claim lease, deliver, reclaim expired lease, failed attempt release ────
DO $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  v_part_id uuid;
  v_retry uuid;
  v_claim uuid;
  v_claim2 uuid;
  r_claim jsonb;
  r_deliver jsonb;
  r_fail jsonb;
BEGIN
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-claim', 'U-b-claim', 'evt-b-claim-open', 11000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;

  PERFORM public.create_purchase_capture_notification_parts(
    v_sid, 'preview_ready', 'claim-1', ARRAY['claim-message']
  );

  SELECT id, retry_key INTO v_part_id, v_retry
    FROM public.purchase_capture_notifications
   WHERE session_id = v_sid
     AND notification_version = 'claim-1'
     AND part_index = 0;

  r_claim := public.claim_next_purchase_capture_notification_part(
    v_sid, 'preview_ready', 'claim-1', 2
  );
  PERFORM pg_temp.pc_b_assert(COALESCE((r_claim->>'claimed')::boolean, false), 'first claim succeeds');
  v_claim := (r_claim->>'claim_token')::uuid;
  PERFORM pg_temp.pc_b_assert((r_claim->>'retry_key')::uuid = v_retry, 'retry_key stable on claim');

  r_claim := public.claim_next_purchase_capture_notification_part(
    v_sid, 'preview_ready', 'claim-1', 2
  );
  PERFORM pg_temp.pc_b_assert(NOT COALESCE((r_claim->>'claimed')::boolean, true), 'unexpired lease blocks reclaim');
  PERFORM pg_temp.pc_b_assert((r_claim->>'reason') = 'lease_active', 'lease_active reason');

  PERFORM pg_sleep(3);

  r_claim := public.claim_next_purchase_capture_notification_part(
    v_sid, 'preview_ready', 'claim-1', 2
  );
  PERFORM pg_temp.pc_b_assert(COALESCE((r_claim->>'claimed')::boolean, false), 'expired lease reclaim');
  v_claim2 := (r_claim->>'claim_token')::uuid;
  PERFORM pg_temp.pc_b_assert(v_claim2 IS DISTINCT FROM v_claim, 'new claim token after reclaim');

  PERFORM pg_temp.pc_b_expect_error(
    format(
      $q$SELECT public.mark_purchase_capture_notification_part_delivered(%L::uuid, %L::uuid)$q$,
      v_part_id, v_claim
    ),
    'claim_token_mismatch',
    'stale claim token refused'
  );

  r_fail := public.record_purchase_capture_notification_part_attempt(
    v_part_id, v_claim2, 'push failed'
  );
  PERFORM pg_temp.pc_b_assert(COALESCE((r_fail->>'ok')::boolean, false), 'failed attempt recorded');

  PERFORM pg_temp.pc_b_assert(
    (SELECT delivery_status FROM public.purchase_capture_notifications WHERE id = v_part_id) = 'failed',
    'failed attempt releases claim'
  );

  r_claim := public.claim_next_purchase_capture_notification_part(
    v_sid, 'preview_ready', 'claim-1', 60
  );
  v_claim := (r_claim->>'claim_token')::uuid;

  r_deliver := public.mark_purchase_capture_notification_part_delivered(v_part_id, v_claim);
  PERFORM pg_temp.pc_b_assert(COALESCE((r_deliver->>'ok')::boolean, false), 'delivered settlement');

  r_claim := public.claim_next_purchase_capture_notification_part(
    v_sid, 'preview_ready', 'claim-1', 60
  );
  PERFORM pg_temp.pc_b_assert(NOT COALESCE((r_claim->>'claimed')::boolean, true), 'delivered rows never reclaimable');
END;
$$;

-- ── 4. finalize success + failed paths ────────────────────────────────────────
DO $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  v_gen uuid;
  v_hash text;
  v_rev bigint;
  v_receipt uuid;
  v_draft_rev bigint;
  r_draft jsonb;
  r_finalize jsonb;
  r_fail jsonb;
  n_preview int;
BEGIN
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-finalize-ok', 'U-b-finalize-ok', 'evt-b-fin-open', 20000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;

  PERFORM public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-b-finalize-ok', 'U-b-finalize-ok',
    'evt-b-fin-close', 20100, 'close', 'ปิดซื้อ 0 รายการ', NULL, NULL
  );

  PERFORM pg_sleep(9);

  SELECT ingest_revision, public.purchase_capture_compute_ingest_set_hash(v_sid)
    INTO v_rev, v_hash
    FROM public.purchase_capture_sessions
   WHERE id = v_sid;

  r_draft := public.upsert_purchase_receipt_draft(
    'line-text', 'evt-b-fin-open', 'p2b-slice-a-v1', '2026-07-29',
    '[{"product_key":"durian-monthong","raw_product_text":"หมอนทอง","quantity":"1","unit_key":"kg","raw_unit":"โล","unit_cost":"10"}]'::jsonb,
    p_source_type => 'group', p_source_id => 'G-b-finalize-ok', p_sender_line_user_id => 'U-b-finalize-ok'
  );
  v_receipt := (r_draft->>'receipt_id')::uuid;
  v_draft_rev := (r_draft->>'draft_revision')::bigint;

  r_finalize := public.finalize_purchase_capture_session(
    v_sid, v_gen, v_rev, v_hash, 'success',
    v_receipt, v_draft_rev, ARRAY['preview line 1'], NULL
  );
  PERFORM pg_temp.pc_b_assert((r_finalize->>'status') = 'awaiting_confirmation', 'closing → awaiting_confirmation');
  PERFORM pg_temp.pc_b_assert(COALESCE((r_finalize->>'idempotent')::boolean, false) = false, 'first finalize not idempotent');

  SELECT count(*) INTO n_preview
    FROM public.purchase_capture_notifications
   WHERE session_id = v_sid
     AND notification_kind = 'preview_ready'
     AND notification_version = v_draft_rev::text;
  PERFORM pg_temp.pc_b_assert(n_preview = 1, 'preview parts created atomically with finalize');

  r_finalize := public.finalize_purchase_capture_session(
    v_sid, v_gen, v_rev, v_hash, 'success',
    v_receipt, v_draft_rev, ARRAY['preview line 1'], NULL
  );
  PERFORM pg_temp.pc_b_assert(COALESCE((r_finalize->>'idempotent')::boolean, false), 'idempotent retry');

  -- failed_closed path
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-finalize-fail', 'U-b-finalize-fail', 'evt-b-fail-open', 30000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-b-finalize-fail', 'U-b-finalize-fail',
    'evt-b-fail-close', 30100, 'close', 'ปิดซื้อ 0 รายการ', NULL, NULL
  );
  PERFORM pg_sleep(9);
  SELECT ingest_revision, public.purchase_capture_compute_ingest_set_hash(v_sid)
    INTO v_rev, v_hash
    FROM public.purchase_capture_sessions
   WHERE id = v_sid;

  r_fail := public.finalize_purchase_capture_session(
    v_sid, v_gen, v_rev, v_hash, 'failed', NULL, NULL, NULL, 'missing_items'
  );
  PERFORM pg_temp.pc_b_assert((r_fail->>'status') = 'failed_closed', 'closing → failed_closed');
  PERFORM pg_temp.pc_b_assert(
    (SELECT receipt_id IS NULL FROM public.purchase_capture_sessions WHERE id = v_sid),
    'INCOMPLETE creates no receipt link'
  );

  r_open := public.open_purchase_capture_session(
    'group', 'G-b-finalize-fail2', 'U-b-finalize-fail2', 'evt-b-fail2-open', 31000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-b-finalize-fail2', 'U-b-finalize-fail2',
    'evt-b-fail2-close', 31100, 'close', 'ปิดซื้อ 0 รายการ', NULL, NULL
  );
  PERFORM pg_sleep(9);
  SELECT ingest_revision, public.purchase_capture_compute_ingest_set_hash(v_sid)
    INTO v_rev, v_hash
    FROM public.purchase_capture_sessions
   WHERE id = v_sid;

  r_fail := public.finalize_purchase_capture_session(
    v_sid, v_gen, v_rev, v_hash, 'failed', v_receipt, v_draft_rev, ARRAY['x'], 'bad'
  );
  PERFORM pg_temp.pc_b_assert((r_fail->>'status') = 'failed_closed', 'failed path ignores receipt args');
  PERFORM pg_temp.pc_b_assert(
    (SELECT receipt_id IS NULL FROM public.purchase_capture_sessions WHERE id = v_sid),
    'failed finalize never links receipt_id'
  );
END;
$$;

-- ── 5. stale revision/hash and quiet window ───────────────────────────────────
DO $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  v_gen uuid;
  v_hash text;
  v_rev bigint;
BEGIN
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-stale', 'U-b-stale', 'evt-b-stale-open', 40000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-b-stale', 'U-b-stale',
    'evt-b-stale-close', 40050, 'close', 'ปิดซื้อ 0 รายการ', NULL, NULL
  );

  SELECT ingest_revision, public.purchase_capture_compute_ingest_set_hash(v_sid)
    INTO v_rev, v_hash
    FROM public.purchase_capture_sessions
   WHERE id = v_sid;

  PERFORM pg_temp.pc_b_expect_error(
    format(
      $q$SELECT public.finalize_purchase_capture_session(
        %L::uuid, %L::uuid, %s, %L, 'failed', NULL, NULL, NULL, 'x')$q$,
      v_sid, v_gen, v_rev + 1, v_hash
    ),
    'stale_ingest_revision',
    'stale ingest revision refused'
  );

  PERFORM pg_temp.pc_b_expect_error(
    format(
      $q$SELECT public.finalize_purchase_capture_session(
        %L::uuid, %L::uuid, %s, %L, 'failed', NULL, NULL, NULL, 'x')$q$,
      v_sid, v_gen, v_rev, 'deadbeef'
    ),
    'stale_ingest_hash',
    'stale ingest hash refused'
  );

  PERFORM pg_temp.pc_b_expect_error(
    format(
      $q$SELECT public.finalize_purchase_capture_session(
        %L::uuid, %L::uuid, %s, %L, 'failed', NULL, NULL, NULL, 'x')$q$,
      v_sid, v_gen, v_rev, v_hash
    ),
    'close_quiet_window',
    'quiet/deadline enforced in DB'
  );
END;
$$;

-- ── 6. replace draft atomic + supersession ────────────────────────────────────
DO $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  v_gen uuid;
  v_hash text;
  v_rev bigint;
  v_receipt uuid;
  v_draft_rev bigint;
  r_draft jsonb;
  r_finalize jsonb;
  r_replace jsonb;
  n_old_pending int;
  n_new_pending int;
  v_old_version text;
BEGIN
  r_open := public.open_purchase_capture_session(
    'group', 'G-b-replace', 'U-b-replace', 'evt-b-replace-open', 50000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-b-replace', 'U-b-replace',
    'evt-b-replace-close', 50100, 'close', 'ปิดซื้อ 0 รายการ', NULL, NULL
  );
  PERFORM pg_sleep(9);

  SELECT ingest_revision, public.purchase_capture_compute_ingest_set_hash(v_sid)
    INTO v_rev, v_hash
    FROM public.purchase_capture_sessions
   WHERE id = v_sid;

  r_draft := public.upsert_purchase_receipt_draft(
    'line-text', 'evt-b-replace-open', 'p2b-slice-a-v1', '2026-07-29',
    '[{"product_key":"durian-monthong","raw_product_text":"หมอนทอง","quantity":"1","unit_key":"kg","raw_unit":"โล","unit_cost":"10"}]'::jsonb,
    p_source_type => 'group', p_source_id => 'G-b-replace', p_sender_line_user_id => 'U-b-replace'
  );
  v_receipt := (r_draft->>'receipt_id')::uuid;
  v_draft_rev := (r_draft->>'draft_revision')::bigint;
  v_old_version := v_draft_rev::text;

  r_finalize := public.finalize_purchase_capture_session(
    v_sid, v_gen, v_rev, v_hash, 'success',
    v_receipt, v_draft_rev, ARRAY['preview v1'], NULL
  );
  PERFORM pg_temp.pc_b_assert((r_finalize->>'status') = 'awaiting_confirmation', 'fixture awaiting_confirmation');

  r_replace := public.replace_purchase_capture_draft(
    v_sid, v_gen, v_receipt, v_draft_rev,
    'group', 'G-b-replace', 'U-b-replace',
    jsonb_build_object(
      'document_namespace', 'line-text',
      'document_key', 'evt-b-replace-open',
      'contract_version', 'p2b-slice-a-v1',
      'business_date', '2026-07-29',
      'items', jsonb_build_array(
        jsonb_build_object(
          'product_key', 'durian-monthong',
          'raw_product_text', 'หมอนทอง',
          'quantity', '2',
          'unit_key', 'kg',
          'raw_unit', 'โล',
          'unit_cost', '12'
        )
      )
    ),
    ARRAY['preview v2']
  );
  PERFORM pg_temp.pc_b_assert((r_replace->>'draft_revision')::bigint > v_draft_rev, 'draft revision advanced');

  SELECT count(*) INTO n_old_pending
    FROM public.purchase_capture_notifications
   WHERE session_id = v_sid
     AND notification_version = v_old_version
     AND delivery_status = 'superseded';
  PERFORM pg_temp.pc_b_assert(n_old_pending = 1, 'old preview superseded');

  SELECT count(*) INTO n_new_pending
    FROM public.purchase_capture_notifications
   WHERE session_id = v_sid
     AND notification_version = (r_replace->>'draft_revision')
     AND delivery_status = 'pending';
  PERFORM pg_temp.pc_b_assert(n_new_pending = 1, 'new preview parts created');

  PERFORM pg_temp.pc_b_expect_error(
    format(
      $q$SELECT public.replace_purchase_capture_draft(
        %L::uuid, %L::uuid, %L::uuid, %s,
        'group', 'G-b-replace', 'U-b-replace',
        '{"document_namespace":"line-text","document_key":"evt-b-replace-open","contract_version":"p2b-slice-a-v1","business_date":"2026-07-29","items":[]}'::jsonb,
        ARRAY['x'])::text$q$,
      v_sid, v_gen, v_receipt, v_draft_rev
    ),
    'stale_revision',
    'stale draft revision refused'
  );
END;
$$;

-- ── 7. Security: RLS enabled, no public table access ─────────────────────────
DO $$
DECLARE
  v_rls boolean;
  v_anon_select boolean;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class
   WHERE oid = 'public.purchase_capture_notifications'::regclass;
  PERFORM pg_temp.pc_b_assert(v_rls, 'notifications RLS enabled');

  SELECT has_table_privilege('anon', 'public.purchase_capture_notifications', 'SELECT')
    INTO v_anon_select;
  PERFORM pg_temp.pc_b_assert(NOT v_anon_select, 'anon cannot SELECT notifications');

  PERFORM pg_temp.pc_b_assert(
    has_function_privilege('service_role', 'public.finalize_purchase_capture_session(uuid,uuid,bigint,text,text,uuid,bigint,text[],text)', 'EXECUTE'),
    'service_role can execute finalize RPC'
  );
  PERFORM pg_temp.pc_b_assert(
    NOT has_function_privilege('anon', 'public.finalize_purchase_capture_session(uuid,uuid,bigint,text,text,uuid,bigint,text[],text)', 'EXECUTE'),
    'anon cannot execute finalize RPC'
  );
END;
$$;

DO $$ BEGIN RAISE NOTICE 'purchase_capture_slice_b_hardening PASS'; END $$;
