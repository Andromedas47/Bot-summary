-- Read-only preflight for applying V2 Work Round migrations.
-- Do not run repair/backfill SQL here. Any row with ok = false is a stop condition.

-- Safe apply order:
-- 1. Confirm 0029_settlement_finalizations exists. Stop if missing.
-- 2. Confirm 0030 manual slip market/session prerequisites exist. Stop if missing.
-- 3. Apply 0031 through 0040 in numeric order only.
-- 4. Stop before 0040 if duplicate checks below return any rows.

WITH required_tables(name) AS (
  VALUES
    ('public.raw_messages'),
    ('public.produce_sessions'),
    ('public.produce_items'),
    ('public.slip_batches'),
    ('public.manual_slip_sessions'),
    ('public.manual_slip_entries'),
    ('public.settlement_entries'),
    ('public.transfer_reconciliations'),
    ('public.settlement_finalizations'),
    ('public.slip_evidences'),
    ('public.work_rounds'),
    ('public.settlement_drafts'),
    ('public.settlement_draft_history'),
    ('public.work_round_selections')
)
SELECT 'required_tables' AS check_name,
       bool_and(to_regclass(name) IS NOT NULL) AS ok,
       array_agg(name) FILTER (WHERE to_regclass(name) IS NULL) AS missing
FROM required_tables;

WITH required_columns(table_name, column_name) AS (
  VALUES
    ('produce_sessions', 'work_round_id'),
    ('produce_sessions', 'is_append_session'),
    ('slip_batches', 'work_round_id'),
    ('manual_slip_sessions', 'work_round_id'),
    ('manual_slip_sessions', 'market_key'),
    ('transfer_reconciliations', 'work_round_id'),
    ('settlement_finalizations', 'work_round_id'),
    ('slip_evidences', 'work_round_id'),
    ('settlement_drafts', 'declared_by_line_user_id'),
    ('settlement_drafts', 'approved_by'),
    ('settlement_drafts', 'approved_at'),
    ('work_round_selections', 'resolved_work_round_id')
)
SELECT 'required_columns' AS check_name,
       bool_and(c.column_name IS NOT NULL) AS ok,
       array_agg(rc.table_name || '.' || rc.column_name) FILTER (WHERE c.column_name IS NULL) AS missing
FROM required_columns rc
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = rc.table_name
 AND c.column_name = rc.column_name;

SELECT 'settlement_finalizations_0029_retry_key' AS check_name,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'settlement_finalizations'
           AND column_name = 'line_retry_key'
       ) AS ok;

SELECT 'old_work_round_statuses' AS check_name, count(*) AS count
FROM public.work_rounds
WHERE status = 'awaiting_evidence';

SELECT 'old_settlement_draft_statuses' AS check_name, count(*) AS count
FROM public.settlement_drafts
WHERE status = 'awaiting_evidence';

SELECT 'duplicate_active_settlement_drafts' AS check_name,
       work_round_id,
       count(*) AS count
FROM public.settlement_drafts
WHERE status IN ('pending', 'declared', 'submitted', 'variance_found', 'ready_for_review', 'needs_correction')
GROUP BY work_round_id
HAVING count(*) > 1;

SELECT 'duplicate_legacy_transfer_reconciliations' AS check_name,
       source_id,
       business_date,
       count(*) AS count
FROM public.transfer_reconciliations
WHERE work_round_id IS NULL
GROUP BY source_id, business_date
HAVING count(*) > 1;

SELECT 'duplicate_work_round_transfer_reconciliations' AS check_name,
       work_round_id,
       count(*) AS count
FROM public.transfer_reconciliations
WHERE work_round_id IS NOT NULL
GROUP BY work_round_id
HAVING count(*) > 1;

SELECT 'duplicate_legacy_settlement_finalizations' AS check_name,
       source_id,
       business_date,
       count(*) AS count
FROM public.settlement_finalizations
WHERE work_round_id IS NULL
GROUP BY source_id, business_date
HAVING count(*) > 1;

SELECT 'duplicate_work_round_settlement_finalizations' AS check_name,
       work_round_id,
       count(*) AS count
FROM public.settlement_finalizations
WHERE work_round_id IS NOT NULL
GROUP BY work_round_id
HAVING count(*) > 1;

SELECT 'new_claim_work_round_selection_rpc' AS check_name,
       to_regprocedure('public.claim_work_round_selection(uuid,text,text,integer,text[])') IS NOT NULL AS ok;

SELECT 'old_claim_work_round_selection_rpc_removed' AS check_name,
       to_regprocedure('public.claim_work_round_selection(uuid,text,text,integer)') IS NULL AS ok;

SELECT 'required_indexes' AS check_name,
       bool_and(to_regclass(idx) IS NOT NULL) AS ok,
       array_agg(idx) FILTER (WHERE to_regclass(idx) IS NULL) AS missing
FROM (VALUES
  ('public.work_rounds_source_date_idx'),
  ('public.work_rounds_status_idx'),
  ('public.produce_sessions_work_round_id_idx'),
  ('public.slip_batches_work_round_id_idx'),
  ('public.manual_slip_sessions_work_round_id_idx'),
  ('public.settlement_drafts_work_round_id_idx'),
  ('public.work_round_selections_active_idx'),
  ('public.transfer_reconciliations_legacy_source_date_key'),
  ('public.transfer_reconciliations_work_round_key'),
  ('public.settlement_finalizations_legacy_source_date_key'),
  ('public.settlement_finalizations_work_round_key'),
  ('public.settlement_drafts_active_work_round_key')
) AS v(idx);

SELECT 'rls_enabled_for_v2_tables' AS check_name,
       bool_and(c.relrowsecurity) AS ok,
       array_agg(c.relname) FILTER (WHERE NOT c.relrowsecurity) AS rls_disabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('work_rounds', 'settlement_drafts', 'settlement_draft_history', 'work_round_selections');
