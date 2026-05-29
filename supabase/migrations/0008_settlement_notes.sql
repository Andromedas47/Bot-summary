ALTER TABLE public.settlement_entries
  ADD COLUMN notes TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN public.settlement_entries.notes IS
  'Optional remark entered on the Settlement Entry form.';
