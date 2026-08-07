# P2D — Actual Cost (migration 0054)

The append-only **value** record for stock, layered additively on top of the
0053 quantity ledger. 0053 is not rewritten: no column of it changes, no
function of it changes, and its `PURCHASE_RECEIPT` posting path is untouched.

Migration number `0054` is claimed here. It has been reserved for P2D since
0053 shipped and is named as such in six places, including
`0053_inventory_movement_ledger.sql:7` and
`20260805130000_purchase_capture_sessions.sql:15`.

---

## 1. Frozen costing rules

| # | Rule |
|---|---|
| 1 | Perpetual **weighted-average** cost, keyed by `(location_code, product_key, unit_key)` — the exact key `inventory_balances` already groups by. `MAIN` is the only seeded location; the key generalizes to more without a schema change. |
| 2 | Money is an integer count of **THB satang**. No floating point anywhere, in SQL or TypeScript. |
| 3 | **No stored average.** Quantity balance is `SUM(signed_quantity)`, value balance is `SUM(signed_value_satang)`, both append-only sums over the same key. Average unit cost is derived at read time and never persisted. A stored average is a second source of truth that drifts the first time a write is retried. |
| 4 | History is immutable. Corrections are compensating records, never edits. |
| 5 | A purchase receipt adds `line_amount_satang` per confirmed item — `round(quantity × unit_cost × 100)`, already computed and frozen by 0052. |
| 6 | A consumption (issue, damaged write-off) consumes at the moving average **effective at posting time**. |
| 7 | A good return restores the **original issue cost**, read from the linked source cost line. If no source can be proven, it fails closed. |
| 8 | Negative resulting quantity fails closed for valuation. |
| 9 | Receipt-level expenses (freight, handling, discount, VAT) are **not** allocated into product cost in V1. |
| 10 | Every valuation posting and reversal carries a deterministic unique key. |
| 11 | No automatic retroactive valuation of pre-existing movements. |

### Why no stored unit cost

Storing an average unit cost per key forces a rounding decision on every write,
and those roundings accumulate: 3 units bought for 100 satang gives 33.333…
satang each, and no integer stores that. Storing only the **total value** and
dividing at read time means the rounding happens once, at the moment value
actually leaves, and the exact-drain rule below guarantees it nets to zero.

---

## 2. Schema

### `public.inventory_cost_movements`

One row per valuation event, bound **1:1** to one `inventory_movements` row.

```
id                            uuid primary key default gen_random_uuid()
movement_id                   uuid not null UNIQUE references inventory_movements(id)
cost_event_type               text not null check in
                                ('PURCHASE_RECEIPT','ISSUE','GOOD_RETURN',
                                 'DAMAGED_WRITE_OFF','ADJUSTMENT','REVERSAL')
valuation_basis               text not null check in
                                ('SOURCE_UNIT_COST','MOVING_AVERAGE',
                                 'SOURCE_ISSUE_SNAPSHOT','EXACT_NEGATION')
dedupe_key                    text not null UNIQUE check (length(btrim(dedupe_key)) > 0)
reversal_of_cost_movement_id  uuid UNIQUE references inventory_cost_movements(id)
reversed_by_cost_movement_id  uuid UNIQUE references inventory_cost_movements(id)
line_count                    integer not null check (> 0 and <= 500)
actor                         text check (null or non-blank)
created_at                    timestamptz not null default now()
```

Mirrors 0053's shape deliberately: same reversal pair, same `line_count`
all-or-nothing assertion, same dedupe discipline.

### `public.inventory_cost_movement_lines`

```
id                        uuid primary key default gen_random_uuid()
cost_movement_id          uuid not null references inventory_cost_movements(id)
movement_line_id          uuid not null UNIQUE references inventory_movement_lines(id)
signed_value_satang       numeric(24,0) not null check (= trunc(signed_value_satang))
unit_cost_satang_snapshot numeric(30,10)      -- audit only, NEVER summed
source_cost_line_id       uuid references inventory_cost_movement_lines(id)
created_at                timestamptz not null default now()
```

**A cost line stores no quantity.** Quantity comes from the ledger line it
points at. This is the single most important decision in the schema: quantity
and value cannot diverge because there is only one copy of the quantity. The
"no quantity/value divergence" test is therefore a structural property, not an
assertion that could rot.

`numeric(24,0)` rather than `bigint` follows the 0052 `line_amount_satang`
precedent: `quantity` up to ~10^12 times `unit_cost` up to ~10^14 overflows
bigint. The `= trunc(...)` CHECK keeps it an exact integer count of satang.

`unit_cost_satang_snapshot` exists so an auditor can see what rate was applied
without re-deriving it. It is never read back by any calculation.

`source_cost_line_id` is the good-return provenance link. It is what makes rule
7 provable rather than guessed.

### Sign agreement

Value must never carry the opposite sign to its quantity. Free goods are legal
(`value = 0` with positive quantity); value flowing the wrong way is not. A
deferred constraint trigger enforces:

```
signed_value_satang = 0 OR sign(signed_value_satang) = sign(ledger_line.signed_quantity)
```

### `public.inventory_cost_balances` (view)

```sql
select l.location_code, l.product_key, l.unit_key,
       sum(l.signed_quantity)     as quantity_balance,
       sum(c.signed_value_satang) as value_balance_satang
from public.inventory_movement_lines l
join public.inventory_cost_movement_lines c on c.movement_line_id = l.id
group by 1, 2, 3
```

The **inner** join is intentional: this view is the valued position. A ledger
line with no cost line is unvalued, and hiding that inside a `COALESCE(...,0)`
would silently report unvalued stock as free stock.

### `public.unvalued_inventory_movement_lines` (view)

The reconciliation counterpart — every ledger line with no cost line. It must
be empty in steady state, and it is the only honest way to see a backfill gap.

### Movement type widening

0054 widens the `inventory_movements.movement_type` CHECK to add `ISSUE`,
`GOOD_RETURN`, `DAMAGED_WRITE_OFF` and `ADJUSTMENT`. This is the mechanism
0053 itself prescribes (`0053:56-60`: "Every future adapter must widen it in
its own migration, alongside the adapter that writes it"). It is additive —
every value previously accepted is still accepted, and the existing
`PURCHASE_RECEIPT` path is not modified.

---

## 3. Transaction design

### Lock order

Every posting takes, in one transaction:

1. `pg_advisory_xact_lock(hashtext(location_code || '|' || product_key || '|' || unit_key))`
   for each distinct balance key touched by the movement, acquired in
   **ascending sorted key order**.
2. Then the row work.

Sorting before locking is what makes two concurrent multi-line movements
deadlock-free. Weighted average is a read-then-write over a derived sum, so
this lock is not optional: without it two concurrent issues both read the same
average and the second one overstates what is left.

### Rounding

`round()` on `numeric`, i.e. half away from zero — the same function and the
same direction 0052 already uses for `line_amount_satang`. One rounding rule
in the codebase, not two.

### Exact-drain rule

When a consumption takes the entire remaining quantity for a key, its value is
the entire remaining value, assigned directly with **no division and no
rounding**. This is what guarantees that quantity reaching zero and value
reaching zero happen together. Without it, a sequence of rounded partial
consumptions leaves a few satang of value sitting against zero quantity, which
then reports as an infinite unit cost.

### Refusals

| Code | When |
|---|---|
| `insufficient_inventory` | consumption would drive the quantity balance below zero |
| `missing_unit_cost` | a receipt item has `unit_cost IS NULL`, so `line_amount_satang` is NULL |
| `unprovable_return_cost` | a good return cannot be linked to a source issue cost line |
| `movement_already_valued` | the movement already has a cost movement with a different dedupe key |
| `cost_ledger_is_append_only` | any UPDATE/DELETE against either cost table |
| `invalid_cost_binding` | cost line points at a ledger line belonging to a different movement |
| `value_sign_conflict` | value sign opposes quantity sign |
| `unsupported_movement_type` | valuation requested for a movement type with no defined rule |

### Idempotency

`dedupe_key = 'inventory-cost:' || lower(cost_event_type) || ':v1:' || movement_id`

`movement_id` is already UNIQUE on the cost movement, so a replay is caught
twice over. Replay returns the existing cost movement with `replayed: true`
and writes nothing.

### Reversal

A cost reversal is `valuation_basis = 'EXACT_NEGATION'`: its lines are the
exact negatives of the original cost lines, bound to the lines of the 0053
`REVERSAL` movement. Nothing is recomputed. Recomputing at reversal time would
value the reversal at a later average and silently rewrite history — the exact
thing rule 4 forbids.

---

## 4. Per-event valuation rules

| Event | Basis | Value |
|---|---|---|
| `PURCHASE_RECEIPT` | `SOURCE_UNIT_COST` | `+line_amount_satang` per item, taken from the frozen 0052 confirmation payload. `NULL` refuses. |
| `ISSUE` | `MOVING_AVERAGE` | `-round(value_balance × qty / quantity_balance)`, or `-value_balance` exactly when `qty = quantity_balance`. |
| `DAMAGED_WRITE_OFF` | `MOVING_AVERAGE` | same as `ISSUE`. Distinguished only by type, so reporting can separate loss from cost of goods issued. It never restores sellable stock — it is a negative movement, so it structurally cannot. |
| `GOOD_RETURN` | `SOURCE_ISSUE_SNAPSHOT` | `+round(source_unit_cost × returned_qty)` where `source_unit_cost = |source_cost_line.signed_value_satang| / |source_ledger_line.signed_quantity|`. Returning the full issued quantity restores the full issued value exactly. |
| `ADJUSTMENT` | `MOVING_AVERAGE` | positive adjustments require an explicit unit cost; negative adjustments consume at the average. |
| `REVERSAL` | `EXACT_NEGATION` | exact negative of the reversed cost movement. |

Receipt-level freight, handling, discount and VAT are recorded on the receipt
and deliberately excluded from product cost. 0052 has no item-level allocation
of them anywhere, so allocating here would require inventing an allocation
basis that no reviewed contract defines.

---

## 5. Security posture

Identical to 0053, for the same reasons:

- RLS enabled, **zero policies** on both tables. `service_role` reads through
  BYPASSRLS; a policy would be a second, weaker access path.
- `REVOKE ALL` from `PUBLIC`, `anon`, `authenticated` **and** `service_role`
  (Production carries broad default ACLs), then `GRANT SELECT` to
  `service_role` on the two tables and two views.
- `GRANT EXECUTE` to `service_role` only, on the RPCs. Trigger functions are
  granted to nobody.
- Append-only triggers on both tables, plus deferred constraint triggers
  asserting `line_count` and sign agreement.

---

## 6. Production

Nothing in P2D is applied to Production in this cycle. Production currently
holds **zero** `inventory_movements` and **zero** `inventory_movement_lines`
rows, so the retroactive-valuation question is empty in practice: there is no
history to backfill. `unvalued_inventory_movement_lines` is the check that
keeps it that way.
