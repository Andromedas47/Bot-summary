# P3 — COGS and Profit / Loss (round-identity final)

Supersedes `docs/plans/p3-profit-loss.md`, which was correct about the accounting
and wrong about identity. Migration: `20260808130000_p3_profitability_snapshots.sql`.

Requires **P2E** (`20260808105001_p2e_accountability_round_identity.sql`, PR #38)
and **P2D** (`0054_inventory_cost_valuation.sql`, PR #36). Neither is merged; see
`docs/handoffs/p3-final-sprint-handoff.md`.

---

## 1. Identity

```
snapshot identity = (accountability_round_id, revision)
```

Nothing else. Not `source_id`, not market, not seller, not `business_date`, and
no combination of them — in the unique key, the advisory lock, the dedupe key,
the input hash, any lineage join, or any read filter.

Two rounds may carry identical source, market, seller and business date and
still be two economically distinct accountability cycles
(`accountability_rounds` table comment, P2E:51-53). They get two UUIDs, two
advisory-lock keys, two independent revision sequences and two snapshots.

`accountability_round_id` is `NOT NULL` on the snapshot. A legacy artifact with
a NULL round therefore has no snapshot at all, and can never be merged into a
modern round by a descriptive fallback — the fallback does not exist to be taken.

## 2. What it never does

- writes or alters an inventory quantity movement (it only reads 0053)
- writes or alters a cost line (it only reads 0054)
- creates a `market_sale` movement — the warehouse `ISSUE` already removed the
  sellable stock, so a derived sale movement would decrement it twice
- recomputes a weighted average
- guesses a round for an unbound artifact
- substitutes `0`, a standard price, or another round's figure for a missing cost

## 3. Line grain and the canonicalization boundary

A snapshot line is one `(location_code, product_key, unit_key)` — the 0054
balance key verbatim, so cost provenance joins without inventing a second
identity, and units and locations stay isolated structurally.

`produce_items.product_name` / `unit` are Thai operator text;
`product_key` / `unit_key` are application-canonical. The resolver is the
application's (`0053:311-313` forbids re-implementing it in SQL), so the caller
supplies `p_quantity_attributions`:

```
[{ produce_item_id, location_code, product_key, unit_key }]
```

and SQL **verifies** rather than trusts it:

| Check | Failure |
|---|---|
| attributed item belongs to this round | raise `cross_round_artifact` |
| no item attributed twice | raise |
| every round produce item attributed | reason `produce_item_unattributed` |
| attributed issued qty = proven ledger `ISSUE` qty | reason `issue_quantity_mismatch` |
| attributed good-return qty = proven ledger `GOOD_RETURN` qty | reason `good_return_quantity_mismatch` |

A mis-canonicalized attribution therefore surfaces as a mismatch reason instead
of a wrong number.

## 4. Quantities

```
sold = issued − good return − approved damaged        (per line)
```

Read from `public.produce_transactions` filtered by `accountability_round_id`.
Missing return types are zero; no return rows means sold out. `sold < 0` raises
`negative_sold_quantity` — it is a contradiction in the operational record, not
a degraded result, and is never clamped.

**Approved** damage is a `คืนเสีย` row visible in the view. **Rejected** damage
is a voided session, filtered out by `produce_transactions` (`0037:136-137`), so
it structurally cannot reduce anything. **Pending** damage has not reached the
view yet; it is surfaced as `pending_produce_sessions` from
`pending_sessions` bound to the same round, which blocks certification without
changing a quantity. All three guarantees hold structurally.

## 5. Cost

Issued and restored costs come from 0054 cost lines reached through movements
bound to this round, excluding anything reversed:

```
issued_cost      = −Σ signed_value_satang   over active ISSUE cost lines
good_return_cost = +Σ signed_value_satang   over active GOOD_RETURN cost lines
damage_loss      = round(issued_cost × damaged_qty / issued_ledger_qty)
cogs_sold        = issued_cost − good_return_cost − damage_loss
```

`GOOD_RETURN` is already valued `SOURCE_ISSUE_SNAPSHOT` by P2D rule 7 — it
restores the proven original issue cost and refuses across rounds — so P3 reads
it rather than re-deriving it.

**Damage has no ledger event by design.** The stock left `MAIN` on the issue and
never came back; posting a `DAMAGED_WRITE_OFF` against `MAIN` would decrement
`MAIN` a second time. So damage is valued at the round's own proven issue rate,
which is what "at its proven issue cost" means here — never the warehouse moving
average, which is a rate the stock never had.

**COGS is a residual, not a third rounding.** Returning everything gives exactly
`0`; returning nothing gives exactly `issued_cost`; no sequence of partial
returns strands satang. Three independent roundings would break all three.

If any `ISSUE` ledger line of a key has no cost line, that key's `issued_cost`
is NULL with `issue_cost_unvalued`, and NULL propagates through every term that
consumes it. Never zero.

## 6. Money

```
expected_money        = Σ round(sold_qty × price_satang)         per line, one rounding each
standard_margin       = expected_money − cogs_sold
approved_wages        = white_sheet.labor × 100
approved_expenses     = (location_fee + bag + snack + other) × 100
expected_operating_pl = expected_money − cogs_sold − damage_loss
                        − approved_expenses − approved_wages − purchasing_expenses
shortage_overage      = actual_cash − (expected_money − verified_transfers − expense_total)
realized_pl           = expected_operating_pl + shortage_overage
```

Sign convention for `shortage_overage` is `actual − expected`: **positive is an
overage, negative a shortage**, identical to `src/lib/white-sheet/calculate.ts:423-429`.
An overage therefore increases realized P/L, which is why the term is added.

Price is `central_selling_prices.price_satang` for
`(product_key, unit_key, round.business_date)` — BR-01's sole trusted price,
never `produce_items.price_per_unit`. Missing → NULL + `missing_central_price`.

White-sheet money is `numeric(12,2)` **baht**, exact by column type, so `× 100`
is an exact satang conversion, not a rounding. `finalized_at IS NOT NULL` is the
only approval gate this repository has (`0043:14-16`); P3 does not invent a
second one.

`verified_transfers` is caller-supplied exact satang plus the row ids that prove
it. Market-scoped slip attribution is application logic
(`src/lib/reconciliation.ts`); re-deriving it in SQL would be a second,
divergent implementation of a money rule. Every supplied id is verified to
carry this `accountability_round_id` or the call is refused.

All persisted money is `numeric(24,0)` integer satang with a `= trunc(...)`
CHECK, and leaves the read RPC as `::text` so no IEEE-754 double ever touches it.

## 7. Purchasing expenses

No column, index or reviewed contract links a `purchase_receipt` to a market
round, and P2D rule 9 refuses to allocate receipt-level freight/handling/
discount/VAT even into product cost. So P3 treats the term the same way it
treats verified transfers: caller-supplied exact satang plus proving
`purchase_receipt` ids (each verified to be a confirmed receipt). Absent it the
term is NULL with `purchasing_expenses_unattributable` and the P/L is INCOMPLETE.
An explicit `0` is a legal and distinct assertion. It is never defaulted.

## 8. Completeness

```
CERTIFIED  ⟺  incomplete_reasons = '{}'
```

enforced by CHECK, alongside a second CHECK that a `CERTIFIED` row carries no
NULL money term — so the state and the numbers cannot drift apart.

Reasons: `issue_movement_unbound`, `issue_cost_unvalued`,
`issue_quantity_mismatch`, `good_return_cost_unvalued`,
`good_return_quantity_mismatch`, `missing_central_price`, `no_round_activity`,
`produce_item_unattributed`, `pending_produce_sessions`,
`accountability_round_open`, `white_sheet_missing`, `white_sheet_not_finalized`,
`missing_verified_transfers`, `purchasing_expenses_unattributable`.

Hard refusals (raise, never degrade): `accountability_round_not_found`,
`cross_round_artifact`, `negative_sold_quantity`, `invalid_satang_input`,
`required_artifact_unbound`, `profitability_ledger_is_append_only`.

A partially calculable round still exposes the subtotals it can prove; it just
cannot claim a certified realized profit.

## 9. Revisions, idempotency, immutability

- `revision` = `max(revision) + 1` **per `accountability_round_id`**, allocated
  under `pg_advisory_xact_lock(hashtext('profitability:' || round_id))`. Two
  rounds sharing every descriptive field hash to two different keys, so both
  independently begin at revision 1 and neither blocks the other.
- `input_hash` = sha256 over the ordered digest of every line, the reasons, the
  white-sheet money and finalization state, the caller-supplied amounts and
  their proving ids, and the round status. Anything that can move a number is in
  it; anything in it produces a new revision when it moves.
- `dedupe_key = 'profitability:v1:' || round_id || '|' || input_hash`. Identical
  inputs replay and write nothing (`replayed: true`).
- Changed inputs append revision *n+1* and set `superseded_by_snapshot_id` on
  *n*. That column moving NULL → value once is the only mutation any P3 table
  permits; everything else raises `profitability_ledger_is_append_only`.
- Nothing recalculates automatically. No trigger, no cron, no cache hook.

## 10. Lineage

`profitability_snapshot_sources` records every contributing artifact: produce
items and sessions, inventory movements and lines, 0054 cost lines, central
prices, the white-sheet cash row and its lifecycle events, settlement entries,
transfer reconciliations, slip batches and evidence, manual slip sessions, and
the purchasing-expense receipts. Every automatic source is selected **by round
id**, so a Round A artifact structurally cannot appear under Round B; every
caller-supplied id is proven to belong to the round before it is stored.

## 11. Security

RLS enabled with zero policies on all three tables (`service_role` reads via
BYPASSRLS, matching 0053/0054). `REVOKE ALL` from `PUBLIC`, `anon`,
`authenticated` **and** `service_role` before granting `SELECT` to
`service_role` only — Production carries broad default ACLs. All DML is through
`record_profitability_snapshot`, `SECURITY DEFINER` with
`SET search_path = public, extensions, pg_temp`, `EXECUTE` granted to
`service_role` only. The read RPC is `SECURITY INVOKER` on purpose: it needs no
elevation, so a leaked grant still cannot read past the caller's own privileges.
Trigger functions are granted to nobody.

## 12. Migration order

```
0053  inventory movement ledger        (on main)
0054  inventory cost valuation         (P2D, PR #36)
...
20260808105001  accountability round identity   (P2E, PR #38)
20260808130000  profitability snapshots         (P3, this file)
```

Lexical caveat: `0054_*` sorts before `0055`–`0062` and before every `2026*`
timestamped file. That is harmless — 0054 depends only on 0053 — but it means
the numeric and timestamp naming schemes interleave, and P3 must stay in the
timestamp scheme, after P2E, to land last.

P3 has never been applied to Production and is not applied in this cycle. The
previous, unpublished P3 migration `20260808120000_profitability_snapshots.sql`
was never pushed to any remote and is replaced outright rather than amended.
