ALTER TABLE public.settlement_entries
  ADD COLUMN IF NOT EXISTS labor NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.settlement_entries.labor IS
  'Labor deducted from cash remittance. Included in sales reconciliation: transfer + cash + expenses + labor.';
