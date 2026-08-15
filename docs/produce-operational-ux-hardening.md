# Produce — Operational UX Hardening

The Produce backend is safe. Accountability-round binding, P4A entry validation,
duplicate protection, out-of-order LINE admission and quantity invariants all
fail closed, and none of that changes here.

What is not yet safe is the *operator experience around* those refusals. Real
shops type imperfectly. A one-character difference in a market name currently
produces a second business identity; a misspelled product name creates a second
product; a shorthand unit produces a block with no route forward; a pending
document belongs to whoever opened it, so a second operator in the same group
cannot finish it.

## The invariant every change in this phase preserves

> Validation remains fail closed. The UX layer helps humans resolve ambiguity.
> The system never silently guesses business identity.

Concretely:

* No fuzzy auto-merge. A reviewed alias is deterministic normalization; anything
  else is a suggestion the operator must act on.
* A typo never binds to an unrelated market, seller, product or unit.
* When the system cannot prove one identity, it persists nothing and says which
  identity it *would* accept.
* Suggestions are computed from evidence that already exists (the reviewed
  market catalog, the approved product dictionary, this round's own withdrawal
  master), never invented.
* Historical evidence is never destroyed to make a current attempt succeed.

## Status

| change | state |
|---|---|
| Product Vocabulary Guard (PR #54) | **merged, Production-active** |
| 08:00 Good Return category classification (PR #55) | **merged, Production-active** |
| PR A — market identity guard + fingerprint compatibility (PR #53) | in review |
| PR B / C / D | not started |

## Product Vocabulary Guard  *(PR #54 — shipped)*

**Problem.** A withdrawal is where a product identity is *created*. Nothing
checked the spelling at that moment, so `4มะม่วงเขียวรกต30บาท` finalized as a
new product, and the mistake only surfaced hours later when the return was typed
correctly and P4A refused it as `product_not_withdrawn`. By then the withdrawal
master was already poisoned. The validator was right; it was just looking at the
wrong end of the round.

The read-only Production audit of 2026-08-15 found nine distinct finalized
withdrawal names outside the approved vocabulary — `มะม่วงเขียวรกต`,
`เขียวมรกต`, `สับปรด`, `ไซมัส`, `อินทผรัม`, `อินมผรัม`, `อะโวคาโด้`,
`ปลาอินทรีย์`, `หมึกกระตอย` — across 19 rows and six sellers (ขวัญ, ดำ, ต้อม,
แทน, มิ้น, เมย์). 2026-08-14 held 33 such names, almost all of them misspellings
of a product that already has a code.

### The dictionary is still NOT a hard allowlist

It gains a second, weaker job: **approved reference vocabulary**. A withdrawal
product name now falls into exactly one of three states.

| state | what it means | what happens |
|---|---|---|
| **known** | exactly an enabled canonical name, or a code that resolved to one | nothing — clean |
| **suspicious** | anything else | `unknown_product_vocabulary`, `review_required`, with up to three suggestions |
| **confirmed new** | suspicious, and the operator confirmed it | persists **exactly** as typed |

A genuinely new product is still enterable — it costs one extra confirmation,
never a rejection. Confirming does **not** register the name: no row is written
to `produce_product_codes`, no code is allocated, no alias is created.
Dictionary maintenance stays a separate administrative action.

### Suggestion is never identity

Three deterministic signals, strongest first. No model, no embedding, no network
call.

1. **Reviewed alias.** `PRODUCT_ALIASES` already knows `อะโวคาโด้ → อะโวคาโด`.
   That is read as *evidence*, never as a resolution — see below.
2. **Bounded edit distance ≤ 2.** Covers `มะม่วงเขียวรกต`, `สับปรด`, `ไซมัส`,
   `อินทผรัม`, `อินมผรัม`.
3. **Longest shared character run**, at least 4 characters and at least half of
   what the operator typed. This is the signal edit distance misses: `เขียวมรกต`
   is six edits from `มะม่วงเขียวมรกต` but wholly contained in it, and dropping a
   leading word is the commonest shop shorthand there is.

Measuring that run against the *entered* name rather than the shorter of the two
is deliberate: a five-character head word shared with `ฝรั่ง` is not evidence
that `ฝรั่งสายพันธุ์ใหม่` was meant to be `ฝรั่ง`.

At most three candidates, and an empty list is a legitimate answer. Nothing is
ever auto-selected. `เขียวมรกต` and `เขียวมรกตเก่า` are one token apart and are
different goods; `ปลาอินทรีย์`/`ปลาอินทรี` and `หมึกกระตอย`/`ปลาหมึกกะตอย` are
suggested and explicitly **not** mapped, because the business has not confirmed
they are the same item.

### The reviewed alias contract

`PRODUCT_ALIASES` is *reporting* canonicalization. It is not promoted to
withdrawal-intake authority. The policy, stated once:

> At intake an alias spelling is **shown**, not **applied**.

`อะโวคาโด้` is therefore not silently accepted merely because reporting knows how
to fold it — the operator sees `ม59 — อะโวคาโด` and decides. Reporting continues
to fold both spellings, and P4A return matching continues to use
`normalizeProductName` exactly as before, so nothing downstream changes. What
changes is that the withdrawal master stops accumulating one more spelling of a
product that already has an approved name.

### Where it lives

Inside the existing P4A gate, as one more `review_required` exception —
deliberately not a second state machine. That inherits, for free, everything the
price review already proves:

* the confirmation is bound to `computeValidationDigest`, which covers the
  session content *and* the exception set, so any later straggler or correction
  invalidates it;
* the two-press protocol carries a different `line_event_id` on the second
  press, so a duplicate LINE delivery can never stand in for an acknowledgement;
* an unresolved review persists **zero** produce rows — no partial withdrawal
  master, ever;
* every suspicious name in the document is reported in one reply, ordered by
  item number, one entry per distinct spelling.

`unknown_product_vocabulary` is kept separate from `product_not_withdrawn` on
purpose. The first is a *withdrawal* minting a suspicious identity; the second is
a *return* that does not match the master. Overloading one onto the other would
lose the distinction that makes either of them actionable.

No migration. `produce_entry_validation_reviews.exceptions` is `jsonb` with no
constraint on the exception kind, and it already stores the exact set that was
shown.

## PR A — market identity guard + fingerprint compatibility  *(PR #53, in review)*

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
* **Duplicate-fingerprint compatibility.** Folding aliases changes the market
  component of the business fingerprint, which means the duplicate blocker would
  stop recognising rows the previous release wrote. See below.
* **Ghost-reservation provenance.** Widening duplicate lookup across three
  fingerprint generations made the existing ghost-recovery delete dangerous. See
  below.

**Product names are not in scope here.** Withdrawal spelling is governed by the
Product Vocabulary Guard above (PR #54, already in Production): a suspicious
withdrawal name is `review_required` with suggestions, and a confirmed new
product persists exactly as typed. A *return* that does not match the round's
withdrawal master remains fail-closed under P4A as `product_not_withdrawn`. PR A
adds no second product guard and changes neither behaviour.

### Fingerprint generations

Three algorithms have written `imported_sessions.session_hash`:

| | shipped | market component |
|---|---|---|
| **V0** | pre-PR #51 | raw parsed strings, ordered by item number — a different algorithm entirely |
| **V1** | PR #51 | canonical business content, market = **normalized raw label** |
| **V2** | PR A | canonical business content, market = **reviewed canonical identity** |

A session's own identity is always V2. V0 and V1 stay *readable*, and no
historical row is ever rewritten or backfilled.

V1 is the one that bites: Production holds V1 rows written between the two
releases — seller ต้อม / `พาซีโอ้` on 2026-08-14 and 2026-08-15, plus
`ราชพฤก`, `ตลาด72` and `เลียบทางด่วน` rows for other sellers. Under V2 those
labels fold to their canonical markets and hash differently, so a resend would
not recognise its own recent history.

`try_finalize_pending_generation` therefore takes a `p_compatibility_hashes`
array: the V1 fingerprints of the same document under the market's *other
reviewed spellings*. It **reserves** them on the UNIQUE
`imported_sessions.session_hash` index before reserving V2, and a main session
that cannot take all of them is a duplicate. Reserving rather than reading is
what makes a rolling deploy safe — the previous build writes V1 directly, so
both builds have to meet on the same index.

The compatibility set is the reviewed equivalence class and nothing wider. An
unreviewed near-miss such as `พาชิโอ้` is its own market in the fingerprint
exactly as it is everywhere else.

### Ghost-reservation provenance

Widening duplicate lookup across V0/V1/V2 turned an existing recovery path into
a way to destroy real evidence.

The old shape was:

```ts
let isDuplicate = await dedup.isDuplicate(ws);
if (isDuplicate && !(await dedup.hasPersistedItems(ws))) {
  await dedup.release(ws);   // delete the reservation
  isDuplicate = false;
}
```

`computeItemHash` includes `parsed.session_title` — the market label. So for a
historical session persisted under `พาซีโอ้`, a resend under the canonical
`พาซิโอ้` matches the V1 reservation but can never match the historical item
hashes. The old code would read that as "duplicate exists, but nothing
persisted", delete the genuine historical reservation, and let the duplicate
withdrawal persist a second time.

The fix is ownership, not heuristics. `imported_sessions` gains one nullable
column, `reserved_by_generation uuid`, stamped only by the code path that
created the reservation. Release is then scoped to what the current attempt
provably owns:

* a reservation with **NULL** provenance predates the mechanism, or belongs to
  another attempt. It is historical evidence and is **never** deleted.
* a reservation stamped with the **current** generation is this attempt's own
  and may be released when it proves to be a ghost.

Read-only Production measurement behind this choice: of 1,934 reservations, only
4 have no corresponding produce rows at all, and three of those are parse
artefacts (empty `staff_name`, the whole header line stored as the market) plus
one test row. Refusing to release unstamped reservations strands nothing real.

Duplicate detection now returns the matched hash and its generation rather than
a bare boolean, so the caller can tell historical evidence from its own
reservation instead of guessing from item hashes.

### Rolling deploy — the state machine

The application calls the RPC with `p_compatibility_hashes`. Production's
current function has **eight arguments and no defaults**, so that call does not
resolve there at all. The schema must move first.

```
STATE 0   old app + old schema            current Production baseline
   ↓        apply fingerprint compatibility migration
STATE 1   old app + compatibility schema  SUPPORTED
   ↓        deploy the application
STATE 2   new app + compatibility schema  SUPPORTED  (old/new coexist here)
   ↓        verify
STATE 3   new app + compatibility + market identity   SUPPORTED, final

FORBIDDEN new app + old schema — the RPC signature does not exist
```

STATE 1 is what makes this safe: the new parameter is
`p_compatibility_hashes text[] DEFAULT NULL`, so the still-running old build,
which sends the eight existing **named** parameters and omits the new one, keeps
resolving to the same function and behaving exactly as before.

Inside STATE 2 old and new instances coexist for the length of one deploy. The
compatibility reservation covers that window in both directions: the old build
writes V1 directly, the new build reserves the V1 class, and both meet on the
same UNIQUE index, so exactly one submission wins.

Market identity activation is deliberately **last**. Landing the catalog rows
earlier would give the database alias-aware round binding while some instances
still fingerprint `พาซีโอ้` and `พาซิโอ้` apart — one round, two accepted
identities, which is the exact double-persist this phase exists to stop.

Migration filenames encode that dependency: the compatibility migration sorts
before the market identity migration, so no ordering is left to a runbook.

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

A → B → C → D, in that order and separately deployed. Within A the order is
schema-then-application, per the state machine above — never the reverse. A is
prevention and must land first so cleanup in D is not immediately re-polluted. B
unblocks the operational dead-end that most often *causes* the retry garbage D
cleans up. C is additive UX on top of both. Nothing in this phase mutates
historical Production business data.
