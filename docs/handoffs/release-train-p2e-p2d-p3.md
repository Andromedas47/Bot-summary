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
