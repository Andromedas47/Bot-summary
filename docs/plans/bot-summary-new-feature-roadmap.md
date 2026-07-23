# Bot-summary New-Feature Roadmap

> - Status: Approved plan — implementation not started
> - Approved main baseline: `35b2513`
> - First required action: Phase 0 only
> - Production mutations allowed: No

This document is the roadmap source of truth unless it is superseded by an explicitly reviewed revision.

Phase 0 is a mandatory blocking prerequisite. Phase 1 must not begin until every Phase 0 exit criterion has passed.

## Summary

Phase 0 must establish a trustworthy starting point before any feature implementation:

- Isolate the current tracked and untracked WIP without modifying it.
- Inspect and document production schema parity.
- Reconcile migration numbering and production migration history in a manifest.
- Verify a local replay path using unchanged historical migrations.
- Produce the official test baseline from a clean worktree at `origin/main` SHA `35b251307c3f85441e72f923414c588a0117b639`.
- Confirm the exact session IDs involved in the 2026-07-21 ปลา / ตลาดราชพฤกษ์ incident.

Phase 1 is divided into:

- **Phase 1A:** authorization, audit, a parity-only effective read model, and shadow comparison. No production correction mutations are enabled.
- **Phase 1B:** correction requests, void/supersede, duplicate resolution, admin UI, and controlled effective-report cutover.

## Current architecture and safety state

### Repository state

- Approved `main` and `origin/main` baseline: `35b251307c3f85441e72f923414c588a0117b639`
- The existing primary workspace contains modified and untracked WIP.
- Known WIP includes:
  - Modified database/application type definitions
  - Untracked admin session summary and void routes
  - Untracked duplicate-session warning implementation and tests
  - An untracked `0037_produce_session_void.sql`
  - An untracked `.claude/launch.json`
- The local void route is unsafe as a production design because it permits any authenticated account to void a session.
- `.claude/launch.json` must remain untouched and untracked.

### Test-baseline distinction

Previously observed passing tests and type-check results came from the dirty WIP workspace. Those results are a **dirty-workspace observation**, not the official production baseline.

The official baseline must be generated independently from a clean worktree checked out at exactly:

`35b251307c3f85441e72f923414c588a0117b639`

Clean and dirty results must be stored as separate artifacts and never combined.

### Current reusable architecture

- Immutable LINE source events in `raw_messages`
- Produce parsing and `produce_sessions` / `produce_items`
- Pending multi-message sessions and idempotent finalization
- Main and additional produce-session flows
- Existing slip evidence storage, extraction, and manual transfer entry
- Daily, financial, remaining-return, PDF, CSV/XLSX, LINE, and reconciliation outputs
- Current legacy calculations during compatibility mode
- Existing session-aware remaining-fruit dedup
- Immutable correction snapshot and stale-version concepts from the correction branch, usable only through selective review

### Production work-round drift

Tracked migration `0036` reports production-only structures including:

- `work_rounds`
- `produce_sessions.work_round_id`
- `produce_sessions.is_append_session`
- Related RPCs

The divergent work-round branch is reference material only. It must not be assumed to match production or be merged wholesale.

## Canonical identities and formulas

### Settlement-round identity

`work_round_id` is the canonical identity for produce accountability, expected-money snapshots, transfers, white forms, and reconciliation.

Market + seller + business date is not unique. Multiple rounds are distinguished by `round_seq` or the equivalent production field.

Expected identity:

`source + business date + seller + market + round sequence`

### Warehouse stock

For each warehouse, canonical product, and unit:

`closing sellable stock = opening stock + posted purchases + posted normal returns − posted market issues + signed approved adjustments`

- Damaged returns enter quarantine/non-sellable stock.
- Yesterday’s returns are already part of warehouse stock and must not be added again when issued today.
- Different units must not be combined without an approved conversion.

### Market accountability

`issued quantity = warehouse issues linked to the work round`

`sold/accountable quantity = issued quantity − normal-return quantity − approved damaged-return quantity`

The initial inventory ledger must not post a synthetic `market_sale` movement.

The warehouse issue already removes stock from central sellable inventory. Posting a derived sale movement against the same inventory would double-decrement stock. Sold/accountable quantity therefore remains a calculation.

An explicit sale movement becomes justified only when an independent observed event exists, such as POS sales, or when persistent market inventory must be tracked. It must be posted from that independent source and reconciled against the derived quantity rather than generated from it.

### Expected money

For each work round:

`standard value = quantity × approved standard price amount ÷ price basis quantity`

`expected money = issue value − normal-return value − approved damaged-return value`

- Pending damage is displayed separately and blocks certification.
- Rejected damage does not reduce expected money.
- Expected-money snapshots store `work_round_id`, calculation version, input IDs/hash, and totals.

### White form

`expected cash = expected money − verified transfers − approved expenses − approved wages`

`accounted amount = verified transfers + cash actually received + approved expenses + approved wages`

`shortage/overage = accounted amount − expected money`

Confirmed paper mapping:

| Paper field | Digital meaning |
|---|---|
| Market, date, seller | Work-round attributes |
| Sales | Expected-money snapshot |
| Transfer | Verified transfers for the work round |
| Expenses | Approved detailed expense lines |
| Cash handed over | Seller-declared cash |
| Wages | Approved detailed wage lines |
| Remaining cash | System-calculated expected cash |
| Sender | Submitter |
| Receiver/certifier | Reviewer/certifier |

Cash actually received remains a separate digital review field.

### Actual cost and profit/loss

- Use perpetual weighted-average cost per warehouse, product, and unit.
- Market issues snapshot their actual weighted-average cost.
- Normal returns restore their original issue cost.
- Approved damage carries its issue cost into damaged stock/loss.

`COGS sold = sold/accountable quantity × issue-cost snapshot`

`damage loss = approved damaged quantity × issue-cost snapshot`

`standard-price margin = expected money − COGS sold`

`expected operating P/L = expected money − COGS sold − damage loss − approved expenses − approved wages − purchasing expenses`

`realized P/L = expected operating P/L + shortage/overage`

## Phase 0 — Mandatory blocking prerequisite

Phase 0 is mandatory and blocks all Phase 1 work.

### 1. Isolate current WIP

- Preserve the dirty workspace unchanged.
- Do not stage, reset, overwrite, delete, or modify its files.
- Record status, diffs, hashes, and contents of all modified/untracked Phase 1 files.
- Exclude `.claude/launch.json` from every branch, commit, patch, or artifact.
- Perform implementation in a separate clean worktree based on the verified origin SHA.
- Port WIP code only after comparing it with the approved design.

### 2. Produce the official clean baseline

Create a clean worktree at exactly:

`35b251307c3f85441e72f923414c588a0117b639`

Record:

- Commit SHA and clean `git status`
- Node, Bun, npm, Next.js, React, TypeScript, and Supabase package versions
- Available environment-variable names, without values
- Full test suite
- Type-check
- ESLint
- Production build

Store complete command outputs as the official baseline.

Classify failures as:

- Existing repository failure
- Missing local environment/dependency
- External-service dependency
- Tooling/platform issue

Phase 1 must not begin with an unexplained baseline failure.

Run the same checks in the dirty WIP workspace only for comparison. Label those results `dirty-wip`; never treat them as production baseline evidence.

### 3. Produce a production parity report

Use read-only inspection to document:

- Applied production migrations
- Tables and columns
- Constraints and indexes
- Views and view security mode
- Functions/RPCs and search paths
- Function execution grants
- Table grants and RLS policies
- `work_rounds`
- Every `work_round_id` relationship
- `is_append_session`
- Settlement, slip, and reconciliation work-round linkage

Compare production against:

- Current tracked migrations
- Local untracked `0037`
- Correction branch migration
- Work-round branch migrations

Classify each difference as:

- Repository-only
- Production-only
- Equivalent but differently defined
- Incompatible
- Unknown pending investigation

### 4. Produce a migration manifest

The manifest must list:

- Every historical migration in execution order
- File hash
- Purpose
- Dependencies
- Whether production records it as applied
- Known production drift
- Competing migration numbers
- Preconditions required by future reconciliation migrations

Historical migration files and production migration history must not be rewritten, squashed, renumbered, or fabricated.

The competing `0037` definitions must be documented. The next migration identifier is chosen only after production history is known.

### 5. Verify the local replay path

Using a disposable empty database:

1. Apply unchanged tracked historical migrations in manifest order.
2. Record the resulting schema signature.
3. Compare it with the production parity report.
4. Identify every additive reconciliation step required before feature work.
5. Verify the replay procedure is deterministic and repeatable.

Phase 0 produces the replay procedure and mismatch report. Any later database reconciliation must use additive, forward-only migrations with explicit schema/data preconditions and must fail safely when a precondition is not met.

### 6. Capture golden report baselines

From the clean worktree, record representative outputs for:

- Dashboard
- Report summary
- Financial summary
- Remaining-return summary
- Settlement expected totals
- Transfer reconciliation
- PDF exports
- CSV/XLSX exports
- LINE daily summaries

### 7. Confirm the incident IDs

Read production data without mutation and confirm exact IDs for:

- Valid later session: 24 items, 28,388.50 THB
- Earlier incomplete session: 23 items, 27,498.50 THB
- Seller: ปลา
- Market: ตลาดราชพฤกษ์
- Business date: 2026-07-21

Totals, timestamps, and text similarity alone are insufficient identifiers.

### Phase 0 deliverables

- WIP isolation record
- Official clean test baseline
- Separately labelled dirty-WIP observation
- Production parity report
- Migration manifest
- Verified local replay procedure
- Golden report artifacts
- Confirmed incident session IDs

### Phase 0 exit criteria

All deliverables must be complete, unexplained baseline failures resolved, migration numbering unambiguous, and production drift fully classified.

Failing any criterion blocks Phase 1.

Complexity: medium.

## Phase 1 authorization and correction model

### Minimal roles

Phase 1 roles:

- `owner_approver`
- `clerk_admin`
- `viewer`

| Action | Owner/approver | Clerk/admin | Viewer |
|---|---:|---:|---:|
| Read effective reports | Yes | Yes | Yes |
| Inspect correction evidence | Yes | Yes | No |
| Create correction request | Yes | Yes | No |
| Add duplicate-review notes | Yes | Yes | No |
| Recommend duplicate resolution | Yes | Yes | No |
| Final duplicate resolution | Yes | No | No |
| Approve/reject correction | Yes | No | No |
| Approve void/supersession | Yes | No | No |
| Manage Phase 1 roles | Yes | No | No |

Purchasing, receiving, seller, and price-specific roles are deferred to their relevant phases.

### `user_profiles`

- `user_id` PK/FK to `auth.users`
- `display_name`
- `active`
- Audit timestamps

### `role_assignments`

- User and one of the three Phase 1 roles
- Active/effective period
- Grant/revoke actors and timestamps
- One active assignment per user/role

### `audit_events`

Append-only:

- Actor
- Action
- Entity type/ID
- Before/after snapshots
- Reason
- Request/source IDs
- Timestamp and request context

Only trusted role/correction operations may write audit events. Update and delete are prohibited.

### `produce_change_requests`

Actions:

- `add_item`
- `edit_item`
- `void_session`
- `supersede_session`

Required data:

- Target session and optional item
- Replacement session for supersession
- Immutable before/proposed-after snapshots
- Reason type/detail
- Target version
- Idempotency key
- Status
- Request/review/apply actors and timestamps

Raw produce sessions/items remain immutable.

- Approved additions become effective overlay rows.
- Approved edits overlay existing items.
- Approved voids exclude a session.
- Approved supersession excludes the old session and records the exact replacement.
- Stale target versions fail.
- Hard deletion is prohibited.

### `duplicate_session_warnings`

Required data:

- Deterministically ordered candidate session IDs
- Market/seller/date/type evidence
- Item overlap and total comparison
- Rule version
- Clerk notes and recommendation
- Final owner decision and reason
- Review timestamps

Statuses:

- `open`
- `confirmed_duplicate`
- `valid_distinct`
- `superseded`

Authorization:

- `clerk_admin` may inspect evidence, add notes, and recommend `confirmed_duplicate` or `valid_distinct`.
- Only `owner_approver` may set the final status.
- A final `confirmed_duplicate` decision does not change totals; it must be followed by a separately approved void or supersession request.
- Duplicate warnings never alter effective totals by themselves.

### `effective_produce_transactions`

The effective model must:

1. Start from immutable raw produce transactions.
2. Preserve a stable effective-row identity.
3. Add approved synthetic `add_item` rows exactly once.
4. Apply only the latest valid approved edit.
5. Exclude only sessions covered by an approved void/supersession.
6. Ignore pending, rejected, malformed, and stale changes.
7. Expose original/effective values and correction metadata.
8. Pass through verified `work_round_id` where present.
9. Use security-invoker behavior or equivalent protected access.

The existing `produce_transactions` view remains the rollback source.

## Phase 1A — Authorization, audit, effective read model, and shadow comparison

No production correction mutation is enabled in Phase 1A.

### Scope

- Add the three-role authorization foundation.
- Add append-only audit infrastructure.
- Add a parity-only effective transaction read model.
- Centralize report reads behind a server-only data-access layer.
- Compare legacy and effective results in shadow mode.

### Effective-model behavior

Before Phase 1B correction data exists, the effective model must be row-for-row and total-for-total equivalent to the legacy source apart from additional metadata columns.

No session is excluded and no item is added or edited in Phase 1A.

### Security

- Reauthorize inside every Server Action and Route Handler.
- Do not rely on proxy authentication.
- Use authenticated-user database context for privileged RPCs.
- Fix function search paths.
- Revoke function execution from `PUBLIC` and `anon`.
- Grant only explicitly required authenticated access.
- Keep service credentials server-only.

### Shadow comparison

For representative and full supported date ranges, compare:

- Row count and stable row IDs
- Issue/return/damage quantities and values
- Market/seller/date grouping
- Remaining-return totals
- Settlement expected totals
- PDF/CSV/LINE output totals

Differences must be recorded with their source rows and must be zero or explicitly reviewed before Phase 1B.

### Phase 1A acceptance

- Role-matrix enforcement passes.
- Effective source is legacy-equivalent.
- All consumers can query through the centralized data-access layer.
- Production continues serving legacy reports.
- No correction, void, supersession, or duplicate-resolution mutation is callable.

Rollback: disable shadow reads; legacy behavior remains unchanged.

Complexity: medium.

## Phase 1B — Corrections, duplicate resolution, and controlled report cutover

### Scope

- Correction request and approval operations
- Item add/edit overlays
- Whole-session void/supersede
- Persisted duplicate warnings
- Clerk recommendation and owner final resolution
- Correction, duplicate, and audit admin UI
- Controlled effective-source report cutover

### Correction workflow

1. Clerk or owner creates a correction request.
2. The system builds the trusted before snapshot and target version.
3. Reports remain unchanged while the request is pending.
4. Owner reviews source LINE evidence and before/after values.
5. Approval atomically records the change and audit event.
6. Effective reports change; raw data remains unchanged.
7. Retries return the same idempotent result.
8. Stale requests must be recreated against the latest version.

### Duplicate workflow

1. Detection creates a warning only.
2. Clerk reviews evidence, writes notes, and recommends a resolution.
3. Owner independently marks the pair `confirmed_duplicate` or `valid_distinct`.
4. Neither decision changes totals.
5. If confirmed, a separate void/supersede request is created and owner-approved.

### Controlled report cutover

Cut over these consumers through the centralized data-access layer:

- Dashboard and report summary
- Financial summary
- Settlement expected totals
- PDF exports
- CSV/XLSX exports
- LINE daily summaries
- Remaining-return data
- Reconciliation paths using produce totals

Cutover requires:

- Phase 1A shadow parity
- Phase 1B correction scenario tests
- Golden-output comparison
- Explicit feature activation

Rollback selects the legacy source without deleting corrections or audit data.

Complexity: large.

## Remaining-return dedup invariants

The existing session-aware remaining-fruit dedup remains required.

Responsibilities must remain separate:

- The effective source handles approved item/session corrections and supersession.
- Remaining-fruit dedup handles only its existing narrowly defined unidentified-return duplication case.
- Remaining dedup must not suppress rows merely because a related session was already excluded by the effective source.
- Approved additional-return sessions remain valid effective rows.
- Similar valid sessions remain counted unless an approved correction excludes one.

Required regression coverage:

1. Existing session-aware dedup tests remain unchanged and passing.
2. A legacy unidentified return matching an identified session is suppressed exactly once.
3. An approved supersession excludes only the old session; remaining dedup does not suppress valid replacement rows.
4. The valid 24-item replacement in the 2026-07-21 case remains present after the earlier session is superseded.
5. Two similar but valid sessions remain counted when no approved supersession exists.
6. Main and additional normal-return sessions remain additive.
7. Item corrections appear once in remaining calculations.
8. Approved added items appear once.
9. Rejected and pending corrections do not change remaining totals.
10. Web and LINE remaining summaries agree from the same effective input.
11. Switching between legacy and effective sources does not reintroduce an excluded duplicate row.
12. Stable effective-row IDs prevent overlay/union logic from duplicating raw rows.

## 2026-07-21 acceptance case

After Phase 0 confirms exact IDs:

1. Duplicate detection links the confirmed pair.
2. Clerk reviews evidence and recommends `confirmed_duplicate`.
3. Owner marks the pair `confirmed_duplicate`; totals remain unchanged.
4. Clerk or owner creates `supersede_session` against the earlier 23-item session.
5. `replacement_session_id` is the confirmed valid 24-item session.
6. Owner approves the supersession.
7. The earlier 27,498.50 THB session is excluded.
8. The valid 24-item, 28,388.50 THB session remains effective.
9. Every effective report, export, and LINE summary shows 28,388.50 THB.
10. Remaining-fruit logic does not suppress valid replacement rows.
11. Raw messages, both sessions, warning evidence, clerk recommendation, owner decision, correction request, and approval remain auditable.

## Later phases

### Phase 2 — Product master and standard pricing

- Add the four confirmed top-level categories.
- Add canonical products, aliases, permitted units, and price history.
- Add a price-specific approval role only in this phase.
- Apply the approved whole-business-date standard-price rule.
- Key expected-value inputs to work rounds.
- Never silently recalculate certified history.

Complexity: large.

### Phase 3 — Purchasing, warehouse, and damaged returns

- Add purchasing and receiving roles only in this phase.
- Add purchase sessions, items, expenses, and documents.
- Add central sellable and damaged/quarantine stock.
- Implement weighted-average actual cost.
- Post issue, normal-return, damage, adjustment, and reversal movements.
- Do not post a synthetic market-sale movement.
- Keep sold/accountable quantity derived per work round.
- Defer bill OCR; use manual structured entry and stored bill images.

Complexity: large.

### Phase 4 — Work-round settlement and white forms

- Adopt the production-verified `work_rounds` model or add an equivalent through an additive, preconditioned migration.
- Add seller permissions only when required for submission.
- Key expected-money snapshots, white forms, transfer verification/links, reconciliation, and finalization by `work_round_id`.
- Support all confirmed paper fields.
- Separate declared cash from cash actually received.
- Preserve paper certification during the transition.
- Persist transfer-validation flags and duplicate transaction identities.

Uniqueness:

- One active white-form revision per `work_round_id`
- Expected snapshot by work round + revision
- One current reconciliation per work round
- Legacy source/date uniqueness only for rows without a work-round ID

Required work-round references:

- `produce_sessions.work_round_id`
- Slip batches, evidence, and manual-slip sessions
- `transfer_verifications.work_round_id`
- `white_forms.work_round_id`
- `white_form_transfer_links.work_round_id`
- `expected_money_snapshots.work_round_id`
- `transfer_reconciliations.work_round_id`
- Settlement finalization records

Composite relationships must enforce that each white form, transfer verification, transfer link, and expected snapshot belongs to the same work round.

Complexity: large.

### Phase 5 — Unified stock and profitability reporting

- Add warehouse, category, product, and market reporting.
- Add certified white-form and work-round reporting.
- Add actual cost, damage loss, margin, and profit/loss.
- Preserve legacy historical adapters.
- Add formal TXT export only if an operational dependency is confirmed.
- Add explicit sale movements only after independent sale events exist.

Complexity: medium.

## Migration, testing, and rollout rules

### Migration rules

- Never rewrite, squash, renumber, or fabricate historical migrations.
- Every reconciliation or feature change must be additive and forward-only.
- Every migration must state explicit schema/data preconditions.
- Preconditions must fail before partial mutation.
- Production application is separate from repository implementation and requires explicit review.
- Raw financial and inventory history must never be hard-deleted.

### Phase 1 test plan

- Clean-origin baseline versus dirty-WIP observation separation
- Authentication and three-role authorization matrix
- Direct table/RPC access restrictions
- Audit immutability
- Effective/legacy Phase 1A parity
- Add/edit/void/supersede overlays
- Idempotent retry and stale-version conflicts
- Clerk duplicate recommendation versus owner-only final decision
- Proof that warnings and warning decisions never alter totals
- Cross-report effective-source consistency
- Remaining-fruit double-suppression and reintroduction regressions
- Exact 2026-07-21 acceptance case
- Full tests, lint, type-check, and production build in the clean implementation worktree

### Rollout rules

- Keep legacy and effective reads independently selectable during validation.
- Do not enable Phase 1B mutations before Phase 1A shadow parity passes.
- Do not cut reports over until correction and dedup regression tests pass.
- Roll back through read-source selection, superseding records, or compensating ledger movements—not deletion.
- Certified expected-money and white-form snapshots are immutable; changes create new revisions.
- Production deployment requires a separately reviewed and authorized action.

## Final implementation order

1. Complete and approve Phase 0.
2. Deliver Phase 1A with production correction mutations disabled.
3. Validate shadow parity and remaining-dedup regressions.
4. Deliver Phase 1B mutations and admin UI behind controlled activation.
5. Validate the exact 2026-07-21 incident case.
6. Cut reports to the effective source.
7. Begin Phase 2 only after Phase 1B acceptance.
