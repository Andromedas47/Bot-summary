-- P2C Inventory Movement Ledger — authoritative append-only QUANTITY ledger.
--
-- Slice C only: locations + movement headers + signed movement lines + the P2B
-- purchase-receipt posting adapter + reversal + balance read model.
--
-- Does NOT implement valuation, landed cost, FIFO/average costing, or COGS.
--   Those are P2D / migration 0054. This migration deliberately creates NO
--   column, table, view or function carrying a monetary value. A test asserts it.
-- Does NOT wire LINE webhooks or any UX.
-- Does NOT implement the Produce or P2A physical-count adapters. Their boundary
--   is documented below so a later migration can add them without reshaping the
--   ledger.
-- Does NOT modify anything created by 0047 (physical inventory), 0051 (guided
--   menu) or 0052 (purchase receipts). 0053 is purely additive.
--
-- Migration id 0053: origin/main highest is 0052 (P2B, merged). 0054 is reserved
-- for P2D valuation. 0055 is reserved by feat/guided-menu-seller-market-catalog-0055
-- and is NOT touched here.
--
-- Requires 0052: this migration calls get_purchase_receipt_confirmation() and
-- lock_purchase_receipt_for_posting(), and reads purchase_receipts.
--
--
-- ─── Why a signed ledger, and what "authoritative" means ────────────────────
--
-- Stock on hand is NEVER stored as a mutable balance column. It is always
--   SUM(signed_quantity) over inventory_movement_lines
-- grouped by (location_code, product_key, unit_key). A stored balance is a
-- second source of truth that drifts the first time a write is lost, retried or
-- partially applied; a derived sum cannot drift because there is nothing for it
-- to disagree with.
--
-- Sign convention, applied without exception:
--     signed_quantity > 0   stock ENTERS the location
--     signed_quantity < 0   stock LEAVES the location
-- Zero is rejected: a line that moves nothing is not evidence of anything, it is
-- a bug that would otherwise sit in the ledger looking intentional.
--
-- A NEGATIVE balance is legal and is deliberately not constrained away. A count
-- or an issue can legitimately drive a product below zero when an earlier
-- receipt was never captured; refusing to represent that would not make the
-- stock exist, it would only move the error somewhere harder to find. Negative
-- balances are a reporting signal, not a schema violation.
--
-- A transfer between two locations is therefore ONE movement carrying TWO lines
-- (negative at the origin, positive at the destination), not two movements. No
-- transfer adapter exists in 0053, but the line model already admits it, so
-- adding one needs no schema change.
--
--
-- ─── Movement types in v1 ───────────────────────────────────────────────────
--
--   PURCHASE_RECEIPT  a confirmed, unblocked P2B purchase document entering MAIN
--   REVERSAL          the exact negative of one earlier movement
--
-- The CHECK list is deliberately CLOSED to these two. Every future adapter
-- (produce issue, physical-count adjustment, sale issue, transfer) must widen it
-- in its own migration alongside the adapter that writes it. An open-ended type
-- column would let an unreviewed caller invent a movement class that no balance
-- consumer knows how to interpret — fail closed is cheaper than fail silent.
--
--
-- ─── Idempotency and source binding ─────────────────────────────────────────
--
-- Every movement carries a globally unique deterministic dedupe_key. For a
-- purchase receipt it is the EXACT frozen key P2B issues:
--     purchase-receipt-confirmation:v1:{receipt_id}:{confirmation_hash}
-- 0053 reads that string from get_purchase_receipt_confirmation() and NEVER
-- recomputes or reinterprets the hash. If P2B ever changes how it hashes, this
-- migration inherits the change instead of silently diverging from it.
--
-- Two distinct protections, doing two distinct jobs:
--
--   UNIQUE (dedupe_key)
--     Replay protection. Re-posting the SAME confirmed content returns the
--     original movement with replayed=true and writes nothing.
--     A key match is necessary but NOT sufficient: before reporting a replay the
--     adapter re-verifies the whole source binding (movement_type, source_system,
--     source_document_type/id/version) and the P2B posting lock against the
--     frozen contract. A dedupe key is an index into the ledger, not a proof of
--     what it points at.
--
--   inventory_movements_source_posting_uidx
--     Source-identity protection. A source document gets AT MOST ONE posting
--     movement, ever. A different payload/hash arriving for a receipt that is
--     already posted therefore FAILS CLOSED rather than double-counting stock
--     under a new dedupe key. Reversals are excluded from this index because
--     they intentionally share their original's source document.
--
--
-- ─── Append-only ────────────────────────────────────────────────────────────
--
-- Enforced in PostgreSQL by triggers, not merely by the TypeScript client:
--   * movement lines   UPDATE and DELETE always rejected
--   * movement headers DELETE always rejected; UPDATE rejected except the single
--     transition reversed_by_movement_id NULL -> value, which is how a reversal
--     links itself back to its original. Every other column, including a second
--     write to reversed_by_movement_id, is rejected — and even that one
--     transition must point at a real REVERSAL row that points back
--   * declared line_count is verified against the actual lines by a DEFERRED
--     constraint trigger, so a header can never reach commit with the wrong
--     number of lines — in particular never with zero
--   * a movement's line set is SEALED by that same immutable line_count: a
--     second DEFERRED trigger on the lines re-checks the invariant, so a later
--     transaction cannot append a line to a movement that already committed.
--     See the soundness argument above the trigger — it rests only on
--     line_count being immutable and lines being undeletable, with no appeal to
--     timestamps or transaction ids.
-- Corrections are expressed as a NEW reversing movement. Nothing is edited.
--
--
-- ─── Reversal contract (v1, deliberately narrow) ────────────────────────────
--
--   * a movement may be reversed AT MOST ONCE — enforced by
--     UNIQUE (reversal_of_movement_id) plus the header back-link, so two
--     concurrent reversal attempts cannot both succeed even if row locking were
--     somehow bypassed
--   * a REVERSAL may NOT itself be reversed — rejected by trigger and by the
--     RPC. Re-posting after a reversal is a new source document with a new
--     dedupe key, which is an auditable act; "un-reversing" is not
--   * reversal lines are exact negatives: same product_key, unit_key,
--     location_code, source_line_id and line_ordinal, quantity * -1, so a
--     reversal line pairs 1:1 with the line it undoes
--   * idempotent on an explicit caller-supplied reversal key; the SAME key
--     replays, a DIFFERENT key against an already-reversed movement fails closed
--
--
-- ─── P2B atomicity ──────────────────────────────────────────────────────────
--
-- post_purchase_receipt_inventory_movement() is ONE plpgsql function with NO
-- exception handler, and therefore runs in ONE transaction that either commits
-- whole or aborts whole. It writes the movement, writes its lines, and calls
-- lock_purchase_receipt_for_posting() before returning. There is no interleaving
-- point at which movements exist without the P2B posting lock, or the lock
-- exists without movements — any failure at any step rolls back both. The
-- receipt row is taken FOR UPDATE first, so concurrent posting attempts against
-- one receipt serialize and exactly one movement is created.
--
-- The deliberate absence of an EXCEPTION block matters: a BEGIN ... EXCEPTION
-- block would open a subtransaction and could swallow a failure, leaving one
-- half of that pair committed. Failures here must propagate.
--
-- lock_purchase_receipt_for_posting() is NOT trusted to establish ownership.
-- 0052 treats ANY pre-existing lock as an idempotent replay and never inspects
-- posting_locked_by, so it reports success for a lock held by a different
-- writer. The adapter therefore brackets the call:
--   * BEFORE inserting anything on the fresh path, it rejects a receipt that
--     already carries any lock — foreign owner, orphan p2c lock with no
--     movement behind it, or a half-written lock. An orphan is never adopted or
--     repaired; a fresh post writes the movement and its lock together or not
--     at all.
--   * AFTER calling the helper, it re-reads the receipt row and asserts
--     posting_locked_at IS NOT NULL AND posting_locked_by = 'p2c-inventory-ledger'.
--     The helper's return value proves nothing; only the row does.
-- Both checks raise, so the movement and lines roll back with them. Neither
-- applies to the replay path, where an existing movement with an exact source
-- binding and its own p2c lock still returns replayed = true.
--
-- Document void is NOT performed here. Once the posting lock is set, 0052's
-- void_purchase_receipt() refuses a standalone void, which is the intended
-- barrier. The future atomic "document void + ledger reversal" adapter is
-- specified at the end of this file; 0053 does not weaken that barrier and does
-- not work around it.
--
--
-- ─── Future adapter boundary (NOT implemented here) ─────────────────────────
--
--   Produce issue        source_document_type 'produce_session', negative MAIN
--                        lines, dedupe on the produce finalization identity.
--   P2A physical count   source_document_type 'physical_inventory_snapshot',
--                        a signed ADJUSTMENT movement for the DIFFERENCE between
--                        counted quantity and ledger balance — never an absolute
--                        overwrite, because an absolute set would destroy the
--                        append-only audit chain the ledger exists to provide.
--   Both need: a new movement_type CHECK value, a new source_document_type, and
--   their own posting RPC. Neither needs a change to the line model.
--
--
-- ─── Privilege model (mirrors 0047 and 0052) ────────────────────────────────
--   anon / authenticated: no table access, no RPC EXECUTE
--   service_role: SELECT on tables and the balance view; mutation ONLY via
--                 SECURITY DEFINER RPCs
--   Production carries broad default ACLs, so every table is REVOKEd from
--   service_role BEFORE the intended SELECT grant rather than assuming a clean
--   slate. A test proves the neutralization works against a seeded broad grant.
--   The read-only balance RPC is SECURITY INVOKER on purpose: it needs no
--   elevation, so a leaked EXECUTE grant still cannot read past the caller's own
--   table privileges. Only the two mutating RPCs are SECURITY DEFINER.
--   Trigger guards are intentionally NOT SECURITY DEFINER — they must run as the
--   mutating role, and DEFINER there is privilege escalation for no gain.

-- 0053 uses only core gen_random_uuid() (PG13+), so it installs no extension.
-- The schema is ensured because it appears in the pinned search_path of the
-- SECURITY DEFINER functions below.
CREATE SCHEMA IF NOT EXISTS extensions;

-- ── Locations ────────────────────────────────────────────────────────────────

CREATE TABLE public.inventory_locations (
  location_code text        PRIMARY KEY
    CHECK (location_code = btrim(location_code) AND length(location_code) > 0),
  label         text        NOT NULL CHECK (length(btrim(label)) > 0),
  location_type text        NOT NULL
    CHECK (location_type IN ('WAREHOUSE', 'MARKET', 'TRANSIT', 'ADJUSTMENT')),
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inventory_locations IS
  'Stock-holding locations. 0053 seeds only MAIN — market locations are NOT '
  'invented here because no authoritative market-location catalog exists yet.';

-- Only the canonical warehouse. P2B already CHECKs intended_warehouse_code =
-- 'MAIN', so MAIN is the sole destination any 0053 adapter can post to.
INSERT INTO public.inventory_locations (location_code, label, location_type)
VALUES ('MAIN', 'Main warehouse', 'WAREHOUSE');

-- ── Movement headers ─────────────────────────────────────────────────────────

CREATE TABLE public.inventory_movements (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  movement_type           text        NOT NULL
    CHECK (movement_type IN ('PURCHASE_RECEIPT', 'REVERSAL')),

  -- Staff-declared business date carried from the source document, never the
  -- server date. Copied verbatim onto a reversal so the reversal lands in the
  -- same reporting period as what it undoes.
  business_date           date        NOT NULL,
  occurred_at             timestamptz NOT NULL DEFAULT now(),

  source_system           text        NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_document_type    text        NOT NULL CHECK (length(btrim(source_document_type)) > 0),
  source_document_id      uuid        NOT NULL,
  -- Frozen version identity of the source content. For a purchase receipt this
  -- is P2B's confirmation_hash, stored so a later audit can prove exactly which
  -- version of the document produced these quantities.
  source_document_version text        CHECK (source_document_version IS NULL
                                             OR length(btrim(source_document_version)) > 0),

  dedupe_key              text        NOT NULL CHECK (length(btrim(dedupe_key)) > 0),

  reversal_of_movement_id uuid        REFERENCES public.inventory_movements(id),
  reversed_by_movement_id uuid        REFERENCES public.inventory_movements(id),
  reversal_reason         text        CHECK (reversal_reason IS NULL
                                             OR length(btrim(reversal_reason)) > 0),

  -- Declared line count, verified against the actual lines by a DEFERRED
  -- constraint trigger at commit. The header is immutable, so this cannot be
  -- back-filled after the fact — it must be correct when written.
  line_count              integer     NOT NULL CHECK (line_count > 0 AND line_count <= 500),

  actor                   text        CHECK (actor IS NULL OR length(btrim(actor)) > 0),
  source_evidence         jsonb       NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_evidence) = 'object'),

  created_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (dedupe_key),
  -- At most one reversal per original, and a reversal points at one original.
  UNIQUE (reversal_of_movement_id),
  UNIQUE (reversed_by_movement_id),

  CONSTRAINT inventory_movements_no_self_reference
    CHECK (reversal_of_movement_id IS DISTINCT FROM id
           AND reversed_by_movement_id IS DISTINCT FROM id),

  -- REVERSAL and reversal_of_movement_id are the same fact stated twice; they
  -- may never disagree.
  CONSTRAINT inventory_movements_reversal_shape
    CHECK ((movement_type = 'REVERSAL') = (reversal_of_movement_id IS NOT NULL)),
  CONSTRAINT inventory_movements_reversal_reason_paired
    CHECK ((reversal_reason IS NOT NULL) = (movement_type = 'REVERSAL'))
);

COMMENT ON TABLE public.inventory_movements IS
  'Append-only inventory movement header. Quantity only — 0053 stores NO '
  'monetary value; valuation and COGS are P2D/0054.';

COMMENT ON COLUMN public.inventory_movements.dedupe_key IS
  'Globally unique deterministic idempotency identity. For purchase receipts '
  'this is P2B''s frozen p2c_dedupe_key verbatim, never recomputed here.';

COMMENT ON COLUMN public.inventory_movements.source_document_version IS
  'Frozen source content version (P2B confirmation_hash for purchase receipts).';

COMMENT ON COLUMN public.inventory_movements.line_count IS
  'Declared line count, verified against actual lines by a DEFERRED constraint '
  'trigger. Guarantees a header can never commit with zero or partial lines.';

-- Source-identity protection: one POSTING movement per source document, ever.
-- Reversals are excluded — they intentionally share the original's source.
CREATE UNIQUE INDEX inventory_movements_source_posting_uidx
  ON public.inventory_movements (source_document_type, source_document_id)
  WHERE reversal_of_movement_id IS NULL;

CREATE INDEX inventory_movements_business_date_idx
  ON public.inventory_movements (business_date, movement_type);

-- ── Movement lines ───────────────────────────────────────────────────────────

CREATE TABLE public.inventory_movement_lines (
  -- Named `id` for consistency with 0047/0052; this IS the movement_line_id and
  -- the RPC contract exposes it under that name.
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id     uuid          NOT NULL REFERENCES public.inventory_movements(id),

  line_ordinal    integer       NOT NULL CHECK (line_ordinal > 0 AND line_ordinal <= 500),

  -- Application-canonical identities, carried verbatim from the source document.
  -- Never derived or normalized in SQL: the resolver is the application's job and
  -- a second normalization here would be a second, divergent identity.
  product_key     text          NOT NULL CHECK (length(btrim(product_key)) > 0),
  unit_key        text          NOT NULL CHECK (length(btrim(unit_key)) > 0),
  location_code   text          NOT NULL REFERENCES public.inventory_locations(location_code),

  -- Same 6dp envelope as purchase_receipt_items.quantity, so a quantity P2B
  -- accepted is always representable here. Zero is not a movement.
  signed_quantity numeric(18,6) NOT NULL CHECK (signed_quantity <> 0),

  -- Line-level provenance: purchase_receipt_items.id for a purchase posting.
  source_line_id  uuid,
  source_evidence jsonb         NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_evidence) = 'object'),

  created_at      timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (movement_id, line_ordinal)
);

COMMENT ON TABLE public.inventory_movement_lines IS
  'Append-only signed quantity lines. Positive = stock enters the location, '
  'negative = stock leaves. Balance is SUM(signed_quantity), never a stored column.';

COMMENT ON COLUMN public.inventory_movement_lines.signed_quantity IS
  'Exact numeric(18,6). Positive enters, negative leaves. Never zero.';

COMMENT ON COLUMN public.inventory_movement_lines.source_line_id IS
  'Source document line identity (purchase_receipt_items.id for a purchase '
  'posting). Preserved verbatim onto the reversal line.';

CREATE INDEX inventory_movement_lines_balance_idx
  ON public.inventory_movement_lines (location_code, product_key, unit_key);

CREATE INDEX inventory_movement_lines_movement_idx
  ON public.inventory_movement_lines (movement_id);

CREATE INDEX inventory_movement_lines_source_line_idx
  ON public.inventory_movement_lines (source_line_id)
  WHERE source_line_id IS NOT NULL;

-- One ledger line per source document line, per movement. A frozen payload that
-- repeated the same receipt_item_id under two ordinals would otherwise post that
-- item's quantity twice under a single valid dedupe key — double-counting stock
-- while every other guard stayed satisfied.
--
-- Scoped to (movement_id, source_line_id), NOT to source_line_id alone: a
-- reversal legitimately carries the same source_line_id values as the movement it
-- negates, and belongs to a different movement_id.
CREATE UNIQUE INDEX inventory_movement_lines_source_item_uidx
  ON public.inventory_movement_lines (movement_id, source_line_id)
  WHERE source_line_id IS NOT NULL;

-- ── RLS: enabled, zero policies ──────────────────────────────────────────────
-- No policy is created on purpose. anon/authenticated hold no grants at all, and
-- service_role reads via BYPASSRLS. A policy here would be a second, weaker
-- access path competing with the grant model.

ALTER TABLE public.inventory_locations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movement_lines  ENABLE ROW LEVEL SECURITY;

-- ── Append-only guards ───────────────────────────────────────────────────────

-- Lines are immutable: UPDATE and DELETE are always rejected.
CREATE OR REPLACE FUNCTION public.inventory_movement_lines_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'inventory_movement_lines is append-only and immutable (attempted %) — '
    'correct stock with a reversing movement, never by editing a line', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER inventory_movement_lines_immutable
  BEFORE UPDATE OR DELETE ON public.inventory_movement_lines
  FOR EACH ROW EXECUTE FUNCTION public.inventory_movement_lines_forbid_mutation();

-- ── Sealing a movement's line set ────────────────────────────────────────────
--
-- A movement's line set is SEALED by its immutable declared line_count. Any
-- transaction that adds a line to a movement breaks
--     count(lines) = movements.line_count
-- and is rejected at commit.
--
-- Why this replaced the earlier design: the previous guard compared the parent's
-- created_at to now() and treated equality as proof of "same transaction". That
-- is a timestamp coincidence, not transaction identity — two transactions can
-- share a transaction_timestamp at microsecond resolution, and created_at is a
-- caller-suppliable column, so an authorized writer could manufacture the match.
-- It proved nothing it claimed to prove.
--
-- The invariant below needs no clock and no transaction id, and its soundness is
-- a short argument:
--   1. line_count is NOT NULL, CHECKed > 0, and immutable (the header UPDATE
--      whitelist rejects any change to it).
--   2. Every movement that COMMITS satisfies count(lines) = line_count — the
--      movement's own deferred trigger enforces this for the transaction that
--      created it.
--   3. Lines can never be deleted (rejected above).
--   4. Therefore any later transaction that inserts a line into an existing
--      movement moves count(lines) to line_count + k (k >= 1), which by (1) and
--      (3) can never be brought back into agreement. This trigger observes the
--      violation at that transaction's commit and rejects it.
-- No timing, ordering, or privilege assumption is involved: the only escape
-- would be changing line_count or deleting a line, and both are closed.
--
-- ponytail: O(lines) index-only counts per commit, bounded by the 500-line
-- document cap. If a future adapter writes far larger movements, replace the
-- per-row constraint trigger with one deferred check per movement.
CREATE OR REPLACE FUNCTION public.inventory_movement_lines_assert_sealed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_declared integer;
  v_actual   integer;
BEGIN
  SELECT m.line_count INTO v_declared
    FROM public.inventory_movements AS m
   WHERE m.id = NEW.movement_id;

  -- The FK guarantees the parent exists; a missing row here would mean the
  -- parent was removed, which the header guard also forbids.
  IF v_declared IS NULL THEN
    RAISE EXCEPTION 'movement % does not exist for line %', NEW.movement_id, NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_actual
    FROM public.inventory_movement_lines
   WHERE movement_id = NEW.movement_id;

  IF v_actual <> v_declared THEN
    RAISE EXCEPTION
      'movement % is sealed at % lines but now has % — lines may only be written '
      'when the movement itself is created', NEW.movement_id, v_declared, v_actual
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_movement_lines_sealed
  AFTER INSERT ON public.inventory_movement_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inventory_movement_lines_assert_sealed();

-- Headers are immutable except the one-way reversal back-link. Written as an
-- explicit whitelist of the single legal transition: everything not named here
-- is rejected, so a future column is immutable by default rather than by
-- someone remembering to add it to a blacklist.
CREATE OR REPLACE FUNCTION public.inventory_movements_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'inventory_movements is append-only and immutable (attempted DELETE) — '
      'correct stock with a reversing movement'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Only NULL -> value on reversed_by_movement_id. Re-pointing an existing link
  -- (value -> other value) and clearing it (value -> NULL) are both rejected.
  IF OLD.reversed_by_movement_id IS NOT NULL
     OR NEW.reversed_by_movement_id IS NULL THEN
    RAISE EXCEPTION
      'inventory_movements is append-only and immutable: reversed_by_movement_id '
      'may only be set once, from NULL'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id                      IS DISTINCT FROM OLD.id
     OR NEW.movement_type        IS DISTINCT FROM OLD.movement_type
     OR NEW.business_date        IS DISTINCT FROM OLD.business_date
     OR NEW.occurred_at          IS DISTINCT FROM OLD.occurred_at
     OR NEW.source_system        IS DISTINCT FROM OLD.source_system
     OR NEW.source_document_type IS DISTINCT FROM OLD.source_document_type
     OR NEW.source_document_id   IS DISTINCT FROM OLD.source_document_id
     OR NEW.source_document_version IS DISTINCT FROM OLD.source_document_version
     OR NEW.dedupe_key           IS DISTINCT FROM OLD.dedupe_key
     OR NEW.reversal_of_movement_id IS DISTINCT FROM OLD.reversal_of_movement_id
     OR NEW.reversal_reason      IS DISTINCT FROM OLD.reversal_reason
     OR NEW.line_count           IS DISTINCT FROM OLD.line_count
     OR NEW.actor                IS DISTINCT FROM OLD.actor
     OR NEW.source_evidence      IS DISTINCT FROM OLD.source_evidence
     OR NEW.created_at           IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'inventory_movements is append-only and immutable: only '
      'reversed_by_movement_id may transition from NULL'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The back-link must describe a reversal that actually exists and actually
  -- points back here. Otherwise a direct UPDATE could mark a movement "reversed"
  -- by an unrelated row, and the balance would disagree with the audit trail.
  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_movements AS r
     WHERE r.id = NEW.reversed_by_movement_id
       AND r.movement_type = 'REVERSAL'
       AND r.reversal_of_movement_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'reversed_by_movement_id must reference a REVERSAL movement that reverses '
      'this movement'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_immutable
  BEFORE UPDATE OR DELETE ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.inventory_movements_forbid_mutation();

-- A REVERSAL may not target another REVERSAL. Cross-row, so it cannot be a CHECK.
-- reversal_of_movement_id is immutable after insert, so BEFORE INSERT is enough.
CREATE OR REPLACE FUNCTION public.inventory_movements_guard_reversal_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_type text;
BEGIN
  IF NEW.reversal_of_movement_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT movement_type INTO v_target_type
    FROM public.inventory_movements
   WHERE id = NEW.reversal_of_movement_id;

  IF v_target_type = 'REVERSAL' THEN
    RAISE EXCEPTION
      'movement % is itself a reversal and cannot be reversed — post a new '
      'source document instead', NEW.reversal_of_movement_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_reversal_target_guard
  BEFORE INSERT ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.inventory_movements_guard_reversal_target();

-- Declared line_count must match reality. DEFERRED so the header may legally be
-- written before its lines within one transaction, but a mismatch can never
-- reach commit — this is what makes "no partial movement, and never a zero-line
-- ghost movement" a database fact rather than a promise made by the RPC.
--
-- NOTE: the trigger name must not collide with the auto-generated name of the
-- line_count column CHECK (inventory_movements_line_count_check) — a constraint
-- trigger and a CHECK share the pg_constraint namespace per relation.
CREATE OR REPLACE FUNCTION public.inventory_movements_assert_line_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actual integer;
BEGIN
  SELECT count(*) INTO v_actual
    FROM public.inventory_movement_lines
   WHERE movement_id = NEW.id;

  IF v_actual <> NEW.line_count THEN
    RAISE EXCEPTION
      'movement % declares % lines but has % — a movement is all-or-nothing',
      NEW.id, NEW.line_count, v_actual
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_movements_line_count_matches
  AFTER INSERT ON public.inventory_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inventory_movements_assert_line_count();

-- ── Balance read model ───────────────────────────────────────────────────────
--
-- SECURITY INVOKER: the view holds no privilege of its own, so a caller sees
-- exactly what its own grants on the underlying lines allow. Reversal lines are
-- ordinary negative lines, so a reversed movement nets to zero here with no
-- special-casing and no exclusion predicate to keep in sync.

CREATE VIEW public.inventory_balances
WITH (security_invoker = true) AS
SELECT
  l.location_code,
  l.product_key,
  l.unit_key,
  sum(l.signed_quantity) AS quantity_balance
FROM public.inventory_movement_lines AS l
GROUP BY l.location_code, l.product_key, l.unit_key;

COMMENT ON VIEW public.inventory_balances IS
  'Derived quantity balance: SUM(signed_quantity) per location/product/unit. '
  'Read-only, quantity only, no valuation. Never a stored balance.';

-- ── RPC: balances ────────────────────────────────────────────────────────────
--
-- Returns quantity_balance as TEXT. PostgREST serializes numeric as a JSON
-- number, which rounds through an IEEE754 double — the one thing an exact
-- quantity ledger must never do. Text out, exact in, decoded by the client.
--
-- SECURITY INVOKER: this reads nothing the caller may not already read, so it
-- takes no elevation. A leaked EXECUTE grant still yields nothing without table
-- SELECT.

CREATE OR REPLACE FUNCTION public.get_inventory_balances(
  p_location_code text    DEFAULT NULL,
  p_product_key   text    DEFAULT NULL,
  p_unit_key      text    DEFAULT NULL,
  p_include_zero  boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'balances',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'location_code',    b.location_code,
          'product_key',      b.product_key,
          'unit_key',         b.unit_key,
          -- Exact decimal text. Never a JSON number.
          'quantity_balance', b.quantity_balance::text
        )
        ORDER BY b.location_code, b.product_key, b.unit_key
      ),
      '[]'::jsonb
    )
  )
  FROM public.inventory_balances AS b
  WHERE (p_location_code IS NULL OR b.location_code = p_location_code)
    AND (p_product_key   IS NULL OR b.product_key   = p_product_key)
    AND (p_unit_key      IS NULL OR b.unit_key      = p_unit_key)
    AND (p_include_zero OR b.quantity_balance <> 0);
$$;

COMMENT ON FUNCTION public.get_inventory_balances(text, text, text, boolean) IS
  'Read-only derived balances. quantity_balance is TEXT so exact numeric never '
  'passes through a JS double. Zero balances omitted unless p_include_zero. '
  'Deterministic order: location_code, product_key, unit_key.';

-- ── RPC: post a confirmed P2B purchase receipt into the ledger ───────────────

CREATE OR REPLACE FUNCTION public.post_purchase_receipt_inventory_movement(
  p_receipt_id uuid,
  p_actor      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_receipt       public.purchase_receipts;
  v_contract      jsonb;
  v_payload       jsonb;
  v_dedupe_key    text;
  v_hash          text;
  v_existing      public.inventory_movements;
  v_movement_id   uuid;
  v_item          jsonb;
  v_item_count    integer;
  v_declared_count integer;
  v_business_date date;
  v_quantity_text text;
  v_quantity      numeric;
  v_actor         text := nullif(btrim(coalesce(p_actor, '')), '');
BEGIN
  -- 1. Lock the document. Everything below is decided under this lock, so two
  --    concurrent posts of one receipt serialize instead of racing.
  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE id = p_receipt_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt % not found', p_receipt_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 3/4. Lifecycle gates, checked before reading the contract so the error names
  --      the actual problem rather than "no confirmation exists".
  IF v_receipt.status = 'void' THEN
    RAISE EXCEPTION
      'purchase receipt % is void and must not be posted to inventory', p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_receipt.status <> 'confirmed' THEN
    RAISE EXCEPTION
      'purchase receipt % is not confirmed (status=%) — only a confirmed receipt posts',
      p_receipt_id, v_receipt.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 2. Read the frozen confirmation through the AUTHORITATIVE P2B contract.
  --    Not the live tables, and not a local re-derivation of the payload.
  v_contract := public.get_purchase_receipt_confirmation(p_receipt_id);
  v_payload  := v_contract -> 'confirmation' -> 'payload';
  v_hash     := v_contract -> 'confirmation' ->> 'hash';

  IF v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION
      'purchase receipt % returned a malformed confirmation payload', p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The frozen confirmation hash is REQUIRED, before any replay decision or
  -- insert. It is the content identity stored verbatim as source_document_version
  -- and the half of the dedupe key that pins WHICH version of the document was
  -- posted. Without it a replay could not be distinguished from a re-post of
  -- different content. It is never recomputed here.
  IF v_hash IS NULL OR btrim(v_hash) = '' THEN
    RAISE EXCEPTION
      'purchase receipt % has no frozen confirmation hash — refusing to post '
      'content whose version cannot be pinned', p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 9. The dedupe key is P2B's, taken verbatim. Never rebuilt from parts here.
  v_dedupe_key := v_contract ->> 'p2c_dedupe_key';
  IF v_dedupe_key IS NULL OR btrim(v_dedupe_key) = '' THEN
    RAISE EXCEPTION
      'P2B returned no p2c_dedupe_key for receipt % — refusing to invent one',
      p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Idempotent replay: same frozen content already posted.
  --
  -- A dedupe_key match alone is NOT sufficient to return replayed=true. The key
  -- is an index into the ledger, not a proof of what it points at: if a movement
  -- carrying this key were bound to a different receipt, a different document
  -- version, or a different movement type, returning it would silently report
  -- "already posted" for stock that was never posted for THIS content. Every
  -- element of the source binding is therefore re-verified against the frozen
  -- contract before the replay is trusted.
  SELECT * INTO v_existing
    FROM public.inventory_movements
   WHERE dedupe_key = v_dedupe_key;

  IF FOUND THEN
    IF v_existing.movement_type        IS DISTINCT FROM 'PURCHASE_RECEIPT'
       OR v_existing.source_system     IS DISTINCT FROM 'p2b-purchase-receipts'
       OR v_existing.source_document_type IS DISTINCT FROM 'purchase_receipt'
       OR v_existing.source_document_id   IS DISTINCT FROM p_receipt_id
       OR v_existing.source_document_version IS DISTINCT FROM v_hash
       OR v_existing.dedupe_key        IS DISTINCT FROM v_dedupe_key
    THEN
      RAISE EXCEPTION
        'replay source mismatch: dedupe key % is held by movement % '
        '(type=%, system=%, doc_type=%, doc_id=%, version=%) which does not match '
        'purchase receipt % at version % — refusing to report it as a replay',
        v_dedupe_key, v_existing.id,
        v_existing.movement_type, v_existing.source_system,
        v_existing.source_document_type,
        coalesce(v_existing.source_document_id::text, '<null>'),
        coalesce(v_existing.source_document_version, '<null>'),
        p_receipt_id, v_hash
        USING ERRCODE = 'unique_violation';
    END IF;

    -- A posted movement without its P2B posting lock is a broken pair: the two
    -- are written in one transaction and must be observed together. Reporting a
    -- clean replay here would hide exactly the atomicity failure the lock exists
    -- to make impossible.
    IF v_receipt.posting_locked_at IS NULL
       OR v_receipt.posting_locked_by IS DISTINCT FROM 'p2c-inventory-ledger'
    THEN
      RAISE EXCEPTION
        'posting lock mismatch: movement % exists for purchase receipt % but the '
        'receipt posting lock is % (expected p2c-inventory-ledger) — refusing to '
        'report a replay over a broken movement/lock pair',
        v_existing.id, p_receipt_id,
        coalesce(v_receipt.posting_locked_by, '<unlocked>')
        USING ERRCODE = 'internal_error';
    END IF;

    RETURN jsonb_build_object(
      'movement_id',             v_existing.id::text,
      'receipt_id',              p_receipt_id::text,
      'dedupe_key',              v_existing.dedupe_key,
      'line_count',              v_existing.line_count,
      'replayed',                true,
      -- Surfaced so a caller replaying a REVERSED posting cannot mistake
      -- replayed=true for "stock is currently on hand".
      'reversed_by_movement_id', CASE WHEN v_existing.reversed_by_movement_id IS NULL
                                      THEN NULL
                                      ELSE v_existing.reversed_by_movement_id::text END,
      'posting_locked_at',       v_receipt.posting_locked_at,
      'posting_locked_by',       v_receipt.posting_locked_by
    );
  END IF;

  -- Source-identity conflict: this receipt already has a posting movement under
  -- a DIFFERENT frozen content hash. Fail closed — posting again would double
  -- the stock. The partial unique index is the backstop; this is the named error.
  SELECT * INTO v_existing
    FROM public.inventory_movements
   WHERE source_document_type = 'purchase_receipt'
     AND source_document_id   = p_receipt_id
     AND reversal_of_movement_id IS NULL;

  IF FOUND THEN
    RAISE EXCEPTION
      'purchase receipt % already posted as movement % under dedupe key % — '
      'refusing to post different content (%) against the same source identity',
      p_receipt_id, v_existing.id, v_existing.dedupe_key, v_dedupe_key
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Fresh post: the receipt must NOT already carry a posting lock.
  --
  -- lock_purchase_receipt_for_posting() treats ANY existing lock as an
  -- idempotent replay and never validates posting_locked_by. Calling it under a
  -- foreign lock therefore SUCCEEDS silently, and the movement would commit
  -- while the caller is told the post failed — committed stock sitting under a
  -- lock this ledger does not own. Both lookups above came back empty, so no
  -- movement exists for this receipt and any lock present here belongs to
  -- someone else's bookkeeping. Stop before a single row is written.
  --
  -- An orphan p2c lock is NOT repaired or adopted. A fresh posting writes the
  -- movement and its lock together in one transaction or not at all; reusing an
  -- orphan would recreate exactly the broken pair the lock exists to prevent,
  -- and would erase the operational evidence that it happened.
  IF v_receipt.posting_locked_at IS NOT NULL OR v_receipt.posting_locked_by IS NOT NULL THEN
    -- Half-written lock. 0052 has a CHECK making this unreachable through
    -- supported writes; if it is ever observed, the invariant is already gone
    -- and posting stock on top of it would only bury the evidence.
    IF v_receipt.posting_locked_at IS NULL OR v_receipt.posting_locked_by IS NULL THEN
      RAISE EXCEPTION
        'posting lock conflict: purchase receipt % carries a malformed posting lock '
        '(locked_at=%, locked_by=%) — refusing to post over a half-written lock',
        p_receipt_id,
        coalesce(v_receipt.posting_locked_at::text, '<null>'),
        coalesce(v_receipt.posting_locked_by, '<null>')
        USING ERRCODE = 'internal_error';
    END IF;

    IF v_receipt.posting_locked_by = 'p2c-inventory-ledger' THEN
      RAISE EXCEPTION
        'posting lock conflict: purchase receipt % holds an orphan p2c-inventory-ledger '
        'posting lock taken at % with no movement behind it — refusing to adopt it; '
        'a fresh posting writes the movement and its lock together',
        p_receipt_id, v_receipt.posting_locked_at
        USING ERRCODE = 'internal_error';
    END IF;

    RAISE EXCEPTION
      'posting lock conflict: purchase receipt % is locked for posting by % since % — '
      'refusing to post inventory under a lock this ledger does not own',
      p_receipt_id, v_receipt.posting_locked_by, v_receipt.posting_locked_at
      USING ERRCODE = 'internal_error';
  END IF;

  -- 5. Blocking blockers must be resolved in P2B before stock moves.
  IF coalesce((v_payload ->> 'has_blocking_blockers')::boolean, true) THEN
    RAISE EXCEPTION
      'purchase receipt % has blocking blockers and must not post to inventory: %',
      p_receipt_id, coalesce(v_payload ->> 'blockers', '[]')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 6. P2B must still declare that IT posts no movement. If that ever flips,
  --    two owners would be writing stock and this adapter must stop, loudly.
  IF coalesce((v_payload ->> 'posts_inventory_movement')::boolean, true) THEN
    RAISE EXCEPTION
      'purchase receipt % declares posts_inventory_movement=true — P2C is the '
      'only movement writer; refusing to double-post', p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 7. Destination.
  IF coalesce(v_payload ->> 'intended_warehouse_code', '') <> 'MAIN' THEN
    RAISE EXCEPTION
      'purchase receipt % targets destination % — 0053 posts only to MAIN',
      p_receipt_id, coalesce(v_payload ->> 'intended_warehouse_code', '<null>')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_business_date := (v_payload ->> 'business_date')::date;
  IF v_business_date IS NULL THEN
    RAISE EXCEPTION 'purchase receipt % has no business_date in its frozen contract',
      p_receipt_id USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF jsonb_typeof(v_payload -> 'items') <> 'array' THEN
    RAISE EXCEPTION 'purchase receipt % has a malformed items array', p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT count(*) INTO v_item_count
    FROM jsonb_array_elements(v_payload -> 'items');

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'purchase receipt % has no items to post', p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The contract must agree with itself. A payload whose declared item_count
  -- disagrees with its own array is malformed, and guessing which one is right
  -- is exactly the silent divergence this ledger exists to prevent.
  v_declared_count := (v_payload ->> 'item_count')::integer;
  IF v_declared_count IS DISTINCT FROM v_item_count THEN
    RAISE EXCEPTION
      'purchase receipt % declares item_count=% but carries % items',
      p_receipt_id, coalesce(v_declared_count::text, '<null>'), v_item_count
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 8. Per-item validation, ALL of it before any insert, so the raised error
  --    names the real cause rather than a downstream constraint.
  FOR v_item IN SELECT jsonb_array_elements(v_payload -> 'items')
  LOOP
    IF (v_item ->> 'receipt_item_id') IS NULL THEN
      RAISE EXCEPTION 'purchase receipt % has an item with no receipt_item_id', p_receipt_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF (v_item ->> 'item_ordinal') IS NULL THEN
      RAISE EXCEPTION 'purchase receipt % item % has no item_ordinal',
        p_receipt_id, v_item ->> 'receipt_item_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF coalesce(v_item ->> 'product_identity_status', 'UNRESOLVED') <> 'RESOLVED' THEN
      RAISE EXCEPTION
        'purchase receipt % item % has UNRESOLVED product identity — stock cannot '
        'move against an unresolved product', p_receipt_id, v_item ->> 'item_ordinal'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF coalesce(v_item ->> 'unit_identity_status', 'UNRESOLVED') <> 'RESOLVED' THEN
      RAISE EXCEPTION
        'purchase receipt % item % has UNRESOLVED unit identity — stock cannot '
        'move against an unresolved unit', p_receipt_id, v_item ->> 'item_ordinal'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF (v_item ->> 'product_key') IS NULL OR btrim(v_item ->> 'product_key') = ''
       OR (v_item ->> 'unit_key') IS NULL OR btrim(v_item ->> 'unit_key') = '' THEN
      RAISE EXCEPTION 'purchase receipt % item % has a blank product_key or unit_key',
        p_receipt_id, v_item ->> 'item_ordinal'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Quantity must survive the trip into numeric(18,6) UNCHANGED.
    --
    -- `text::numeric` accepts far more than this column can hold, and the
    -- subsequent assignment to numeric(18,6) would SILENTLY ROUND a 7th decimal
    -- away — turning a malformed frozen payload into a plausible-looking stock
    -- figure that no longer equals the document it came from. The regex is the
    -- gate: it admits only a plain unsigned decimal with at most 6 fractional
    -- digits, which simultaneously rejects exponent notation ('1e3'), NaN and
    -- Infinity text, signs, whitespace, empty strings and over-scale values.
    -- Magnitude is then bounded so the cast cannot overflow, and the round trip
    -- is asserted rather than assumed.
    v_quantity_text := v_item ->> 'quantity';

    IF v_quantity_text IS NULL THEN
      RAISE EXCEPTION 'purchase receipt % item % has no quantity',
        p_receipt_id, v_item ->> 'item_ordinal'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_quantity_text !~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$' THEN
      RAISE EXCEPTION
        'purchase receipt % item % quantity % is not a plain decimal with at most '
        '6 fractional digits — refusing to round a frozen quantity',
        p_receipt_id, v_item ->> 'item_ordinal', v_quantity_text
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_quantity := v_quantity_text::numeric;

    IF v_quantity <= 0 THEN
      RAISE EXCEPTION
        'purchase receipt % item % has non-positive quantity %',
        p_receipt_id, v_item ->> 'item_ordinal', v_quantity_text
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- numeric(18,6) holds 12 integer digits. Checked BEFORE the cast so an
    -- oversized value is a named business error, never a raw overflow.
    IF v_quantity >= 1000000000000 THEN
      RAISE EXCEPTION
        'purchase receipt % item % quantity % exceeds the numeric(18,6) envelope',
        p_receipt_id, v_item ->> 'item_ordinal', v_quantity_text
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_quantity <> v_quantity::numeric(18,6) THEN
      RAISE EXCEPTION
        'purchase receipt % item % quantity % would not be stored exactly',
        p_receipt_id, v_item ->> 'item_ordinal', v_quantity_text
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;

  -- 10. One purchase movement.
  INSERT INTO public.inventory_movements (
    movement_type, business_date, source_system,
    source_document_type, source_document_id, source_document_version,
    dedupe_key, line_count, actor, source_evidence
  ) VALUES (
    'PURCHASE_RECEIPT',
    v_business_date,
    'p2b-purchase-receipts',
    'purchase_receipt',
    p_receipt_id,
    v_hash,
    v_dedupe_key,
    v_item_count,
    v_actor,
    jsonb_build_object(
      'contract_version',        v_contract -> 'confirmation' ->> 'contract_version',
      'confirmation_key',        v_contract -> 'confirmation' ->> 'confirmation_key',
      'document_namespace',      v_payload ->> 'document_namespace',
      'document_key',            v_payload ->> 'document_key',
      'parser_contract_version', v_payload ->> 'parser_contract_version'
    )
  )
  RETURNING id INTO v_movement_id;

  -- 11/12. One POSITIVE MAIN line per receipt item, bound to its receipt_item_id.
  --        line_ordinal is the document's own item_ordinal, so a ledger line
  --        traces back to a document line without a lookup table.
  INSERT INTO public.inventory_movement_lines (
    movement_id, line_ordinal, product_key, unit_key, location_code,
    signed_quantity, source_line_id, source_evidence
  )
  SELECT
    v_movement_id,
    (e ->> 'item_ordinal')::integer,
    e ->> 'product_key',
    e ->> 'unit_key',
    'MAIN',
    -- Positive: stock enters MAIN. Every value reaching here was proven above to
    -- be representable in numeric(18,6) exactly, so this cast cannot round.
    (e ->> 'quantity')::numeric(18,6),
    (e ->> 'receipt_item_id')::uuid,
    jsonb_build_object(
      'receipt_item_id',  e ->> 'receipt_item_id',
      'item_ordinal',     e ->> 'item_ordinal',
      'raw_product_text', e ->> 'raw_product_text',
      'raw_unit',         e ->> 'raw_unit'
    )
  FROM jsonb_array_elements(v_payload -> 'items') AS e;

  -- 13. P2B posting lock, in THIS transaction. From here the document can no
  --     longer be voided on its own, and if anything below fails both the
  --     movement and the lock disappear together.
  PERFORM public.lock_purchase_receipt_for_posting(p_receipt_id, 'p2c-inventory-ledger');

  -- Re-read and ASSERT ownership. The helper returns a success shape for a lock
  -- it did not take, so its return value proves nothing — only the row does.
  -- Raising here (rather than returning) rolls the ENTIRE transaction back, the
  -- movement and its lines included, which is the whole point of doing the post
  -- and the lock in one transaction with no EXCEPTION block to swallow it.
  SELECT * INTO v_receipt FROM public.purchase_receipts WHERE id = p_receipt_id;

  IF v_receipt.posting_locked_at IS NULL
     OR v_receipt.posting_locked_by IS DISTINCT FROM 'p2c-inventory-ledger'
  THEN
    RAISE EXCEPTION
      'posting lock not established: purchase receipt % reads back as locked by % '
      'after lock_purchase_receipt_for_posting(p2c-inventory-ledger) — rolling back '
      'the movement rather than committing stock without its lock',
      p_receipt_id, coalesce(v_receipt.posting_locked_by, '<unlocked>')
      USING ERRCODE = 'internal_error';
  END IF;

  -- 14.
  RETURN jsonb_build_object(
    'movement_id',             v_movement_id::text,
    'receipt_id',              p_receipt_id::text,
    'dedupe_key',              v_dedupe_key,
    'line_count',              v_item_count,
    'replayed',                false,
    'reversed_by_movement_id', NULL,
    'posting_locked_at',       v_receipt.posting_locked_at,
    'posting_locked_by',       v_receipt.posting_locked_by
  );
END;
$$;

COMMENT ON FUNCTION public.post_purchase_receipt_inventory_movement(uuid, text) IS
  'Atomically posts a confirmed, unblocked P2B receipt into MAIN and sets the '
  'P2B posting lock in the SAME transaction. Idempotent on P2B''s frozen '
  'p2c_dedupe_key. Quantity only — no valuation, no COGS.';

-- ── RPC: reversal ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reverse_inventory_movement(
  p_movement_id  uuid,
  p_reversal_key text,
  p_reason       text,
  p_actor        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_original    public.inventory_movements;
  v_existing    public.inventory_movements;
  v_dedupe_key  text;
  v_reversal_id uuid;
  v_line_count  integer;
  v_actor       text := nullif(btrim(coalesce(p_actor, '')), '');
BEGIN
  IF p_reversal_key IS NULL OR btrim(p_reversal_key) = '' THEN
    RAISE EXCEPTION 'reversal key is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reversal reason is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Namespaced so a reversal key can never collide with a posting dedupe key.
  v_dedupe_key := 'inventory-movement-reversal:v1:' || btrim(p_reversal_key);

  -- Lock the original. Concurrent reversals of one movement serialize here: the
  -- loser re-reads the committed row under READ COMMITTED and sees the link.
  SELECT * INTO v_original
    FROM public.inventory_movements
   WHERE id = p_movement_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory movement % not found', p_movement_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_original.movement_type = 'REVERSAL' THEN
    RAISE EXCEPTION
      'movement % is itself a reversal and cannot be reversed', p_movement_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_original.reversed_by_movement_id IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM public.inventory_movements
     WHERE id = v_original.reversed_by_movement_id;

    -- Same key: idempotent replay. Different key: fail closed.
    IF v_existing.dedupe_key = v_dedupe_key THEN
      RETURN jsonb_build_object(
        'movement_id', v_original.id::text,
        'reversal_id', v_existing.id::text,
        'dedupe_key',  v_existing.dedupe_key,
        'line_count',  v_existing.line_count,
        'replayed',    true
      );
    END IF;

    RAISE EXCEPTION
      'movement % is already reversed by % under a different reversal key — '
      'a movement may be reversed at most once',
      p_movement_id, v_existing.id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- A dedupe key already used by an UNRELATED movement is a caller error, not a
  -- replay: returning that movement would silently answer the wrong question.
  IF EXISTS (SELECT 1 FROM public.inventory_movements WHERE dedupe_key = v_dedupe_key) THEN
    RAISE EXCEPTION
      'reversal key % is already in use by a different movement', p_reversal_key
      USING ERRCODE = 'unique_violation';
  END IF;

  v_line_count := v_original.line_count;

  INSERT INTO public.inventory_movements (
    movement_type, business_date, occurred_at, source_system,
    source_document_type, source_document_id, source_document_version,
    dedupe_key, reversal_of_movement_id, reversal_reason,
    line_count, actor, source_evidence
  ) VALUES (
    'REVERSAL',
    -- Same business date as the original: a reversal belongs to the period it
    -- undoes, not to the day someone noticed the mistake.
    v_original.business_date,
    now(),
    v_original.source_system,
    v_original.source_document_type,
    v_original.source_document_id,
    v_original.source_document_version,
    v_dedupe_key,
    v_original.id,
    btrim(p_reason),
    v_line_count,
    v_actor,
    jsonb_build_object('reversal_of', v_original.id::text,
                       'reversal_key', btrim(p_reversal_key))
  )
  RETURNING id INTO v_reversal_id;

  -- Exact negatives, preserving product/unit/location/source-line linkage and
  -- ordinals so a reversal line pairs 1:1 with the line it undoes.
  INSERT INTO public.inventory_movement_lines (
    movement_id, line_ordinal, product_key, unit_key, location_code,
    signed_quantity, source_line_id, source_evidence
  )
  SELECT
    v_reversal_id,
    l.line_ordinal,
    l.product_key,
    l.unit_key,
    l.location_code,
    l.signed_quantity * -1,
    l.source_line_id,
    l.source_evidence
  FROM public.inventory_movement_lines AS l
  WHERE l.movement_id = v_original.id;

  -- Back-link. The header trigger allows exactly this NULL -> value transition,
  -- and verifies the target really is the reversal of this row.
  UPDATE public.inventory_movements
     SET reversed_by_movement_id = v_reversal_id
   WHERE id = v_original.id;

  RETURN jsonb_build_object(
    'movement_id', v_original.id::text,
    'reversal_id', v_reversal_id::text,
    'dedupe_key',  v_dedupe_key,
    'line_count',  v_line_count,
    'replayed',    false
  );
END;
$$;

COMMENT ON FUNCTION public.reverse_inventory_movement(uuid, text, text, text) IS
  'Atomically reverses one movement with exact negative lines. Idempotent on the '
  'reversal key; a different key against an already-reversed movement fails closed. '
  'Does NOT void the source document — see the atomic void boundary note in 0053.';

-- ── Future atomic receipt-void adapter boundary (NOT implemented in 0053) ────
--
-- Reversing a purchase movement does NOT void the P2B document, and 0053
-- deliberately does not attempt it. void_purchase_receipt() refuses while the
-- posting lock is held, and 0053 does not clear, bypass or weaken that lock —
-- the barrier stays exactly as P2B built it.
--
-- The future adapter, when it is written, is:
--
--   void_purchase_receipt_with_ledger_reversal(receipt_id, reversal_key, reason, actor)
--     1. SELECT ... FOR UPDATE on purchase_receipts
--     2. locate the posting movement by (purchase_receipt, receipt_id)
--     3. reverse_inventory_movement(...)                -- same transaction
--     4. release the posting lock and void the document -- same transaction
--
-- Step 4 needs a P2B-owned RPC that clears posting_locked_at as part of the void.
-- That RPC does not exist at 0052 and MUST NOT be simulated here by a direct
-- UPDATE from P2C: P2C writing P2B's lifecycle columns behind the RPC boundary
-- is precisely the coupling the posting lock was created to prevent. The
-- adapter therefore waits for that P2B primitive rather than reaching around it.

-- ── Privileges ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'get_inventory_balances',
         'post_purchase_receipt_inventory_movement',
         'reverse_inventory_movement'
       )
       AND p.prorettype <> 'trigger'::regtype::oid
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END
$$;

-- Trigger functions take no EXECUTE grant at all: they are invoked by the
-- trigger machinery, and a direct-call grant would only widen the surface.
DO $$
DECLARE
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'inventory_movement_lines_forbid_mutation',
         'inventory_movement_lines_assert_sealed',
         'inventory_movements_forbid_mutation',
         'inventory_movements_guard_reversal_target',
         'inventory_movements_assert_line_count'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated, service_role', v_sig);
  END LOOP;
END
$$;

REVOKE ALL ON TABLE public.inventory_locations      FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_movements      FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_movement_lines FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_balances       FROM PUBLIC;

REVOKE ALL ON TABLE public.inventory_locations      FROM anon, authenticated;
REVOKE ALL ON TABLE public.inventory_movements      FROM anon, authenticated;
REVOKE ALL ON TABLE public.inventory_movement_lines FROM anon, authenticated;
REVOKE ALL ON TABLE public.inventory_balances       FROM anon, authenticated;

-- Production carries broad default ACLs. REVOKE FROM service_role BEFORE the
-- intended grant, or an inherited GRANT ALL leaves INSERT/UPDATE/DELETE/TRUNCATE/
-- REFERENCES/TRIGGER in place and every "mutation only via RPC" claim is false.
REVOKE ALL ON TABLE public.inventory_locations      FROM service_role;
REVOKE ALL ON TABLE public.inventory_movements      FROM service_role;
REVOKE ALL ON TABLE public.inventory_movement_lines FROM service_role;
REVOKE ALL ON TABLE public.inventory_balances       FROM service_role;

GRANT SELECT ON TABLE public.inventory_locations      TO service_role;
GRANT SELECT ON TABLE public.inventory_movements      TO service_role;
GRANT SELECT ON TABLE public.inventory_movement_lines TO service_role;
GRANT SELECT ON TABLE public.inventory_balances       TO service_role;
