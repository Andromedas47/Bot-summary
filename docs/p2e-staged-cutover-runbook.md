# P2E staged cutover runbook

Production project: `apjjsqibavjaitcedavn`. Production authorization is required before step 1.

## Immutable artifacts

- EXPAND: `supabase/migrations/20260809045345_p2e_accountability_round_identity_expand.sql`
- CONTRACT: `supabase/migrations/20260809045849_p2e_accountability_round_identity_contract.sql`
- App: exact approved PR #38 head; record the SHA before rollout.

Never apply CONTRACT before the compatible app is fully deployed. Do not run P2D or P3 during this window.

## Compatibility matrix

| App/schema | Result |
|---|---|
| Current app / current schema | Existing behavior. Tuple-only settlement and reconciliation targets work. The rare finalization `ON CONFLICT (source_id,business_date)` path is already incompatible with Production's partial legacy index; P2E does not hide that fact. |
| Current app / EXPAND | Legacy NULL writes, tuple-only conflict targets, and tuple-only White Sheet RPCs remain. Existing behavior stays available. |
| P2E app / EXPAND | Round creation and non-financial binding work. Bound cash/settlement/finalization/reconciliation writes raise `P2E EXPAND: bound financial writes require CONTRACT`; no silent merge. |
| P2E app / CONTRACT | Round-aware conflict targets and lifecycle overloads work. Same-description rounds stay distinct. |
| Current app / CONTRACT | Settlement/reconciliation tuple-only `onConflict` and old White Sheet RPC signatures fail closed. Unsupported rollback state. |

## Ordered cutover

0. Pin the approved app SHA. Confirm PR checks green and Production migration history still ends at `20260806112815`. Confirm `accountability_rounds` is absent and all four legacy identity targets still have the audited names.
1. Apply EXPAND only.
2. Verify in catalogs: `accountability_rounds` exists; four `p2e_expand_guard_*` triggers exist; old and round-aware unique targets coexist; old and new White Sheet RPC signatures exist; `settlement_entries` RLS is enabled; anon/authenticated have no table privileges; service role has SELECT/INSERT/UPDATE.
3. Deploy the pinned P2E app SHA. Wait for the deployment to become healthy. During rolling deployment, old financial writers still work; new bound financial writes fail closed.
4. Confirm the deployed SHA and basic read paths. Confirm all four guarded tables have zero non-NULL `accountability_round_id` rows.
5. Apply CONTRACT immediately.
6. Verify: guard function/triggers and old tuple-only targets/RPC signatures are absent; round-aware targets/RPCs remain; RLS/grants remain; legacy row counts are unchanged.
7. Run one authorized same-description two-round smoke flow and confirm distinct UUIDs/artifact bindings. Then begin normal monitoring.

## Rollback matrix

| Failure | Action |
|---|---|
| EXPAND errors | Its transaction rolls back. Keep current app. Investigate. |
| EXPAND succeeds; deploy fails | Redeploy current app. Leave EXPAND installed. Old writers/RPCs remain valid. |
| P2E app unhealthy before CONTRACT | Redeploy current app. Leave EXPAND installed. Guard ensures no bound financial rows exist. |
| CONTRACT errors | Its transaction restores EXPAND, including guards and old targets. Keep or roll back app; fix forward. |
| App issue after CONTRACT | Do not deploy the current/pre-P2E app. Roll forward with a P2E-compatible hotfix. Recreating tuple-only uniques is unsafe once same-description rows can exist. |

## Stop conditions

Stop before CONTRACT if the pinned SHA is not fully deployed, any guard is absent, any bound financial row exists, or old compatibility targets disappeared early. Stop after any count, grant, RLS, constraint, or RPC mismatch. Do not infer identity from source/date/market/seller.
