-- Data Quality Inbox — one table holding every back-office data-quality
-- exception (operational/system anomalies), separate from the LINE reports
-- operators already receive. Additive only: no existing table is touched.
--
-- Design (see src/lib/data-quality/*):
--   * issue_key is the DEDUPLICATION identity — a deterministic function of
--     (category, business_date, sorted affected entity ids). The nightly scan
--     upserts on this key so the same underlying problem is always ONE row,
--     never a fresh row every morning.
--   * severity is CRITICAL / ACTION_REQUIRED / ADVISORY only. NORMAL-severity
--     findings are never written here at all (src/lib/data-quality/severity.ts
--     decides "no user-facing notification" by never producing a candidate
--     that reaches this table).
--   * status is OPEN / RESOLVED / IGNORED. resolved_at/resolved_by/
--     resolution_note are the generic "left OPEN" metadata — populated for
--     BOTH a Resolve and an Ignore action (see inbox.ts planResolve/planIgnore),
--     and cleared again if a RESOLVED issue's key recurs (reopen).
--   * technical_context is free-form JSON for the admin detail view and must
--     never contain secrets, tokens, or raw credentials — enforced by
--     application code (src/lib/data-quality/inbox.ts), not by the database.
BEGIN;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'data_quality_issues'
  ) THEN
    RAISE EXCEPTION 'data_quality_issues already applied: table already exists';
  END IF;
END;
$preflight$;

CREATE TABLE public.data_quality_issues (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable dedup identity. See buildIssueKey() — never assigned by hand.
  issue_key          text          NOT NULL UNIQUE CHECK (length(btrim(issue_key)) > 0),
  category           text          NOT NULL CHECK (length(btrim(category)) > 0),
  severity           text          NOT NULL CHECK (severity IN ('CRITICAL', 'ACTION_REQUIRED', 'ADVISORY')),
  business_date      date          NOT NULL,

  -- Entity identifiers this occurrence is about (round ids, session ids,
  -- product keys, ...). Free-form strings, sorted by the application.
  affected_refs      jsonb         NOT NULL DEFAULT '[]'::jsonb,

  -- Operator-safe Thai summary shown on the admin list without drilling in.
  summary_th         text          NOT NULL CHECK (length(btrim(summary_th)) > 0),

  -- Machine detail for the admin detail view. Never secrets/tokens/credentials
  -- (enforced in application code, see src/lib/data-quality/inbox.ts).
  technical_context  jsonb         NOT NULL DEFAULT '{}'::jsonb,

  status             text          NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED')),

  first_seen         timestamptz   NOT NULL DEFAULT now(),
  last_seen          timestamptz   NOT NULL DEFAULT now(),

  -- Populated together whenever status leaves OPEN (Resolve or Ignore);
  -- cleared together on reopen. Never partially set.
  resolved_at        timestamptz,
  resolved_by        text,
  resolution_note    text,

  created_at         timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT data_quality_issues_resolution_matches_status
    CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);

CREATE INDEX data_quality_issues_status_idx        ON public.data_quality_issues (status);
CREATE INDEX data_quality_issues_business_date_idx  ON public.data_quality_issues (business_date);
CREATE INDEX data_quality_issues_severity_idx       ON public.data_quality_issues (severity);
CREATE INDEX data_quality_issues_status_date_idx    ON public.data_quality_issues (status, business_date DESC);

-- ── Access ────────────────────────────────────────────────────────────────
-- Production carries broad default ACLs, so REVOKE precedes every GRANT.
-- Only the service-role backend reads/writes this table today (the admin
-- surface uses createServiceClient(), same as every other /admin page in
-- this repo — see src/lib/auth/admin.ts for the session-level admin gate
-- enforced at the application layer for mutations).
ALTER TABLE public.data_quality_issues ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.data_quality_issues FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.data_quality_issues TO service_role;

DO $postflight$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'data_quality_issues'
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'data_quality_issues postflight failed: table missing after create';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'data_quality_issues_status_idx'
  ) THEN
    RAISE EXCEPTION 'data_quality_issues postflight failed: status index missing';
  END IF;
END;
$postflight$;

COMMIT;
