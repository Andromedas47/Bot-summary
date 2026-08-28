-- P2D Inventory Cost Valuation — append-only VALUE ledger, layered additively on
-- top of the 0053 quantity ledger.
--
-- Migration id 0054: reserved for P2D since 0053 shipped and named as such in
-- six places, including 0053_inventory_movement_ledger.sql:7 and
-- 20260805130000_purchase_capture_sessions.sql:15. This migration is that
-- reservation being redeemed.
--
-- Purely additive over 0053 and 0052:
--   * 0053's inventory_movements and inventory_movement_lines gain NO new
--     column, and no existing column changes meaning. The ONLY 0053 object
--     touched is the movement_type CHECK, widened by the exact mechanism
--     0053:56-60 itself prescribes for a future adapter.
--   * 0052's purchase_receipts / purchase_receipt_items are not touched at all.
--     This migration only READS the frozen confirmation payload through
--     get_purchase_receipt_confirmation(), never the live tables.
--
-- Does NOT implement FIFO or specific-lot costing, landed-cost allocation of
-- receipt-level freight/handling/discount/VAT, or retroactive valuation of
-- movements posted before this migration. See docs/p2d-actual-cost.md rule 9
-- and section 6 for why: no reviewed contract defines an allocation basis, and
-- Production holds zero inventory_movements rows today, so there is no history
-- to backfill.
--
--
-- ─── Why no stored average, and why a separate value ledger at all ──────────
--
-- Stock QUANTITY is already authoritative in 0053 as SUM(signed_quantity). This
-- migration adds stock VALUE the same way: SUM(signed_value_satang) over a new
-- append-only line table, keyed by the exact (location_code, product_key,
-- unit_key) triplet 0053's balance already groups by. Average unit cost is
-- derived at READ time — value_balance / quantity_balance — and is never
-- written anywhere. A stored average forces a rounding decision on every
-- write, and those roundings accumulate: 3 units bought for 100 satang is
-- 33.333... satang each, and no integer stores that exactly. Storing only the
-- total value means the rounding happens once, at the moment value actually
-- leaves (the exact-drain rule below), and that rounding nets to zero by
-- construction rather than by hope.
--
-- A cost line stores NO quantity of its own — it points at the 0053 ledger
-- line and that line's signed_quantity is the only quantity that exists. This
-- is the single most important structural decision here: quantity and value
-- cannot diverge because there is only one copy of the quantity to diverge
-- from. "Quantity and value never disagree" is therefore a foreign-key fact,
-- not an assertion that could rot.
--
--
-- ─── Money ────────────────────────────────────────────────────────────────
--
-- Integer THB satang throughout. No float, no double precision, no ::real,
-- anywhere in this file. signed_value_satang is numeric(24,0) rather than
-- bigint, following the 0052 line_amount_satang precedent at 0052:34-47:
-- quantity up to ~10^12 times unit_cost up to ~10^14 overflows bigint's
-- 9.22*10^18 ceiling. The `= trunc(...)` CHECK keeps it an exact integer count
-- of satang even though the column can hold values bigint cannot.
--
--
-- ─── Movement type widening (mechanism prescribed at 0053:56-60) ────────────
--
-- 0053 closed movement_type to PURCHASE_RECEIPT and REVERSAL on purpose and
-- said: "Every future adapter must widen it in its own migration, alongside
-- the adapter that writes it." 0054 widens it to admit ISSUE, GOOD_RETURN,
-- DAMAGED_WRITE_OFF and ADJUSTMENT — the quantity-side adapters valuation
-- needs to value. This is additive: every value PURCHASE_RECEIPT and REVERSAL
-- already accepted is still accepted, unchanged.
--
--
-- ─── Requires 0053 and 0052 ─────────────────────────────────────────────────
--
-- This migration reads inventory_movements, inventory_movement_lines and
-- get_purchase_receipt_confirmation(). It must run after both.

-- ── B. Widen inventory_movements.movement_type (the ONLY 0053 object this
--      migration modifies) ────────────────────────────────────────────────
--
-- Same constraint name, same table, DROP-then-ADD so the CHECK is replaced
-- atomically rather than left absent between statements. Every value 0053
-- accepted (PURCHASE_RECEIPT, REVERSAL) is listed again unchanged; only the
-- four new values are new.
ALTER TABLE public.inventory_movements
  DROP CONSTRAINT inventory_movements_movement_type_check;

ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN (
    'PURCHASE_RECEIPT', 'REVERSAL',
    'ISSUE', 'GOOD_RETURN', 'DAMAGED_WRITE_OFF', 'ADJUSTMENT'
  ));

-- ── C. Cost movement headers ─────────────────────────────────────────────────

CREATE TABLE public.inventory_cost_movements (
  id                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 1:1 with the quantity movement being valued. UNIQUE, not just indexed: a
  -- movement is valued at most once, ever — a second valuation attempt is a
  -- replay (same dedupe_key) or a conflict (different key), never a second row.
  movement_id                   uuid        NOT NULL UNIQUE
    REFERENCES public.inventory_movements(id),

  cost_event_type               text        NOT NULL
    CHECK (cost_event_type IN (
      'PURCHASE_RECEIPT', 'ISSUE', 'GOOD_RETURN',
      'DAMAGED_WRITE_OFF', 'ADJUSTMENT', 'REVERSAL'
    )),

  valuation_basis                text        NOT NULL
    CHECK (valuation_basis IN (
      'SOURCE_UNIT_COST', 'MOVING_AVERAGE',
      'SOURCE_ISSUE_SNAPSHOT', 'EXACT_NEGATION'
    )),

  dedupe_key                    text        NOT NULL UNIQUE
    CHECK (length(btrim(dedupe_key)) > 0),

  reversal_of_cost_movement_id  uuid        UNIQUE
    REFERENCES public.inventory_cost_movements(id),
  reversed_by_cost_movement_id  uuid        UNIQUE
    REFERENCES public.inventory_cost_movements(id),

  -- Declared line count, verified against the actual lines by a DEFERRED
  -- constraint trigger at commit — same discipline as 0053's line_count.
  line_count                    integer     NOT NULL
    CHECK (line_count > 0 AND line_count <= 500),

  actor                          text        CHECK (actor IS NULL OR length(btrim(actor)) > 0),
  created_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inventory_cost_movements_no_self_reference
    CHECK (reversal_of_cost_movement_id IS DISTINCT FROM id
           AND reversed_by_cost_movement_id IS DISTINCT FROM id),

  -- REVERSAL and reversal_of_cost_movement_id are the same fact stated twice;
  -- mirrors 0053's inventory_movements_reversal_shape for the same reason —
  -- they may never disagree.
  CONSTRAINT inventory_cost_movements_reversal_shape
    CHECK ((cost_event_type = 'REVERSAL') = (reversal_of_cost_movement_id IS NOT NULL)),

  -- A cost reversal is EXACT_NEGATION and nothing else recomputes at reversal
  -- time (docs/p2d-actual-cost.md section 3, "Reversal"); pin that pairing too.
  CONSTRAINT inventory_cost_movements_reversal_basis_paired
    CHECK ((cost_event_type = 'REVERSAL') = (valuation_basis = 'EXACT_NEGATION'))
);

COMMENT ON TABLE public.inventory_cost_movements IS
  'Append-only inventory VALUE movement header, bound 1:1 to one 0053 '
  'inventory_movements row. Mirrors 0053''s shape deliberately: same reversal '
  'pair, same line_count all-or-nothing assertion, same dedupe discipline.';

COMMENT ON COLUMN public.inventory_cost_movements.dedupe_key IS
  'Deterministic: inventory-cost:<lower(cost_event_type)>:v1:<movement_id>. '
  'movement_id is already UNIQUE here, so a replay is caught twice over.';

-- ── Cost movement lines ──────────────────────────────────────────────────────

CREATE TABLE public.inventory_cost_movement_lines (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_movement_id          uuid          NOT NULL
    REFERENCES public.inventory_cost_movements(id),

  -- The ONLY link to quantity. UNIQUE: a 0053 ledger line is valued at most
  -- once — a second cost line pointing at the same movement_line_id would be a
  -- second, competing value for one quantity fact.
  movement_line_id          uuid          NOT NULL UNIQUE
    REFERENCES public.inventory_movement_lines(id),

  -- A cost line stores no quantity. Quantity comes from the ledger line it
  -- points at, via movement_line_id. This is deliberate: quantity and value
  -- cannot diverge because there is only one copy of the quantity to diverge
  -- from. numeric(24,0), not bigint — see the money note above.
  signed_value_satang       numeric(24,0) NOT NULL
    CHECK (signed_value_satang = trunc(signed_value_satang)),

  -- Audit-only. NEVER read back by any calculation in this file — re-deriving
  -- a rate from it would reintroduce the stored-average drift this schema
  -- exists to avoid. numeric(40,10): deliberately generous width because this
  -- column holds a DERIVED RATIO (abs(signed_value_satang) / quantity), not a
  -- stored amount — a value near the numeric(24,0) ceiling divided by a
  -- quantity at the numeric(18,6) floor (0.000001) needs more than 20 integer
  -- digits, which numeric(30,10) cannot hold without overflowing.
  unit_cost_satang_snapshot numeric(40,10),

  -- Good-return provenance: the issue cost line this return restores value
  -- from. What makes docs/p2d-actual-cost.md rule 7 provable rather than
  -- guessed.
  source_cost_line_id       uuid          REFERENCES public.inventory_cost_movement_lines(id),

  created_at                timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inventory_cost_movement_lines IS
  'Append-only signed value lines, one per valued 0053 ledger line. No quantity '
  'column — quantity is read through movement_line_id so it cannot diverge.';

COMMENT ON COLUMN public.inventory_cost_movement_lines.signed_value_satang IS
  'Exact numeric(24,0) satang. Sign must agree with the pointed-at ledger '
  'line''s signed_quantity (0 is always legal — free goods) — enforced by a '
  'deferred constraint trigger below, not by a CHECK, because it is cross-row.';

CREATE INDEX inventory_cost_movement_lines_cost_movement_idx
  ON public.inventory_cost_movement_lines (cost_movement_id);

-- No separate index for "the balance join" (c.movement_line_id = l.id): the
-- UNIQUE constraint on movement_line_id above already creates that btree
-- index. Mirrors 0053's balance_idx in spirit — the join this view needs is
-- already covered, so a duplicate index would only cost write time.

-- ── RLS: enabled, zero policies — same reasoning as 0053 ────────────────────
-- service_role reads via BYPASSRLS; a policy would be a second, weaker access
-- path competing with the grant model below.

ALTER TABLE public.inventory_cost_movements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_cost_movement_lines  ENABLE ROW LEVEL SECURITY;

-- ── D. Append-only guards ────────────────────────────────────────────────────

-- Lines are immutable: UPDATE and DELETE always rejected. Mirrors 0053's
-- inventory_movement_lines_forbid_mutation line for line.
CREATE OR REPLACE FUNCTION public.inventory_cost_movement_lines_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'cost_ledger_is_append_only: inventory_cost_movement_lines is append-only '
    'and immutable (attempted %) — correct value with a reversing cost '
    'movement, never by editing a line', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER inventory_cost_movement_lines_immutable
  BEFORE UPDATE OR DELETE ON public.inventory_cost_movement_lines
  FOR EACH ROW EXECUTE FUNCTION public.inventory_cost_movement_lines_forbid_mutation();

-- Headers are immutable except the one-way reversal back-link. Written as an
-- explicit whitelist of the single legal transition, exactly as 0053's
-- inventory_movements_forbid_mutation: everything not named here is rejected,
-- so a future column is immutable by default rather than by someone
-- remembering to add it to a blacklist.
CREATE OR REPLACE FUNCTION public.inventory_cost_movements_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'cost_ledger_is_append_only: inventory_cost_movements is append-only and '
      'immutable (attempted DELETE) — correct value with a reversing cost movement'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Only NULL -> value on reversed_by_cost_movement_id. Re-pointing an
  -- existing link (value -> other value) and clearing it (value -> NULL) are
  -- both rejected.
  IF OLD.reversed_by_cost_movement_id IS NOT NULL
     OR NEW.reversed_by_cost_movement_id IS NULL THEN
    RAISE EXCEPTION
      'cost_ledger_is_append_only: inventory_cost_movements is append-only and '
      'immutable: reversed_by_cost_movement_id may only be set once, from NULL'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id                            IS DISTINCT FROM OLD.id
     OR NEW.movement_id                IS DISTINCT FROM OLD.movement_id
     OR NEW.cost_event_type            IS DISTINCT FROM OLD.cost_event_type
     OR NEW.valuation_basis            IS DISTINCT FROM OLD.valuation_basis
     OR NEW.dedupe_key                 IS DISTINCT FROM OLD.dedupe_key
     OR NEW.reversal_of_cost_movement_id IS DISTINCT FROM OLD.reversal_of_cost_movement_id
     OR NEW.line_count                 IS DISTINCT FROM OLD.line_count
     OR NEW.actor                      IS DISTINCT FROM OLD.actor
     OR NEW.created_at                 IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'cost_ledger_is_append_only: inventory_cost_movements is append-only and '
      'immutable: only reversed_by_cost_movement_id may transition from NULL'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The back-link must describe a reversal that actually exists and actually
  -- points back here — same soundness argument as 0053's header trigger.
  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_cost_movements AS r
     WHERE r.id = NEW.reversed_by_cost_movement_id
       AND r.cost_event_type = 'REVERSAL'
       AND r.reversal_of_cost_movement_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'reversed_by_cost_movement_id must reference a REVERSAL cost movement '
      'that reverses this cost movement'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_cost_movements_immutable
  BEFORE UPDATE OR DELETE ON public.inventory_cost_movements
  FOR EACH ROW EXECUTE FUNCTION public.inventory_cost_movements_forbid_mutation();

-- A REVERSAL cost movement may not itself be reversed. Cross-row, so it cannot
-- be a CHECK. reversal_of_cost_movement_id is immutable after insert (the
-- trigger above forbids all UPDATE except the unrelated back-link), so BEFORE
-- INSERT is enough — mirrors 0053's guard_reversal_target. Defense in depth
-- alongside the same refusal made explicitly inside
-- reverse_inventory_cost_movement() below.
CREATE OR REPLACE FUNCTION public.inventory_cost_movements_guard_reversal_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_type text;
BEGIN
  IF NEW.reversal_of_cost_movement_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT cost_event_type INTO v_target_type
    FROM public.inventory_cost_movements
   WHERE id = NEW.reversal_of_cost_movement_id;

  IF v_target_type = 'REVERSAL' THEN
    RAISE EXCEPTION
      'cost movement % is itself a reversal and cannot be reversed — post a '
      'new valuation instead', NEW.reversal_of_cost_movement_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_cost_movements_reversal_target_guard
  BEFORE INSERT ON public.inventory_cost_movements
  FOR EACH ROW EXECUTE FUNCTION public.inventory_cost_movements_guard_reversal_target();

-- ── E. Deferred constraint triggers ──────────────────────────────────────────

-- Declared line_count must match reality. DEFERRED so the header may legally
-- be written before its lines within one transaction — mirrors 0053's
-- inventory_movements_line_count_matches.
CREATE OR REPLACE FUNCTION public.inventory_cost_movements_assert_line_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actual integer;
BEGIN
  SELECT count(*) INTO v_actual
    FROM public.inventory_cost_movement_lines
   WHERE cost_movement_id = NEW.id;

  IF v_actual <> NEW.line_count THEN
    RAISE EXCEPTION
      'cost movement % declares % lines but has % — a cost movement is '
      'all-or-nothing', NEW.id, NEW.line_count, v_actual
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_cost_movements_line_count_matches
  AFTER INSERT ON public.inventory_cost_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inventory_cost_movements_assert_line_count();

-- A cost movement's line set is SEALED by that same immutable declared
-- line_count, exactly as 0053's inventory_movement_lines_sealed: a later
-- transaction cannot append a cost line to a cost movement that already
-- committed. The soundness argument is identical to 0053's (see 0053:406-420)
-- — line_count is immutable, lines are undeletable, so any later INSERT moves
-- count(lines) permanently out of agreement with line_count and this trigger
-- catches it at that transaction's commit.
CREATE OR REPLACE FUNCTION public.inventory_cost_movement_lines_assert_sealed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_declared integer;
  v_actual   integer;
BEGIN
  SELECT cm.line_count INTO v_declared
    FROM public.inventory_cost_movements AS cm
   WHERE cm.id = NEW.cost_movement_id;

  IF v_declared IS NULL THEN
    RAISE EXCEPTION 'cost movement % does not exist for cost line %',
      NEW.cost_movement_id, NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_actual
    FROM public.inventory_cost_movement_lines
   WHERE cost_movement_id = NEW.cost_movement_id;

  IF v_actual <> v_declared THEN
    RAISE EXCEPTION
      'cost movement % is sealed at % lines but now has % — cost lines may '
      'only be written when the cost movement itself is created',
      NEW.cost_movement_id, v_declared, v_actual
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_cost_movement_lines_sealed
  AFTER INSERT ON public.inventory_cost_movement_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inventory_cost_movement_lines_assert_sealed();

-- Sign agreement (docs/p2d-actual-cost.md section 2, "Sign agreement"): value
-- must never flow opposite to quantity. Free goods are legal — value=0 against
-- a positive or negative quantity — but a positive value against stock LEAVING
-- (or vice versa) is not. Cross-row (needs the pointed-at ledger line), so a
-- deferred constraint trigger rather than a CHECK, same reasoning as every
-- other cross-row invariant in this file.
CREATE OR REPLACE FUNCTION public.inventory_cost_movement_lines_assert_sign_agreement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_quantity numeric(18,6);
BEGIN
  SELECT ml.signed_quantity INTO v_quantity
    FROM public.inventory_movement_lines AS ml
   WHERE ml.id = NEW.movement_line_id;

  IF v_quantity IS NULL THEN
    RAISE EXCEPTION 'ledger line % does not exist for cost line %',
      NEW.movement_line_id, NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.signed_value_satang <> 0
     AND sign(NEW.signed_value_satang) <> sign(v_quantity) THEN
    RAISE EXCEPTION
      'value_sign_conflict: cost line % carries signed_value_satang=% but its '
      'ledger line % carries signed_quantity=% — value must never flow '
      'opposite to quantity', NEW.id, NEW.signed_value_satang,
      NEW.movement_line_id, v_quantity
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_cost_movement_lines_sign_agreement
  AFTER INSERT ON public.inventory_cost_movement_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inventory_cost_movement_lines_assert_sign_agreement();

-- Binding integrity: a cost line may only value a ledger line that belongs to
-- the SAME 0053 movement its parent cost movement was opened for. Without
-- this, a coding error could bind a cost line to a stranger movement's ledger
-- line — the value would be real money against the wrong movement's audit
-- trail, and inventory_cost_balances would silently misattribute it.
CREATE OR REPLACE FUNCTION public.inventory_cost_movement_lines_assert_binding_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cost_movement_bound_to uuid; -- movement_id the parent cost movement values
  v_line_movement_id       uuid; -- movement_id the ledger line actually belongs to
BEGIN
  SELECT cm.movement_id INTO v_cost_movement_bound_to
    FROM public.inventory_cost_movements AS cm
   WHERE cm.id = NEW.cost_movement_id;

  SELECT ml.movement_id INTO v_line_movement_id
    FROM public.inventory_movement_lines AS ml
   WHERE ml.id = NEW.movement_line_id;

  IF v_cost_movement_bound_to IS DISTINCT FROM v_line_movement_id THEN
    RAISE EXCEPTION
      'invalid_cost_binding: cost line % (movement_line %) belongs to '
      'movement % but cost movement % is bound to movement % — a cost line '
      'may only value a line of the movement its cost movement was opened for',
      NEW.id, NEW.movement_line_id, v_line_movement_id, NEW.cost_movement_id,
      v_cost_movement_bound_to
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_cost_movement_lines_binding_integrity
  AFTER INSERT ON public.inventory_cost_movement_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inventory_cost_movement_lines_assert_binding_integrity();

-- ── F. Read models ───────────────────────────────────────────────────────────
--
-- SECURITY INVOKER on both: the view holds no privilege of its own, so a
-- caller sees exactly what its own grants on the underlying tables allow —
-- same reasoning as 0053's inventory_balances.

-- The INNER join is the whole point. A ledger line with no cost line is
-- UNVALUED, not free — COALESCE(...,0) would silently report unvalued stock as
-- zero-cost stock, which is a worse lie than omitting it. This view IS the
-- valued position.
CREATE VIEW public.inventory_cost_balances
WITH (security_invoker = true) AS
SELECT
  l.location_code,
  l.product_key,
  l.unit_key,
  sum(l.signed_quantity)     AS quantity_balance,
  sum(c.signed_value_satang) AS value_balance_satang
FROM public.inventory_movement_lines AS l
JOIN public.inventory_cost_movement_lines AS c ON c.movement_line_id = l.id
GROUP BY l.location_code, l.product_key, l.unit_key;

COMMENT ON VIEW public.inventory_cost_balances IS
  'Derived value balance: SUM(signed_value_satang) per (location, product, '
  'unit), INNER joined to the quantity ledger so an unvalued line is absent, '
  'never reported as free. average_unit_cost is derived at read time only.';

-- The reconciliation counterpart. Must be empty in steady state — the only
-- honest way to see a backfill gap (docs/p2d-actual-cost.md section 2).
CREATE VIEW public.unvalued_inventory_movement_lines
WITH (security_invoker = true) AS
SELECT l.*
FROM public.inventory_movement_lines AS l
LEFT JOIN public.inventory_cost_movement_lines AS c ON c.movement_line_id = l.id
WHERE c.id IS NULL;

COMMENT ON VIEW public.unvalued_inventory_movement_lines IS
  'Every 0053 ledger line with no 0054 cost line. Empty in steady state; a '
  'non-empty result is a valuation backfill gap, not a schema violation.';

-- ── G. Balance-key lock ordering helper ──────────────────────────────────────
--
-- Weighted average is a read-then-write over a derived SUM, so the advisory
-- lock is not optional: without it, two concurrent consumptions against the
-- same key both read the same average and the second one overstates what is
-- left. Every posting RPC below takes these locks FIRST, in ASCENDING sorted
-- key order, before touching a single row.
--
-- Sorting is what makes two concurrent MULTI-line movements deadlock-free: if
-- movement A touches keys {x, y} and movement B touches keys {y, x} and each
-- locked in the order its own lines happen to appear, A could hold x waiting
-- for y while B holds y waiting for x — classic deadlock. Locking in one
-- total order (ascending key text) means every transaction that needs both x
-- and y always acquires x before y, so the cycle above cannot form.
--
-- Not SECURITY DEFINER: it is invoked only from inside the SECURITY DEFINER
-- RPCs below, and a nested call inside a SECURITY DEFINER function already
-- executes as that function's owner — adding DEFINER here would be
-- privilege escalation for no gain, the same reasoning 0053 gives for why its
-- trigger functions are not DEFINER.
CREATE OR REPLACE FUNCTION public.inventory_cost_lock_balance_keys(
  p_movement_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_key record;
BEGIN
  FOR v_key IN
    SELECT DISTINCT location_code, product_key, unit_key
      FROM public.inventory_movement_lines
     WHERE movement_id = p_movement_id
     ORDER BY location_code, product_key, unit_key
  LOOP
    -- hashtext() is deterministic for a given Postgres instance; casting the
    -- int4 result to bigint matches pg_advisory_xact_lock's signature exactly
    -- as 0022_get_or_create_slip_batch.sql already does elsewhere in this repo.
    PERFORM pg_advisory_xact_lock(
      hashtext(v_key.location_code || '|' || v_key.product_key || '|' || v_key.unit_key)::bigint
    );
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.inventory_cost_lock_balance_keys(uuid) IS
  'Takes pg_advisory_xact_lock for every distinct balance key on a movement''s '
  'lines, in ascending sorted key order, so concurrent multi-line valuations '
  'cannot deadlock. Internal only — called by the valuation RPCs below.';

-- ── Internal: build the lines[] payload for a cost movement ─────────────────
--
-- Shared by every RPC's return value and every replay branch, so the payload
-- shape in J cannot drift between the four entry points. Ordered by the
-- pointed-at ledger line's line_ordinal, which is the document-native order.
CREATE OR REPLACE FUNCTION public.inventory_cost_movement_lines_payload(
  p_cost_movement_id uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'movement_line_id',          c.movement_line_id::text,
        'signed_value_satang',       c.signed_value_satang::text,
        'unit_cost_satang_snapshot', CASE WHEN c.unit_cost_satang_snapshot IS NULL THEN NULL
                                          ELSE c.unit_cost_satang_snapshot::text END,
        'source_cost_line_id',       CASE WHEN c.source_cost_line_id IS NULL THEN NULL
                                          ELSE c.source_cost_line_id::text END
      )
      ORDER BY l.line_ordinal
    ),
    '[]'::jsonb
  )
  FROM public.inventory_cost_movement_lines AS c
  JOIN public.inventory_movement_lines AS l ON l.id = c.movement_line_id
  WHERE c.cost_movement_id = p_cost_movement_id;
$$;

-- ── H. RPC: read cost balances ───────────────────────────────────────────────
--
-- Returns every numeric as TEXT, exactly as 0053's get_inventory_balances —
-- PostgREST serializes numeric as a JSON number, which rounds through an
-- IEEE754 double, the one thing an exact value ledger must never do.
-- average_unit_cost_satang is derived here and NEVER stored; NULL when
-- quantity_balance is zero rather than dividing by it.
--
-- SECURITY INVOKER: reads nothing the caller may not already read.

CREATE OR REPLACE FUNCTION public.get_inventory_cost_balances(
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
          'location_code',             b.location_code,
          'product_key',               b.product_key,
          'unit_key',                  b.unit_key,
          'quantity_balance',          b.quantity_balance::text,
          'value_balance_satang',      b.value_balance_satang::text,
          -- Derived, never stored. NULL rather than divide-by-zero when there
          -- is nothing on hand to have an average cost.
          'average_unit_cost_satang',  CASE WHEN b.quantity_balance = 0 THEN NULL
                                            ELSE (b.value_balance_satang / b.quantity_balance)::text END
        )
        ORDER BY b.location_code, b.product_key, b.unit_key
      ),
      '[]'::jsonb
    )
  )
  FROM public.inventory_cost_balances AS b
  WHERE (p_location_code IS NULL OR b.location_code = p_location_code)
    AND (p_product_key   IS NULL OR b.product_key   = p_product_key)
    AND (p_unit_key      IS NULL OR b.unit_key      = p_unit_key)
    AND (p_include_zero OR b.quantity_balance <> 0);
$$;

COMMENT ON FUNCTION public.get_inventory_cost_balances(text, text, text, boolean) IS
  'Read-only derived value balances. Every numeric is TEXT so exact numeric '
  'never passes through a JS double. average_unit_cost_satang is derived at '
  'read time and NULL, never divided, when quantity_balance is zero.';

-- ── I.1 RPC: value a PURCHASE_RECEIPT movement ───────────────────────────────
--
-- SOURCE_UNIT_COST: takes the frozen line_amount_satang from 0052's
-- confirmation payload verbatim. NEVER recomputes quantity * unit_cost here —
-- that computation already happened once, in 0052, and is frozen; a second
-- computation could only diverge from it, never agree by construction.
--
-- NO exception handler: this whole function is one transaction that either
-- commits complete or rolls back complete. A BEGIN...EXCEPTION block would
-- open a subtransaction that could swallow a failure and leave a half-written
-- cost movement — exactly what the append-only/sealed triggers above exist to
-- make impossible, so nothing here is allowed to catch and hide their errors.

CREATE OR REPLACE FUNCTION public.value_purchase_receipt_movement(
  p_movement_id uuid,
  p_actor       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_movement          public.inventory_movements;
  v_existing          public.inventory_cost_movements;
  v_dedupe_key        text;
  v_contract          jsonb;
  v_payload           jsonb;
  v_cost_movement_id  uuid;
  v_line_count        integer;
  v_missing_ordinals  jsonb;
  v_actor             text := nullif(btrim(coalesce(p_actor, '')), '');
BEGIN
  -- Lock the 0053 movement row; everything below is decided under this lock.
  SELECT * INTO v_movement
    FROM public.inventory_movements
   WHERE id = p_movement_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory movement % not found', p_movement_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_movement.movement_type <> 'PURCHASE_RECEIPT' THEN
    RAISE EXCEPTION
      'unsupported_movement_type: movement % has type % — '
      'value_purchase_receipt_movement only values PURCHASE_RECEIPT',
      p_movement_id, v_movement.movement_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_dedupe_key := 'inventory-cost:' || lower('PURCHASE_RECEIPT') || ':v1:' || p_movement_id::text;

  -- Idempotent replay: movement_id is UNIQUE on inventory_cost_movements, so
  -- at most one cost movement can ever exist for this movement.
  SELECT * INTO v_existing
    FROM public.inventory_cost_movements
   WHERE movement_id = p_movement_id;

  IF FOUND THEN
    IF v_existing.dedupe_key = v_dedupe_key THEN
      RETURN jsonb_build_object(
        'cost_movement_id', v_existing.id::text,
        'movement_id',      p_movement_id::text,
        'cost_event_type',  v_existing.cost_event_type,
        'valuation_basis',  v_existing.valuation_basis,
        'dedupe_key',       v_existing.dedupe_key,
        'line_count',       v_existing.line_count,
        'replayed',         true,
        'lines',            public.inventory_cost_movement_lines_payload(v_existing.id)
      );
    END IF;

    RAISE EXCEPTION
      'movement_already_valued: cost movement % already exists for movement % '
      'under dedupe key % which does not match the freshly computed key % — '
      'refusing to treat this as a replay',
      v_existing.id, p_movement_id, v_existing.dedupe_key, v_dedupe_key
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Locks FIRST, in ascending key order, before any balance is read or row is
  -- inserted — see the deadlock note on inventory_cost_lock_balance_keys
  -- above. Without this, a concurrent consumption valuation reading a balance
  -- under the advisory lock could interleave with this receipt valuation
  -- inserting against the same key outside it.
  PERFORM public.inventory_cost_lock_balance_keys(p_movement_id);

  -- Frozen contract, never the live tables — exactly what 0053's own
  -- posting adapter does when it reads P2B.
  v_contract := public.get_purchase_receipt_confirmation(v_movement.source_document_id);
  v_payload  := v_contract -> 'confirmation' -> 'payload';

  IF v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION
      'purchase receipt % returned a malformed confirmation payload for movement %',
      v_movement.source_document_id, p_movement_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT count(*) INTO v_line_count
    FROM public.inventory_movement_lines
   WHERE movement_id = p_movement_id;

  -- Every ledger line must resolve to a priced receipt item BEFORE any insert,
  -- so the raised error names the real cause rather than a downstream
  -- constraint violation. Matched by source_line_id = receipt_item_id, the
  -- binding 0053 itself established when it posted this movement.
  SELECT coalesce(jsonb_agg(l.source_line_id), '[]'::jsonb) INTO v_missing_ordinals
    FROM public.inventory_movement_lines AS l
    LEFT JOIN LATERAL (
      SELECT (item ->> 'line_amount_satang') AS line_amount_satang
        FROM jsonb_array_elements(v_payload -> 'items') AS item
       WHERE (item ->> 'receipt_item_id')::uuid = l.source_line_id
    ) AS matched ON true
   WHERE l.movement_id = p_movement_id
     AND matched.line_amount_satang IS NULL;

  IF jsonb_array_length(v_missing_ordinals) > 0 THEN
    RAISE EXCEPTION
      'missing_unit_cost: movement % has ledger lines with receipt_item_id in '
      '% whose confirmation item has NULL line_amount_satang — refusing to '
      'value an unpriced receipt line', p_movement_id, v_missing_ordinals
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.inventory_cost_movements (
    movement_id, cost_event_type, valuation_basis, dedupe_key, line_count, actor
  ) VALUES (
    p_movement_id, 'PURCHASE_RECEIPT', 'SOURCE_UNIT_COST', v_dedupe_key, v_line_count, v_actor
  )
  RETURNING id INTO v_cost_movement_id;

  -- One positive cost line per ledger line. The frozen line_amount_satang is
  -- taken VERBATIM — never quantity * unit_cost recomputed here.
  INSERT INTO public.inventory_cost_movement_lines (
    cost_movement_id, movement_line_id, signed_value_satang, unit_cost_satang_snapshot
  )
  SELECT
    v_cost_movement_id,
    l.id,
    (matched.line_amount_satang)::numeric,
    -- unit_cost is a BAHT rate (0052:30-32); *100 is the satang-per-unit rate
    -- actually applied, kept for audit only and never summed.
    CASE WHEN matched.unit_cost IS NULL THEN NULL ELSE matched.unit_cost::numeric * 100 END
  FROM public.inventory_movement_lines AS l
  JOIN LATERAL (
    SELECT (item ->> 'line_amount_satang') AS line_amount_satang,
           (item ->> 'unit_cost')          AS unit_cost
      FROM jsonb_array_elements(v_payload -> 'items') AS item
     WHERE (item ->> 'receipt_item_id')::uuid = l.source_line_id
  ) AS matched ON true
  WHERE l.movement_id = p_movement_id;

  RETURN jsonb_build_object(
    'cost_movement_id', v_cost_movement_id::text,
    'movement_id',      p_movement_id::text,
    'cost_event_type',  'PURCHASE_RECEIPT',
    'valuation_basis',  'SOURCE_UNIT_COST',
    'dedupe_key',       v_dedupe_key,
    'line_count',       v_line_count,
    'replayed',         false,
    'lines',            public.inventory_cost_movement_lines_payload(v_cost_movement_id)
  );
END;
$$;

COMMENT ON FUNCTION public.value_purchase_receipt_movement(uuid, text) IS
  'Values a PURCHASE_RECEIPT movement at the frozen 0052 line_amount_satang, '
  'never recomputed. Idempotent on the deterministic inventory-cost dedupe key.';

-- ── I.2 RPC: value an ISSUE / DAMAGED_WRITE_OFF (consumption) movement ──────
--
-- MOVING_AVERAGE at the effective-at-posting-time average: value_balance *
-- |signed_quantity| / quantity_balance, rounded — EXCEPT the exact-drain case,
-- assigned directly with no division and no rounding, which is what guarantees
-- quantity reaching zero and value reaching zero happen together (see
-- docs/p2d-actual-cost.md section 3, "Exact-drain rule").
--
-- Lines are processed in line_ordinal order. Each line starts from the stable
-- PRE-MOVEMENT valued balance, computed by explicitly excluding this movement,
-- then applies the running total of earlier lines in THIS SAME LOOP against the
-- same key. The exclusion is essential: after line 1 is inserted, PostgreSQL
-- read-your-own-writes makes inventory_cost_balances include it, so combining
-- that live balance with v_running would subtract line 1 twice.

CREATE OR REPLACE FUNCTION public.value_inventory_consumption_movement(
  p_movement_id uuid,
  p_actor       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_movement         public.inventory_movements;
  v_existing         public.inventory_cost_movements;
  v_dedupe_key       text;
  v_cost_movement_id uuid;
  v_line_count       integer;
  v_line             public.inventory_movement_lines;
  v_key              text;
  v_adj              jsonb;
  v_base_qty         numeric;
  v_base_value       numeric;
  v_qty_balance      numeric;
  v_value_balance    numeric;
  v_ledger_qty       numeric;
  v_line_value       numeric(24,0);
  v_unit_cost        numeric(40,10);
  v_running          jsonb := '{}'::jsonb;
  v_actor            text := nullif(btrim(coalesce(p_actor, '')), '');
BEGIN
  SELECT * INTO v_movement
    FROM public.inventory_movements
   WHERE id = p_movement_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory movement % not found', p_movement_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_movement.movement_type NOT IN ('ISSUE', 'DAMAGED_WRITE_OFF') THEN
    RAISE EXCEPTION
      'unsupported_movement_type: movement % has type % — '
      'value_inventory_consumption_movement only values ISSUE and '
      'DAMAGED_WRITE_OFF', p_movement_id, v_movement.movement_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_dedupe_key := 'inventory-cost:' || lower(v_movement.movement_type) || ':v1:' || p_movement_id::text;

  SELECT * INTO v_existing
    FROM public.inventory_cost_movements
   WHERE movement_id = p_movement_id;

  IF FOUND THEN
    IF v_existing.dedupe_key = v_dedupe_key THEN
      RETURN jsonb_build_object(
        'cost_movement_id', v_existing.id::text,
        'movement_id',      p_movement_id::text,
        'cost_event_type',  v_existing.cost_event_type,
        'valuation_basis',  v_existing.valuation_basis,
        'dedupe_key',       v_existing.dedupe_key,
        'line_count',       v_existing.line_count,
        'replayed',         true,
        'lines',            public.inventory_cost_movement_lines_payload(v_existing.id)
      );
    END IF;

    RAISE EXCEPTION
      'movement_already_valued: cost movement % already exists for movement % '
      'under dedupe key % which does not match the freshly computed key % — '
      'refusing to treat this as a replay',
      v_existing.id, p_movement_id, v_existing.dedupe_key, v_dedupe_key
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Every line must be negative (stock leaving) BEFORE any lock or insert.
  IF EXISTS (
    SELECT 1 FROM public.inventory_movement_lines
     WHERE movement_id = p_movement_id AND signed_quantity >= 0
  ) THEN
    RAISE EXCEPTION
      'consumption movement % has a non-negative ledger line — ISSUE and '
      'DAMAGED_WRITE_OFF may only remove stock', p_movement_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Locks FIRST, in ascending key order, before any balance is read — see the
  -- deadlock note on inventory_cost_lock_balance_keys above.
  PERFORM public.inventory_cost_lock_balance_keys(p_movement_id);

  SELECT count(*) INTO v_line_count
    FROM public.inventory_movement_lines
   WHERE movement_id = p_movement_id;

  INSERT INTO public.inventory_cost_movements (
    movement_id, cost_event_type, valuation_basis, dedupe_key, line_count, actor
  ) VALUES (
    p_movement_id, v_movement.movement_type, 'MOVING_AVERAGE', v_dedupe_key, v_line_count, v_actor
  )
  RETURNING id INTO v_cost_movement_id;

  FOR v_line IN
    SELECT * FROM public.inventory_movement_lines
     WHERE movement_id = p_movement_id
     ORDER BY line_ordinal
  LOOP
    v_key := v_line.location_code || '|' || v_line.product_key || '|' || v_line.unit_key;

    -- Stable PRE-MOVEMENT valued balance for this key. Query the underlying
    -- lines rather than inventory_cost_balances so this movement can be
    -- excluded explicitly. After the first line is inserted, the view already
    -- reflects it in this transaction; v_running below is the one and only
    -- mechanism that applies same-movement lines to this baseline.
    SELECT coalesce(sum(l.signed_quantity), 0),
           coalesce(sum(c.signed_value_satang), 0)
      INTO v_base_qty, v_base_value
      FROM public.inventory_movement_lines AS l
      JOIN public.inventory_cost_movement_lines AS c
        ON c.movement_line_id = l.id
     WHERE l.location_code = v_line.location_code
       AND l.product_key   = v_line.product_key
       AND l.unit_key      = v_line.unit_key
       AND l.movement_id  <> p_movement_id;

    -- Adjust by what earlier lines in THIS loop already consumed against the
    -- same key, so a second line against one key sees the first line's effect.
    v_adj := coalesce(v_running -> v_key, jsonb_build_object('qty', '0', 'value', '0'));
    v_qty_balance   := v_base_qty   + (v_adj ->> 'qty')::numeric;
    v_value_balance := v_base_value + (v_adj ->> 'value')::numeric;

    IF v_qty_balance + v_line.signed_quantity < 0 THEN
      -- inventory_cost_balances is an INNER join, so v_qty_balance above is
      -- the VALUED quantity, not the ledger quantity. Before failing closed,
      -- check the LEDGER-side balance for the same key: if the real ledger
      -- balance is not negative, the true cause is unvalued stock at this key,
      -- not genuinely insufficient stock, and that must be reported distinctly
      -- rather than sending the reader hunting for missing stock that is not
      -- actually missing.
      --
      -- No adjustment term is added to v_ledger_qty, deliberately. The quantity
      -- movement was posted to the ledger BEFORE valuation ran, so every line
      -- of this movement — including this one and any earlier line in this same
      -- loop — is ALREADY inside this sum. Adding signed_quantity or the
      -- running total again would subtract the consumption twice, and an
      -- unvalued receipt drained by exactly its own quantity would then be
      -- misreported as insufficient stock.
      SELECT coalesce(sum(signed_quantity), 0) INTO v_ledger_qty
        FROM public.inventory_movement_lines
       WHERE location_code = v_line.location_code
         AND product_key   = v_line.product_key
         AND unit_key      = v_line.unit_key;

      IF v_ledger_qty >= 0 THEN
        RAISE EXCEPTION
          'unvalued_source_inventory: movement % line % cannot be valued '
          'because (%,%,%) settles at ledger quantity % once this movement is '
          'counted, so the stock exists — but the valued balance is only %, so '
          'some earlier movement at this key was never valued. This is a '
          'valuation gap, not missing stock — see '
          'public.unvalued_inventory_movement_lines',
          p_movement_id, v_line.line_ordinal, v_line.location_code,
          v_line.product_key, v_line.unit_key, v_ledger_qty, v_qty_balance
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      RAISE EXCEPTION
        'insufficient_inventory: movement % line % would drive (%,%,%) balance '
        'to % — refusing to post a negative resulting quantity',
        p_movement_id, v_line.line_ordinal, v_line.location_code,
        v_line.product_key, v_line.unit_key, v_qty_balance + v_line.signed_quantity
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Exact-drain: taking the entire remaining quantity assigns the entire
    -- remaining value directly, no division, no rounding — the only way
    -- quantity and value can both reach exactly zero together.
    IF abs(v_line.signed_quantity) = v_qty_balance THEN
      v_line_value := -v_value_balance;
    ELSE
      v_line_value := -round(v_value_balance * abs(v_line.signed_quantity) / v_qty_balance);
    END IF;

    v_unit_cost := CASE WHEN v_qty_balance = 0 THEN NULL ELSE v_value_balance / v_qty_balance END;

    INSERT INTO public.inventory_cost_movement_lines (
      cost_movement_id, movement_line_id, signed_value_satang, unit_cost_satang_snapshot
    ) VALUES (
      v_cost_movement_id, v_line.id, v_line_value, v_unit_cost
    );

    v_running := jsonb_set(v_running, ARRAY[v_key], jsonb_build_object(
      'qty',   (v_adj ->> 'qty')::numeric   + v_line.signed_quantity,
      'value', (v_adj ->> 'value')::numeric + v_line_value
    ), true);
  END LOOP;

  RETURN jsonb_build_object(
    'cost_movement_id', v_cost_movement_id::text,
    'movement_id',      p_movement_id::text,
    'cost_event_type',  v_movement.movement_type,
    'valuation_basis',  'MOVING_AVERAGE',
    'dedupe_key',       v_dedupe_key,
    'line_count',       v_line_count,
    'replayed',         false,
    'lines',            public.inventory_cost_movement_lines_payload(v_cost_movement_id)
  );
END;
$$;

COMMENT ON FUNCTION public.value_inventory_consumption_movement(uuid, text) IS
  'Values an ISSUE or DAMAGED_WRITE_OFF movement at the moving average '
  'effective at posting time. Locks every touched balance key first, in '
  'ascending order, to stay deadlock-free and read-consistent under concurrency.';

-- ── I.3 RPC: value a GOOD_RETURN movement ────────────────────────────────────
--
-- SOURCE_ISSUE_SNAPSHOT: restores the ORIGINAL issue cost, read from a
-- caller-proven source cost line — never the moving average at return time.
-- p_source_cost_line_ids is positionally aligned to line_ordinal (1-based,
-- matching PL/pgSQL's default array indexing): index i is the source cost
-- line id for the ledger line whose line_ordinal = i. A NULL entry, an empty
-- array, or a source whose (location_code, product_key, unit_key) does not
-- match the return line all raise unprovable_return_cost — there is no
-- fallback to the moving average, ever, because that would let an unprovable
-- return quietly restore a rate nobody can point to.

CREATE OR REPLACE FUNCTION public.value_good_return_movement(
  p_movement_id            uuid,
  p_source_cost_line_ids   uuid[],
  p_actor                  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_movement           public.inventory_movements;
  v_existing           public.inventory_cost_movements;
  v_dedupe_key         text;
  v_cost_movement_id   uuid;
  v_line_count         integer;
  v_line               public.inventory_movement_lines;
  v_source_id          uuid;
  v_source_cost_line   public.inventory_cost_movement_lines;
  v_source_cost_event  public.inventory_cost_movements;
  v_source_ledger_line public.inventory_movement_lines;
  v_source_movement    public.inventory_movements;
  v_round_aware        boolean;
  v_return_round_id    uuid;
  v_source_round_id    uuid;
  v_source_issue_qty   numeric;
  v_source_unit_cost   numeric(40,10);
  v_already_returned_qty   numeric;
  v_already_returned_value numeric(24,0);
  v_line_value         numeric(24,0);
  v_actor              text := nullif(btrim(coalesce(p_actor, '')), '');
BEGIN
  SELECT * INTO v_movement
    FROM public.inventory_movements
   WHERE id = p_movement_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory movement % not found', p_movement_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_movement.movement_type <> 'GOOD_RETURN' THEN
    RAISE EXCEPTION
      'unsupported_movement_type: movement % has type % — '
      'value_good_return_movement only values GOOD_RETURN',
      p_movement_id, v_movement.movement_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- P2E owns accountability_round_id and may be applied before or after 0054.
  -- Resolve the column dynamically so this function remains installable before
  -- P2E, but immediately enforces round provenance once that canonical column
  -- exists. Round identity is lineage only; no balance query or lock key below
  -- includes it.
  SELECT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = 'public.inventory_movements'::regclass
       AND attname = 'accountability_round_id'
       AND attnum > 0
       AND NOT attisdropped
  ) INTO v_round_aware;

  IF v_round_aware THEN
    EXECUTE
      'SELECT accountability_round_id
         FROM public.inventory_movements
        WHERE id = $1'
      INTO v_return_round_id
      USING p_movement_id;

    IF v_return_round_id IS NULL THEN
      RAISE EXCEPTION
        'unprovable_return_cost: GOOD_RETURN movement % has no '
        'accountability_round_id — round-aware source-cost restoration fails '
        'closed when return provenance is missing',
        p_movement_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  v_dedupe_key := 'inventory-cost:' || lower('GOOD_RETURN') || ':v1:' || p_movement_id::text;

  SELECT * INTO v_existing
    FROM public.inventory_cost_movements
   WHERE movement_id = p_movement_id;

  IF FOUND THEN
    IF v_existing.dedupe_key = v_dedupe_key THEN
      RETURN jsonb_build_object(
        'cost_movement_id', v_existing.id::text,
        'movement_id',      p_movement_id::text,
        'cost_event_type',  v_existing.cost_event_type,
        'valuation_basis',  v_existing.valuation_basis,
        'dedupe_key',       v_existing.dedupe_key,
        'line_count',       v_existing.line_count,
        'replayed',         true,
        'lines',            public.inventory_cost_movement_lines_payload(v_existing.id)
      );
    END IF;

    RAISE EXCEPTION
      'movement_already_valued: cost movement % already exists for movement % '
      'under dedupe key % which does not match the freshly computed key % — '
      'refusing to treat this as a replay',
      v_existing.id, p_movement_id, v_existing.dedupe_key, v_dedupe_key
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Locks FIRST, in ascending key order, before any balance is read or row is
  -- inserted — see the deadlock note on inventory_cost_lock_balance_keys
  -- above. Without this, a concurrent consumption valuation reading a balance
  -- under the advisory lock could interleave with this return valuation
  -- inserting against the same key outside it.
  PERFORM public.inventory_cost_lock_balance_keys(p_movement_id);

  IF EXISTS (
    SELECT 1 FROM public.inventory_movement_lines
     WHERE movement_id = p_movement_id AND signed_quantity <= 0
  ) THEN
    RAISE EXCEPTION
      'good return movement % has a non-positive ledger line — a good return '
      'may only add stock', p_movement_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT count(*) INTO v_line_count
    FROM public.inventory_movement_lines
   WHERE movement_id = p_movement_id;

  IF p_source_cost_line_ids IS NULL OR array_length(p_source_cost_line_ids, 1) IS NULL THEN
    RAISE EXCEPTION
      'unprovable_return_cost: movement % was called with no source cost line '
      'ids — a good return must be positionally bound to the issue lines it '
      'restores, never inferred', p_movement_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.inventory_cost_movements (
    movement_id, cost_event_type, valuation_basis, dedupe_key, line_count, actor
  ) VALUES (
    p_movement_id, 'GOOD_RETURN', 'SOURCE_ISSUE_SNAPSHOT', v_dedupe_key, v_line_count, v_actor
  )
  RETURNING id INTO v_cost_movement_id;

  FOR v_line IN
    SELECT * FROM public.inventory_movement_lines
     WHERE movement_id = p_movement_id
     ORDER BY line_ordinal
  LOOP
    v_source_id := NULL;
    IF v_line.line_ordinal <= array_length(p_source_cost_line_ids, 1) THEN
      v_source_id := p_source_cost_line_ids[v_line.line_ordinal];
    END IF;

    IF v_source_id IS NULL THEN
      RAISE EXCEPTION
        'unprovable_return_cost: movement % line % has no source cost line id '
        'at its positional index — refusing to fall back to the moving average',
        p_movement_id, v_line.line_ordinal
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_source_cost_line
      FROM public.inventory_cost_movement_lines
     WHERE id = v_source_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'unprovable_return_cost: movement % line % names source cost line % '
        'which does not exist', p_movement_id, v_line.line_ordinal, v_source_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_source_cost_event
      FROM public.inventory_cost_movements
     WHERE id = v_source_cost_line.cost_movement_id
       FOR UPDATE;

    SELECT * INTO v_source_ledger_line
      FROM public.inventory_movement_lines
     WHERE id = v_source_cost_line.movement_line_id;

    SELECT * INTO v_source_movement
      FROM public.inventory_movements
     WHERE id = v_source_ledger_line.movement_id;

    IF v_source_cost_event.cost_event_type IS DISTINCT FROM 'ISSUE'
       OR v_source_movement.movement_type IS DISTINCT FROM 'ISSUE' THEN
      RAISE EXCEPTION
        'unprovable_return_cost: movement % line % names source cost line % '
        'which does not belong to an ISSUE movement (cost event %, quantity '
        'movement %) — a GOOD_RETURN may only restore an ISSUE',
        p_movement_id, v_line.line_ordinal, v_source_id,
        v_source_cost_event.cost_event_type, v_source_movement.movement_type
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_source_cost_event.reversed_by_cost_movement_id IS NOT NULL THEN
      RAISE EXCEPTION
        'unprovable_return_cost: movement % line % names source cost line % '
        'from ISSUE cost movement % which has been reversed — a GOOD_RETURN '
        'cannot restore a cancelled issue',
        p_movement_id, v_line.line_ordinal, v_source_id, v_source_cost_event.id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_round_aware THEN
      EXECUTE
        'SELECT accountability_round_id
           FROM public.inventory_movements
          WHERE id = $1'
        INTO v_source_round_id
        USING v_source_movement.id;

      IF v_source_round_id IS NULL THEN
        RAISE EXCEPTION
          'unprovable_return_cost: movement % line % names source cost line % '
          'whose ISSUE movement % has no accountability_round_id — '
          'round-aware source-cost restoration fails closed',
          p_movement_id, v_line.line_ordinal, v_source_id, v_source_movement.id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      IF v_source_round_id IS DISTINCT FROM v_return_round_id THEN
        RAISE EXCEPTION
          'unprovable_return_cost: movement % line % belongs to accountability '
          'round % but source ISSUE cost line % belongs to round % — a '
          'GOOD_RETURN cannot restore cost across accountability rounds',
          p_movement_id, v_line.line_ordinal, v_return_round_id,
          v_source_id, v_source_round_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END IF;

    IF v_source_ledger_line.location_code <> v_line.location_code
       OR v_source_ledger_line.product_key <> v_line.product_key
       OR v_source_ledger_line.unit_key    <> v_line.unit_key THEN
      RAISE EXCEPTION
        'unprovable_return_cost: movement % line % (%,%,%) names source cost '
        'line % which values a different key (%,%,%) — a return cannot borrow '
        'the cost of an unrelated product',
        p_movement_id, v_line.line_ordinal, v_line.location_code, v_line.product_key,
        v_line.unit_key, v_source_id, v_source_ledger_line.location_code,
        v_source_ledger_line.product_key, v_source_ledger_line.unit_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_source_issue_qty := abs(v_source_ledger_line.signed_quantity);

    -- Cumulative guard: the per-line check alone ("this return does not
    -- exceed the source issue quantity") is not enough — TWO separate
    -- GOOD_RETURN movements can each pass it independently while together
    -- over-restoring the same source cost line. Sum what has ALREADY been
    -- restored against this exact source cost line, across every cost line
    -- in the table (including cost lines written earlier in THIS loop, which
    -- this SELECT already sees within the same transaction), and require the
    -- running total plus this request to stay within what was issued.
    SELECT coalesce(sum(prior.signed_value_satang), 0),
           coalesce(sum(prior_line.signed_quantity), 0)
      INTO v_already_returned_value, v_already_returned_qty
      FROM public.inventory_cost_movement_lines AS prior
      JOIN public.inventory_cost_movements AS prior_cost
        ON prior_cost.id = prior.cost_movement_id
      JOIN public.inventory_movement_lines AS prior_line
        ON prior_line.id = prior.movement_line_id
     WHERE prior.source_cost_line_id = v_source_id
       AND prior_cost.cost_event_type = 'GOOD_RETURN'
       AND prior_cost.reversed_by_cost_movement_id IS NULL;

    IF v_already_returned_qty + v_line.signed_quantity > v_source_issue_qty THEN
      RAISE EXCEPTION
        'unprovable_return_cost: movement % line % names source cost line % '
        'which already had % returned against it — returning % more would '
        'total % against an issued quantity of only %',
        p_movement_id, v_line.line_ordinal, v_source_id, v_already_returned_qty,
        v_line.signed_quantity, v_already_returned_qty + v_line.signed_quantity,
        v_source_issue_qty
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_source_unit_cost := abs(v_source_cost_line.signed_value_satang) / v_source_issue_qty;

    -- Returning the full issued quantity — cumulative across every return
    -- against this source cost line, not just this one — restores the exact
    -- REMAINING value with no rounding residue: the full issued value minus
    -- whatever has already been restored against this same source cost line.
    -- The same exact-drain discipline as consumption, mirrored for the
    -- inbound direction, so a sequence of partial returns still sums to
    -- exactly the issued value.
    IF v_already_returned_qty + v_line.signed_quantity = v_source_issue_qty THEN
      v_line_value := abs(v_source_cost_line.signed_value_satang) - v_already_returned_value;
    ELSE
      v_line_value := round(v_source_unit_cost * v_line.signed_quantity);
    END IF;

    INSERT INTO public.inventory_cost_movement_lines (
      cost_movement_id, movement_line_id, signed_value_satang,
      unit_cost_satang_snapshot, source_cost_line_id
    ) VALUES (
      v_cost_movement_id, v_line.id, v_line_value, v_source_unit_cost, v_source_id
    );
  END LOOP;

  RETURN jsonb_build_object(
    'cost_movement_id', v_cost_movement_id::text,
    'movement_id',      p_movement_id::text,
    'cost_event_type',  'GOOD_RETURN',
    'valuation_basis',  'SOURCE_ISSUE_SNAPSHOT',
    'dedupe_key',       v_dedupe_key,
    'line_count',       v_line_count,
    'replayed',         false,
    'lines',            public.inventory_cost_movement_lines_payload(v_cost_movement_id)
  );
END;
$$;

COMMENT ON FUNCTION public.value_good_return_movement(uuid, uuid[], text) IS
  'Values a GOOD_RETURN at the ORIGINAL issue cost, read from a caller-proven, '
  'positionally-bound active ISSUE cost line per return line. When P2E''s '
  'accountability_round_id column exists, both movements must have the same '
  'non-null round. Round identity is provenance, never a weighted-average '
  'balance key. Never falls back to the moving average — an unprovable return '
  'fails closed. Tracks cumulative quantity and value restored by active '
  'GOOD_RETURN movements against each source cost line, so reversals release '
  'their return capacity and active returns can never over-restore.';

-- ── I.4 RPC: reverse a cost movement ─────────────────────────────────────────
--
-- EXACT_NEGATION: the reversal's lines are the exact negatives of the
-- original's, bound to the mirroring lines of the 0053 REVERSAL movement.
-- Nothing is recomputed — recomputing at reversal time would value the
-- reversal at a LATER average and silently rewrite history, exactly what
-- append-only immutability exists to prevent.

CREATE OR REPLACE FUNCTION public.reverse_inventory_cost_movement(
  p_cost_movement_id     uuid,
  p_reversal_movement_id uuid,
  p_reason               text,
  p_actor                text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_original          public.inventory_cost_movements;
  v_reversal_movement  public.inventory_movements;
  v_existing_reversal  public.inventory_cost_movements;
  v_dedupe_key         text;
  v_reversal_cost_id   uuid;
  v_actor              text := nullif(btrim(coalesce(p_actor, '')), '');
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reversal reason is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_original
    FROM public.inventory_cost_movements
   WHERE id = p_cost_movement_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory cost movement % not found', p_cost_movement_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_original.cost_event_type = 'REVERSAL' THEN
    RAISE EXCEPTION
      'cost movement % is itself a reversal and cannot be reversed',
      p_cost_movement_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- p_reversal_movement_id must be the 0053 REVERSAL that undoes the exact
  -- quantity movement this cost movement values — the binding integrity
  -- trigger above will refuse a mismatched movement anyway, but checking here
  -- names the real cause instead of a downstream constraint failure.
  SELECT * INTO v_reversal_movement
    FROM public.inventory_movements
   WHERE id = p_reversal_movement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory movement % not found', p_reversal_movement_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_reversal_movement.movement_type <> 'REVERSAL'
     OR v_reversal_movement.reversal_of_movement_id IS DISTINCT FROM v_original.movement_id THEN
    RAISE EXCEPTION
      'invalid_cost_binding: movement % is not a REVERSAL of movement % — '
      'cost movement % values movement % and can only be reversed by the 0053 '
      'REVERSAL that undoes that exact movement',
      p_reversal_movement_id, v_original.movement_id, p_cost_movement_id, v_original.movement_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- An ISSUE remains the provenance root of every active GOOD_RETURN that
  -- references one of its cost lines. Reversing that ISSUE first would leave
  -- those returns restoring a cancelled source. Require callers to reverse the
  -- dependent returns before reversing their source ISSUE.
  IF v_original.cost_event_type = 'ISSUE'
     AND EXISTS (
       SELECT 1
         FROM public.inventory_cost_movement_lines AS source_line
         JOIN public.inventory_cost_movement_lines AS return_line
           ON return_line.source_cost_line_id = source_line.id
         JOIN public.inventory_cost_movements AS return_cost
           ON return_cost.id = return_line.cost_movement_id
        WHERE source_line.cost_movement_id = v_original.id
          AND return_cost.cost_event_type = 'GOOD_RETURN'
          AND return_cost.reversed_by_cost_movement_id IS NULL
     ) THEN
    RAISE EXCEPTION
      'source_issue_has_active_returns: ISSUE cost movement % cannot be '
      'reversed while an active GOOD_RETURN still restores one of its source '
      'cost lines — reverse the dependent return first',
      v_original.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  v_dedupe_key := 'inventory-cost:' || lower('REVERSAL') || ':v1:' || p_reversal_movement_id::text;

  IF v_original.reversed_by_cost_movement_id IS NOT NULL THEN
    SELECT * INTO v_existing_reversal
      FROM public.inventory_cost_movements
     WHERE id = v_original.reversed_by_cost_movement_id;

    IF v_existing_reversal.dedupe_key = v_dedupe_key THEN
      RETURN jsonb_build_object(
        'cost_movement_id', v_existing_reversal.id::text,
        'movement_id',      v_existing_reversal.movement_id::text,
        'cost_event_type',  v_existing_reversal.cost_event_type,
        'valuation_basis',  v_existing_reversal.valuation_basis,
        'dedupe_key',       v_existing_reversal.dedupe_key,
        'line_count',       v_existing_reversal.line_count,
        'replayed',         true,
        'lines',            public.inventory_cost_movement_lines_payload(v_existing_reversal.id)
      );
    END IF;

    RAISE EXCEPTION
      'movement_already_valued: cost movement % is already reversed by % '
      'under a different reversal binding — a cost movement may be reversed '
      'at most once', p_cost_movement_id, v_existing_reversal.id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- A cost movement already bound to this reversal movement_id without the
  -- original's back-link set would be the same broken-pair situation 0053
  -- guards against for the posting lock — fail loud rather than silently
  -- proceeding to a UNIQUE violation on movement_id.
  IF EXISTS (SELECT 1 FROM public.inventory_cost_movements WHERE movement_id = p_reversal_movement_id) THEN
    RAISE EXCEPTION
      'movement_already_valued: a cost movement already exists for reversal '
      'movement % but original cost movement % has no back-link to it — '
      'refusing to proceed over an inconsistent pair',
      p_reversal_movement_id, p_cost_movement_id
      USING ERRCODE = 'internal_error';
  END IF;

  -- Locks FIRST, in ascending key order, before any balance is read or row is
  -- inserted — see the deadlock note on inventory_cost_lock_balance_keys
  -- above. The reversal movement's lines carry the same balance keys as the
  -- original movement's, so locking against the reversal movement id covers
  -- exactly the keys this EXACT_NEGATION touches.
  PERFORM public.inventory_cost_lock_balance_keys(p_reversal_movement_id);

  INSERT INTO public.inventory_cost_movements (
    movement_id, cost_event_type, valuation_basis, dedupe_key,
    reversal_of_cost_movement_id, line_count, actor
  ) VALUES (
    p_reversal_movement_id, 'REVERSAL', 'EXACT_NEGATION', v_dedupe_key,
    p_cost_movement_id, v_original.line_count, v_actor
  )
  RETURNING id INTO v_reversal_cost_id;

  -- Exact negatives, matched to the reversal movement's lines by the ledger
  -- line they mirror: the original ledger line's line_ordinal equals the
  -- reversal ledger line's line_ordinal, exactly as 0053's
  -- reverse_inventory_movement() preserves ordinals when it negates quantity.
  INSERT INTO public.inventory_cost_movement_lines (
    cost_movement_id, movement_line_id, signed_value_satang, unit_cost_satang_snapshot
  )
  SELECT
    v_reversal_cost_id,
    rl.id,
    -ocl.signed_value_satang,
    ocl.unit_cost_satang_snapshot
  FROM public.inventory_cost_movement_lines AS ocl
  JOIN public.inventory_movement_lines AS oml ON oml.id = ocl.movement_line_id
  JOIN public.inventory_movement_lines AS rl
    ON rl.movement_id = p_reversal_movement_id AND rl.line_ordinal = oml.line_ordinal
  WHERE ocl.cost_movement_id = p_cost_movement_id;

  -- Back-link. The header trigger allows exactly this NULL -> value
  -- transition, and verifies the target really is the reversal of this row.
  UPDATE public.inventory_cost_movements
     SET reversed_by_cost_movement_id = v_reversal_cost_id
   WHERE id = p_cost_movement_id;

  RETURN jsonb_build_object(
    'cost_movement_id', v_reversal_cost_id::text,
    'movement_id',      p_reversal_movement_id::text,
    'cost_event_type',  'REVERSAL',
    'valuation_basis',  'EXACT_NEGATION',
    'dedupe_key',       v_dedupe_key,
    'line_count',       v_original.line_count,
    'replayed',         false,
    'lines',            public.inventory_cost_movement_lines_payload(v_reversal_cost_id)
  );
END;
$$;

COMMENT ON FUNCTION public.reverse_inventory_cost_movement(uuid, uuid, text, text) IS
  'Reverses one cost movement with exact negative lines bound to the mirroring '
  '0053 REVERSAL movement''s lines. Recomputes nothing. Idempotent on the '
  'deterministic reversal dedupe key; refuses to reverse a reversal.';

-- ── K. Privileges ─────────────────────────────────────────────────────────────
--
-- Mirrors 0053's privilege block (0053:1289-1359) exactly: RLS enabled with
-- zero policies, dynamic REVOKE-then-GRANT loops so Production's broad default
-- ACLs cannot leave a wider grant in place, trigger functions granted to
-- nobody, and only service_role reads the tables/views or executes the RPCs.

DO $$
DECLARE
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'get_inventory_cost_balances',
         'value_purchase_receipt_movement',
         'value_inventory_consumption_movement',
         'value_good_return_movement',
         'reverse_inventory_cost_movement'
       )
       AND p.prorettype <> 'trigger'::regtype::oid
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END
$$;

-- Trigger functions AND internal-only helpers take no EXECUTE grant at all,
-- even for service_role: trigger functions are invoked by trigger machinery,
-- the lock helper and the lines-payload builder are invoked only from inside
-- the SECURITY DEFINER RPCs above (which run as their owner regardless of
-- grants), so a direct-call grant to anyone would only widen the surface for
-- no functional gain.
DO $$
DECLARE
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'inventory_cost_movement_lines_forbid_mutation',
         'inventory_cost_movement_lines_assert_sealed',
         'inventory_cost_movement_lines_assert_sign_agreement',
         'inventory_cost_movement_lines_assert_binding_integrity',
         'inventory_cost_movements_forbid_mutation',
         'inventory_cost_movements_guard_reversal_target',
         'inventory_cost_movements_assert_line_count',
         'inventory_cost_lock_balance_keys',
         'inventory_cost_movement_lines_payload'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated, service_role', v_sig);
  END LOOP;
END
$$;

REVOKE ALL ON TABLE public.inventory_cost_movements       FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_cost_movement_lines  FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_cost_balances        FROM PUBLIC;
REVOKE ALL ON TABLE public.unvalued_inventory_movement_lines FROM PUBLIC;

REVOKE ALL ON TABLE public.inventory_cost_movements       FROM anon, authenticated;
REVOKE ALL ON TABLE public.inventory_cost_movement_lines  FROM anon, authenticated;
REVOKE ALL ON TABLE public.inventory_cost_balances        FROM anon, authenticated;
REVOKE ALL ON TABLE public.unvalued_inventory_movement_lines FROM anon, authenticated;

-- Production carries broad default ACLs. REVOKE FROM service_role BEFORE the
-- intended grant, or an inherited GRANT ALL leaves INSERT/UPDATE/DELETE in
-- place and every "mutation only via RPC" claim made above is false.
REVOKE ALL ON TABLE public.inventory_cost_movements       FROM service_role;
REVOKE ALL ON TABLE public.inventory_cost_movement_lines  FROM service_role;
REVOKE ALL ON TABLE public.inventory_cost_balances        FROM service_role;
REVOKE ALL ON TABLE public.unvalued_inventory_movement_lines FROM service_role;

GRANT SELECT ON TABLE public.inventory_cost_movements       TO service_role;
GRANT SELECT ON TABLE public.inventory_cost_movement_lines  TO service_role;
GRANT SELECT ON TABLE public.inventory_cost_balances        TO service_role;
GRANT SELECT ON TABLE public.unvalued_inventory_movement_lines TO service_role;
