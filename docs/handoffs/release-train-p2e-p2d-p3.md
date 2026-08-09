# Release train handoff: P2E -> P2D -> P3

## Gate

P2E staged cutover is prepared, not applied. Production mutations: none. PR #38 remains the active delivery vehicle. Exact rollout and rollback: `docs/p2e-staged-cutover-runbook.md`.

## Root cause and repair

The original P2E migration removed tuple-only unique targets before a compatible app deployment. Current PostgREST writers name those targets, so Production would reject settlement/reconciliation writes immediately after migration. Keeping the targets alone was also unsafe: an old tuple-only upsert could silently merge into the first bound round row.

Repair:

1. EXPAND keeps old targets/RPCs and adds round-aware objects.
2. One shared trigger rejects bound writes on the four financial tables during the short mixed-version window.
3. The compatible app carries explicit White Sheet round identity and uses round-aware lifecycle overloads.
4. CONTRACT atomically removes the guards and tuple-only targets/RPCs.

## Production read-only evidence

- PostgreSQL 17; latest migration `20260806112815`; no P2E/P2D history.
- `accountability_rounds` absent; all 12 P2E prerequisite tables and the prerequisite guided-open RPC present.
- Legacy counts: 4 inventory movements, 151 settlement entries, 1 settlement finalization, 3 reconciliations.
- Finalizations: zero `work_round_id`, zero duplicate source/date. Production uses a partial NULL-work-round source/date index, so the current rare plain `ON CONFLICT (source_id,business_date)` path is already invalid.
- `service_role` bypasses RLS. `settlement_entries` currently has RLS off; P2E turns it on and revokes anon/authenticated access after confirming all app paths are server/service-role.

## Rehearsal evidence

Disposable PostgreSQL applies EXPAND and CONTRACT against a Production-shaped bootstrap. It proves old writer upserts/RPCs during EXPAND, bound financial fail-closed guards, forced CONTRACT failure rollback, post-CONTRACT old-writer failure, two same-description round isolation, lifecycle audit binding, parent/child and reversal constraints, RLS, grants, and concurrent open idempotency.

## P2D impact

No P2D code or PR #36 change is required. P2E and P2D both admit the future inventory movement classes; P2E still creates no ISSUE cost adapter. Land and cut over P2E first, then rebase/revalidate P2D on the merged Production schema.

## P3 impact

Do not port the stale P3 base. Rebuild/port P3 only from merged P2E + P2D. Profit snapshot identity remains `(accountability_round_id, revision)`. Missing bound ISSUE/cost, transfer, White Sheet, settlement, or reconciliation evidence must report INCOMPLETE; never fall back to descriptive tuples.

## 2026-08-09 Production cutover evidence

- Authorized PR head: `6ee232cc5d39c4ed46d5816e41029c3108006927`.
- EXPAND SHA-256: `97871CF187ADB1B82218984B36836003BA41C0AB75C1344E88FBBBFA5734B5A6`; applied as `20260809045345_p2e_accountability_round_identity_expand`.
- PR #38 was rechecked exact-head, mergeable, and fully green; merged as `8cfd20a57c34af8c02df1e137ac6f6a10294f2de`.
- Production deployment `dpl_55eJ3iKwmDU1emZG8X6dmRPahCyL` is READY at the exact merge SHA; HTTP 200; no Vercel runtime errors.
- Mixed-version gate passed with zero bound financial rows, four guards, four legacy keys, unchanged row counts, and unchanged inventory fingerprint.
- CONTRACT SHA-256: `9092879CBC3DE67B94650478FC38B005341C93BA3753DDA876DAF9003AB9C0C5`; applied as `20260809045849_p2e_accountability_round_identity_contract`.
- Post-CONTRACT verification: guards and legacy targets/RPCs absent; round-aware targets/RPCs present; RLS and service-role grants correct.
- Rollback-only Production smoke passed UUID creation/idempotency, distinct same-description rounds, continuation binding, settlement upsert/isolation, White Sheet finalize/reopen, and cross-round refusal. Smoke residue: zero.
- Baseline remains 4 inventory movements, 151 settlements, 1 finalization, 3 reconciliations, 7 White Sheet cash rows, and 3 lifecycle rows; all existing rows remain unbound. Inventory fingerprint: `7432929ff3c3b8582232e1b7cfcbdad7`.
- Supabase advisors: INFO only; no P2E security or correctness blocker.
- P2E status: Active. Recovery posture: roll-forward only.

## P2D preparation state

- Production P2D mutation: none.
- PR #36 head before restack: `6ea7423e85257790964dde6412d52cbcbad0440b`; current Production/main base: `8cfd20a57c34af8c02df1e137ac6f6a10294f2de`.
- Current main has been merged into a clean local P2D prep branch for review and validation.
- Existing P2D PostgreSQL suite: 32/32 tests, 250 assertions passed after the restack.
- Added focused Production-order rehearsal: exact P2E EXPAND → CONTRACT → migration 0054; verifies P2E movement bind/write-once/round-required guards survive, a valid bound ISSUE is accepted, an unbound GOOD_RETURN is rejected, and a failed valuation writes no cost row. Result: 1/1 test, 22 assertions passed.
- Reused P2E PostgreSQL rehearsal remains green: 1/1 test, 73 assertions. Cost service unit tests: 35/35. Lint: zero errors (pre-existing warnings only). Diff check: clean.
- Standalone typecheck still reports the unrelated `recoverSlipBatch` route export already present on `main`; P2D does not change that file. Local Turbopack build cannot follow this disposable worktree's out-of-root `node_modules` symlink; Vercel CI is the authoritative build gate.

## 2026-08-09 P2D Production Active

- P2D schema migration: `20260809063116_inventory_cost_valuation`; exact file SHA-256 `034FE93DE2E7F7867B7F7B53E0E99E6BF1C3D9E0D2CBEDDDA31E01421EB8EE0A`.
- PR #36 merged at exact reviewed head `1e2b15b62241cbfa429d1c0e10b2f2d5d4d4a40c` as main `c3c2fbb36713939539d1314f8df382ddd910c1bf`.
- Production deployment `dpl_566vM65dhzbgwuWeAbeHLZEg6YKv` is READY at that SHA; alias HTTP 200; no attributable runtime errors.
- Schema/security verification: 25/25 compact assertions. Cost rows remain zero; all four pre-P2D quantity lines remain visible unvalued; full quantity fingerprint remains `2adac7f43d46aa152de1350498aff4a8`.
- No financial history was fabricated, backfilled, valued, or mutated. P2D status: Production Active.

## 2026-08-09 P3 clean release port

- Release base: exact merged P2D main `c3c2fbb36713939539d1314f8df382ddd910c1bf`.
- Refreshed source: `origin/feat/p3-profit-loss-final` at `3c4708ee987af50a338858e76e6acf9132225b07`.
- Git-derived authoritative range `ad9c37d..origin/feat/p3-profit-loss-final`: 13 commits. Ordered cherry-pick into new `codex/p3-release` worktree completed with no conflicts.
- `git range-diff` maps all 13 source patches exactly (`=`). Final delta has one P3 migration only and no duplicated P2E/P2D migration or implementation.
- Production P3 mutation: none. Next: critical contract review, full test matrix, actual P2E+P2D migration rehearsal, clean PR/CI, then stop at Production authorization gate.

## 2026-08-09 P3 release validation

- Frozen accounting, round-only identity, proven P2D cost lineage, CLOSED-only certification, append-only revisions, service-role boundaries, and the read-only White Sheet surface were re-reviewed without formula changes.
- Actual-order rehearsal now applies P2E EXPAND, P2E CONTRACT, P2D, then P3. The non-P3 schema fingerprint is identical before/after P3. P3 PostgreSQL: 15/15 tests, 465 assertions.
- P2E regression: 1/1 test, 73 assertions. P2D regression: 33/33 tests, 272 assertions. Critical TypeScript compatibility: 250/250 tests, 718 assertions. Existing White Sheet compatibility: 55/55 tests, 136 assertions.
- Typecheck passed. Build passed with build-only Supabase placeholders; no secret was used. Lint passed with zero errors and 65 pre-existing warnings. `git diff --check` passed.
- Fixed one shared page-model boundary defect: an invalid round UUID is normalized to the unbound read scope before any White Sheet loader runs, so P3 reports `round_unbound` without an RPC call. Existing persistence validation remains strict.
- Corrected the P3 runbook to the actual Production migration history, exact P2D RPC signatures, exact-artifact application, current rehearsal evidence, and zero-round smoke posture: never fabricate a round/snapshot to exercise INCOMPLETE, cancelled, or bound rendering. P3 migration SHA-256: `97760688897F5BC00D7380D511B35F488DA73E635EECCA38619AAB7FE74B7BB9`.
- Read-only Production preflight: P2E EXPAND `20260809045345`, P2E CONTRACT `20260809045849`, and P2D `20260809063116` present; P3 history/relations/functions/triggers all absent; all 12 relations and four exact dependency RPCs present; round status vocabulary exact; zero rounds, zero bound movements, zero cost rows; four legacy quantity movements remain unbound/unvalued.
- Production P3 mutations: none. Next: commit/push `codex/p3-release`, open truthful PR, wait/remediate CI and preview, refresh final preflight, then stop for P3 Production authorization.
