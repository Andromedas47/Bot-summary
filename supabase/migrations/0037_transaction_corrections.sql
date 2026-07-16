-- Immutable transaction correction workflow.
-- This migration has not been applied to Production and is intentionally
-- amended in place before its first release. Raw produce_items stay untouched;
-- only validated, approved overlays affect effective reports.

CREATE OR REPLACE FUNCTION public.is_valid_transaction_correction_snapshot(
  p_snapshot jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_quantity        numeric;
  v_price_amount    numeric;
  v_price_quantity  numeric;
  v_total_amount    numeric;
BEGIN
  IF jsonb_typeof(p_snapshot) <> 'object'
     OR NOT p_snapshot ?& ARRAY[
       'sourceTransactionId', 'sourceLineMessageId', 'sourceVersion',
       'sourceNames', 'productName', 'quantity', 'unit', 'priceAmount',
       'priceQuantity', 'totalAmount', 'transactionType', 'transactionDate',
       'staffName', 'marketName', 'voided'
     ] THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_snapshot->'sourceTransactionId') <> 'string'
     OR length(btrim(p_snapshot->>'sourceTransactionId')) = 0
     OR jsonb_typeof(p_snapshot->'sourceVersion') <> 'string'
     OR length(btrim(p_snapshot->>'sourceVersion')) = 0
     OR jsonb_typeof(p_snapshot->'sourceNames') <> 'array'
     OR jsonb_array_length(p_snapshot->'sourceNames') = 0
     OR jsonb_typeof(p_snapshot->'productName') <> 'string'
     OR length(btrim(p_snapshot->>'productName')) NOT BETWEEN 1 AND 200
     OR jsonb_typeof(p_snapshot->'unit') <> 'string'
     OR length(btrim(p_snapshot->>'unit')) NOT BETWEEN 1 AND 50
     OR jsonb_typeof(p_snapshot->'transactionType') <> 'string'
     OR length(btrim(p_snapshot->>'transactionType')) NOT BETWEEN 1 AND 50
     OR jsonb_typeof(p_snapshot->'transactionDate') <> 'string'
     OR (p_snapshot->>'transactionDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR jsonb_typeof(p_snapshot->'staffName') <> 'string'
     OR length(btrim(p_snapshot->>'staffName')) NOT BETWEEN 1 AND 200
     OR jsonb_typeof(p_snapshot->'marketName') <> 'string'
     OR length(p_snapshot->>'marketName') > 200
     OR jsonb_typeof(p_snapshot->'quantity') <> 'number'
     OR jsonb_typeof(p_snapshot->'priceAmount') <> 'number'
     OR jsonb_typeof(p_snapshot->'priceQuantity') <> 'number'
     OR jsonb_typeof(p_snapshot->'totalAmount') <> 'number'
     OR jsonb_typeof(p_snapshot->'voided') <> 'boolean'
     OR (
       p_snapshot->'sourceLineMessageId' <> 'null'::jsonb
       AND jsonb_typeof(p_snapshot->'sourceLineMessageId') <> 'string'
     )
     OR length(COALESCE(p_snapshot->>'sourceLineMessageId', '')) > 200 THEN
    RETURN false;
  END IF;

  v_quantity := (p_snapshot->>'quantity')::numeric;
  v_price_amount := (p_snapshot->>'priceAmount')::numeric;
  v_price_quantity := (p_snapshot->>'priceQuantity')::numeric;
  v_total_amount := (p_snapshot->>'totalAmount')::numeric;

  RETURN v_quantity > 0 AND v_quantity <= 1000000
    AND v_price_amount >= 0 AND v_price_amount <= 1000000
    AND v_price_quantity >= 0.001 AND v_price_quantity <= 1000000
    AND v_total_amount >= 0 AND v_total_amount <= 1000000000000;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.canonicalize_transaction_correction_changes(
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_text   text;
  v_number numeric;
BEGIN
  IF jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION 'requested changes must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_changes) AS item(key)
    WHERE item.key NOT IN (
      'productName', 'quantity', 'unit', 'priceAmount', 'priceQuantity', 'duplicate'
    )
  ) THEN
    RAISE EXCEPTION 'requested changes contain unsupported fields' USING ERRCODE = '22023';
  END IF;
  IF p_changes = '{}'::jsonb THEN
    RAISE EXCEPTION 'at least one requested change is required' USING ERRCODE = '22023';
  END IF;

  IF p_changes ? 'productName' THEN
    IF jsonb_typeof(p_changes->'productName') <> 'string' THEN
      RAISE EXCEPTION 'productName must be a JSON string' USING ERRCODE = '22023';
    END IF;
    v_text := btrim(p_changes->>'productName');
    IF length(v_text) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'productName must contain 1-200 characters' USING ERRCODE = '22023';
    END IF;
    v_result := v_result || jsonb_build_object('productName', v_text);
  END IF;

  IF p_changes ? 'unit' THEN
    IF jsonb_typeof(p_changes->'unit') <> 'string' THEN
      RAISE EXCEPTION 'unit must be a JSON string' USING ERRCODE = '22023';
    END IF;
    v_text := btrim(p_changes->>'unit');
    IF length(v_text) NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION 'unit must contain 1-50 characters' USING ERRCODE = '22023';
    END IF;
    v_result := v_result || jsonb_build_object('unit', v_text);
  END IF;

  IF p_changes ? 'quantity' THEN
    IF jsonb_typeof(p_changes->'quantity') <> 'number' THEN
      RAISE EXCEPTION 'quantity must be a JSON number' USING ERRCODE = '22023';
    END IF;
    v_number := (p_changes->>'quantity')::numeric;
    IF v_number <= 0 OR v_number > 1000000 THEN
      RAISE EXCEPTION 'quantity must be greater than 0 and at most 1000000' USING ERRCODE = '22023';
    END IF;
    v_result := v_result || jsonb_build_object('quantity', v_number);
  END IF;

  IF p_changes ? 'priceAmount' THEN
    IF jsonb_typeof(p_changes->'priceAmount') <> 'number' THEN
      RAISE EXCEPTION 'priceAmount must be a JSON number' USING ERRCODE = '22023';
    END IF;
    v_number := (p_changes->>'priceAmount')::numeric;
    IF v_number < 0 OR v_number > 1000000 THEN
      RAISE EXCEPTION 'priceAmount must be between 0 and 1000000' USING ERRCODE = '22023';
    END IF;
    v_result := v_result || jsonb_build_object('priceAmount', v_number);
  END IF;

  IF p_changes ? 'priceQuantity' THEN
    IF jsonb_typeof(p_changes->'priceQuantity') <> 'number' THEN
      RAISE EXCEPTION 'priceQuantity must be a JSON number' USING ERRCODE = '22023';
    END IF;
    v_number := (p_changes->>'priceQuantity')::numeric;
    IF v_number < 0.001 OR v_number > 1000000 THEN
      RAISE EXCEPTION 'priceQuantity must be between 0.001 and 1000000' USING ERRCODE = '22023';
    END IF;
    v_result := v_result || jsonb_build_object('priceQuantity', v_number);
  END IF;

  IF p_changes ? 'duplicate' THEN
    IF jsonb_typeof(p_changes->'duplicate') <> 'boolean' THEN
      RAISE EXCEPTION 'duplicate must be a JSON boolean' USING ERRCODE = '22023';
    END IF;
    v_result := v_result || jsonb_build_object(
      'duplicate', (p_changes->>'duplicate')::boolean
    );
  END IF;

  IF COALESCE((v_result->>'duplicate')::boolean, false)
     AND (v_result - 'duplicate') <> '{}'::jsonb THEN
    RAISE EXCEPTION 'duplicate void cannot include other field changes' USING ERRCODE = '22023';
  END IF;
  RETURN v_result;
EXCEPTION
  WHEN SQLSTATE '22023' THEN RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'requested changes are malformed' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.build_transaction_correction_after_snapshot(
  p_before jsonb,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_changes         jsonb;
  v_after           jsonb;
  v_quantity        numeric;
  v_price_amount    numeric;
  v_price_quantity  numeric;
  v_duplicate       boolean;
  v_total           numeric;
BEGIN
  IF NOT public.is_valid_transaction_correction_snapshot(p_before)
     OR COALESCE((p_before->>'voided')::boolean, false) THEN
    RAISE EXCEPTION 'trusted before snapshot is invalid or voided' USING ERRCODE = '22023';
  END IF;

  v_changes := public.canonicalize_transaction_correction_changes(p_changes);
  v_quantity := COALESCE(
    (v_changes->>'quantity')::numeric,
    (p_before->>'quantity')::numeric
  );
  v_price_amount := COALESCE(
    (v_changes->>'priceAmount')::numeric,
    (p_before->>'priceAmount')::numeric
  );
  v_price_quantity := COALESCE(
    (v_changes->>'priceQuantity')::numeric,
    (p_before->>'priceQuantity')::numeric
  );
  v_duplicate := COALESCE((v_changes->>'duplicate')::boolean, false);
  v_total := CASE
    WHEN v_duplicate THEN 0
    ELSE round(v_quantity * v_price_amount / v_price_quantity, 2)
  END;

  v_after := p_before || jsonb_build_object(
    'productName', COALESCE(v_changes->>'productName', p_before->>'productName'),
    'quantity', v_quantity,
    'unit', COALESCE(v_changes->>'unit', p_before->>'unit'),
    'priceAmount', v_price_amount,
    'priceQuantity', v_price_quantity,
    'totalAmount', v_total,
    'voided', v_duplicate
  );

  IF NOT public.is_valid_transaction_correction_after_snapshot(v_after) THEN
    RAISE EXCEPTION 'computed after snapshot is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_after = p_before THEN
    RAISE EXCEPTION 'requested changes do not change the transaction' USING ERRCODE = '22023';
  END IF;
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_transaction_correction_after_snapshot(
  p_snapshot jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_expected numeric;
BEGIN
  IF NOT public.is_valid_transaction_correction_snapshot(p_snapshot) THEN
    RETURN false;
  END IF;
  v_expected := CASE
    WHEN (p_snapshot->>'voided')::boolean THEN 0
    ELSE round(
      (p_snapshot->>'quantity')::numeric
      * (p_snapshot->>'priceAmount')::numeric
      / (p_snapshot->>'priceQuantity')::numeric,
      2
    )
  END;
  RETURN (p_snapshot->>'totalAmount')::numeric = v_expected;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.safe_transaction_correction_numeric(
  p_snapshot jsonb,
  p_key text
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
BEGIN
  IF jsonb_typeof(p_snapshot->p_key) <> 'number' THEN
    RETURN NULL;
  END IF;
  RETURN (p_snapshot->>p_key)::numeric;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE TABLE public.transaction_corrections (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_transaction_id     uuid NOT NULL REFERENCES public.produce_items(id) ON DELETE RESTRICT,
  status                    text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'cancelled')),
  reason_type               text NOT NULL
    CHECK (reason_type IN ('wrong_price', 'wrong_quantity', 'wrong_unit', 'wrong_product', 'duplicate', 'other')),
  reason_detail             text NOT NULL CHECK (length(btrim(reason_detail)) BETWEEN 3 AND 1000),
  requested_changes         jsonb NOT NULL,
  before_snapshot           jsonb NOT NULL,
  after_snapshot            jsonb NOT NULL,
  requested_by              uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_at              timestamptz NOT NULL,
  approved_by               uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at               timestamptz,
  rejected_by               uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  rejected_at               timestamptz,
  rejection_reason          text,
  supersedes_correction_id  uuid REFERENCES public.transaction_corrections(id) ON DELETE RESTRICT,
  source_line_message_id    text,
  evidence_url              text CHECK (evidence_url IS NULL OR length(evidence_url) <= 2048),
  target_version            text NOT NULL,
  request_key               uuid NOT NULL,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,

  CONSTRAINT transaction_corrections_requested_changes_are_canonical CHECK (
    requested_changes = public.canonicalize_transaction_correction_changes(requested_changes)
  ),
  CONSTRAINT transaction_corrections_snapshots_are_valid CHECK (
    public.is_valid_transaction_correction_snapshot(before_snapshot)
    AND public.is_valid_transaction_correction_after_snapshot(after_snapshot)
    AND after_snapshot = public.build_transaction_correction_after_snapshot(
      before_snapshot, requested_changes
    )
  ),
  CONSTRAINT transaction_corrections_snapshot_identity CHECK (
    before_snapshot->>'sourceTransactionId' = target_transaction_id::text
    AND after_snapshot->>'sourceTransactionId' = target_transaction_id::text
    AND before_snapshot->>'sourceVersion' = target_version
    AND after_snapshot->>'sourceVersion' = target_version
    AND before_snapshot->>'sourceLineMessageId'
      IS NOT DISTINCT FROM source_line_message_id
    AND after_snapshot->>'sourceLineMessageId'
      IS NOT DISTINCT FROM source_line_message_id
    AND (reason_type = 'duplicate') =
      COALESCE((after_snapshot->>'voided')::boolean, false)
  ),
  CONSTRAINT transaction_corrections_audit_clock CHECK (
    requested_at = created_at AND updated_at >= created_at
  ),
  CONSTRAINT transaction_corrections_status_actor_state CHECK (
    (
      status IN ('pending', 'cancelled')
      AND approved_by IS NULL AND approved_at IS NULL
      AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
    ) OR (
      status IN ('approved', 'superseded')
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND approved_at >= requested_at
      AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
    ) OR (
      status = 'rejected'
      AND approved_by IS NULL AND approved_at IS NULL
      AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL
      AND rejected_at >= requested_at
      AND length(btrim(rejection_reason)) BETWEEN 3 AND 1000
    )
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
  'Append-only audit records created only by trusted RPCs. Raw produce_items stay immutable; a single validated approved overlay may affect reports.';

ALTER TABLE public.transaction_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY transaction_corrections_authenticated_read
  ON public.transaction_corrections FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.transaction_corrections TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.transaction_corrections FROM authenticated;
REVOKE ALL ON public.transaction_corrections FROM anon;

CREATE OR REPLACE FUNCTION public.enforce_transaction_correction_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.id, NEW.target_transaction_id, NEW.reason_type, NEW.reason_detail,
    NEW.requested_changes, NEW.before_snapshot, NEW.after_snapshot,
    NEW.requested_by, NEW.requested_at, NEW.supersedes_correction_id,
    NEW.source_line_message_id, NEW.evidence_url, NEW.target_version,
    NEW.request_key, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.target_transaction_id, OLD.reason_type, OLD.reason_detail,
    OLD.requested_changes, OLD.before_snapshot, OLD.after_snapshot,
    OLD.requested_by, OLD.requested_at, OLD.supersedes_correction_id,
    OLD.source_line_message_id, OLD.evidence_url, OLD.target_version,
    OLD.request_key, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'correction audit payload is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL
       OR NEW.rejected_by IS NOT NULL OR NEW.rejected_at IS NOT NULL
       OR NEW.rejection_reason IS NOT NULL THEN
      RAISE EXCEPTION 'invalid approval transition' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'pending' AND NEW.status = 'rejected' THEN
    IF NEW.rejected_by IS NULL OR NEW.rejected_at IS NULL
       OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR length(btrim(COALESCE(NEW.rejection_reason, ''))) NOT BETWEEN 3 AND 1000 THEN
      RAISE EXCEPTION 'invalid rejection transition' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'approved' AND NEW.status = 'superseded' THEN
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.rejected_by IS NOT NULL OR NEW.rejected_at IS NOT NULL
       OR NEW.rejection_reason IS NOT NULL THEN
      RAISE EXCEPTION 'invalid supersede transition' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'correction status transition is not allowed' USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_transaction_correction_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'transaction correction audit rows cannot be deleted' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER transaction_corrections_immutable_update
BEFORE UPDATE ON public.transaction_corrections
FOR EACH ROW EXECUTE FUNCTION public.enforce_transaction_correction_immutability();

CREATE TRIGGER transaction_corrections_immutable_delete
BEFORE DELETE ON public.transaction_corrections
FOR EACH ROW EXECUTE FUNCTION public.prevent_transaction_correction_delete();

CREATE OR REPLACE FUNCTION public.is_transaction_correction_approver()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
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

CREATE OR REPLACE FUNCTION public.build_trusted_raw_transaction_snapshot(
  p_target_transaction_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_target          public.produce_transactions%ROWTYPE;
  v_price_amount    numeric;
  v_price_quantity  numeric;
  v_total_amount    numeric;
  v_snapshot        jsonb;
BEGIN
  SELECT * INTO v_target
  FROM public.produce_transactions
  WHERE id = p_target_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'target transaction not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_target.transaction_date IS NULL
     OR COALESCE(btrim(v_target.product_name), '') = ''
     OR COALESCE(btrim(v_target.unit), '') = ''
     OR COALESCE(btrim(v_target.transaction_type), '') = ''
     OR COALESCE(btrim(v_target.staff_name), '') = ''
     OR v_target.quantity IS NULL OR v_target.quantity <= 0 THEN
    RAISE EXCEPTION 'target transaction is incomplete and cannot be corrected' USING ERRCODE = '22023';
  END IF;

  v_price_amount := COALESCE(v_target.basis_price, v_target.price_per_unit, 0);
  v_price_quantity := COALESCE(v_target.basis_quantity, 1);
  v_total_amount := COALESCE(
    v_target.total_amount,
    round(v_target.quantity * v_price_amount / v_price_quantity, 2)
  );

  v_snapshot := jsonb_build_object(
    'sourceTransactionId', v_target.id::text,
    'sourceLineMessageId', to_jsonb(v_target.raw_message_id::text),
    'sourceVersion', 'raw:' || v_target.id::text,
    'sourceNames', jsonb_build_array(v_target.product_name),
    'productName', v_target.product_name,
    'quantity', v_target.quantity,
    'unit', v_target.unit,
    'priceAmount', v_price_amount,
    'priceQuantity', v_price_quantity,
    'totalAmount', v_total_amount,
    'transactionType', v_target.transaction_type,
    'transactionDate', v_target.transaction_date::text,
    'staffName', v_target.staff_name,
    'marketName', COALESCE(v_target.market_name, ''),
    'voided', false
  );

  IF NOT public.is_valid_transaction_correction_snapshot(v_snapshot) THEN
    RAISE EXCEPTION 'trusted raw snapshot is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN v_snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_transaction_correction(
  p_target_transaction_id uuid,
  p_reason_type text,
  p_reason_detail text,
  p_requested_changes jsonb,
  p_idempotency_key uuid,
  p_source_line_message_id text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL
)
RETURNS public.transaction_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor             uuid := auth.uid();
  v_existing          public.transaction_corrections%ROWTYPE;
  v_active            public.transaction_corrections%ROWTYPE;
  v_result            public.transaction_corrections%ROWTYPE;
  v_raw_snapshot      jsonb;
  v_before            jsonb;
  v_after             jsonb;
  v_changes           jsonb;
  v_target_version    text;
  v_source_message_id text;
  v_reason_detail     text := btrim(COALESCE(p_reason_detail, ''));
  v_evidence_url      text := NULLIF(btrim(COALESCE(p_evidence_url, '')), '');
  v_now               timestamptz := clock_timestamp();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication is required' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
  FROM public.transaction_corrections
  WHERE request_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.requested_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'idempotency key belongs to another requester' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;

  IF p_reason_type NOT IN (
    'wrong_price', 'wrong_quantity', 'wrong_unit',
    'wrong_product', 'duplicate', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid correction reason type' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason_detail) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'reason detail must contain 3-1000 characters' USING ERRCODE = '22023';
  END IF;
  IF v_evidence_url IS NOT NULL AND (
    length(v_evidence_url) > 2048 OR v_evidence_url !~* '^https?://'
  ) THEN
    RAISE EXCEPTION 'evidence URL must be an http(s) URL up to 2048 characters' USING ERRCODE = '22023';
  END IF;

  PERFORM pi.id
  FROM public.produce_items pi
  WHERE pi.id = p_target_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target transaction not found' USING ERRCODE = 'P0002';
  END IF;

  v_raw_snapshot := public.build_trusted_raw_transaction_snapshot(
    p_target_transaction_id
  );
  v_source_message_id := v_raw_snapshot->>'sourceLineMessageId';
  IF p_source_line_message_id IS NOT NULL
     AND btrim(p_source_line_message_id) <> v_source_message_id THEN
    RAISE EXCEPTION 'source LINE message does not match target transaction' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_active
  FROM public.transaction_corrections tc
  WHERE tc.target_transaction_id = p_target_transaction_id
    AND tc.status = 'approved'
  FOR UPDATE;

  IF v_active.id IS NOT NULL THEN
    IF NOT public.is_valid_transaction_correction_after_snapshot(
      v_active.after_snapshot
    ) THEN
      RAISE EXCEPTION 'active correction snapshot is invalid' USING ERRCODE = '22023';
    END IF;
    IF COALESCE((v_active.after_snapshot->>'voided')::boolean, false) THEN
      RAISE EXCEPTION 'voided transaction cannot be corrected again' USING ERRCODE = '22023';
    END IF;
    v_target_version := 'correction:' || v_active.id::text;
    v_before := jsonb_set(
      v_active.after_snapshot,
      '{sourceVersion}',
      to_jsonb(v_target_version),
      true
    );
  ELSE
    v_target_version := 'raw:' || p_target_transaction_id::text;
    v_before := v_raw_snapshot;
  END IF;

  v_changes := public.canonicalize_transaction_correction_changes(
    p_requested_changes
  );
  IF p_reason_type = 'duplicate'
     AND NOT COALESCE((v_changes->>'duplicate')::boolean, false) THEN
    RAISE EXCEPTION 'duplicate reason requires duplicate void' USING ERRCODE = '22023';
  END IF;
  IF p_reason_type <> 'duplicate'
     AND COALESCE((v_changes->>'duplicate')::boolean, false) THEN
    RAISE EXCEPTION 'duplicate void requires duplicate reason' USING ERRCODE = '22023';
  END IF;
  v_after := public.build_transaction_correction_after_snapshot(
    v_before, v_changes
  );

  INSERT INTO public.transaction_corrections (
    target_transaction_id, status, reason_type, reason_detail,
    requested_changes, before_snapshot, after_snapshot,
    requested_by, requested_at, approved_by, approved_at,
    rejected_by, rejected_at, rejection_reason,
    supersedes_correction_id, source_line_message_id, evidence_url,
    target_version, request_key, created_at, updated_at
  ) VALUES (
    p_target_transaction_id, 'pending', p_reason_type, v_reason_detail,
    v_changes, v_before, v_after,
    v_actor, v_now, NULL, NULL,
    NULL, NULL, NULL,
    v_active.id, v_source_message_id, v_evidence_url,
    v_target_version, p_idempotency_key, v_now, v_now
  )
  RETURNING * INTO v_result;
  RETURN v_result;
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM public.transaction_corrections
    WHERE request_key = p_idempotency_key AND requested_by = v_actor;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
    RAISE EXCEPTION 'a correction request is already pending for this transaction'
      USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_transaction_correction(
  p_correction_id uuid,
  p_expected_target_version text
)
RETURNS public.transaction_corrections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor             uuid := auth.uid();
  v_correction        public.transaction_corrections%ROWTYPE;
  v_active            public.transaction_corrections%ROWTYPE;
  v_current_snapshot  jsonb;
  v_recomputed_after  jsonb;
  v_current_version   text;
  v_now               timestamptz := clock_timestamp();
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

  IF NOT public.is_valid_transaction_correction_snapshot(
       v_correction.before_snapshot
     )
     OR NOT public.is_valid_transaction_correction_after_snapshot(
       v_correction.after_snapshot
     )
     OR v_correction.requested_changes
        <> public.canonicalize_transaction_correction_changes(
          v_correction.requested_changes
        ) THEN
    RAISE EXCEPTION 'correction payload failed approval validation'
      USING ERRCODE = '22023';
  END IF;
  v_recomputed_after := public.build_transaction_correction_after_snapshot(
    v_correction.before_snapshot,
    v_correction.requested_changes
  );
  IF v_recomputed_after IS DISTINCT FROM v_correction.after_snapshot THEN
    RAISE EXCEPTION 'correction total or after snapshot was modified'
      USING ERRCODE = '22023';
  END IF;

  IF v_correction.status = 'approved' THEN
    RETURN v_correction;
  END IF;
  IF v_correction.status <> 'pending' THEN
    RAISE EXCEPTION 'correction is not pending' USING ERRCODE = '55000';
  END IF;
  IF v_correction.target_version IS DISTINCT FROM p_expected_target_version THEN
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

  IF v_active.id IS NOT NULL THEN
    IF NOT public.is_valid_transaction_correction_after_snapshot(
      v_active.after_snapshot
    ) THEN
      RAISE EXCEPTION 'active correction snapshot is invalid' USING ERRCODE = '22023';
    END IF;
    v_current_version := 'correction:' || v_active.id::text;
    v_current_snapshot := jsonb_set(
      v_active.after_snapshot,
      '{sourceVersion}',
      to_jsonb(v_current_version),
      true
    );
  ELSE
    v_current_version := 'raw:' || v_correction.target_transaction_id::text;
    v_current_snapshot := public.build_trusted_raw_transaction_snapshot(
      v_correction.target_transaction_id
    );
  END IF;

  IF v_current_version IS DISTINCT FROM v_correction.target_version
     OR v_current_snapshot IS DISTINCT FROM v_correction.before_snapshot THEN
    RAISE EXCEPTION 'stale version conflict' USING ERRCODE = '40001';
  END IF;
  IF v_active.id IS DISTINCT FROM v_correction.supersedes_correction_id THEN
    RAISE EXCEPTION 'stale correction chain conflict' USING ERRCODE = '40001';
  END IF;

  IF v_active.id IS NOT NULL THEN
    UPDATE public.transaction_corrections
    SET status = 'superseded'
    WHERE id = v_active.id;
  END IF;

  UPDATE public.transaction_corrections
  SET status = 'approved', approved_by = v_actor, approved_at = v_now
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
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_correction  public.transaction_corrections%ROWTYPE;
  v_reason      text := btrim(COALESCE(p_rejection_reason, ''));
  v_now         timestamptz := clock_timestamp();
BEGIN
  IF v_actor IS NULL OR NOT public.is_transaction_correction_approver() THEN
    RAISE EXCEPTION 'not authorized to reject corrections' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'rejection reason must contain 3-1000 characters'
      USING ERRCODE = '22023';
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
    RAISE EXCEPTION 'correction is not pending' USING ERRCODE = '55000';
  END IF;

  UPDATE public.transaction_corrections
  SET status = 'rejected', rejected_by = v_actor, rejected_at = v_now,
      rejection_reason = v_reason
  WHERE id = p_correction_id
  RETURNING * INTO v_correction;
  RETURN v_correction;
END;
$$;

REVOKE ALL ON FUNCTION public.is_transaction_correction_approver() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_trusted_raw_transaction_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_transaction_correction_after_snapshot(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canonicalize_transaction_correction_changes(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_transaction_correction(
  uuid, text, text, jsonb, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_transaction_correction(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_transaction_correction(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_transaction_correction_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_transaction_correction_delete() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_transaction_correction_approver()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_transaction_correction(
  uuid, text, text, jsonb, uuid, text, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_transaction_correction(uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_transaction_correction(uuid, text)
  TO authenticated;

-- Central effective read model. A malformed approved row is ignored rather
-- than cast, so historical corruption cannot take the whole report view down.
CREATE VIEW public.effective_produce_transactions
WITH (security_invoker = true)
AS
SELECT
  pt.id,
  pt.item_number,
  COALESCE(tc.after_snapshot->>'productName', pt.product_name) AS product_name,
  CASE WHEN tc.id IS NOT NULL
    THEN public.safe_transaction_correction_numeric(
      tc.after_snapshot, 'priceAmount'
    ) / NULLIF(
      public.safe_transaction_correction_numeric(
        tc.after_snapshot, 'priceQuantity'
      ),
      0
    )
    ELSE pt.price_per_unit
  END AS price_per_unit,
  COALESCE(
    public.safe_transaction_correction_numeric(tc.after_snapshot, 'quantity'),
    pt.quantity
  ) AS quantity,
  COALESCE(
    public.safe_transaction_correction_numeric(tc.after_snapshot, 'totalAmount'),
    pt.total_amount
  ) AS total_amount,
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
  CASE
    WHEN tc.id IS NULL THEN pt.basis_quantity
    WHEN public.safe_transaction_correction_numeric(
      tc.after_snapshot, 'priceQuantity'
    ) <> 1 THEN public.safe_transaction_correction_numeric(
      tc.after_snapshot, 'priceQuantity'
    )
    ELSE NULL
  END AS basis_quantity,
  CASE
    WHEN tc.id IS NULL THEN pt.basis_unit
    WHEN public.safe_transaction_correction_numeric(
      tc.after_snapshot, 'priceQuantity'
    ) <> 1 THEN tc.after_snapshot->>'unit'
    ELSE NULL
  END AS basis_unit,
  CASE
    WHEN tc.id IS NULL THEN pt.basis_price
    WHEN public.safe_transaction_correction_numeric(
      tc.after_snapshot, 'priceQuantity'
    ) <> 1 THEN public.safe_transaction_correction_numeric(
      tc.after_snapshot, 'priceAmount'
    )
    ELSE NULL
  END AS basis_price,
  CASE
    WHEN tc.id IS NULL THEN pt.pricing_mode
    WHEN public.safe_transaction_correction_numeric(
      tc.after_snapshot, 'priceQuantity'
    ) <> 1 THEN 'basis'
    ELSE 'unit'
  END AS pricing_mode,
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
  ON tc.target_transaction_id = pt.id
  AND tc.status = 'approved'
  AND public.is_valid_transaction_correction_snapshot(tc.before_snapshot)
  AND public.is_valid_transaction_correction_after_snapshot(tc.after_snapshot)
  AND tc.before_snapshot->>'sourceTransactionId' = pt.id::text
  AND tc.after_snapshot->>'sourceTransactionId' = pt.id::text
WHERE COALESCE(
  tc.after_snapshot->'voided' = 'true'::jsonb,
  false
) = false;

COMMENT ON VIEW public.effective_produce_transactions IS
  'Raw produce transactions plus one validated approved immutable correction overlay. Invalid, pending, rejected and voided rows cannot break or duplicate effective totals.';
GRANT SELECT ON public.effective_produce_transactions TO authenticated;
