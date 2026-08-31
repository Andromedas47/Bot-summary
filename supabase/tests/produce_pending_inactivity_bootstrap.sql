-- Adapter fixture: the columns 20260829090000_produce_pending_inactivity_lifecycle.sql
-- preflights on that are not already supplied by produce_pending_lifecycle_bootstrap.sql
-- (finalization_started_at, finalize_hold_until — added in Production by 0034/0050,
-- neither of which this disposable-DB harness applies in full).
--
-- Apply order: round_market_identity_bootstrap.sql, produce_pending_lifecycle_bootstrap.sql,
-- THIS, [optionally 20260817090200 + 20260817090300 for close-recovery/supersession
-- parity tests], then 20260829090000_produce_pending_inactivity_lifecycle.sql.
--
-- Disposable test databases only. Never run against Production.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS finalization_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalize_hold_until     timestamptz;
