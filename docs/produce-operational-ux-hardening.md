# Produce — Operational UX Hardening

The Produce backend is safe. Accountability-round binding, P4A entry validation,
duplicate protection, out-of-order LINE admission and quantity invariants all
fail closed, and none of that changes here.

What is not yet safe is the *operator experience around* those refusals. Real
shops type imperfectly. A one-character difference in a market name currently
produces a second business identity; a misspelled product name creates a second
product; a shorthand unit produces a block with no route forward.

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

> **Note.** PR #53 (market / vocabulary identity guard) adds its own sections to
> this file on its branch. Both are additive; the two versions merge by
> concatenation.

## Product Vocabulary Guard

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
แทน, มิ้น, เมย์). 2026-08-14 held
33 such names, almost all of them misspellings of a product that already has a
code.

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
withdrawal-intake authority here. The policy, stated once:

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

### Interaction with the duplicate fingerprint

None, by construction. The fingerprint is computed from the parsed item names,
and no name is ever rewritten — a suggestion the operator never accepted cannot
reach it. A corrected document is different content, so it is a different
fingerprint and a different digest; a confirmed new product is fingerprinted
under the raw name that was actually confirmed.

### Deferred finalization

`runProduceFinalizeGate` re-checks the review from live data and never presents
or confirms anything of its own, exactly as it does for price. A document whose
vocabulary review was never acknowledged fails closed at the deferred finalizer
instead of persisting — which is the correct outcome, and is what the two
existing finalizer regression suites now assert explicitly by seeding the
confirmation the close gate would have written.
