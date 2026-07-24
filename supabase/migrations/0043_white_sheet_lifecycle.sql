-- White Sheet lifecycle (BR-06): NOT_SUBMITTED -> SUBMITTED -> FINALIZED.
--
-- This is a separate concept from the financial result status
-- (matched/shortage/overage/blocked, computed in calculate.ts) — a row can
-- be SUBMITTED or FINALIZED regardless of what its financial status is.
--
-- A missing row is NOT_SUBMITTED (unchanged). A present row with
-- finalized_at IS NULL is SUBMITTED — the normal operator upsert path
-- (saveWhiteSheetCashEntry) remains available. A present row with
-- finalized_at IS NOT NULL is FINALIZED — the normal upsert path must reject
-- further writes; only an explicit privileged reopen (audited below) clears
-- finalized_at back to NULL.

ALTER TABLE public.digital_white_sheet_cash_entries
  ADD COLUMN finalized_at timestamptz,
  ADD COLUMN finalized_by text;

CREATE TABLE public.white_sheet_lifecycle_events (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                text        NOT NULL,
  market_label_normalized  text        NOT NULL,
  business_date            date        NOT NULL,
  event                    text        NOT NULL CHECK (event IN ('finalized', 'reopened')),
  actor                    text        NOT NULL,
  reason                   text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.white_sheet_lifecycle_events IS
  'Append-only audit trail for White Sheet FINALIZED/reopen transitions (BR-06). Never updated or deleted.';

CREATE INDEX white_sheet_lifecycle_events_identity_idx
  ON public.white_sheet_lifecycle_events (source_id, market_label_normalized, business_date, created_at);
