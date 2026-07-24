-- Void/supersede mechanism for produce_sessions (BR-03).
--
-- This integration worktree's migration chain currently has no local 0037 —
-- that number is reserved for the protected primary workspace's
-- 0037_produce_session_void.sql (C:\GitHub\Bot-summary), which this branch
-- has not yet merged/rebased onto. Per task instruction, that file is
-- inspected READ-ONLY and never copied or edited in place.
--
-- This migration reproduces the IDENTICAL DDL (same column names, same
-- constraint names, same view bodies) as the protected 0037, so this
-- integration worktree gets working void support NOW without waiting for a
-- merge. This is safe specifically because every statement in the protected
-- 0037 is idempotent by construction (ADD COLUMN IF NOT EXISTS, constraint
-- guards checked against pg_constraint, CREATE INDEX IF NOT EXISTS, CREATE OR
-- REPLACE VIEW) — when this branch is eventually merged with the real 0037
-- already applied, running this migration's identical statements a second
-- time is a guaranteed no-op, not a conflict. Whoever performs that merge
-- should reconcile the two files (e.g. drop this one) at that time; this is
-- noted as a remaining step, not solved here.
--
-- Scope (additive only — no DELETE / TRUNCATE / DROP, no mutation of
-- produce_items, and no mutation of existing produce_sessions rows other
-- than the new nullable columns which default to "not voided"):
--   1. produce_sessions: voided_at / voided_by / void_reason /
--      replacement_session_id. A session is voided iff voided_at IS NOT
--      NULL; the CHECK constraint fails closed if void_reason or voided_by
--      is missing, regardless of whether the caller goes through the API
--      route or edits the table directly.
--   2. produce_transactions_all: same shape as produce_transactions
--      (identical SELECT list, same column order) but includes voided
--      sessions — the audit-only source of truth so the admin view never
--      needs to duplicate the total_amount pricing formula in application
--      code.
--   3. produce_transactions: redefined as `SELECT * FROM
--      produce_transactions_all WHERE voided_at IS NULL`. Every existing
--      consumer (financial summary, report summary, daily table,
--      remaining-fruit report, PDF/TXT exports, settlement/reconciliation
--      totals, White Sheet loader) reads this view, so this one change is
--      the single enforcement point — no call site needs its own voided_at
--      filter.

-- ── 1. Void columns on produce_sessions ─────────────────────────────────────

ALTER TABLE public.produce_sessions
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by text,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS replacement_session_id uuid
    REFERENCES public.produce_sessions(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'produce_sessions_void_requires_reason'
  ) THEN
    ALTER TABLE public.produce_sessions
      ADD CONSTRAINT produce_sessions_void_requires_reason
      CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND voided_by IS NOT NULL));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'produce_sessions_replacement_not_self'
  ) THEN
    ALTER TABLE public.produce_sessions
      ADD CONSTRAINT produce_sessions_replacement_not_self
      CHECK (replacement_session_id IS NULL OR replacement_session_id <> id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS produce_sessions_voided_at_idx
  ON public.produce_sessions (voided_at) WHERE voided_at IS NOT NULL;

-- ── 2 & 3. Audit (unfiltered) view + operational (filtered) view ───────────
-- Body is the 0036 SELECT list unchanged, plus the four void columns
-- appended at the end.

CREATE OR REPLACE VIEW public.produce_transactions_all AS
SELECT
  pi.id,
  pi.item_number,
  pi.product_name,
  pi.price_per_unit,
  pi.quantity,
  CASE
    WHEN pi.basis_quantity IS NOT NULL AND pi.basis_price IS NOT NULL
         AND pi.basis_quantity <> 0 AND pi.quantity IS NOT NULL
    THEN ROUND(pi.quantity * pi.basis_price / pi.basis_quantity, 2)
    WHEN pi.quantity IS NOT NULL AND pi.price_per_unit IS NOT NULL
    THEN pi.quantity * pi.price_per_unit
    ELSE NULL
  END                                   AS total_amount,
  pi.unit,
  pi.section,
  pi.transaction_type,
  pi.item_hash,
  pi.created_at                         AS item_created_at,
  ps.id                                 AS session_id,
  ps.session_date                       AS transaction_date,
  ps.transaction_time,
  COALESCE(ps.session_title, '')        AS market_name,
  ps.staff_name,
  ps.sender_name,
  ps.created_at                         AS session_created_at,
  ps.raw_message_id,
  rm.raw_text                           AS source_message,
  pi.basis_quantity,
  pi.basis_unit,
  pi.basis_price,
  CASE WHEN pi.basis_quantity IS NOT NULL THEN 'basis' ELSE 'unit' END AS pricing_mode,
  CASE pi.transaction_type
    WHEN 'เบิกเพิ่ม'   THEN 'เบิก'
    WHEN 'ชั่งคืนเพิ่ม' THEN 'คืน'
    WHEN 'คืนเสียเพิ่ม' THEN 'คืนเสีย'
    ELSE pi.transaction_type
  END                                   AS base_transaction_type,
  ps.session_kind,
  ps.declared_transaction_type,
  ps.voided_at,
  ps.voided_by,
  ps.void_reason,
  ps.replacement_session_id
FROM  produce_items    pi
JOIN  produce_sessions ps ON ps.id = pi.session_id
LEFT JOIN raw_messages rm ON rm.id = ps.raw_message_id;

COMMENT ON VIEW public.produce_transactions_all IS
  'Audit-only superset of produce_transactions: includes voided/superseded '
  'sessions. Never use for totals — use produce_transactions instead.';

CREATE OR REPLACE VIEW public.produce_transactions AS
SELECT * FROM public.produce_transactions_all WHERE voided_at IS NULL;

COMMENT ON VIEW public.produce_transactions IS
  'Primary operational view. Each row = one transaction (parsed product line). '
  'Excludes voided/superseded sessions (see produce_transactions_all for audit). '
  'market_name is COALESCE(session_title, ''''). total_amount for basis rows is '
  'round(quantity * basis_price / basis_quantity, 2). base_transaction_type '
  'normalizes legacy เบิกเพิ่ม/ชั่งคืนเพิ่ม/คืนเสียเพิ่ม onto เบิก/คืน/คืนเสีย; '
  'session_kind marks ชุดหลัก (main) vs ชุดเพิ่ม (additional).';
