-- ═══════════════════════════════════════════════════════════════════
-- Migration 0004 — Performance indexes
-- ═══════════════════════════════════════════════════════════════════

-- raw_messages: composite index for is_processed filter + created_at sort
-- Covers: WHERE is_processed = true/false ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_raw_messages_processed_created
  ON public.raw_messages (is_processed, created_at DESC);

-- produce_sessions: ORDER BY created_at DESC (used on every page load)
CREATE INDEX IF NOT EXISTS idx_produce_sessions_created_at
  ON public.produce_sessions (created_at DESC);

-- produce_sessions: partial index for "sessions with errors" filter
CREATE INDEX IF NOT EXISTS idx_produce_sessions_has_errors
  ON public.produce_sessions (created_at DESC)
  WHERE parser_errors IS NOT NULL;
