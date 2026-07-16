-- Read-only schema audit. Run before applying migration 0037.
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('produce_items', 'produce_sessions', 'produce_transactions',
    'effective_produce_transactions', 'transaction_corrections')
ORDER BY table_name;

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('produce_items', 'produce_sessions', 'transaction_corrections')
ORDER BY table_name, ordinal_position;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'transaction_corrections'
ORDER BY policyname;

SELECT routine_schema, routine_name, security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('approve_transaction_correction',
    'reject_transaction_correction', 'is_transaction_correction_approver')
ORDER BY routine_name;
