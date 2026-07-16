-- Read-only schema audit. Run before and after applying migration 0037 in a
-- non-production environment. This file never mutates data.
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
  AND routine_name IN ('request_transaction_correction',
    'approve_transaction_correction', 'reject_transaction_correction',
    'is_transaction_correction_approver',
    'build_trusted_raw_transaction_snapshot',
    'canonicalize_transaction_correction_changes',
    'is_valid_transaction_correction_snapshot',
    'is_valid_transaction_correction_after_snapshot',
    'safe_transaction_correction_numeric')
ORDER BY routine_name;

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'transaction_corrections'
  AND grantee IN ('anon', 'authenticated')
ORDER BY grantee, privilege_type;

SELECT grantee, routine_name, privilege_type
FROM information_schema.role_routine_grants
WHERE specific_schema = 'public'
  AND routine_name IN ('request_transaction_correction',
    'approve_transaction_correction', 'reject_transaction_correction')
ORDER BY routine_name, grantee;

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.transaction_corrections'::regclass
ORDER BY conname;

SELECT trigger_name, event_manipulation, action_timing, action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table = 'transaction_corrections'
ORDER BY trigger_name, event_manipulation;
