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

## Real-PostgreSQL apply chain (verified, ~60s)

```
supabase/tests/purchase_capture_slice_b_bootstrap.sql
supabase/migrations/0052_purchase_receipt_persistence.sql
supabase/tests/purchase_capture_slice_c_pre_0053.sql
supabase/migrations/0053_inventory_movement_ledger.sql
supabase/migrations/0054_inventory_cost_valuation.sql          <- P2D
supabase/tests/p3_profitability_bootstrap.sql
supabase/migrations/20260808105001_p2e_accountability_round_identity.sql   <- P2E
supabase/migrations/20260808130000_p3_profitability_snapshots.sql          <- P3
```

`purchase_capture_slice_c_hardening.sql`, `purchase_capture_slice_c_post_0053.sql`
and the `20260805*` purchase-capture migrations are deliberately NOT in the chain:
they are unrelated to P3, and `slice_c_hardening` executes a `pg_sleep` timeout
assertion — **that is the root cause of the previously reported ">600s local
PostgreSQL hang"**, not 0053/0054. Confirmed via `pg_stat_activity`
(`wait_event = PgSleep`).

## Files changed

| File | State |
|---|---|
| `supabase/migrations/20260808130000_p3_profitability_snapshots.sql` | new, applies clean |
| `supabase/tests/p3_profitability_bootstrap.sql` | new |
| `docs/plans/p3-profit-loss-final.md` | new, frozen contract |
| `docs/handoffs/p3-final-sprint-handoff.md` | this file |
| `src/lib/profitability/*` | in progress (TypeScript service, validators, formatter, tests) |
| `src/lib/profitability/migration-p3.pg.test.ts` + `.github/workflows/pg-tests.yml` | in progress (real-PostgreSQL matrix + CI job) |

## Verified so far

Migration applies clean on the chain above. Smoke test proves:
two same-description rounds get distinct UUIDs; each independently allocates
revision 1; `sold = issued − good return − damaged` (10 − 2 − 1 = 7);
`expected_money = 35000` satang at a 5000-satang price; every cost term is NULL
with `issue_movement_unbound` when no ISSUE is posted (never 0); an identical
retry returns `replayed: true` with the same `snapshot_id` and no second
revision; a Round A produce item attributed to Round B raises
`cross_round_artifact`; lineage contains only Round A artifacts.

## Report integration — deliberate scope decision

P3 exposes `ProfitabilityService.getSnapshot` and `formatProfitabilitySnapshot`.
The Digital White Sheet page model (`src/lib/white-sheet/compose.ts`) is **not**
modified: it is a live UAT money surface with a hard-stop error path, and wiring
it to an unreleased layer whose two dependencies are still unmerged would be the
wrong trade. The wiring point is `loadDigitalWhiteSheetPageModel`, which already
has the `accountability_round_id` in scope.

## Final sprint result — 2026-08-08

Status: **P3 TEST/CI READY — AWAITING CLAUDE FINAL LEAD REVIEW**

- PostgreSQL worker output was coherent uncommitted work and was preserved.
- P3 PostgreSQL matrix: 40 required scenarios grouped into 12 test blocks;
  **12 pass / 0 fail / 325 assertions**.
- P2D PostgreSQL compatibility: **32 pass / 0 fail / 250 assertions**.
- P2E PostgreSQL compatibility: **1 pass / 0 fail / 46 assertions**.
- Focused settlement/reconciliation compatibility:
  **102 pass / 0 fail / 294 assertions**.
- P3 TypeScript bundle after the targeted contract fix:
  **111 pass / 0 fail / 313 assertions**.
- Defect found and fixed: the TypeScript caller accepted negative verified
  transfers/purchasing expenses even though the PostgreSQL RPC rejects them.
  Both client inputs now fail before an RPC call, matching the money contract.
- Typecheck: clean.
- Build: clean with documented non-production placeholder Supabase variables.
  The first attempt compiled but could not prerender `/overview` because this
  worktree has no Supabase environment; no live service was contacted.
- Lint: exit 0, no errors; 65 pre-existing warnings outside changed P3 files.
- `git diff --check`: clean (Windows line-ending notices only).
- CI: dedicated `p3-profitability` PostgreSQL 17 job added. It runs P3, P2D,
  P2E, typecheck, and diff-check with required-PostgreSQL flags. A forced
  unreachable-port probe exits 1, proving PostgreSQL absence cannot green-skip.
- New commits:
  - `73b24f9` — real-PostgreSQL matrix and CI protection
  - `3c8c11d` — TypeScript/PostgreSQL input-contract alignment
  - `503d891` — final validation handoff
- Branch pushed as `origin/feat/p3-profit-loss-final`; no PR opened while the
  dependency PRs remain unmerged.
- Final git status: clean, tracking `origin/feat/p3-profit-loss-final`.
- Integration-base application regression remains **270 pass / 0 fail**.
- Exact remaining work: Claude final lead review; dependency PRs #36 and #38
  must still land before opening a truthful P3 PR against `main`.
- Production mutations: none. No deploy, Production migration, or LINE send.
