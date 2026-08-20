-- F-4: generation-scoped ledger ownership for the pending-produce ingest and
-- admission ledgers.
--
-- Forward-only. No existing migration is modified. No ledger row is deleted by
-- this migration; every (session_key, session_generation) pair that already
-- has ingest or admission evidence is backfilled into a new registry BEFORE
-- the new constraint is validated, so zero orphans are created.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The defect (read-only production evidence, apjjsqibavjaitcedavn, 2026-08-20)
-- ─────────────────────────────────────────────────────────────────────────────
-- pending_session_ingest     PRIMARY KEY (session_generation, line_event_id)
--                            FOREIGN KEY (session_key) REFERENCES
--                              pending_sessions(session_key) ON DELETE CASCADE
-- pending_session_admission  same shape.
--
-- pending_sessions holds exactly ONE row per session_key (UNIQUE(session_key)).
-- session_generation is mutated IN PLACE on that one row every time a
-- generation rotates (open_pending_plain_text_generation,
-- PendingSessionService.replaceGeneration) — it is never append-only. The
-- ingest/admission tables, by contrast, accumulate one row per LINE event
-- across EVERY generation a session_key has ever had. Production proof: of
-- 32,872 pending_session_ingest rows, 32,144 (97.8%) do not match the CURRENT
-- generation recorded on their session_key's pending_sessions row — that is
-- expected, not corruption; it is the historical ledger doing its job.
--
-- Because the two ledger tables' ONLY ownership key is session_key, deleting
-- the single pending_sessions row for a session_key cascades to EVERY
-- generation's ledger rows for that key, not just the one being acted on.
--
-- This is not theoretical. `PendingSessionService.deleteGeneration` in
-- src/lib/line/pending-session-service.ts (called from the catch block of
-- `replaceGeneration`, i.e. whenever the ingest/admission insert for a
-- freshly-rotated generation fails) issues:
--   DELETE FROM pending_sessions WHERE session_key = $1 AND session_generation = $2
-- The WHERE clause is correctly scoped to one generation, but because the
-- table-level CASCADE is keyed on session_key alone, it deletes ingest/
-- admission evidence for every OTHER generation of that key too — the exact
-- opposite of what the method name promises. `PendingSessionService.delete`
-- (a full-key purge) is unreachable dead code today, but its correctness
-- depends on the same FK and is intentionally left with full-purge semantics
-- (see below).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the fix is NOT "add session_generation to the existing FK"
-- ─────────────────────────────────────────────────────────────────────────────
-- pending_sessions has only ONE row per session_key, so it can never be the
-- referenced side of a composite (session_key, session_generation) foreign
-- key: as soon as a generation rotates, the OLD (session_key, generation)
-- tuple stops existing in pending_sessions (the row was UPDATEd, not
-- inserted), which would either reject the rotation outright (default
-- ON UPDATE NO ACTION) or silently corrupt history (ON UPDATE CASCADE
-- rewriting old ledger rows to the new generation). Confirmed empirically:
-- 32,144 of 32,872 ingest rows already reference a (session_key, generation)
-- pair that pending_sessions' CURRENT row no longer carries. A composite FK
-- straight into pending_sessions is not merely unsafe on 32,872 live rows —
-- it is the wrong parent, full stop.
--
-- The fix instead introduces an APPEND-ONLY registry, `pending_session_generations`,
-- of every generation a session_key has ever had. It is the parent the ledger
-- tables reference by composite key. Its own relationship to pending_sessions
-- stays keyed on session_key ON DELETE CASCADE — identical to today's
-- contract — so a genuine full-key purge (`PendingSessionService.delete`,
-- still unreachable, still intentional) continues to wipe every generation,
-- exactly as it does now. What changes is that deleting ONE registry row
-- (one generation) now cascades to ONLY that generation's ledger rows.
--
-- `PendingSessionService.deleteGeneration` is updated in the same PR to target
-- `pending_session_generations` instead of `pending_sessions`, which is what
-- actually closes the defect end-to-end — see the mixed-version note in the
-- PR body: the schema change alone does not fix the reachable bug until the
-- app-code change ships too.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Lock behaviour (32,872-row ingest table, 32,872-row admission table, 64-row
-- pending_sessions parent, all measured 2026-08-20)
-- ─────────────────────────────────────────────────────────────────────────────
--   1. CREATE TABLE pending_session_generations: new table, no lock on any
--      existing table.
--   2. Backfill INSERT ... SELECT ... UNION ... ON CONFLICT DO NOTHING: takes
--      ROW SHARE on the three source tables (readers), ROW EXCLUSIVE on the
--      new table. Does not block concurrent readers or writers of
--      pending_sessions/ingest/admission. At 32,872 rows this is a sub-second
--      scan; there is no plausible reason for this to be slow at current
--      production scale.
--   3. DROP CONSTRAINT / ADD CONSTRAINT ... NOT VALID on ingest/admission:
--      briefly takes SHARE ROW EXCLUSIVE on the child table (blocks
--      concurrent writers, not readers) for the metadata change only — no row
--      scan happens here.
--   4. VALIDATE CONSTRAINT: takes SHARE UPDATE EXCLUSIVE, which does NOT block
--      concurrent INSERT/UPDATE/DELETE on the table, only concurrent DDL. It
--      scans the full 32,872-row table to prove no violation exists.
--   IMPORTANT: steps 3-4 only get the "writes stay unblocked during the scan"
--   benefit if VALIDATE CONSTRAINT runs in a SEPARATE transaction from ADD
--   CONSTRAINT ... NOT VALID. If this file is applied by tooling that wraps
--   the whole migration in one transaction, the SHARE ROW EXCLUSIVE lock from
--   step 3 is held until COMMIT, so step 4's scan effectively blocks writers
--   for its duration too. At 32,872 rows that scan is expected to complete in
--   well under a second, so the practical exposure is small either way, but
--   this is stated explicitly per program instructions rather than assumed
--   away. If applying to production under sustained write load, consider
--   splitting steps 3-4 into their own non-transactional `psql` invocations.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotency
-- ─────────────────────────────────────────────────────────────────────────────
-- Every DDL statement is guarded (IF NOT EXISTS / IF EXISTS / catalog check
-- before ADD CONSTRAINT / CREATE OR REPLACE / DROP TRIGGER IF EXISTS then
-- CREATE). Re-applying this file in full is a no-op the second time.
--
-- Disposable test proof: src/lib/produce/migration-generation-scoped-ledger.pg.test.ts
-- (guarded by ALLOW_DISPOSABLE_POSTGRES_TESTS=1).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Append-only generation registry.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pending_session_generations (
  session_key        text NOT NULL,
  session_generation uuid NOT NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_key, session_generation),
  CONSTRAINT pending_session_generations_session_key_fkey
    FOREIGN KEY (session_key) REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE
);

ALTER TABLE public.pending_session_generations ENABLE ROW LEVEL SECURITY;

-- Explicitly no anon/authenticated grants and no policies: this is internal
-- bookkeeping for server-side (service_role) writers only, matching the
-- default-deny posture already in force on pending_sessions,
-- pending_session_ingest and pending_session_admission.
REVOKE ALL ON public.pending_session_generations FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Backfill every generation that already has ledger evidence or a current
--    pending_sessions row, so the composite FK below creates zero orphans.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.pending_session_generations (session_key, session_generation)
SELECT session_key, session_generation FROM public.pending_sessions
UNION
SELECT session_key, session_generation FROM public.pending_session_ingest
UNION
SELECT session_key, session_generation FROM public.pending_session_admission
ON CONFLICT (session_key, session_generation) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Auto-register a generation the moment it first writes a ledger row, so
--    no future INSERT can ever create an orphan regardless of which RPC or
--    application code path performs it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_pending_session_generation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.pending_session_generations (session_key, session_generation)
  VALUES (NEW.session_key, NEW.session_generation)
  ON CONFLICT (session_key, session_generation) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pending_session_ingest_register_generation
  ON public.pending_session_ingest;
CREATE TRIGGER pending_session_ingest_register_generation
  BEFORE INSERT ON public.pending_session_ingest
  FOR EACH ROW EXECUTE FUNCTION public.register_pending_session_generation();

DROP TRIGGER IF EXISTS pending_session_admission_register_generation
  ON public.pending_session_admission;
CREATE TRIGGER pending_session_admission_register_generation
  BEFORE INSERT ON public.pending_session_admission
  FOR EACH ROW EXECUTE FUNCTION public.register_pending_session_generation();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Redirect ownership: drop the session_key-only FK, add a
--    (session_key, session_generation) composite FK against the registry.
--    NOT VALID + VALIDATE CONSTRAINT — see the lock-behaviour note above for
--    what this does and does not buy when run inside a single transaction.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pending_session_ingest
  DROP CONSTRAINT IF EXISTS pending_session_ingest_session_key_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_session_ingest_generation_fkey'
      AND conrelid = 'public.pending_session_ingest'::regclass
  ) THEN
    ALTER TABLE public.pending_session_ingest
      ADD CONSTRAINT pending_session_ingest_generation_fkey
      FOREIGN KEY (session_key, session_generation)
      REFERENCES public.pending_session_generations (session_key, session_generation)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;
ALTER TABLE public.pending_session_ingest
  VALIDATE CONSTRAINT pending_session_ingest_generation_fkey;

ALTER TABLE public.pending_session_admission
  DROP CONSTRAINT IF EXISTS pending_session_admission_session_key_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_session_admission_generation_fkey'
      AND conrelid = 'public.pending_session_admission'::regclass
  ) THEN
    ALTER TABLE public.pending_session_admission
      ADD CONSTRAINT pending_session_admission_generation_fkey
      FOREIGN KEY (session_key, session_generation)
      REFERENCES public.pending_session_generations (session_key, session_generation)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;
ALTER TABLE public.pending_session_admission
  VALIDATE CONSTRAINT pending_session_admission_generation_fkey;
