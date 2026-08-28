# P4A — Produce entry validation gate (handoff)

**Status:** implementation complete, validation in progress.
**Production mutations: NONE.** No migration applied, no deploy, no LINE send, no
Production data touched. Production was not even read.

## Mission

Catch human transcription mistakes at entry time instead of discovering them in
the 08:00/08:10 reports. The bot becomes the second checker: every return line
is compared against its own round's withdrawal master before the session may
finalize.

## Branch / base

| | |
|---|---|
| Branch | `feat/p4a-produce-entry-validation-gate` |
| Worktree | `.claude/worktrees/p4a-produce-entry-validation-gate` |
| Base SHA | `d481a51` (`origin/main`, "Merge pull request #39 from Andromedas47/codex/p3-release") |
| Head SHA | `d7b9fd5` — `feat(produce): gate produce entry on the round's withdrawal master` |

The primary checkout's own dirty state (staged P2E/P2D work on
`fix/purchase-capture-supplier-key-pairing`, plus `uat-preview-results/`) was
deliberately left untouched — that is why this work lives in a worktree.

## Frozen business rules (do not renegotiate)

1. Withdrawal data is the master reference for product identity, unit identity,
   available quantity and known prices, per accountability round.
2. Product identity is **(canonical product, canonical unit)**. Price is never
   part of identity — several withdrawal price buckets on one product (100 and
   119 on the same durian) are normal, not an error.
3. **A return price may differ from the withdrawal price.** It is never coerced
   and never rejected — it only has to be acknowledged.
4. Fuzzy similarity produces a *suggestion*, never a match. `เขียวมรกต` and
   `เขียวมรกตเก่า` are never merged.
5. An unknown unit (`โลก`) is a blocking exception. Unknown units are never
   converted.
6. `good return + damaged return > withdrawal` is impossible data. No
   confirmation can override it.
7. An approved price override means "this entry is deliberate". It is **not** a
   financial certification — P1/P2/P3 accounting semantics are untouched.
8. Prospective only. No historical row is rewritten, corrected or backfilled.

## Architecture decision

The repo already had the right shape, so P4A is an extension, not a subsystem.

- `GuidedSessionCaptureService.requestClose` already ran the finalizer's own
  validation *before* creating the immutable close boundary, precisely so a
  refusal leaves the round in capture where a correction is an ordinary item
  message. The gate hooks in at exactly that point.
- The same check already ran again at `confirmFinalize` and a third time in the
  deferred finalizer. The gate hooks into all three, so a verdict is never
  older than the data it describes.
- Round identity is P2E `accountability_round_id`, carried on `pending_sessions`
  and propagated to `produce_sessions`. The master is read from the existing
  `produce_transactions` view, which already excludes voided sessions.

### Two tiers, deliberately

| Tier | Applies to | Why |
|---|---|---|
| Unit vocabulary | **every** session, bound or legacy | Self-contained; needs no master. This is the `โลก` fix. |
| Product / unit / quantity / price vs master | round-bound sessions, or any session whose own document contains a withdrawal | An unbound legacy session has no knowable round. Blocking it would be guessing, not failing closed. |

### Confirmation protocol

Two presses of the **existing** button, no new command:

1. First `จบรายการ` with price exceptions → nothing is closed; the exceptions
   are shown and recorded (`presented_line_event_id` = that event).
2. Second press (a *different* LINE event) → acknowledges exactly that exception
   set, then closes.

A duplicate delivery of the presenting event carries the same event id and can
therefore never stand in for the acknowledgement. The acknowledgement is bound
to a **digest over the session content plus the exception set**, so a straggler
that changes the document invalidates it and the operator is asked again.

Blocking exceptions have no confirmation path at all — they must be corrected.

## Files changed

**New**

| Path | What |
|---|---|
| `src/lib/produce/entry-validation.ts` | Pure domain: master folding, the four blocking checks, the price review, the digest |
| `src/lib/produce/entry-validation-message.ts` | Thai operator text, exceptions only, capped at 10 listed |
| `src/lib/produce/entry-validation-gate.ts` | DB-facing gate: round master read, review record/confirm, close vs finalize decisions |
| `src/lib/summary/pending-validation-notice.ts` | 08:00 "some produce never landed" notice |
| `supabase/migrations/20260810070313_p4a_produce_entry_validation_gate.sql` | Additive append-only audit table + 2 SECURITY DEFINER RPCs |
| `supabase/tests/p4a_produce_entry_validation_bootstrap.sql` | Disposable-DB bootstrap |
| `src/lib/produce/entry-validation.test.ts` | 30 domain regressions (cases A–L) |
| `src/lib/produce/entry-validation-gate.test.ts` | 17 gate regressions (idempotency, staleness, round scoping, fail-closed) |
| `src/lib/produce/migration-p4a.pg.test.ts` | 12 real-PostgreSQL proofs |
| `src/lib/line/guided-menu/produce-entry-gate.test.ts` | 7 close-press integration regressions |

**Modified**

| Path | What |
|---|---|
| `src/lib/parsers/weigh-session/units.ts` | `nearestKnownUnit()` — suggestion only, distance ≤ 1 |
| `src/lib/line/guided-menu/session-capture.ts` | Gate on close and on confirm; new `review_required` outcome |
| `src/lib/line/guided-menu/ux-handler.ts` | Renders the gate's own Thai detail; new review screen |
| `src/lib/line/guided-menu/ux-types.ts` | `session_validation_review` screen name |
| `src/lib/line/pending-session-finalizer.ts` | Read-only revalidation immediately before the authoritative RPC |
| `src/lib/sales/load.ts` | `countUnresolvedPendingSessions` exported (no behaviour change) |
| `src/app/api/cron/daily-stock-summary/route.ts` | Appends the pending-validation notice |
| `.github/workflows/pg-tests.yml`, `package.json` | `p4a-produce-entry-validation` job, `test:pg:p4a` |

## Migration

`20260810070313_p4a_produce_entry_validation_gate.sql` — one table
(`produce_entry_validation_reviews`), two triggers, two RPCs.

- Additive only. No existing table, view, function, constraint or grant is
  altered. No backfill.
- **Mixed-version safe.** The gate is enforced in the application layer, so the
  currently deployed app is unaffected by the table existing: old app + new
  schema behaves exactly as today. New app + old schema is the only unsafe
  order, so the migration ships first.
- Append-only: DELETE always raises; UPDATE may only set the three confirmation
  columns on a still-unconfirmed row, once.
- RLS on, no policies, `REVOKE ALL` then `GRANT SELECT` to `service_role` only;
  both RPCs are `SECURITY DEFINER` with `search_path = pg_catalog, public` and
  executable by `service_role` alone.

## Validation states

| State | Meaning | Confirmable |
|---|---|---|
| `clean` | nothing to say | — |
| `review_required` | `price_not_withdrawn` | yes, explicitly |
| `blocked` | `unknown_unit`, `product_not_withdrawn`, `unit_not_withdrawn`, `return_exceeds_withdrawal` | **never** |

## Results

- `bun test src/lib/produce/entry-validation.test.ts` — 30 pass
- `bun test src/lib/produce/entry-validation-gate.test.ts` — 17 pass
- `bun test src/lib/line/guided-menu/produce-entry-gate.test.ts` — 7 pass
- `ALLOW_DISPOSABLE_POSTGRES_TESTS=1 REQUIRE_P4A_POSTGRES=1 bun run test:pg:p4a` — 12 pass, 1 skip
- `bun test src/lib/line/guided-menu src/lib/line/pending-session-finalizer.test.ts` — 354 pass
- `bun test` (full suite) — **3211 pass, 54 skip, 3 fail**, 3268 tests / 188 files.
  The 3 are the documented baseline below; zero new failures.
- `npm run type-check` — clean
- `npm run lint` — 0 errors, 65 pre-existing warnings, none in P4A files
- `npm run build` — succeeds (worktrees need placeholder Supabase env vars)
- `git diff --check` — clean

**Baseline.** `src/lib/summary/daily-good-return-value.test.ts` fails 3 LINE-cap
assertions, exactly the documented `origin/main` baseline. `git diff d481a51`
shows P4A touches neither that builder, its test, nor `line-chunking.ts`.

**One regression found and fixed during validation.**
`migration-0049-structured-foundation.test.ts` asserts on the *source text* of
`pending-session-finalizer.ts`, slicing between `"} else if (hasHeaderInLedger("`
and the first `"} catch (error) {"`. Defining the new gate helper above
`finalizePendingGeneration` introduced an earlier `catch` and collapsed that
slice to `""`. The helper now lives below `finalizePendingGeneration`. Anything
adding a `try/catch` to that file ahead of the legacy branch will hit the same
trap.

## Known limitations (deliberate)

- Legacy (unbound) sessions get the unit check only. Giving them the master
  checks would mean inventing a round.
- Basis-priced rows are compared on their rounded per-unit price. Both sides
  derive it with the same formula, so identical bundles match exactly.
- Blocking exceptions are surfaced with `⛔` and reviews with `⚠️`, matching the
  repo's existing vocabulary rather than the `❌` used in the spec sketch.

## Next action

Full-suite/lint/build confirmation, then commit, push, open the PR. **Do not
merge, do not apply the migration to Production, do not deploy.**
