-- Staging/local-only psql smoke test for migration 0037.
-- Prerequisites: migration applied in a disposable database, two existing
-- auth.users rows (requester and explicit approver), and one editable target.
-- Replace values before running. Every data change is rolled back at the end.
\set requester_id '11111111-1111-4111-8111-111111111111'
\set approver_id  '22222222-2222-4222-8222-222222222222'
\set target_id    '33333333-3333-4333-8333-333333333333'

\set ON_ERROR_STOP on
BEGIN;

-- Capture the effective amount before any request.
SELECT id, total_amount AS effective_total_before
FROM public.effective_produce_transactions
WHERE id = :'target_id'::uuid;

-- 1. An authenticated caller cannot insert a correction directly.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'requester_id', true);
SAVEPOINT malicious_direct_insert;
\set ON_ERROR_STOP off
INSERT INTO public.transaction_corrections DEFAULT VALUES;
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT malicious_direct_insert;

-- 2. JSON strings and non-finite textual values cannot reach a stored request.
SAVEPOINT malformed_price_quantity_text;
\set ON_ERROR_STOP off
SELECT public.request_transaction_correction(
  :'target_id'::uuid, 'wrong_price', 'malformed price quantity string',
  '{"priceQuantity":"x"}'::jsonb, gen_random_uuid(), NULL, NULL
);
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT malformed_price_quantity_text;

SAVEPOINT numeric_string;
\set ON_ERROR_STOP off
SELECT public.request_transaction_correction(
  :'target_id'::uuid, 'wrong_price', 'numeric value encoded as string',
  '{"priceQuantity":"109"}'::jsonb, gen_random_uuid(), NULL, NULL
);
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT numeric_string;

SAVEPOINT malformed_quantity;
\set ON_ERROR_STOP off
SELECT public.request_transaction_correction(
  :'target_id'::uuid, 'wrong_quantity', 'quantity null must fail',
  '{"quantity":null}'::jsonb, gen_random_uuid(), NULL, NULL
);
SELECT public.request_transaction_correction(
  :'target_id'::uuid, 'wrong_quantity', 'quantity NaN text must fail',
  jsonb_build_object('quantity', to_jsonb('NaN'::float8)),
  gen_random_uuid(), NULL, NULL
);
SELECT public.request_transaction_correction(
  :'target_id'::uuid, 'wrong_quantity', 'quantity Infinity text must fail',
  jsonb_build_object('quantity', to_jsonb('Infinity'::float8)),
  gen_random_uuid(), NULL, NULL
);
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT malformed_quantity;

-- 3. Create one valid request. The database owns actor, clock and snapshots.
SELECT (request_row).* FROM public.request_transaction_correction(
  :'target_id'::uuid,
  'wrong_price',
  'staging smoke correction',
  '{"priceAmount":109,"priceQuantity":1}'::jsonb,
  '44444444-4444-4444-8444-444444444444'::uuid,
  NULL,
  'https://example.test/evidence'
) AS request_row
\gset correction_

SELECT
  id,
  requested_by = :'requester_id'::uuid AS actor_is_auth_uid,
  requested_at = created_at AS database_owned_request_clock,
  before_snapshot = public.build_trusted_raw_transaction_snapshot(
    :'target_id'::uuid
  ) AS before_matches_raw,
  jsonb_typeof(after_snapshot->'priceAmount') AS price_amount_json_type,
  (after_snapshot->>'totalAmount')::numeric AS recomputed_total
FROM public.transaction_corrections
WHERE id = :'correction_id'::uuid;

-- Same key returns the same row, not a second request.
SELECT id = :'correction_id'::uuid AS idempotent_request
FROM public.request_transaction_correction(
  :'target_id'::uuid,
  'wrong_price',
  'staging smoke correction',
  '{"priceAmount":109,"priceQuantity":1}'::jsonb,
  '44444444-4444-4444-8444-444444444444'::uuid,
  NULL,
  'https://example.test/evidence'
);

-- Pending correction does not change the effective total.
SELECT id, total_amount AS effective_total_while_pending
FROM public.effective_produce_transactions
WHERE id = :'target_id'::uuid;

-- 4. Direct timestamp/actor mutation is denied.
SAVEPOINT fake_audit_timestamp;
\set ON_ERROR_STOP off
UPDATE public.transaction_corrections
SET requested_at = '1999-01-01 00:00:00+00',
    requested_by = :'approver_id'::uuid
WHERE id = :'correction_id'::uuid;
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT fake_audit_timestamp;

-- 5. The requester cannot approve.
SAVEPOINT unauthorized_approval;
\set ON_ERROR_STOP off
SELECT public.approve_transaction_correction(
  :'correction_id'::uuid, :'correction_target_version'
);
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT unauthorized_approval;

-- 6. An explicit approver still cannot approve a stale version.
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'approver_id', true);
SAVEPOINT stale_approval;
\set ON_ERROR_STOP off
SELECT public.approve_transaction_correction(
  :'correction_id'::uuid, 'raw:stale-version'
);
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT stale_approval;

-- 7. Valid approval succeeds and duplicate approval is idempotent.
SELECT (approved).* FROM public.approve_transaction_correction(
  :'correction_id'::uuid, :'correction_target_version'
) AS approved;
SELECT id = :'correction_id'::uuid AS duplicate_approval_is_idempotent
FROM public.approve_transaction_correction(
  :'correction_id'::uuid, :'correction_target_version'
);

SELECT id, total_amount AS effective_total_after_approval,
  correction_id, is_corrected
FROM public.effective_produce_transactions
WHERE id = :'target_id'::uuid;

-- 8. Approved snapshots and audit actors remain immutable.
SAVEPOINT immutable_approved_snapshot;
RESET ROLE;
\set ON_ERROR_STOP off
UPDATE public.transaction_corrections
SET after_snapshot = jsonb_set(after_snapshot, '{totalAmount}', '1'::jsonb),
    approved_at = '1999-01-01 00:00:00+00'
WHERE id = :'correction_id'::uuid;
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT immutable_approved_snapshot;

ROLLBACK;
\echo 'Smoke test finished; review every expected error and boolean result above.'
