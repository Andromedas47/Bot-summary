-- Add source_id to settlement_entries for reconciliation audit trail.
-- Nullable for backward compatibility with existing rows.

ALTER TABLE public.settlement_entries ADD COLUMN source_id text;
