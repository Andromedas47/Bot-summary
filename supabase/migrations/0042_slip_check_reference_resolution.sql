-- Manual reference-ID resolution audit (BR-02).
--
-- An accepted slip_checks row with a NULL reference_id cannot contribute to
-- verifiedTransfers (see src/lib/reconciliation.ts
-- aggregateGloballyAcceptedVerifiedTransfers) until an authorized reviewer
-- supplies a reference id (src/lib/slips/reference-resolution.ts). Resolution
-- only writes slip_checks.reference_id — it never bypasses or duplicates the
-- existing global reference-winner dedupe (resolveGloballyAcceptedCheckIds);
-- the newly-referenced check is picked up by that SAME logic on next load.
--
-- This table is an append-only audit trail: one row per resolution action.

CREATE TABLE public.slip_check_reference_resolutions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id     uuid        NOT NULL REFERENCES public.slip_checks(id),
  reference_id text        NOT NULL,
  actor        text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.slip_check_reference_resolutions IS
  'Append-only audit trail of manual reference-ID resolutions for slip_checks (BR-02). Never updated or deleted.';

CREATE INDEX slip_check_reference_resolutions_check_id_idx
  ON public.slip_check_reference_resolutions (check_id, created_at);
