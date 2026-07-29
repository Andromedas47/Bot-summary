# P2C — Inventory Movement Ledger (migration 0053)

The authoritative append-only **quantity** record for stock.

First visible checkpoint delivered: a confirmed, unblocked P2B purchase receipt
posts **exactly once** into the MAIN warehouse and increases the stock balance.

**Migration checksum (SHA-256, canonical LF):**
`b33d2475217aac1181138b871d89b6516eb2afcc0bb5874e4ba65f861271e8dc`
(`supabase/migrations/0053_inventory_movement_ledger.sql`, 1282 lines)

---

## Explicitly out of scope

0053 contains **no monetary value of any kind**. No cost, price, satang, amount,
currency or valuation column exists on any ledger table, and a test asserts it by
scanning `information_schema.columns`.

Valuation, landed cost, FIFO/average costing and COGS are **P2D / migration 0054**.

Also not in this slice: LINE/UX wiring, Guided Menu Slice 2.5, the Produce
adapter, the P2A physical-count adapter, and any Production apply or deploy.

---

## Movement type semantics

| Type | Meaning |
|---|---|
| `PURCHASE_RECEIPT` | A confirmed, unblocked P2B purchase document entering MAIN. |
| `REVERSAL` | The exact negative of one earlier movement. |

The `CHECK` list is deliberately **closed** to these two. Every future adapter
(produce issue, physical-count adjustment, sale issue, transfer) must widen it in
its own migration, alongside the adapter that writes it. An open-ended type
column would let an unreviewed caller invent a movement class that no balance
consumer knows how to interpret.

## Signed quantity convention

```
signed_quantity > 0   stock ENTERS the location
signed_quantity < 0   stock LEAVES the location
```

Zero is rejected — a line that moves nothing is not evidence, it is a bug that
would otherwise sit in the ledger looking intentional.

Balance is **always** `SUM(signed_quantity)` grouped by
`(location_code, product_key, unit_key)`. There is no stored balance column: a
stored balance is a second source of truth that drifts the first time a write is
lost or retried, while a derived sum has nothing to disagree with.

A **negative balance is legal** and deliberately not constrained away. A count or
issue can legitimately drive a product below zero when an earlier receipt was
never captured; refusing to represent that would not make the stock exist, it
would only move the error somewhere harder to find.

A transfer is one movement with two lines (negative at origin, positive at
destination). No transfer adapter exists yet, but the line model already admits
one without a schema change.

## Dedupe identity

Every movement carries a globally unique deterministic `dedupe_key`.

For a purchase receipt it is P2B's frozen key, **verbatim**:

```
purchase-receipt-confirmation:v1:{receipt_id}:{confirmation_hash}
```

0053 reads this from `get_purchase_receipt_confirmation()` and **never recomputes
or reinterprets the hash**. If P2B ever changes how it hashes, this migration
inherits the change instead of silently diverging.

Reversal keys are namespaced by the database as
`inventory-movement-reversal:v1:{caller_key}` so they can never collide with a
posting key.

## Source binding

Two protections doing two different jobs:

| Constraint | Job |
|---|---|
| `UNIQUE (dedupe_key)` | **Replay protection.** Re-posting identical frozen content returns the original movement, `replayed=true`, and writes nothing. |
| `inventory_movements_source_posting_uidx` (partial, `WHERE reversal_of_movement_id IS NULL`) | **Source-identity protection.** A source document gets at most one posting movement ever, so a *different* payload/hash for an already-posted receipt fails closed instead of double-counting stock. Reversals are excluded because they legitimately share their original's source. |
| `inventory_movement_lines_source_item_uidx` (partial, `WHERE source_line_id IS NOT NULL`) | **One ledger line per source item, per movement.** A frozen payload repeating a `receipt_item_id` under two ordinals would otherwise post that item twice under a single valid dedupe key. Scoped to `(movement_id, source_line_id)` so a reversal can legitimately reuse the same source lines. |

### A dedupe key match is necessary but not sufficient

The key is an *index into* the ledger, not a proof of what it points at. Before
reporting `replayed=true`, the adapter re-verifies the whole binding against the
frozen contract:

- `movement_type = 'PURCHASE_RECEIPT'`
- `source_system = 'p2b-purchase-receipts'`
- `source_document_type = 'purchase_receipt'`
- `source_document_id` = the requested receipt
- `source_document_version` = the frozen confirmation hash
- `dedupe_key` = P2B's `p2c_dedupe_key`
- the receipt holds a posting lock, and `posting_locked_by = 'p2c-inventory-ledger'`

Any mismatch fails closed — a source-binding mismatch as a duplicate-source
error, a missing or foreign posting lock as an atomicity error. Returning an
unrelated movement would report "already posted" for stock that was never posted
for this content; reporting a replay over a movement whose lock is missing would
hide exactly the atomicity failure the lock exists to make impossible.

### The frozen confirmation hash is mandatory

Validated before any replay decision or insert: it must be present and non-blank,
and it is stored verbatim as `source_document_version`. It is never recomputed. A
missing or blank hash fails closed and creates no movement and no posting lock —
without it, a replay could not be distinguished from a re-post of different
content.

### Quantities are never silently rounded

`text::numeric` accepts far more than `numeric(18,6)` can hold, and the
assignment would silently round a 7th decimal away, turning a malformed payload
into a plausible-looking stock figure. Every quantity is therefore validated
before insertion:

- matches `^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$` — a plain unsigned decimal with
  at most 6 fractional digits. This single gate rejects exponent notation, `NaN`
  and `Infinity` text, signs, padding, empty strings, leading zeros, malformed
  text and over-scale values.
- strictly positive
- below `10^12`, checked *before* the cast so an oversized value is a named
  business error rather than a raw overflow
- round-trip asserted: `v = v::numeric(18,6)`

Exactly supported decimals are unchanged — `0.000001` and `999999999999.999999`
both store and read back verbatim.

Each movement also records `source_system`, `source_document_type`,
`source_document_id` and `source_document_version` (the P2B confirmation hash);
each line records `source_line_id` (the `purchase_receipt_items.id`) and uses the
document's own `item_ordinal` as its `line_ordinal`.

## Append-only and correction rules

Enforced in PostgreSQL by triggers, not merely in TypeScript:

- **Lines** — `UPDATE` and `DELETE` always rejected.
- **Headers** — `DELETE` always rejected. `UPDATE` rejected except the single
  transition `reversed_by_movement_id` `NULL → value`, and even that must point at
  a real `REVERSAL` row that points back, so the link cannot be forged.
- **`line_count`** — verified against the actual lines by a *deferred* constraint
  trigger, so a header can never reach commit with a wrong count, and in
  particular never as a zero-line ghost movement holding a dedupe key hostage.
- **The line set is sealed** by that same `line_count` (see below).

Corrections are expressed as a **new reversing movement**. Nothing is ever edited.

### Sealing: why not a timestamp

An earlier draft compared the parent movement's `created_at` to `now()` and
treated equality as proof of "same transaction". That is a **timestamp
coincidence, not transaction identity**: two transactions can share a
`transaction_timestamp` at microsecond resolution, and `created_at` is a
caller-suppliable column, so an authorized writer could manufacture the match. It
proved nothing it claimed to prove.

It was replaced by a deferred constraint trigger on the lines asserting

```
count(lines for movement M) = M.line_count
```

which needs no clock and no transaction id. Soundness:

1. `line_count` is `NOT NULL`, `CHECK`ed `> 0`, and **immutable** — the header
   `UPDATE` whitelist rejects any change to it.
2. Every movement that **commits** satisfies the equality — the movement's own
   deferred trigger enforces it for the transaction that created it.
3. Lines can **never** be deleted.
4. Therefore any later transaction inserting a line moves the count to
   `line_count + k` (`k ≥ 1`), which by (1) and (3) can never be brought back into
   agreement. The trigger observes the violation at that transaction's commit and
   rejects it.

The only escapes would be changing `line_count` or deleting a line, and both are
closed. A regression test creates a movement carrying a deliberately chosen
`created_at`, then appends a line from a **later** transaction supplying that very
same timestamp — the seal still rejects it.

One behavioural consequence: a late append is now refused at **commit** rather
than at statement time. Nothing persists either way.

## Reversal rules

- A movement may be reversed **at most once** — `UNIQUE (reversal_of_movement_id)`
  plus the header back-link.
- A `REVERSAL` may **not itself be reversed** (rejected by trigger *and* by the
  RPC). Re-posting after a reversal is a new source document with a new dedupe
  key, which is an auditable act; "un-reversing" is not.
- Reversal lines are **exact negatives**: same `product_key`, `unit_key`,
  `location_code`, `source_line_id` and `line_ordinal`, quantity `* -1`, so each
  pairs 1:1 with the line it undoes.
- The reversal inherits the original's `business_date` — a reversal belongs to
  the period it undoes, not the day someone noticed the mistake.
- **Idempotent** on an explicit caller-supplied reversal key. The same key
  replays; a *different* key against an already-reversed movement fails closed.

## P2B atomic posting sequence

`post_purchase_receipt_inventory_movement(p_receipt_id, p_actor)`

1. `SELECT ... FOR UPDATE` on `purchase_receipts` — concurrent posts of one
   receipt serialize here.
2. Reject `void`; reject anything other than `confirmed`.
3. Read the frozen contract via `get_purchase_receipt_confirmation()` — the
   authoritative P2B surface, never the live tables or a local re-derivation.
4. Take `p2c_dedupe_key` verbatim. If it is already posted → return the original,
   `replayed=true`.
5. If the receipt already has a posting movement under a *different* key → fail
   closed (`already posted as movement …`).
6. Verify `has_blocking_blockers = false`, `posts_inventory_movement = false`,
   `intended_warehouse_code = 'MAIN'`, and that declared `item_count` matches the
   actual array.
7. Per item: `receipt_item_id` and `item_ordinal` present, product and unit
   identity `RESOLVED`, non-blank keys, quantity `> 0`.
8. Insert one movement header, then one positive MAIN line per item.
9. `lock_purchase_receipt_for_posting(receipt_id, 'p2c-inventory-ledger')` — in
   **this same transaction**.

The function has **no `EXCEPTION` block on purpose**: a `BEGIN … EXCEPTION` block
would open a subtransaction and could swallow a failure, leaving one half of the
movement/lock pair committed. Failures must propagate, so the pair is genuinely
all-or-nothing.

`void_purchase_receipt()` refuses a standalone void once the lock is held. 0053
does **not** clear, bypass or weaken that barrier.

## Balance read model

- `public.inventory_balances` — `SECURITY INVOKER` view,
  `SUM(signed_quantity)` grouped by location/product/unit. Reversal lines are
  ordinary negative lines, so a reversed movement nets to zero with no
  special-casing and no exclusion predicate to keep in sync.
- `get_inventory_balances(p_location_code, p_product_key, p_unit_key, p_include_zero)`
  — returns `quantity_balance` as **TEXT**. PostgREST serializes `numeric` as a
  JSON number, which rounds through an IEEE754 double; that is the one thing an
  exact-quantity ledger must never do.

Zero balances are omitted unless `p_include_zero` is explicitly true. Ordering is
deterministic: `location_code`, `product_key`, `unit_key`.

## Security model

Mirrors 0047 and 0052.

- RLS **enabled** on all three tables, **zero policies**. `anon`/`authenticated`
  hold no grants at all; `service_role` reads via `BYPASSRLS`.
- Every table is `REVOKE ALL … FROM service_role` **before** the intended
  `GRANT SELECT`. Production carries broad default ACLs, so without the revoke an
  inherited `GRANT ALL` would leave `INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
  TRIGGER` in place and every "mutation only via RPC" claim would be false. The
  test suite seeds exactly that production hazard via
  `ALTER DEFAULT PRIVILEGES … GRANT ALL` *before* applying 0053, so the assertions
  are meaningful rather than vacuous.
- Only the **two mutating RPCs** are `SECURITY DEFINER`. The read-only balance RPC
  is `SECURITY INVOKER`: it needs no elevation, so a leaked `EXECUTE` grant still
  reads nothing without table `SELECT`.
- All three RPCs pin `search_path = public, extensions, pg_temp`, and every object
  reference inside them is schema-qualified.
- Trigger guards are **not** `SECURITY DEFINER` and hold no `EXECUTE` grant.

## Future adapter boundaries (not implemented)

| Adapter | Shape |
|---|---|
| **Produce issue** | `source_document_type = 'produce_session'`, negative MAIN lines, dedupe on the produce finalization identity. |
| **P2A physical count** | `source_document_type = 'physical_inventory_snapshot'`, a signed **ADJUSTMENT** movement for the *difference* between counted quantity and ledger balance — never an absolute overwrite, which would destroy the append-only audit chain the ledger exists to provide. |

Both need a new `movement_type` CHECK value, a new `source_document_type`, and
their own posting RPC. Neither needs a change to the line model.

### Atomic receipt-void adapter (deferred, with reason)

Reversing a purchase movement does **not** void the P2B document. The intended
future adapter is:

```
void_purchase_receipt_with_ledger_reversal(receipt_id, reversal_key, reason, actor)
  1. SELECT ... FOR UPDATE on purchase_receipts
  2. locate the posting movement by (purchase_receipt, receipt_id)
  3. reverse_inventory_movement(...)                -- same transaction
  4. release the posting lock and void the document -- same transaction
```

Step 4 requires a **P2B-owned RPC** that clears `posting_locked_at` as part of the
void. That primitive does not exist at 0052 and must not be simulated from P2C by
a direct `UPDATE`: P2C writing P2B's lifecycle columns behind the RPC boundary is
precisely the coupling the posting lock was created to prevent. The adapter
therefore waits for that P2B primitive rather than reaching around it.

## TypeScript surface

`src/lib/inventory-ledger/`

| File | Role |
|---|---|
| `types.ts` | Contract types and constants. Quantities are decimal **strings**. |
| `validate.ts` | Fail-closed runtime validation. No casts; a `number` where an exact quantity belongs is rejected outright, because it has already lost precision. The **posting lock is required** on every accepted posting result, replay included: `posting_locked_at` must be a parseable non-empty timestamp and `posting_locked_by` must be exactly `p2c-inventory-ledger`, so a response describing a movement without its lock is refused rather than typed as success. |
| `ledger-service.ts` | `postPurchaseReceipt`, `reverseMovement`, `getBalances`, plus typed errors and RPC error mapping. |

Typed errors: `InventoryNotFoundError`, `InventoryInvalidLifecycleError`,
`InventorySourceBlockedError`, `InventoryUnresolvedIdentityError`,
`InventoryDuplicateSourceError`, `InventoryAlreadyReversedError`,
`InventoryAppendOnlyViolationError`, `InventoryPostingAtomicityError`,
`InventoryContractViolationError`. An unrecognised failure stays a plain `Error`
rather than being flattened into a business case.

## Tests

- `src/lib/inventory-ledger/ledger-service.test.ts` — 47 unit tests (marshalling,
  error mapping, fail-closed response handling, posting-lock enforcement).
- `src/lib/inventory-ledger/migration-0053.pg.test.ts` — 72 tests against a real
  disposable **PostgreSQL 17** database.

Concurrency tests use a deterministic advisory-lock barrier (poll `pg_locks`
until the blocking session's lock is visible), never a sleep whose length the
assertion depends on.

Two cases use **fault injection** — replacing the P2B posting-lock RPC and the
P2B confirmation getter — to reach guards that a well-behaved P2B cannot trigger.
The injection runs inside a transaction that is **rolled back**; PostgreSQL DDL is
transactional, so the real function is restored by the database itself rather than
by a manual restore step that could fail and leak a fake into later tests.

No Production data, real or fabricated, is used anywhere.
