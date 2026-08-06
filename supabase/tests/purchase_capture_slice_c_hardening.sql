-- Slice C1 contract hardening (run after 20260805160000 on disposable DB).

CREATE OR REPLACE FUNCTION pg_temp.pc_c_assert(cond boolean, msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT cond THEN
    RAISE EXCEPTION 'purchase_capture_slice_c_hardening FAIL: %', msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_c_snapshot(p_session_id uuid, p_receipt_id uuid)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'session', (
      SELECT to_jsonb(s.*)
      FROM public.purchase_capture_sessions s
      WHERE s.id = p_session_id
    ),
    'receipt', (
      SELECT to_jsonb(r.*)
      FROM public.purchase_receipts r
      WHERE r.id = p_receipt_id
    ),
    'items', (
      SELECT coalesce(
        jsonb_agg(to_jsonb(i.*) ORDER BY i.item_ordinal, i.id),
        '[]'::jsonb
      )
      FROM public.purchase_receipt_items i
      WHERE i.receipt_id = p_receipt_id
    ),
    'lifecycle_events', (
      SELECT coalesce(
        jsonb_agg(to_jsonb(e.*) ORDER BY e.created_at, e.id),
        '[]'::jsonb
      )
      FROM public.purchase_capture_lifecycle_events e
      WHERE e.session_id = p_session_id
    ),
    'notifications', (
      SELECT coalesce(
        jsonb_agg(to_jsonb(n.*) ORDER BY n.notification_kind, n.notification_version, n.part_index, n.id),
        '[]'::jsonb
      )
      FROM public.purchase_capture_notifications n
      WHERE n.session_id = p_session_id
    )
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_c_snapshot_notifications(p_session_id uuid)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT coalesce(
    jsonb_agg(to_jsonb(n.*) ORDER BY n.notification_kind, n.notification_version, n.part_index, n.id),
    '[]'::jsonb
  )
  FROM public.purchase_capture_notifications n
  WHERE n.session_id = p_session_id;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_c_assert_refusal_unchanged(
  p_before jsonb,
  p_after jsonb,
  p_msg text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_before IS DISTINCT FROM p_after THEN
    RAISE EXCEPTION 'purchase_capture_slice_c_hardening FAIL: % — before=% after=%',
      p_msg, p_before, p_after;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_c_expect_error(
  p_sql text,
  p_sqlstate text,
  p_needle text,
  p_msg text
)
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
      'purchase_capture_slice_c_hardening FAIL: % (expected sqlstate=% message containing "%"; statement succeeded)',
      p_msg, p_sqlstate, p_needle;
  END IF;

  IF v_state IS DISTINCT FROM p_sqlstate THEN
    RAISE EXCEPTION
      'purchase_capture_slice_c_hardening FAIL: % — got sqlstate=% message="%" (wanted sqlstate=% message containing "%")',
      p_msg, v_state, v_err, p_sqlstate, p_needle;
  END IF;

  IF position(lower(p_needle) IN lower(v_err)) = 0 THEN
    RAISE EXCEPTION
      'purchase_capture_slice_c_hardening FAIL: % — got sqlstate=% message="%" (wanted sqlstate=% message containing "%")',
      p_msg, v_state, v_err, p_sqlstate, p_needle;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_c_expect_begin_refusal(
  p_sql text,
  p_sqlstate text,
  p_needle text,
  p_msg text,
  p_session_id uuid,
  p_receipt_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := pg_temp.pc_c_snapshot(p_session_id, p_receipt_id);
  PERFORM pg_temp.pc_c_expect_error(p_sql, p_sqlstate, p_needle, p_msg);
  v_after := pg_temp.pc_c_snapshot(p_session_id, p_receipt_id);
  PERFORM pg_temp.pc_c_assert_refusal_unchanged(v_before, v_after, p_msg || ' (no mutation)');
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_c_setup_awaiting(
  p_tag text,
  p_items jsonb DEFAULT '[{"product_key":"p","raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":"10"}]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r_open jsonb;
  v_sid uuid;
  v_gen uuid;
  v_hash text;
  v_rev bigint;
  v_receipt uuid;
  v_draft_rev bigint;
  v_evt text;
BEGIN
  v_evt := 'evt-c-' || p_tag || '-open';
  r_open := public.open_purchase_capture_session(
    'group', 'G-c-' || p_tag, 'U-c-' || p_tag, v_evt, 100000, 'header'
  );
  v_sid := (r_open->>'session_id')::uuid;
  v_gen := (r_open->>'session_generation')::uuid;
  PERFORM public.admit_purchase_capture_event(
    v_sid, v_gen, 'group', 'G-c-' || p_tag, 'U-c-' || p_tag,
    'evt-c-' || p_tag || '-close', 100100, 'close', 'ปิดซื้อ 1 รายการ', NULL, NULL
  );
  PERFORM pg_sleep(9);
  SELECT ingest_revision, public.purchase_capture_compute_ingest_set_hash(v_sid)
    INTO v_rev, v_hash FROM public.purchase_capture_sessions WHERE id = v_sid;

  SELECT (public.upsert_purchase_receipt_draft(
    'line-text', v_evt, 'p2b-slice-a-v1', '2026-07-29', p_items,
    p_source_type => 'group', p_source_id => 'G-c-' || p_tag, p_sender_line_user_id => 'U-c-' || p_tag
  )->>'receipt_id')::uuid INTO v_receipt;
  SELECT draft_revision INTO v_draft_rev FROM public.purchase_receipts WHERE id = v_receipt;

  PERFORM public.finalize_purchase_capture_session(
    v_sid, v_gen, 'group', 'G-c-' || p_tag, 'U-c-' || p_tag,
    v_rev, v_hash, 'success', v_receipt, v_draft_rev, ARRAY['preview'], NULL
  );

  RETURN jsonb_build_object(
    'session_id', v_sid,
    'session_generation', v_gen,
    'receipt_id', v_receipt,
    'draft_revision', v_draft_rev,
    'opened_line_event_id', v_evt,
    'source_id', 'G-c-' || p_tag,
    'sender', 'U-c-' || p_tag
  );
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pc_c_setup_confirming(p_tag text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  s jsonb;
BEGIN
  s := pg_temp.pc_c_setup_awaiting(p_tag);
  PERFORM public.begin_purchase_capture_confirmation(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid,
    (s->>'receipt_id')::uuid, (s->>'draft_revision')::bigint,
    'group', s->>'source_id', s->>'sender', NULL
  );
  PERFORM public.confirm_purchase_receipt(
    (s->>'receipt_id')::uuid,
    'purchase-capture:v1:' || (s->>'opened_line_event_id'),
    (s->>'draft_revision')::bigint, NULL
  );
  RETURN s || jsonb_build_object(
    'movement_id', (public.post_purchase_receipt_inventory_movement((s->>'receipt_id')::uuid, NULL)->>'movement_id')
  );
END;
$$;

-- ── 1. begin success ─────────────────────────────────────────────────────────
DO $$
DECLARE
  s jsonb;
  r jsonb;
BEGIN
  s := pg_temp.pc_c_setup_awaiting('begin-ok');
  r := public.begin_purchase_capture_confirmation(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid,
    (s->>'receipt_id')::uuid, (s->>'draft_revision')::bigint,
    'group', s->>'source_id', s->>'sender', 'test'
  );
  PERFORM pg_temp.pc_c_assert((r->>'ok')::boolean, '1: ok');
  PERFORM pg_temp.pc_c_assert(r->>'status' = 'confirming', '1: confirming');
  PERFORM pg_temp.pc_c_assert(
    (SELECT count(*) FROM public.purchase_capture_lifecycle_events
      WHERE session_id = (s->>'session_id')::uuid AND event = 'confirming') = 1,
    '1: lifecycle confirming'
  );
END;
$$;

-- ── 2. already confirming ────────────────────────────────────────────────────
DO $$
DECLARE
  s jsonb;
BEGIN
  s := pg_temp.pc_c_setup_awaiting('begin-already');
  PERFORM public.begin_purchase_capture_confirmation(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid,
    (s->>'receipt_id')::uuid, (s->>'draft_revision')::bigint,
    'group', s->>'source_id', s->>'sender', NULL
  );
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', s->>'draft_revision',
      s->>'source_id', s->>'sender'),
    'P0001', 'invalid_state', '2: already confirming', (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );
END;
$$;

-- ── 3–7. begin refusal codes with no-mutation snapshots ─────────────────────
DO $$
DECLARE
  s jsonb;
  v_receipt uuid;
  v_draft_rev bigint;
  v_items jsonb;
BEGIN
  s := pg_temp.pc_c_setup_awaiting('begin-own');
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', 'WRONG', %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', s->>'draft_revision', s->>'sender'),
    'P0001', 'ownership_mismatch', '3: ownership mismatch',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );

  s := pg_temp.pc_c_setup_awaiting('begin-gen');
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', gen_random_uuid(), s->>'receipt_id', s->>'draft_revision',
      s->>'source_id', s->>'sender'),
    'P0001', 'generation_conflict', '4: generation conflict',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );

  s := pg_temp.pc_c_setup_awaiting('begin-stale');
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', '99999',
      s->>'source_id', s->>'sender'),
    'P0001', 'stale_revision', '5: stale revision',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );

  s := pg_temp.pc_c_setup_awaiting('begin-not-draft');
  PERFORM public.confirm_purchase_receipt(
    (s->>'receipt_id')::uuid, 'purchase-capture:v1:' || (s->>'opened_line_event_id'),
    (s->>'draft_revision')::bigint, NULL
  );
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', s->>'draft_revision',
      s->>'source_id', s->>'sender'),
    'P0001', 'receipt_not_draft', '5b: receipt not draft',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );

  s := pg_temp.pc_c_setup_awaiting('begin-bind');
  SELECT (public.upsert_purchase_receipt_draft(
    'line-text', 'WRONG-KEY', 'p2b-slice-a-v1', '2026-07-29',
    '[{"product_key":"p","raw_product_text":"p","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_cost":"1"}]'::jsonb,
    p_source_type => 'group', p_source_id => s->>'source_id', p_sender_line_user_id => s->>'sender'
  )->>'receipt_id')::uuid INTO v_receipt;
  SELECT draft_revision INTO v_draft_rev FROM public.purchase_receipts WHERE id = v_receipt;
  UPDATE public.purchase_capture_sessions
     SET receipt_id = v_receipt, draft_revision = v_draft_rev
   WHERE id = (s->>'session_id')::uuid;
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', v_receipt, v_draft_rev,
      s->>'source_id', s->>'sender'),
    'P0001', 'receipt_binding_mismatch', '6: receipt binding mismatch',
    (s->>'session_id')::uuid, v_receipt
  );

  v_items := '[{"product_key":"unresolved:product:x","raw_product_text":"x","product_identity_status":"UNRESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":"1"}]'::jsonb;
  s := pg_temp.pc_c_setup_awaiting('block-prod', v_items);
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', s->>'draft_revision',
      s->>'source_id', s->>'sender'),
    'P0001', 'blocking_blocker_present', '7a: unresolved product',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );

  v_items := '[{"product_key":"p","raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"unresolved:unit:u","raw_unit":"u","unit_identity_status":"UNRESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":"1"}]'::jsonb;
  s := pg_temp.pc_c_setup_awaiting('block-unit', v_items);
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', s->>'draft_revision',
      s->>'source_id', s->>'sender'),
    'P0001', 'blocking_blocker_present', '7b: unresolved unit',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );

  v_items := '[{"product_key":"p","raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_text":"crate","price_unit_status":"UNRESOLVED","unit_cost":"1"}]'::jsonb;
  s := pg_temp.pc_c_setup_awaiting('block-pu', v_items);
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', s->>'draft_revision',
      s->>'source_id', s->>'sender'),
    'P0001', 'blocking_blocker_present', '7c: unresolved price unit',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );

  v_items := '[{"product_key":"p","raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":null}]'::jsonb;
  s := pg_temp.pc_c_setup_awaiting('block-cost', v_items);
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', s->>'draft_revision',
      s->>'source_id', s->>'sender'),
    'P0001', 'blocking_blocker_present', '7d: missing unit cost',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );
END;
$$;

-- ── 7e. invalid session states ───────────────────────────────────────────────
DO $$
DECLARE
  s jsonb;
  v_open jsonb;
BEGIN
  v_open := public.open_purchase_capture_session(
    'group', 'G-c-open', 'U-c-open', 'evt-c-open-only', 100000, 'header'
  );
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, gen_random_uuid(), 1, 'group', 'G-c-open', 'U-c-open', NULL)$q$,
      v_open->>'session_id', v_open->>'session_generation'),
    'P0001', 'invalid_state', '7e: open session refused',
    (v_open->>'session_id')::uuid, NULL::uuid
  );

  s := pg_temp.pc_c_setup_awaiting('begin-cancelled');
  PERFORM public.cancel_purchase_capture_session(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid,
    'group', s->>'source_id', s->>'sender'
  );
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', s->>'receipt_id', s->>'draft_revision',
      s->>'source_id', s->>'sender'),
    'P0001', 'invalid_state', '7e: cancelled session refused',
    (s->>'session_id')::uuid, (s->>'receipt_id')::uuid
  );
END;
$$;

-- ── 7f. empty receipt ────────────────────────────────────────────────────────
DO $$
DECLARE
  s jsonb;
  v_evt text;
  v_receipt uuid;
  v_draft_rev bigint;
BEGIN
  s := pg_temp.pc_c_setup_awaiting('empty-gate');
  v_evt := s->>'opened_line_event_id';
  SELECT (public.upsert_purchase_receipt_draft(
    'line-text', v_evt, 'p2b-slice-a-v1', '2026-07-29', '[]'::jsonb,
    p_source_type => 'group', p_source_id => s->>'source_id', p_sender_line_user_id => s->>'sender'
  )->>'receipt_id')::uuid INTO v_receipt;
  SELECT draft_revision INTO v_draft_rev FROM public.purchase_receipts WHERE id = v_receipt;
  UPDATE public.purchase_capture_sessions
     SET receipt_id = v_receipt, draft_revision = v_draft_rev
   WHERE id = (s->>'session_id')::uuid;
  PERFORM pg_temp.pc_c_expect_begin_refusal(
    format($q$SELECT public.begin_purchase_capture_confirmation(
      %L::uuid, %L::uuid, %L::uuid, %s, 'group', %L, %L, NULL)$q$,
      s->>'session_id', s->>'session_generation', v_receipt, v_draft_rev,
      s->>'source_id', s->>'sender'),
    'P0001', 'empty_receipt', '7f: empty receipt refused',
    (s->>'session_id')::uuid, v_receipt
  );
END;
$$;

-- ── 8. complete success ──────────────────────────────────────────────────────
DO $$
DECLARE
  s jsonb;
  v_mov uuid;
  r jsonb;
BEGIN
  s := pg_temp.pc_c_setup_confirming('complete-ok');
  v_mov := (s->>'movement_id')::uuid;
  r := public.complete_purchase_capture_posting(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid,
    v_mov, ARRAY['posted summary'], NULL
  );
  PERFORM pg_temp.pc_c_assert((r->>'ok')::boolean, '8: complete ok');
  PERFORM pg_temp.pc_c_assert(r->>'status' = 'posted', '8: posted status');
  PERFORM pg_temp.pc_c_assert(
    (SELECT movement_id FROM public.purchase_capture_sessions WHERE id = (s->>'session_id')::uuid) = v_mov,
    '8: movement_id set'
  );
  PERFORM pg_temp.pc_c_assert(
    (SELECT count(*) FROM public.purchase_capture_notifications
      WHERE session_id = (s->>'session_id')::uuid
        AND notification_kind = 'posted_success'
        AND notification_version = v_mov::text) = 1,
    '8: posted_success part exists'
  );
END;
$$;

-- ── 9. complete idempotent replay ────────────────────────────────────────────
DO $$
DECLARE
  s jsonb;
  v_mov uuid;
  r1 jsonb;
  r2 jsonb;
BEGIN
  s := pg_temp.pc_c_setup_confirming('complete-replay');
  v_mov := (s->>'movement_id')::uuid;
  r1 := public.complete_purchase_capture_posting(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid, v_mov, ARRAY['same'], NULL
  );
  r2 := public.complete_purchase_capture_posting(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid, v_mov, ARRAY['same'], NULL
  );
  PERFORM pg_temp.pc_c_assert((r1->>'idempotent')::boolean = false, '9: first not replay');
  PERFORM pg_temp.pc_c_assert((r2->>'idempotent')::boolean = true, '9: second replay');
END;
$$;

-- ── 10–12. complete refusal paths ────────────────────────────────────────────
DO $$
DECLARE
  s jsonb;
  v_mov uuid;
BEGIN
  s := pg_temp.pc_c_setup_confirming('complete-mismatch');
  v_mov := (s->>'movement_id')::uuid;
  PERFORM public.complete_purchase_capture_posting(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid, v_mov, ARRAY['x'], NULL
  );
  PERFORM pg_temp.pc_c_expect_error(
    format($q$SELECT public.complete_purchase_capture_posting(
      %L::uuid, %L::uuid, %L::uuid, ARRAY['x'], NULL)$q$,
      s->>'session_id', s->>'session_generation', gen_random_uuid()),
    'P0001', 'invalid_state', '10: movement mismatch on posted'
  );

  s := pg_temp.pc_c_setup_confirming('complete-conflict-posted');
  v_mov := (s->>'movement_id')::uuid;
  PERFORM public.complete_purchase_capture_posting(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid, v_mov, ARRAY['original'], NULL
  );
  PERFORM pg_temp.pc_c_expect_error(
    format($q$SELECT public.complete_purchase_capture_posting(
      %L::uuid, %L::uuid, %L::uuid, ARRAY['DIFFERENT'], NULL)$q$,
      s->>'session_id', s->>'session_generation', v_mov),
    'P0001', 'notification_identity_conflict', '11: payload conflict on posted replay'
  );
  PERFORM pg_temp.pc_c_assert(
    (SELECT status FROM public.purchase_capture_sessions WHERE id = (s->>'session_id')::uuid) = 'posted',
    '11: stays posted after conflict'
  );

  s := pg_temp.pc_c_setup_awaiting('complete-bad-mov');
  PERFORM public.begin_purchase_capture_confirmation(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid,
    (s->>'receipt_id')::uuid, (s->>'draft_revision')::bigint,
    'group', s->>'source_id', s->>'sender', NULL
  );
  PERFORM pg_temp.pc_c_expect_error(
    format($q$SELECT public.complete_purchase_capture_posting(
      %L::uuid, %L::uuid, %L::uuid, ARRAY['x'], NULL)$q$,
      s->>'session_id', s->>'session_generation', gen_random_uuid()),
    'P0001', 'invalid_movement', '12: invalid movement'
  );
  PERFORM pg_temp.pc_c_assert(
    (SELECT status FROM public.purchase_capture_sessions WHERE id = (s->>'session_id')::uuid) = 'confirming',
    '12: stays confirming'
  );
  PERFORM pg_temp.pc_c_assert(
    (SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = (s->>'session_id')::uuid),
    '12: movement_id null'
  );
END;
$$;

-- ── 13. first-attempt complete atomic rollback (outbox identity conflict) ────
DO $$
DECLARE
  s jsonb;
  v_mov uuid;
  v_notif_before jsonb;
  v_notif_after jsonb;
  v_before jsonb;
  v_after jsonb;
BEGIN
  s := pg_temp.pc_c_setup_awaiting('complete-first-conflict');
  PERFORM public.begin_purchase_capture_confirmation(
    (s->>'session_id')::uuid, (s->>'session_generation')::uuid,
    (s->>'receipt_id')::uuid, (s->>'draft_revision')::bigint,
    'group', s->>'source_id', s->>'sender', NULL
  );
  PERFORM public.confirm_purchase_receipt(
    (s->>'receipt_id')::uuid, 'purchase-capture:v1:' || (s->>'opened_line_event_id'),
    (s->>'draft_revision')::bigint, NULL
  );
  v_mov := (public.post_purchase_receipt_inventory_movement((s->>'receipt_id')::uuid, NULL)->>'movement_id')::uuid;

  PERFORM public.purchase_capture_create_notification_parts_internal(
    (s->>'session_id')::uuid, 'posted_success', v_mov::text,
    ARRAY['seed-conflict-payload'], false
  );

  v_notif_before := pg_temp.pc_c_snapshot_notifications((s->>'session_id')::uuid);
  v_before := pg_temp.pc_c_snapshot((s->>'session_id')::uuid, (s->>'receipt_id')::uuid);

  PERFORM pg_temp.pc_c_expect_error(
    format($q$SELECT public.complete_purchase_capture_posting(
      %L::uuid, %L::uuid, %L::uuid, ARRAY['DIFFERENT-FIRST-ATTEMPT'], NULL)$q$,
      s->>'session_id', s->>'session_generation', v_mov),
    'P0001', 'notification_identity_conflict', '13: first-attempt payload conflict'
  );

  v_notif_after := pg_temp.pc_c_snapshot_notifications((s->>'session_id')::uuid);
  v_after := pg_temp.pc_c_snapshot((s->>'session_id')::uuid, (s->>'receipt_id')::uuid);

  PERFORM pg_temp.pc_c_assert_refusal_unchanged(
    v_notif_before, v_notif_after, '13: all notification rows byte-equivalent');
  PERFORM pg_temp.pc_c_assert(
    (v_after->'session'->>'status') = 'confirming', '13: session confirming');
  PERFORM pg_temp.pc_c_assert(
    (v_after->'session'->>'movement_id') IS NULL, '13: movement_id null');
  PERFORM pg_temp.pc_c_assert(
    (SELECT count(*) FROM public.purchase_capture_lifecycle_events
      WHERE session_id = (s->>'session_id')::uuid AND event = 'posted') = 0,
    '13: no posted lifecycle');
  PERFORM pg_temp.pc_c_assert_refusal_unchanged(
    v_before - 'notifications', v_after - 'notifications', '13: session/receipt/items/lifecycle unchanged');
END;
$$;

-- ── 14. movement binding failures leave confirming + null movement_id ─────────
DO $$
DECLARE
  s_a jsonb;
  s_b jsonb;
  v_mov_a uuid;
  v_reversal uuid;
BEGIN
  s_a := pg_temp.pc_c_setup_confirming('mov-bind-a');
  v_mov_a := (s_a->>'movement_id')::uuid;

  s_b := pg_temp.pc_c_setup_awaiting('mov-bind-b');
  PERFORM public.begin_purchase_capture_confirmation(
    (s_b->>'session_id')::uuid, (s_b->>'session_generation')::uuid,
    (s_b->>'receipt_id')::uuid, (s_b->>'draft_revision')::bigint,
    'group', s_b->>'source_id', s_b->>'sender', NULL
  );

  PERFORM pg_temp.pc_c_expect_error(
    format($q$SELECT public.complete_purchase_capture_posting(
      %L::uuid, %L::uuid, %L::uuid, ARRAY['wrong-receipt'], NULL)$q$,
      s_b->>'session_id', s_b->>'session_generation', v_mov_a),
    'P0001', 'invalid_movement', '14a: movement from receipt A on session B'
  );
  PERFORM pg_temp.pc_c_assert(
    (SELECT status FROM public.purchase_capture_sessions WHERE id = (s_b->>'session_id')::uuid) = 'confirming',
    '14a: confirming');
  PERFORM pg_temp.pc_c_assert(
    (SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = (s_b->>'session_id')::uuid),
    '14a: movement_id null');

  v_reversal := (public.reverse_inventory_movement(
    v_mov_a, 'p2c:reversal:mov-bind-a', 'test reversal', NULL
  )->>'reversal_id')::uuid;

  PERFORM pg_temp.pc_c_expect_error(
    format($q$SELECT public.complete_purchase_capture_posting(
      %L::uuid, %L::uuid, %L::uuid, ARRAY['reversal'], NULL)$q$,
      s_a->>'session_id', s_a->>'session_generation', v_reversal),
    'P0001', 'invalid_movement', '14b: reversal movement rejected'
  );
  PERFORM pg_temp.pc_c_assert(
    (SELECT status FROM public.purchase_capture_sessions WHERE id = (s_a->>'session_id')::uuid) = 'confirming',
    '14b: confirming after reversal attempt');
  PERFORM pg_temp.pc_c_assert(
    (SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = (s_a->>'session_id')::uuid),
    '14b: movement_id null');
END;
$$;

-- ── 15. grants: catalog + runtime SET ROLE ───────────────────────────────────
DO $$
DECLARE
  s jsonb;
  v_sid uuid;
  v_gen uuid;
  v_rid uuid;
  v_rev bigint;
  v_mov uuid;
BEGIN
  s := pg_temp.pc_c_setup_confirming('grants-runtime');
  v_sid := (s->>'session_id')::uuid;
  v_gen := (s->>'session_generation')::uuid;
  v_rid := (s->>'receipt_id')::uuid;
  v_rev := (s->>'draft_revision')::bigint;
  v_mov := (s->>'movement_id')::uuid;

  PERFORM pg_temp.pc_c_assert(
    has_function_privilege('service_role',
      'public.begin_purchase_capture_confirmation(uuid,uuid,uuid,bigint,text,text,text,text)', 'EXECUTE'),
    '15: service_role catalog begin');
  PERFORM pg_temp.pc_c_assert(
    NOT has_function_privilege('anon',
      'public.begin_purchase_capture_confirmation(uuid,uuid,uuid,bigint,text,text,text,text)', 'EXECUTE'),
    '15: anon catalog denied begin');
  PERFORM pg_temp.pc_c_assert(
    NOT has_function_privilege('service_role',
      'public.purchase_capture_evaluate_blocking_blockers(uuid)', 'EXECUTE'),
    '15: internal helper not granted to service_role');

  BEGIN
    SET LOCAL ROLE service_role;
    BEGIN
      PERFORM public.purchase_capture_evaluate_blocking_blockers(v_rid);
      RAISE EXCEPTION 'purchase_capture_slice_c_hardening FAIL: 15 service_role EXECUTE helper should be denied';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
      WHEN OTHERS THEN
        RAISE EXCEPTION 'purchase_capture_slice_c_hardening FAIL: 15 service_role helper expected insufficient_privilege, got SQLSTATE=% message=%',
          SQLSTATE, SQLERRM;
    END;
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM public.begin_purchase_capture_confirmation(
        v_sid, v_gen, v_rid, v_rev, 'group', s->>'source_id', s->>'sender', NULL);
      RAISE EXCEPTION 'purchase_capture_slice_c_hardening FAIL: 15 anon EXECUTE begin should be denied';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.complete_purchase_capture_posting(
        v_sid, v_gen, v_mov, ARRAY['x'], NULL);
      RAISE EXCEPTION 'purchase_capture_slice_c_hardening FAIL: 15 authenticated EXECUTE complete should be denied';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE service_role;
    BEGIN
      PERFORM public.begin_purchase_capture_confirmation(
        v_sid, v_gen, v_rid, v_rev, 'group', s->>'source_id', s->>'sender', NULL);
      RAISE EXCEPTION 'purchase_capture_slice_c_hardening FAIL: 15 service_role begin should refuse invalid_state replay';
    EXCEPTION WHEN OTHERS THEN
      IF position('invalid_state' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
    END;
    PERFORM public.complete_purchase_capture_posting(
      v_sid, v_gen, v_mov, ARRAY['grants-runtime-ok'], NULL);
    RESET ROLE;
  END;
END;
$$;

DO $$ BEGIN RAISE NOTICE 'purchase_capture_slice_c_hardening PASS'; END $$;
