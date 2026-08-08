# P3 Final Sprint — Handoff

Updated: 2026-08-08. Status: **ARCHITECTURE FROZEN — implementation in progress.**

## Workspace

| Item | Value |
|---|---|
| Worktree | `C:\GitHub\_worktrees\Bot-summary-p3-final` |
| Branch | `feat/p3-profit-loss-final` |
| Integration base SHA | `ad9c37daa19b40dc095182d8650c3441b407cfd3` |
| Base parents | `04e5d9f4290f4498cfa6f08a8aa3957285592675` (P2E, PR #38) + `6ea7423e85257790964dde6412d52cbcbad0440b` (P2D, PR #36) |
| Merge result | clean — no conflicts (`.github/workflows/pg-tests.yml` and `src/types/database.ts` auto-merged) |
| Old blocked worktree | `C:\GitHub\Bot-summary-p3` @ `10db01b` (branch `feat/p3-profit-loss`) — **preserved unchanged, reference only** |

## Dependency state (verified 2026-08-08 via `gh pr list`)

| PR | Branch | Head | State |
|---|---|---|---|
| #38 P2E | `feat/p2e-accountability-round-identity` | `04e5d9f4290f4498cfa6f08a8aa3957285592675` | **OPEN** |
| #36 P2D | `feat/p2d-actual-cost` | `6ea7423e85257790964dde6412d52cbcbad0440b` | **OPEN** |

Neither is merged. `origin/main` = `a2121413818707732f24441659fdd4c2ba681237`.
`feat/p3-profit-loss` was **never pushed** (`git ls-remote --heads origin` has no P3 ref),
so the old P3 migration `20260808120000_profitability_snapshots.sql` is local and
unpublished — it may be replaced outright.

## Salvage classification (old `feat/p3-profit-loss`, 3 files)

| File | Verdict | Note |
|---|---|---|
| `docs/plans/p3-profit-loss.md` (682 l) | **REUSE (concepts) / REWRITE (identity)** | Formula reasoning, residual-COGS discipline, reason vocabulary, satang rules, NULL-propagation, recalculation policy all survive. §4 round identity is invalid and is replaced. |
| `supabase/migrations/20260808120000_profitability_snapshots.sql` (1371 l) | **DROP** | Tuple-keyed identity `(source_id, market_label_normalized, business_date)` in the unique key, advisory lock, dedupe key and lineage joins. Unpublished, so no rewrite hazard. |
| `supabase/tests/p3_profitability_bootstrap.sql` (174 l) | **REUSE (adapted)** | The produce/pricing/white-sheet table shapes and the verbatim 0037 views are correct and reused; extended for the P2E/P2D chain. |

## Frozen architecture

**Snapshot identity: `(accountability_round_id, revision)`. No descriptive tuple anywhere.**

- Advisory lock: `pg_advisory_xact_lock(hashtext('profitability:' || accountability_round_id::text))`.
- Revision: `max(revision) + 1` per `accountability_round_id`, allocated under that lock.
- Dedupe / idempotency: `dedupe_key = 'profitability:v1:' || accountability_round_id || '|' || input_hash`.
- Line grain: `(location_code, product_key, unit_key)`, taken from the round's proven 0053 `ISSUE` ledger lines.
- Immutability: append-only triggers on all three tables; the only permitted UPDATE is
  `superseded_by_snapshot_id` NULL → value, once.

**Canonicalization boundary.** SQL never derives `product_key`/`unit_key` from
`produce_items.product_name`/`unit` — 0053:311-313 forbids re-implementing the
application resolver. The caller supplies `p_quantity_attributions`
(`[{produce_item_id, location_code, product_key, unit_key}]`) and SQL *verifies* it:
every attributed item must belong to the round, every round produce item must be
attributed exactly once, and the attributed issued quantity must equal the proven
ledger `ISSUE` quantity for the same key.

**Cost.** Issued and good-return cost come from 0054 cost lines bound to the round.
Damage has no ledger event by design (posting one would double-decrement `MAIN`),
so damage loss is prorated at the round's own proven issue rate. COGS is the
residual, never a third rounding:

```
issued_cost      = -Σ signed_value_satang over the round's ISSUE cost lines
good_return_cost = +Σ signed_value_satang over the round's GOOD_RETURN cost lines
damage_loss      = round(issued_cost × damaged_qty / issued_ledger_qty)
cogs_sold        = issued_cost − good_return_cost − damage_loss
```

**Purchasing expenses.** No repo artifact links a `purchase_receipt` to a round.
The term is caller-supplied with proving receipt ids, or NULL +
`purchasing_expenses_unattributable`. Never defaulted to zero.
See "Open business decision" below.

## Prohibited in this sprint

merge P2E / P2D / P3 · deploy · apply Production migrations · mutate Production ·
send LINE · enable/disable cron · rewrite applied migrations · hard-delete history ·
infer round identity from descriptive fields · invent zero cost · create synthetic
`market_sale` movements · modify `uat-preview-results/` · touch unrelated local WIP
(the dirty index in `C:\GitHub\Bot-summary` is someone else's).

## Open business decision (flagged, not blocking)

`− purchasing expenses` is in the authoritative expected-operating-P/L formula, but
this repository has no attribution from a warehouse purchase receipt to a market
round, and P2D rule 9 refuses to allocate receipt-level freight/handling/discount/VAT
even into product cost. Implemented as an explicit caller-supplied input with proving
receipt ids; absent it, the snapshot is INCOMPLETE. An explicit `0` is a legal,
distinct assertion. If the owner rules that purchasing expenses are *not* a market-round
operating expense, the term becomes a constant 0 and one reason disappears — a one-line
change, no schema impact.

## Files changed so far

- (integration merge only)

## Tests run so far

- none

## Exact next action

Write `supabase/migrations/20260808130000_p3_profitability_snapshots.sql`.
