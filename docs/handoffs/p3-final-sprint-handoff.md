# P3 Final Sprint — Handoff

Updated: 2026-08-09. Status: **P3 END-TO-END RELEASE PACKAGE COMPLETE — WAITING
ONLY FOR DEPENDENCY RELEASE.** See the RELEASE PACKAGE and END-TO-END SURFACE
sections at the end of this file for the current state; the sections above are
the sprint history that produced it.

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
supabase/migrations/20260729084558_purchase_receipt_persistence.sql
supabase/tests/purchase_capture_slice_c_pre_0053.sql
supabase/migrations/20260729172613_inventory_movement_ledger.sql
supabase/migrations/20260809063116_inventory_cost_valuation.sql          <- P2D
supabase/tests/p3_profitability_bootstrap.sql
supabase/migrations/20260809045345_p2e_accountability_round_identity_expand.sql   <- P2E
supabase/migrations/20260809075951_p3_profitability_snapshots.sql          <- P3
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
| `supabase/migrations/20260809075951_p3_profitability_snapshots.sql` | new, applies clean |
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

## Report integration — completed in the end-to-end surface sprint

P3 exposes `ProfitabilityService.getSnapshot` and `formatProfitabilitySnapshot`.
They are now wired into `loadDigitalWhiteSheetPageModel` as a **read-only**
attach: page load never calls `recordSnapshot` or any profitability write RPC.
See **END-TO-END SURFACE — 2026-08-09** below.

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

---

# RELEASE PACKAGE — 2026-08-09

Status: **P3 END-TO-END RELEASE PACKAGE COMPLETE — WAITING ONLY FOR DEPENDENCY
RELEASE.** (Supersedes the earlier "release package complete" wording once the
White Sheet read surface landed; see END-TO-END SURFACE below.)

No P3 architecture work, implementation work or known test gap remains. What is
left is a mechanical release sequence gated on PRs #36 and #38.

## Final head and commit set

| Item | Value |
|---|---|
| Integration base | `ad9c37daa19b40dc095182d8650c3441b407cfd3` (`04e5d9f` P2E + `6ea7423` P2D) |
| Branch | `feat/p3-profit-loss-final` |
| Head before this sprint | `0f851221fb817752d2d2e0f5eead79d46965227a` |
| Head after this sprint | `99a5f7e23899e3b82e95265978e6e1507aefe41c` (plus any later documentation-only commit) |

The authoritative commit list is always
`git log --oneline ad9c37d..origin/feat/p3-profit-loss-final`, not this table.
As of the release-package sprint it is these eleven, in order:

```
235b8d5  feat(profitability): P3 COGS and profit/loss snapshots keyed by accountability round
a43bcae  fix(profitability): refuse to certify a round carrying an unsupported movement
163e037  fix(profitability): refuse a negative or fractional verified-transfer amount
10fee89  feat(profitability): add the P3 service, validators and Thai report block
73b24f9  test(profitability): verify the PG money matrix
3c8c11d  fix(profitability): align caller money validation
503d891  docs(profitability): record final sprint readiness
49701a3  docs(profitability): record published branch state
0f85122  fix(profitability): refuse to certify a cancelled accountability round
af135c9  test(profitability): prove settlement and White Sheet round isolation
99a5f7e  docs(profitability): add the Production release runbook and release package
```

The earlier "four commits" note in a prior handoff was wrong; nine were required
before this sprint, and this sprint adds two: the round-isolation regressions and
the release-package record.

## P3-only delta (15 files, verified against `ad9c37d`)

| File | State |
|---|---|
| `supabase/migrations/20260809075951_p3_profitability_snapshots.sql` | new — the only migration |
| `supabase/tests/p3_profitability_bootstrap.sql` | new — test fixtures |
| `src/lib/profitability/{types,validate,profitability-service,format}.ts` | new — service layer |
| `src/lib/profitability/{format,profitability-service}.test.ts` | new — TypeScript suites |
| `src/lib/profitability/migration-p3.pg.test.ts` | new — real-PostgreSQL matrix |
| `src/types/database.ts` | modified — **additive only**, the two P3 RPC signatures |
| `package.json` | modified — additive only, `test:pg:p3` script |
| `.github/workflows/pg-tests.yml` | modified — additive only, the `p3-profitability` job |
| `docs/plans/p3-profit-loss-final.md` | new — frozen contract |
| `docs/p3-production-release-runbook.md` | new — preflight / verification / smoke / rollback |
| `docs/handoffs/p3-final-sprint-handoff.md` | this file |

Contamination audit: **clean.** No file belonging to P2E or P2D appears in the
P3-only commit set (no `0054*`, no `20260808105001*`, no `src/lib/inventory-cost/`,
no `src/lib/accountability-round/`). The three modified files are strictly
additive. No `TODO`/`FIXME`/`console.log`/`.only(`/`.skip(` in the added lines. No
unrelated WIP.

## Final test state

| Suite | Result |
|---|---|
| P3 PostgreSQL 17 matrix | **15 pass / 0 fail / 461 assertions** (was 13 / 344) |
| ↳ new: settlement cross-round isolation | pass |
| ↳ new: White Sheet cross-round isolation | pass |
| P3 TypeScript | **111 pass / 0 fail / 318 assertions** |
| Full focused P3 bundle | **126 pass / 0 fail / 779 assertions** |
| P2E PostgreSQL (P3's only identity) | **1 pass / 0 fail / 46 assertions** |
| P2D PostgreSQL 0054 (P3's cost source) | **32 pass / 0 fail / 250 assertions** |
| Settlement / reconciliation / White Sheet compatibility (21 files) | **300 pass / 0 fail / 820 assertions** |
| Typecheck | clean |
| Build | clean (documented non-production placeholder Supabase variables) |
| Lint | 0 errors, 65 pre-existing warnings, **none** in a P3 file |
| `git diff --check` | clean (Windows line-ending notice only) |

The previously reported Windows-local P2D `pg_sleep`/host-speed timeout did
**not** reproduce this run: 0054 completed 32/32 in 642s, with one
byte-identical-replay test alone taking 402s. P3 changes nothing about that
test's behaviour, so it is not a P3 signal either way.

## Coverage gaps closed

The independent review named two. Both are now real PostgreSQL regressions
exercising production SQL, not query inspection. **Neither exposed a defect** —
the implementation was already correct; it is now proven.

**1. Settlement cross-round isolation.** Three rounds sharing every descriptive
field (source, owner, business date, seller, market). Rounds A and B each own a
settlement entry, settlement finalization, transfer reconciliation and slip
batch whose descriptive columns are *byte-identical* — same `settlement_time`
included — differing only in `accountability_round_id`. Round C owns none. Proven:

- the descriptive tuple is genuinely ambiguous (asserted, not assumed: one
  distinct descriptive tuple across two distinct rounds);
- the exact query a descriptive implementation would run for Round C finds both
  siblings' rows, while Round C's snapshot lineage contains **zero** settlement,
  finalization, reconciliation or slip-batch artifacts;
- each round's lineage contains exactly its own evidence and never its twin's,
  in both directions;
- explicit cross-round transfer-source ids are refused per id and per class
  (`cross_round_artifact`), and one valid own-round id does not launder a
  cross-round id beside it;
- a settlement entry or finalization id is refused as transfer evidence even
  from its **own** round, which proves the lineage classifier's final `ELSE
  transfer_reconciliation` branch is unreachable for an unproven id;
- every refusal was a refusal: no extra revision, no mislabelled lineage row.

**2. White Sheet cross-round isolation.** Three descriptively identical rounds
with identical produce, cost and price, so every difference in the result comes
from the White Sheet alone. Round A: wages 50 000 satang, expenses 1 000, cash
123 400. Round B: wages 90 000, expenses 10 000, cash 432 100. Round C: none.
Proven:

- with no sheet of its own, Round B is `INCOMPLETE` with `white_sheet_missing`,
  and wages/expenses/cash/operating/shortage/realized are all **NULL** — while
  `cogs_sold_satang` is still exactly `500`, so a missing sheet neither coerces
  COGS to 0 nor suppresses it;
- the moment Round B has its **own** sheet the reason disappears and not one
  moment earlier, and the figures are B's own 90 000 / 10 000 / 432 100 — not
  A's 50 000, and not a sibling merge of 140 000;
- Round A still reads 50 000 / 1 000 / 123 400, so two rounds with identical
  produce, cost and price legitimately reach different operating P/L;
- Round C, with two funded identically-described siblings, stays `INCOMPLETE`
  with NULL money, and a SQL-level check over the real tables shows zero overlap
  between what a descriptive lookup would hand Round C and what Round C's
  lineage recorded — which also covers any legacy round-unbound sheet sharing
  the tuple;
- a second sheet for one round is rejected by
  `digital_white_sheet_cash_entries_accountability_round_uidx`, which is what
  makes the round-keyed read single-valued;
- neither sibling's sheet was mutated: P3 reads money, it never writes it back.

## Migration rehearsal

Disposable PostgreSQL 17.10, created and dropped locally. Production never
contacted. Full detail and the reusable verification SQL are in
`docs/p3-production-release-runbook.md` §4 and §8.

- **Order A** (Production version order `0053` → `0054` P2D → P2E → P3): applies
  clean, 8/8.
- **Order B** (out of order, `0053` → P2E → `0054` P2D → P3): applies clean, and
  the resulting `public` schema dump is **identical** to order A — only
  pg_dump 17's random `\restrict` nonce differs. The one object both P2D and P2E
  drop-and-recreate, `inventory_movements_movement_type_check`, is defined with
  the same six values in both, so the outcome is order-independent.
- **Additivity**: a fingerprint of every non-P3 relation, column, constraint,
  index, trigger, function body, ACL and RLS flag, plus every legacy
  round-unbound row, is **byte-identical before and after** applying P3. The
  migration contains three `CREATE TABLE`, three `ENABLE ROW LEVEL SECURITY` on
  those new tables, functions, triggers and grants — and no `ALTER` of an
  existing table, no `DROP`, and no DML at all.
- **Object names**: no collision; four trigger names, three tables, two RPCs,
  two trigger functions, 11 indexes, 48 constraints, all new.
- **Security posture**: RLS enabled with zero policies on all three tables;
  `service_role` holds `SELECT` only and no `INSERT`/`UPDATE`/`DELETE`;
  `anon`/`authenticated` hold nothing on any table or function;
  `record_profitability_snapshot` is `SECURITY DEFINER` with
  `search_path=public, extensions, pg_temp`; `get_profitability_snapshot` is
  `SECURITY INVOKER`, `STABLE`, `search_path=public, pg_temp`.
- **Append-only**: `UPDATE` and `DELETE` on a snapshot both raise; the probe was
  rolled back and left nothing behind.

Note for future validators: the full `0001..0062` history is **not** replayable
on an empty database — `0032` needs `pending_sessions.close_event_timestamp_ms`,
which no migration in this repository creates. That is a pre-existing repository
condition, unrelated to P3, and it means schema validation must apply new
migrations onto an existing schema, which is what Production does anyway.

## Rollout verdict

**Additive schema-first is SAFE and recommended: apply the P3 migration first,
deploy the P3 application afterwards.** Verified, not assumed — by the
additivity fingerprint above.

| Case | Verdict |
|---|---|
| A. old app + P2E/P2D schema | out of P3 scope; P3 contributes nothing in this state |
| B. current app + P2E/P2D schema | safe — identical to today's Production |
| C. current app + P3 schema, before the P3 app deploy | **safe — the recommended window**; P3 is invisible to the deployed app |
| D. P3 app + P3 schema | safe — the certified path, covered by the suite |
| E. app rolled back after the P3 schema exists | safe — returns to case C |

## Clean-port rehearsal

Simulated the future port without touching `main` or the published branch: a
disposable worktree at `origin/main` (`a212141`), `git merge` of P2E
(`04e5d9f`, fast-forward) then P2D (`6ea7423`, clean `ort` merge) to build base
`39582b9`, then cherry-picked the P3 commits **in order**.

Result: every commit applied **clean**, and the resulting delta is
**byte-identical** to `git diff ad9c37d..0f85122` (6 197 patch lines both sides).

Commit-order simplification: possible but **not recommended**. The two docs
commits could fold into one and the three migration fixes could squash into
`235b8d5`. Neither is worth it — the cherry-pick is already clean, and each
refusal commit carries the review reasoning for *why* that refusal exists. The
published branch is **not** rewritten.

## Production preflight, verification, smoke and rollback

All in `docs/p3-production-release-runbook.md`, with expected results and no
secrets:

- §0 dependency gate, including P2D's own P2C Production UAT precondition, which
  this package does not override.
- §1 rollout verdict and mixed-version matrix.
- §2 preflight: dependencies present / P3 absent, 12 required relations, 4
  required functions, round status vocabulary, zero pre-existing P3 objects and
  trigger names, round counts by status, smoke-candidate rounds, legacy unbound
  counts, ledger/cost readiness, unsupported movement classes, uniqueness
  invariants.
- §4 post-migration verification: migration history, tables, RLS, grants, RPC
  signatures and `search_path`, EXECUTE grants, anon/authenticated denial,
  triggers, constraints, indexes, the shared P2D/P2E constraint, and a re-run of
  the legacy counts.
- §5 smoke plan: an INCOMPLETE round (always available, proves COGS is never
  coerced to 0 and nothing mutates), a COMPLETE round **only if Production
  already has one** — no fabricated financial history, otherwise rely on the
  proven disposable-PostgreSQL COMPLETE cases — a cancelled round that must
  never certify, and a cross-round isolation spot check.
- §6 reversible vs irreversible steps.
- §7 rollback: if the migration applies and the deploy fails, **leave the schema
  in place** (that is case C, proven safe); keep the schema even if P3 is
  abandoned; disable exposure by revoking EXECUTE on
  `record_profitability_snapshot`, which deletes nothing; never hard-delete
  snapshot, cost or inventory rows.

## CI

The dedicated `p3-profitability` PostgreSQL 17 job runs `bun run test:pg:p3`,
which executes the whole `migration-p3.pg.test.ts` file — so the two new
round-isolation regressions are covered without a workflow change. The job also
runs P2D 0054, P2E, typecheck and diff-check, with `REQUIRE_P3_POSTGRES=1`,
`REQUIRE_POSTGRES_TESTS=1` and `REQUIRE_P2E_POSTGRES=1`: an unreachable database
is a **hard failure**, never a green skip.

## Dependency state (re-verified 2026-08-09 via `gh pr view`)

| PR | Branch | Head | State | Mergeable |
|---|---|---|---|---|
| #38 P2E | `feat/p2e-accountability-round-identity` | `04e5d9f4290f4498cfa6f08a8aa3957285592675` | **OPEN** | MERGEABLE / CLEAN |
| #36 P2D | `feat/p2d-actual-cost` | `6ea7423e85257790964dde6412d52cbcbad0440b` | **OPEN** | MERGEABLE / CLEAN |

`origin/main` = `a2121413818707732f24441659fdd4c2ba681237`, unchanged. Both heads
unchanged from final review. Neither PR was modified by this sprint.

## Exact next action once #36 and #38 have merged

```bash
# 1. latest main
cd C:\GitHub\Bot-summary
git fetch origin --prune
git rev-parse origin/main            # confirm both dependencies are in it:
git merge-base --is-ancestor 04e5d9f4290f4498cfa6f08a8aa3957285592675 origin/main
git merge-base --is-ancestor 6ea7423e85257790964dde6412d52cbcbad0440b origin/main

# 2. clean worktree off main
git worktree add -b feat/p3-profit-loss C:\GitHub\_worktrees\Bot-summary-p3-port origin/main
cd C:\GitHub\_worktrees\Bot-summary-p3-port

# 3. port ONLY the P3 commits, in order (rehearsed clean). Take the list from git
#    rather than from this file, so a later docs commit cannot be missed:
#      git log --reverse --format=%h ad9c37d..origin/feat/p3-profit-loss-final
git cherry-pick 235b8d5 a43bcae 163e037 10fee89 73b24f9 3c8c11d 503d891 49701a3 0f85122 af135c9 99a5f7e

# 4. prove the delta is P3-only: expect exactly the 15 files listed above
git diff --name-status origin/main..HEAD

# 5. rerun critical tests
$env:PGHOST="localhost"; $env:PGUSER="postgres"; $env:PGPASSWORD="postgres"; $env:PGPORT="5432"
$env:REQUIRE_P3_POSTGRES="1"; $env:REQUIRE_P2E_POSTGRES="1"; $env:REQUIRE_POSTGRES_TESTS="1"
bun run test:pg:p3                                    # expect 15 pass / 0 fail
bun run test:pg:p2e                                   # expect 1 pass / 0 fail
bun test src/lib/profitability                        # expect 126 pass / 0 fail
npm run type-check ; npm run lint ; npm run build
git diff --check

# 6. push and open the PR
git push -u origin feat/p3-profit-loss
gh pr create --base main --title "P3: profitability snapshots keyed by accountability round"

# 7. wait for CI; remediate P3-only regressions only. DO NOT MERGE without
#    explicit authorisation.
```

Then, and only with authorisation, follow
`docs/p3-production-release-runbook.md` in order: §0 gate → §2 preflight → §3
apply → §4 verify → §5 smoke.

## Separation of remaining work

**COMPLETE**

Architecture · migration · service layer · formatter · validators · TypeScript
suites · real-PostgreSQL matrix including both round-isolation regressions ·
migration rehearsal in both application orders · additivity proof · rollout
matrix · clean-port rehearsal · Production preflight · Production post-migration
verification · smoke plan · rollback plan · CI · branch pushed.

**BLOCKED BY DEPENDENCY RELEASE**

Opening a truthful P3 PR against `main` (#36 and #38 are unmerged, so a PR now
would show their diffs as P3's) · the port itself · Production migration ·
Production smoke · P2D's own P2C Production UAT precondition.

**POST-RELEASE OPTIONAL IMPROVEMENTS** — none of these blocks the release

1. ~~Wire `ProfitabilityService.getSnapshot` / `formatProfitabilitySnapshot` into
   `loadDigitalWhiteSheetPageModel`~~ — **COMPLETE** (end-to-end surface sprint).
2. Resolve the open business decision on `− purchasing expenses`. If the owner
   rules it is not a market-round operating expense, the term becomes a constant
   `0` and one reason disappears — a one-line change, no schema impact.
3. Lineage vocabulary is broader than the writers: `profitability_snapshot_sources`
   permits `settlement_finalization` and `pending_session`, and neither is ever
   inserted. Not a money defect — neither contributes to any term — but either
   record them or narrow the CHECK.
4. `docs/handoffs/p3-final-sprint-handoff.md` has grown into three sprint
   reports; it could be split into a single current-state document plus an
   archive.

---

# END-TO-END SURFACE — 2026-08-09

Status: **P3 END-TO-END RELEASE PACKAGE COMPLETE — WAITING ONLY FOR DEPENDENCY
RELEASE.**

No missing P3 user-facing read integration remains before dependency release.
The money engine is unchanged. This sprint only attaches an approved read of the
latest snapshot to the White Sheet page model and UI.

## Integration

```
loadServerDigitalWhiteSheetPageModel
  → loadDigitalWhiteSheetPageModel
      → existing White Sheet summary (unchanged)
      → ProfitabilityService.getSnapshot(accountabilityRoundId)  // read only
      → formatProfitabilitySnapshot(snapshot)                     // presentation only
  → DigitalWhiteSheetProfitability (read-only block)
```

No public mutation route was added. Page load never calls
`record_profitability_snapshot`.

## Page model contract

`DigitalWhiteSheetPageModel.profitability`:

| state | When |
|---|---|
| `available` | Valid round UUID + snapshot exists — carries `snapshot` + `formatted` |
| `not_calculated` | Valid round UUID + `getSnapshot` returns null |
| `round_unbound` | `accountabilityRoundId` is `undefined`, `null`, or not a UUID |

No descriptive (source/market/date) fallback. Invalid UUID is unbound without an
RPC call. NULL money terms stay unprovable in the formatted block — never ฿0.

## Hard-stop

`requireTrustedWhiteSheetSummary` / `WhiteSheetHardStopError` are unchanged.
P3 CERTIFIED/INCOMPLETE is independently visible even when the White Sheet is
untrusted; an untrustworthy White Sheet is never converted into a trusted result.

## Tests / gates

| Suite | Result |
|---|---|
| White Sheet/P3 compose integration (`compose-profitability.test.tsx`) | **12 pass / 0 fail** |
| `src/lib/profitability` TypeScript (format + service) | **111 pass / 0 fail** |
| White Sheet compose / load / local-UAT / central-pricing / client | **pass** |
| Settlement / reconciliation market-scope focused | **pass** |
| Typecheck | clean |
| Build | clean (placeholder Supabase env) |
| Lint | 0 errors, 65 pre-existing warnings |
| `git diff --check` | clean (Windows LF/CRLF notice only) |

## Dependency state (unchanged)

| PR | State |
|---|---|
| #38 P2E | **OPEN** |
| #36 P2D | **OPEN** |

Production mutations: **none**. No merge, deploy, migration, LINE, or cron change.

## Prohibitions honoured this sprint

No merge of #36 or #38 · no modification of either PR · no override of P2D's P2C
Production UAT precondition · no deploy · no Production mutation · no Production
migration · no LINE send · no cron change · no weakened test · no fabricated
COMPLETE Production data · no rewrite of the published P3 branch · no unrelated
WIP touched.
