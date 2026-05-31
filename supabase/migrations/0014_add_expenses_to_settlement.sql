ALTER TABLE public.settlement_entries
  ADD COLUMN expenses NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.settlement_entries.expenses IS
  'Expenses deducted from the seller''s remittance. Included in ยอดขาย: โอน + สด + ค่าใช้จ่าย = ยอดขาย.';
