# P4A completion — plain-text accountability round binding

Status: **implementation in progress**
Branch: `feat/p4a-plain-text-round-binding`
Base: `dd7d2fa013374483ebcae0b7ac6b276dff93dfc6` (`origin/main`, P4A Production Active)

## Mission

P4A's produce entry validation gate is deployed and its unit-vocabulary tier is
proven in Production (`โลก` blocks a return). Its **master tier** — product
identity, unit-vs-master, quantity invariant, price review — never fires,
because it needs `accountability_round_id` and every plain-text produce session
finalizes with `accountability_round_id = NULL`.

This sprint makes the existing plain-text workflow

```
ดำ-ราชพฤกษ์ เบิก / 9/8/2569 / …items… / จบรายการเบิก
ดำ-ราชพฤกษ์ ชั่งคืน / … / จบรายการชั่งคืน
ดำ-ราชพฤกษ์ คืนเสีย / … / จบรายการคืนเสีย
```

participate in the P2E accountability round lifecycle, with no new validation
system, no P4A rewrite and no change to what the operator types.

## Root cause (answers to the section-5 questions)

1. **Where does the guided flow create a round?** `GuidedSessionOpener.open`
   → `ProduceSessionCommandService.execute({kind:"open"})` → RPC
   `open_accountability_round_produce_session` (migration
   `20260808105001_p2e_accountability_round_identity.sql`). That RPC creates the
   round *only* for an initial main `เบิก` (`v_is_initial`), then `UPDATE
   pending_sessions SET accountability_round_id = …` for the generation it just
   opened.
2. **What remembers the active round?** `pending_sessions.accountability_round_id`
   for the live generation, and `accountability_rounds.status = 'open'`.
   `produce_sessions` inherits the value automatically through the P2E trigger
   `propagate_produce_session_accountability_round`, which matches
   `ingest_idempotency_key` back to `session_key || ':' || session_generation`.
3. **Why does plain text skip it?** Plain text never issues a typed open
   command. `WebhookService.tryProcessProduceSession` calls
   `PendingSessionService.create()` / `replaceGeneration()` directly. Those
   writers never touch `accountability_round_id`, and the seller/market/date are
   not known at that moment — they only exist once the accumulated document is
   parsed.
4. **Can the existing round service be reused?** Only partially.
   `open_accountability_round_produce_session` *opens the pending session
   itself* through the guided RPC, so it cannot be pointed at a pending row that
   already exists with `entry_origin IS NULL`. A small additive RPC is required;
   it reuses `accountability_rounds`, `accountability_round_normalize` and the
   same identity checks.
5. **Safest moment to bind?** After the document parses — i.e. at the plain-text
   **close** message (before the immutable close boundary is written) and again,
   idempotently, in the deferred finalizer. Both sites already hold a parsed
   `WeighSession` with seller, market, business date, session kind and item
   transaction types.
6. **How do later sessions retrieve the UUID?** See "Binding algorithm" below.
7. **Two legitimate same-description rounds?** See "Ambiguity policy".
8. **How are rounds closed today?** Only `closeGuidedRound` (`ปิดรอบ` in the
   guided menu) calls `close_accountability_round`. Plain-text rounds therefore
   stay `open`. Discovery is scoped by business date, so an unclosed round from
   a previous day can never be a candidate for today's return.
9. **Legacy data?** Untouched. No backfill, no rewrite. Rows with
   `accountability_round_id = NULL` stay NULL forever.
10. **Mixed-version safe?** Yes. The migration only adds one RPC. The old app
    never calls it and keeps writing NULL, exactly as today.

## Architecture decision

**One additive RPC + one shared TypeScript helper, called from the two places
that already hold a parsed document.** No new round system, no new mapping
table, no change to P4A itself.

```
plain-text close message (webhook)
  ├─ parse accumulated_text + this message
  ├─ bindPlainTextRound()  ── RPC bind_plain_text_accountability_round
  └─ runProduceCloseGate()  (existing P4A close gate, unchanged)
        blocked          → reply ⛔, do NOT set the close boundary
        review_presented → reply ⚠️, ask for a second จบรายการ
        proceed          → append/replaceGeneration with markClose (as today)

deferred finalizer
  ├─ parse
  ├─ bindPlainTextRound()  (idempotent safety net for paths that reach the
  │                          close boundary without passing the webhook gate)
  └─ runProduceFinalizeGate()  (existing, unchanged, read-only, fail closed)
```

Because the gate refusal happens **before** the close boundary, a blocked
session stays in capture: the operator sends the corrected line and closes
again, with the original header and business date intact (section 12).

### Why the close message, and not the header

At header time the document has no items, so "is this a new round" is unknown
and an abandoned header would mint a round with no withdrawals. At close time
the parsed document answers both questions with data that already exists.

## Binding algorithm

Inputs, all derived from the parsed document — never from a stored tuple:
`business_date = parsed.date`, `seller = parsed.staff_name`,
`market = parsed.session_title` (normalized with the same
`normalizedMarketLabel` the guided flow uses, then
`accountability_round_normalize` inside the RPC).

```
is_new_round := parsed.session_kind = 'main'
                AND at least one item has base transaction type เบิก
```

* **is_new_round → CREATE.** Insert into `accountability_rounds` with
  `created_line_event_id = 'plaintext:' || session_key || ':' || session_generation`.
  That column is already `UNIQUE`, which makes creation idempotent *per pending
  generation*: closing twice after a P4A block reuses the same round, while a
  genuinely new generation (a second withdrawal) mints a new one. The value is
  a synthetic, namespaced creation key, not a claim about a real LINE event id.
* **otherwise → RESOLVE, never create.** Trust order:
  1. `pending_sessions.accountability_round_id` already carried by this row —
     the durable tracked binding, which survives `create()`/`replaceGeneration()`
     because neither writer touches the column. Accepted only if the round is
     still `open` and its source, owner, business date, seller and market all
     match the parsed document.
  2. Otherwise discovery among `accountability_rounds` with `status = 'open'`
     and matching `(source_id, owner_line_user_id, business_date,
     seller_label, market_label_normalized)`.
     * exactly one → bind
     * zero → `no_round` (fail closed)
     * two or more → `ambiguous` (fail closed)

Descriptive fields are used for **discovery and validation only**. The UUID is
persisted and is the identity. `ADDITIONAL_WITHDRAWAL`, `GOOD_RETURN` and
`DAMAGED_RETURN` all take the resolve path, so an additional batch enlarges the
same round's withdrawal master (section 14).

## Ambiguity policy

Trust level 1 makes the common case unambiguous: one operator has exactly one
`pending_sessions` row (`session_key = group:<g>:user:<u>`), and it carries the
round its own withdrawal created.

Discovery can only return two candidates if the same operator has two `open`
rounds with the same seller, market and business date **and** the pending row's
own binding is gone or mismatched. That fails closed with an actionable Thai
message; the operator closes one round through the guided menu (`ปิดรอบ`) or
asks an administrator. No newest-wins, no oldest-wins, no price heuristic, no
arbitrary UUID.

Known limitation, reported rather than papered over: after two main withdrawals
for the same seller/market/date, plain-text syntax carries nothing that says
which of the two a later return belongs to. The tracked binding resolves it to
the operator's current round, which is the only non-guessing answer available;
there is no plain-text disambiguation grammar and none was invented.

## Enforcement cutover

`no_round` fails closed only for business dates on or after
`PLAIN_TEXT_ROUND_ENFORCEMENT_FROM`. Earlier dates behave exactly as today
(unbound, unit-vocabulary tier only). Without this, a return entered after
deployment whose withdrawal was entered before it would be permanently
un-recordable. Round *creation* is unconditional from deployment onward.

## Single-message documents

A pasted document that contains a header **and** its `จบรายการ…` closer used to
take `runParser`'s direct-persist path, which writes `produce_sessions` with no
pending row — so it was invisible to P4A and produced an unbound withdrawal that
a later return could never resolve against. It now goes through the same pending
generation → close boundary → deferred finalizer path that pasted *additional*
blocks have always used. A document with items but **no** closer is unchanged
and still persists directly; it is an incomplete document and routing it through
pending would strand it waiting for a close that never comes.

## Files

| File | What |
|---|---|
| `supabase/migrations/20260810120000_p4a_plain_text_round_binding.sql` | the only schema change: one SECURITY DEFINER RPC, `service_role` EXECUTE only |
| `src/lib/produce/plain-text-round-binding.ts` | `isNewRoundDocument`, `bindPlainTextRound`, the enforcement cutover, the Thai refusals |
| `src/lib/produce/entry-validation-message.ts` | `buildPlainTextReviewValidationReply` — same content, "send จบรายการ again" instead of "press ยืนยัน" |
| `src/lib/line/webhook-service.ts` | `runPlainTextCloseGate` + the close-time hook; `markClose` becomes `let` so a refusal drops the close while still appending the text |
| `src/lib/line/pending-session-finalizer.ts` | binds before the read-only gate; `sessionPayload.accountability_round_id` now comes from the binding, not the stale snapshot |
| `supabase/tests/p4a_plain_text_round_binding_bootstrap.sql` | disposable-DB bootstrap |
| `src/lib/produce/migration-p4a-round-binding.pg.test.ts` | 17 real PostgreSQL 17 tests, `REQUIRE_P4A_POSTGRES=1` hard-fails when PG is unavailable |
| `src/lib/produce/plain-text-round-binding.test.ts` | 16 focused tests |
| `src/lib/line/webhook-plain-text-entry-gate.test.ts` | 8 end-to-end close-path tests |
| `.github/workflows/pg-tests.yml`, `package.json` | `test:pg:p4a-round-binding` added to the existing P4A job |

Four existing test doubles (`pending-session-finalizer-additional`,
`pending-session-finalizer-multiline-item`, `webhook-pending-boundary`,
`webhook-structured-text-close`) learned to answer the new RPC with
`{"outcome":"no_round"}`, which is the honest answer for a double that has no
`accountability_rounds` table. Without it they returned `{data:null}` and the
binding failed closed — correct behaviour, wrong fixture.

## Known limitations, reported not papered over

1. **Two open same-description rounds.** Plain-text syntax carries nothing that
   says which of two rounds a later return belongs to. Trust 1 answers it with
   the operator's own current round; if that binding is gone, discovery refuses.
   No allocation rule was invented.
2. **Single-message complete documents.** A message carrying a header *and* its
   closer still takes `runParser`'s direct-persist path: no pending row, no
   entry gate, no accountability round. Routing it through pending was
   implemented and then reverted — it moved that path's validation evidence,
   duplicate handling and immediate reply onto the deferred finalizer, a legacy
   behaviour change well beyond round binding days after a Production release.
   The multi-message workflow the operators actually use is fully gated.
3. **A blocked withdrawal still opens its round.** The round is created at the
   first close and reused on the corrected one (idempotent per generation). An
   abandoned session therefore leaves an empty open round, exactly as an
   abandoned guided open does.

## Exact next action

Full regression, then commit / push / PR / CI, then the Production release order
in section 25 of the sprint prompt.
