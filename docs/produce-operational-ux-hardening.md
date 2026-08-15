# Produce — Operational UX Hardening

The Produce backend is safe. Accountability-round binding, P4A entry validation,
duplicate protection, out-of-order LINE admission and quantity invariants all
fail closed, and none of that changes here.

What is not yet safe is the *operator experience around* those refusals. Real
shops type imperfectly. A one-character difference in a market name currently
produces a second business identity; a shorthand unit produces a block with no
route forward; a pending document belongs to whoever opened it, so a second
operator in the same group cannot finish it.

This phase is four sequential PRs. Each one keeps validation fail-closed and
adds only the guidance a human needs to resolve the ambiguity themselves.

## The invariant every PR in this phase preserves

> Validation remains fail closed. The UX layer helps humans resolve ambiguity.
> The system never silently guesses business identity.

Concretely:

* No fuzzy auto-merge. A reviewed alias is deterministic normalization; anything
  else is a suggestion the operator must act on.
* A typo never binds to an unrelated market, seller, product or unit.
* When the system cannot prove one identity, it persists nothing and says which
  identity it *would* accept.
* Suggestions are computed from evidence that already exists (the reviewed
  catalog, this round's own withdrawal master), never invented.

## PR A — market / vocabulary identity guard  *(this PR)*

**Problem.** `พาซิโอ้`, `พาซีโอ้` and `พาสิโอ้` are one real market. Production
2026-08-14 holds two accountability rounds for seller ต้อม because of it.
Separately, the shop's shorthand `ปุก` for `กระปุก` is blocked by P4A.

**Change.**

* One authoritative market identity, used by round creation, round lookup,
  continuation, return/damage binding and the duplicate fingerprint alike: the
  reviewed catalog (`line_guided_menu_markets` + `line_guided_menu_market_aliases`),
  mirrored into TypeScript as `canonicalMarketLabel()` for the offline
  fingerprint path.
* Reviewed aliases added: `พาซีโอ้` → `พาซิโอ้`, `พาสิโอ้` → `พาซิโอ้`
  (canonical market `พาซิโอ้` registered; the existing `ทุ่งลานนา` →
  `วัดทุ่งลานนา` and every other 0055 alias is preserved unchanged).
* Reviewed unit alias: `ปุก` → `กระปุก`, factor 1. Quantity untouched.
* New **near-match guard**: a withdrawal whose market is not a reviewed alias
  but is one character away from an existing open withdrawal round for the same
  group/date/seller does **not** create a second round. It fails closed and
  names the existing market so the operator can retype it.

**Not in PR A.** No product auto-aliasing, no confirmation *state*. The
near-match guard is a refusal with a suggestion, which is the safe first version.

## PR B — cross-user pending takeover

**Problem.** One LINE user opens a pending Produce document, hits a validation
block, and disappears. `pending_sessions` is keyed by `session_key`, which
embeds the LINE user, and `bind_plain_text_accountability_round` refuses on
`identity_mismatch` when a different actor touches the generation. A second
operator or admin in the same group cannot finish the document, and cannot
discard it either.

**Direction.** Explicit, audited takeover of a *pending* generation inside the
same source, never an implicit one:

* an explicit operator command claims the pending document;
* the claim is recorded (original actor kept as provenance, claimant recorded as
  the acting user), and only inside the same `source_id` and business date;
* the accountability round it is bound to does not change owner — PR #50's
  business-identity rule already lets a different actor continue the round;
* stream locks, deferred-event ordering and finalization barriers from PR #52
  are untouched: takeover changes *who may act*, never *what order events
  applied in*;
* a takeover of an already-finalizing generation is refused, not queued.

Needs a migration (a claim RPC + provenance columns) and a LINE command.

## PR C — correction UX

**Problem.** A validation failure today tells the operator what is wrong but
forces them to know the session lifecycle to fix it: which message to resend,
whether to re-send the header, whether the round is still open.

**Direction.** Turn each blocking exception into a route forward:

* the corrected line can be sent on its own and replaces the offending line in
  the pending document, rather than requiring a full resend;
* `product_not_withdrawn` shows the exact withdrawal spelling (already
  implemented — PR A adds regression coverage) in a copy-paste-ready form;
* `unknown_unit` offers its nearest known unit the same way;
* an explicit "what is still blocking" query for a pending document.

No new silent normalization: every correction is an operator action.

## PR D — operational recovery / admin controls

**Problem.** Cleanup is currently a developer with SQL access. Production
already carries the artefacts: empty open rounds from blocked-then-retried
withdrawals, and the 2026-08-14 duplicate-identity pair for ต้อม.

**Direction.** Admin-scoped, audited operations:

* list open rounds and pending documents for a group/date;
* cancel an *empty* round (the guard `cancel_duplicate_plain_text_round` already
  encodes: no produce session, no transaction, no other pending generation);
* propose a market-alias registration from an observed variant, for human review
  — a reviewed alias is a catalog write, never an inference;
* merge two accountability rounds only as an explicit, logged, reversible
  admin action, with a preview of what moves.

Historical cleanup of the ต้อม 2026-08-14 pair happens here, after prevention
(PR A) is deployed — never before.

## Rollout order

A → B → C → D, in that order and separately deployed. A is prevention and must
land first so cleanup in D is not immediately re-polluted. B unblocks the
operational dead-end that most often *causes* the retry garbage D cleans up. C
is additive UX on top of both. Nothing in this phase mutates historical
Production business data.
