# P2E — Accountability round identity

Status: implementation contract. P2E owns identity and association only; P3 owns profitability.

## 1. Meaning

An accountability round is one economically distinct cycle that starts when produce is first issued to one seller/operator for one market and ends after all produce, transfer, cash, expense, wage, settlement, and reconciliation evidence for that cycle is closed. `accountability_rounds.id` is a generated UUID and the only canonical identity. Source, seller, market, date, session key, and session generation are attributes, never an identity or fallback key.

Two rounds may have identical source, owner, seller, market, and business date. They still have different UUIDs.

## 2. Creation point

The earliest authoritative event is an accepted initial guided main withdrawal open. Its LINE event ID is the retry key. One database transaction opens the structured pending generation, creates the UUID round, and binds the generation. A retry of the same event returns the same UUID. Another accepted event creates another UUID even when every descriptive attribute matches.

Legacy free-text sessions have no equally strong open event. P2E does not manufacture a round for them.

## 3. Lifecycle

`open` accepts produce and financial evidence. `closed` is terminal for new evidence. `cancelled` records an abandoned round without deleting audit history. P2E does not infer lifecycle from dates and does not calculate profit.

## 4. Ownership

Each round freezes LINE source type/ID and owner LINE user ID from the accepted guided open. Continuation validates the requested UUID against source, owner, seller, normalized market, business date, and `open` status under a row lock. A mismatch refuses before rotating the pending generation.

## 5–8. Produce binding

- Initial withdrawal: creates and binds a new UUID atomically.
- Additional withdrawal: requires an explicit existing UUID; descriptive matching is forbidden.
- Good return: requires an explicit existing UUID.
- Damaged return: requires an explicit existing UUID. P2E records identity only and does not create a `DAMAGED_WRITE_OFF`, because issued stock already left `MAIN` and a second decrement would be wrong.
- Multiple additional sessions may bind the same round. Each keeps its existing `session_key:session_generation` ingest idempotency.
- A pending generation carries the UUID into its immutable `produce_sessions` row. Legacy/unbound produce remains NULL.

The minimum continuation mechanism is an opaque/server-stored round UUID supplied to the structured open command. Callers must obtain it from an explicit operator choice. Even one descriptive candidate is not auto-selected. Until a UI exposes that choice for an operation, the safe behavior is refusal, not tuple inference.

## 9. Inventory

`inventory_movements.accountability_round_id` is the only inventory round column; movement lines and P2D cost rows inherit through their existing parent FKs. A bound non-reversal movement must trace to a `produce_sessions` row carrying the same UUID. A reversal inherits the original movement UUID and cannot change it. Purchase receipts and adjustments remain unbound unless a future authoritative contract says otherwise.

P2E creates no ISSUE adapter: produce rows do not yet freeze canonical ledger product/unit keys. P3 must report INCOMPLETE when a round has no bound ISSUE/cost evidence. P2D weighted-average pools remain keyed only by location/product/unit, never by round.

## 10–13. Financial evidence

- AI transfer slips: bind `slip_batches`; attached `slip_evidences` inherit the same UUID. `slip_checks` inherit through evidence.
- Manual transfers: bind `manual_slip_sessions`; entries inherit through session.
- White-sheet money: bind the staging note session and canonical `digital_white_sheet_cash_entries`; lifecycle events inherit the canonical row.
- Expenses/wages/cash use the existing white-sheet columns. Settlement aggregates remain their separate existing contract; P2E adds identity, not duplicate money.
- Settlement entries, settlement finalizations, and transfer reconciliations carry the UUID when the caller has authoritative round context.

Existing descriptive unique constraints remain during the mixed-version gate. They may safely refuse a same-description second bound financial row; they must never overwrite or merge it. Removing those constraints requires a later cutover after every writer uses round-aware RPCs, because old PostgREST `onConflict` calls otherwise break (the failure previously repaired by migration 0058).

## 14. Corrections and reversals

Artifact UUID bindings are write-once: NULL may be explicitly bound after proof, but non-NULL cannot be cleared or changed. Corrections keep the existing artifact's update/revision contract and the same round. Inventory reversals copy the original round. Voided/replacement produce sessions retain round lineage; replacement cannot move evidence to another round.

## 15–18. Legacy, backfill, ambiguity, idempotency

- Existing rows remain NULL and are classified `legacy_unbound`/INCOMPLETE by consumers.
- Safe backfill is allowed only from a durable one-to-one parent relation, such as evidence inheriting an already-bound batch or a reversal inheriting its original movement.
- No backfill uses source/date/market/seller, even when one candidate currently exists.
- Ambiguous association refuses and stays NULL.
- Round creation retries use the unique accepted open event ID. Artifact retries keep their existing durable keys and must return the already-bound UUID or reject a mismatch.

## 19. Concurrency

The structured open transaction retains current source ownership/session-generation serialization, locks continuation rounds, and uses a unique open-event key. Concurrent retry of one event yields one UUID. Two valid sequential same-day open events yield two UUIDs. Artifact parent/child FKs and write-once triggers prevent racing rebinds.

## 20. Auditability

The round stores creator event, source, owner, seller, market, date, status, and timestamps. Child rows retain their existing raw-message, LINE-message, ingest, source-document, revision, and reversal evidence. No history is rewritten.

## 21. Security

`accountability_rounds` has RLS enabled and no public policies. PUBLIC, anon, and authenticated receive no table access or privileged function execution. Narrow RPCs use `SECURITY DEFINER`, fixed `search_path = public, extensions, pg_temp`, validate all identities, and are executable only by `service_role`.

Production currently reports RLS disabled on `settlement_entries`, `produce_session_notifications`, and `produce_notification_attempts`. P2E does not silently change those unrelated live access contracts; remediation needs a separate policy decision.

## 22. Mixed-version rollout

Migration M1 is forward-only and additive: new table plus nullable FKs, indexes, triggers, and new RPC signatures. Old writers continue with NULL. New writers use generated/explicit UUIDs. No NOT NULL is added to legacy artifacts. Plain legacy unique constraints stay until all writers are round-aware; conflicts fail closed rather than merge money.

## 23. Rollback

Application rollback is safe because columns stay nullable and old RPCs remain. Schema rollback is not destructive: leave M1 objects in place and stop new writers. Do not drop UUIDs or rewrite history.

## 24. P3 handoff

Profitability snapshot identity is exactly `(accountability_round_id, revision)`.

P3 must join:

- issued quantity and ISSUE cost through bound `inventory_movements` and lines;
- good return and approved damage through bound produce sessions/evidence;
- expected money through bound produce items and the round's pricing revision;
- expenses, wages, and actual cash through bound white-sheet cash;
- transfers through bound checked slip evidence/manual slip sessions;
- shortage/overage through bound settlement and reconciliation.

Any required NULL, missing, or mismatched binding makes the snapshot INCOMPLETE. P3 must never fall back to source/date/market/seller.

## 25. Acceptance criteria

1. Same-description opens create different UUIDs.
2. Retry of one open event returns one UUID.
3. Main withdrawal creates a round; additional withdrawal, good return, and damaged return require and preserve an explicit UUID.
4. Produce finalization carries pending UUID to `produce_sessions`.
5. ISSUE, slip/evidence, manual slip, white-sheet cash, settlement, finalization, and reconciliation support nullable round binding.
6. Wrong source/owner/round and parent/child mismatch fail in PostgreSQL.
7. Rebinding and reversal lineage violations fail.
8. Legacy rows stay NULL; ambiguous tuple backfill is absent.
9. Real PostgreSQL concurrency and constraint tests hard-fail in CI when PostgreSQL is unavailable.
10. P2D/P3 worktrees, Production data/schema, LINE, and PR #36 remain untouched.
