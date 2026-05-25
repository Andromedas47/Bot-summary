-- Migration 0003 — Drop weigh_entries table
-- This table was scaffolded for a personal weight-tracker use case
-- that was never implemented. The active feature is produce_sessions
-- (migration 0002). Removing to keep the schema clean.

DROP TABLE IF EXISTS public.weigh_entries CASCADE;
