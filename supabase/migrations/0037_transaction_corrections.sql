-- Immutable transaction correction workflow.
-- Original produce_items rows remain untouched. Approved corrections are
-- projected through effective_produce_transactions and are the only
-- corrections that affect operational totals.

CREATE TABLE public.transaction_corrections (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_transaction_id     uuid NOT NULL REFERENCES public.produce_items(id) ON DELETE RESTRICT,
  status                    text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'cancelled')),
  reason_type               text NOT NULL
    CHECK (reason_type IN ('wrong_price', 'wrong_quantity', 'wrong_unit', 'wrong_product', 'duplicate', 'other')),
  reason_detail             text NOT NULL CHECK (length(btrim(reason_detail)) >= 3),
  before_snapshot           jsonb NOT NULL,
  after_snapshot            jsonb NOT NULL,
  requested_by              uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_at              timestamptz NOT NULL DEFAULT now(),
  approved_by               uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at               timestamptz,
  rejected_by               uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  rejected_at               timestamptz,
  rejection_reason          text,
  supersedes_correction_id  uuid REFERENCES public.transaction_corrections(id) ON DELETE RESTRICT,
  source_line_message_id    text,
  evidence_url              text,
  target_version            text NOT NULL,
  request_key               uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT transaction_corrections_snapshots_are_objects CHECK (
    jsonb_typeof(before_snapshot) = 'object'
    AND jsonb_typeof(after_snapshot) = 'object'
  ),
  CONSTRAINT transaction_corrections_snapshot_identity CHECK (
    before_snapshot->>'sourceTransactionId' = target_transaction_id::text
    AND after_snapshot->>'sourceTransactionId' = target_transaction_id::text
  ),
  CONSTRAINT transaction_corrections_snapshot_required_fields CHECK (
    before_snapshot ?& ARRAY[
      'sourceTransactionId', 'productName', 'quantity', 'unit',
      'priceAmount', 'priceQuantity', 'totalAmount', 'transactionType',
      'transactionDate', 'staffName', 'marketName', 'voided'
    ]
    AND after_snapshot ?& ARRAY[
      'sourceTransactionId', 'productName', 'quantity', 'unit',
      'priceAmount', 'priceQuantity', 'totalAmount', 'transactionType',
      'transactionDate', 'staffName', 'marketName', 'voided'
    ]
  ),
  CONSTRAINT transaction_corrections_approval_state CHECK (
    (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR status <> 'approved'
  ),
  CONSTRAINT transaction_corrections_rejection_state CHECK (
    (status = 'rejected' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL
      AND length(btrim(COALESCE(rejection_reason, ''))) >= 3)
    OR status <> 'rejected'
  )
);

CREATE UNIQUE INDEX transaction_corrections_request_key_idx
  ON public.transaction_corrections (request_key);
CREATE UNIQUE INDEX transaction_corrections_one_pending_per_target_idx
  ON public.transaction_corrections (target_transaction_id) WHERE status = 'pending';
CREATE UNIQUE INDEX transaction_corrections_one_active_approved_idx
  ON public.transaction_corrections (target_transaction_id) WHERE status = 'approved';
CREATE INDEX transaction_corrections_filter_idx
  ON public.transaction_corrections (status, requested_at DESC);
CREATE INDEX transaction_corrections_target_history_idx
  ON public.transaction_corrections (target_transaction_id, created_at DESC);

COMMENT ON TABLE public.transaction_corrections IS
  'Append-only audit records. Original produce_items are immutable; only the single approved correction per target is projected into effective reports.';

ALTER TABLE public.transaction_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY transaction_corrections_authenticated_read
  ON public.transaction_corrections FOR SELECT TO authenticated USING (true);

CREATE POLICY transaction_corrections_authenticated_request
  ON public.transaction_corrections FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
    AND status = 'pending'
    AND approved_by IS NULL AND approved_at IS NULL
    AND rejected_by IS NULL AND rejected_at IS NULL
  );

GRANT SELECT, INSERT ON public.transaction_corrections TO authenticated;
REVOKE UPDATE, DELETE ON public.transaction_corrections FROM authenticated;

-- Approval is intentionally fail-closed. Production currently has no role
-- model, so only users explicitly marked in auth app metadata may act.
CREATE OR REPLACE FUNCTION public.is_transaction_correction_approver()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE(
    (SELECT
      u.raw_app_meta_data->>'role' = 'admin'
      OR COALESCE(u.raw_app_meta_data->>'correction_approver' = 'true', false)
     FROM auth.users u
     WHERE u.id = auth.uid()),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_transaction_correction_approver() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_transaction_correction_approver() TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_transaction_correction(
  p_correction_id uuid,
  p_expected_target_version text
)
RETURNS public.transaction_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_actor              uuid := auth.uid();
  v_correction         public.transaction_corrections%ROWTYPE;
  v_active             public.transaction_corrections%ROWTYPE;
  v_current_version    text;
BEGIN
  IF v_actor IS NULL OR NOT public.is_transaction_correction_approver() THEN
    RAISE EXCEPTION 'not authorized to approve corrections' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_correction
  FROM public.transaction_corrections
  WHERE id = p_correction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_correction.status = 'approved' THEN
    RETURN v_correction;
  END IF;
  IF v_correction.status <> 'pending' THEN
    RAISE EXCEPTION 'correction is not pending';
  END IF;
  IF v_correction.target_version <> p_expected_target_version THEN
    RAISE EXCEPTION 'stale version conflict' USING ERRCODE = '40001';
  END IF;

  PERFORM pi.id
  FROM public.produce_items pi
  WHERE pi.id = v_correction.target_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target transaction not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_active
  FROM public.transaction_corrections tc
  WHERE tc.target_transaction_id = v_correction.target_transaction_id
    AND tc.status = 'approved'
  FOR UPDATE;

  v_current_version := CASE
    WHEN v_active.id IS NOT NULL THEN 'correction:' || v_active.id::text
    ELSE 'raw:' || v_correction.target_transaction_id::text
  END;

  IF v_current_version <> v_correction.target_version THEN
    RAISE EXCEPTION 'stale version conflict' USING ERRCODE = '40001';
  END IF;
  IF v_active.id IS DISTINCT FROM v_correction.supersedes_correction_id THEN
    RAISE EXCEPTION 'stale correction chain conflict' USING ERRCODE = '40001';
  END IF;

  IF v_active.id IS NOT NULL THEN
    UPDATE public.transaction_corrections
    SET status = 'superseded', updated_at = now()
    WHERE id = v_active.id;
  END IF;

  UPDATE public.transaction_corrections
  SET status = 'approved', approved_by = v_actor, approved_at = now(), updated_at = now()
  WHERE id = p_correction_id
  RETURNING * INTO v_correction;
  RETURN v_correction;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_transaction_correction(
  p_correction_id uuid,
  p_rejection_reason text
)
RETURNS public.transaction_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_correction  public.transaction_corrections%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.is_transaction_correction_approver() THEN
    RAISE EXCEPTION 'not authorized to reject corrections' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_rejection_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'rejection reason is required';
  END IF;

  SELECT * INTO v_correction
  FROM public.transaction_corrections
  WHERE id = p_correction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_correction.status = 'rejected' THEN
    RETURN v_correction;
  END IF;
  IF v_correction.status <> 'pending' THEN
    RAISE EXCEPTION 'correction is not pending';
  END IF;

  UPDATE public.transaction_corrections
  SET status = 'rejected', rejected_by = v_actor, rejected_at = now(),
      rejection_reason = btrim(p_rejection_reason), updated_at = now()
  WHERE id = p_correction_id
  RETURNING * INTO v_correction;
  RETURN v_correction;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_transaction_correction(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_transaction_correction(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_transaction_correction(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_transaction_correction(uuid, text) TO authenticated;

-- Central effective read model. produce_transactions remains immutable/raw.
CREATE VIEW public.effective_produce_transactions
WITH (security_invoker = true)
AS
SELECT
  pt.id,
  pt.item_number,
  COALESCE(tc.after_snapshot->>'productName', pt.product_name) AS product_name,
  CASE WHEN tc.id IS NOT NULL
    THEN (tc.after_snapshot->>'priceAmount')::numeric
      / NULLIF((tc.after_snapshot->>'priceQuantity')::numeric, 0)
    ELSE pt.price_per_unit
  END AS price_per_unit,
  COALESCE((tc.after_snapshot->>'quantity')::numeric, pt.quantity) AS quantity,
  COALESCE((tc.after_snapshot->>'totalAmount')::numeric, pt.total_amount) AS total_amount,
  COALESCE(tc.after_snapshot->>'unit', pt.unit) AS unit,
  pt.section,
  pt.transaction_type,
  pt.item_hash,
  pt.item_created_at,
  pt.session_id,
  pt.transaction_date,
  pt.transaction_time,
  pt.market_name,
  pt.staff_name,
  pt.sender_name,
  pt.session_created_at,
  pt.raw_message_id,
  pt.source_message,
  CASE WHEN tc.id IS NOT NULL AND (tc.after_snapshot->>'priceQuantity')::numeric <> 1
    THEN (tc.after_snapshot->>'priceQuantity')::numeric ELSE pt.basis_quantity END AS basis_quantity,
  CASE WHEN tc.id IS NOT NULL AND (tc.after_snapshot->>'priceQuantity')::numeric <> 1
    THEN COALESCE(tc.after_snapshot->>'unit', pt.basis_unit) ELSE pt.basis_unit END AS basis_unit,
  CASE WHEN tc.id IS NOT NULL AND (tc.after_snapshot->>'priceQuantity')::numeric <> 1
    THEN (tc.after_snapshot->>'priceAmount')::numeric ELSE pt.basis_price END AS basis_price,
  CASE WHEN tc.id IS NOT NULL AND (tc.after_snapshot->>'priceQuantity')::numeric <> 1
    THEN 'basis' ELSE pt.pricing_mode END AS pricing_mode,
  pt.base_transaction_type,
  pt.session_kind,
  pt.declared_transaction_type,
  (tc.id IS NOT NULL) AS is_corrected,
  tc.id AS correction_id,
  tc.reason_type AS correction_reason_type,
  tc.reason_detail AS correction_reason_detail,
  tc.requested_by AS correction_requested_by,
  tc.approved_by AS correction_approved_by,
  tc.approved_at AS correction_approved_at,
  pt.product_name AS original_product_name,
  pt.quantity AS original_quantity,
  pt.unit AS original_unit,
  COALESCE(pt.basis_price, pt.price_per_unit) AS original_price_amount,
  COALESCE(pt.basis_quantity, 1) AS original_price_quantity,
  pt.total_amount AS original_total_amount
FROM public.produce_transactions pt
LEFT JOIN public.transaction_corrections tc
  ON tc.target_transaction_id = pt.id AND tc.status = 'approved'
WHERE COALESCE((tc.after_snapshot->>'voided')::boolean, false) = false;

COMMENT ON VIEW public.effective_produce_transactions IS
  'Raw produce transactions plus the single approved immutable correction overlay. Pending/rejected corrections never affect this view; approved duplicates are omitted.';
GRANT SELECT ON public.effective_produce_transactions TO authenticated;
