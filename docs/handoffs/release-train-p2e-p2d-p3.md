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
