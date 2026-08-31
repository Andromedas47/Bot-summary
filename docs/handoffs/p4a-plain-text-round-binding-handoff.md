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
   `20260809045345_p2e_accountability_round_identity_expand.sql`). That RPC creates the
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
| `supabase/migrations/20260810100414_p4a_plain_text_round_binding.sql` | the only schema change: one SECURITY DEFINER RPC, `service_role` EXECUTE only |
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

## Production baseline — read-only preflight, 2026-08-10

Captured before any mutation, with the Supabase MCP.

| | before |
|---|---|
| `accountability_rounds` | 0 |
| `produce_sessions` | 1823 |
| `produce_items` | 28628 (`c20aaba3889ab8711adeeed5e66d6f96`) |
| `produce_transactions` | 28627 |
| `pending_sessions` | 40 |
| `produce_entry_validation_reviews` | 0 |
| `inventory_movements` / lines | 4 / 4 (`fad7c2a5ada13f77b07dcef1a621d809`) |
| `inventory_cost_movement_lines` | 0 |
| `profitability_snapshots` | 0 |

Schema preconditions verified: `pending_sessions.session_generation` is `uuid`
(the RPC signature depends on it), `accountability_round_normalize` and
`open_accountability_round_produce_session` present,
`bind_plain_text_accountability_round` absent.

## Production release — 2026-08-10

Exactly three mutations, in the mandated order.

| | |
|---|---|
| Migration (repo) | `20260810100414_p4a_plain_text_round_binding.sql` |
| Migration (Production) | `p4a_plain_text_round_binding` |
| Merge commit / `main` | `9d2106ba680bd345f202db637da056b4eade6906` (PR #41, `--match-head-commit e443d22`) |
| Deployment | `dpl_AzBq9LsbLbhxvUGxbjnRDy7CqSUN` — READY, target `production`, SHA `9d2106b`, alias `bot-summary.vercel.app`, `aliasError: null` |

**Schema / security.** `bind_plain_text_accountability_round` is
`SECURITY DEFINER`, owner `postgres`, `search_path=public, extensions, pg_temp`.
`service_role` holds EXECUTE; `anon` and `authenticated` hold none. No new
table, no new column, so no new RLS surface. Supabase advisors report the same
four pre-existing ERRORs as before (the two `produce_transactions*` SECURITY
DEFINER views from 0037 and two RLS-disabled tables); the new function appears
nowhere in advisor output, including `function_search_path_mutable`.

**Old app + new schema.** Verified before the merge: `/` 307, `/login` 200,
webhook 401. The deployed build never calls the new RPC, so this step was
expected to be a no-op and was.

**Runtime after deployment.** `/` 307, `/login` 200, webhook 401, both crons
401, zero error or fatal runtime logs, log status codes 200/401 only.

**Data integrity, before vs after — every value identical.**

| | before | after |
|---|---|---|
| `accountability_rounds` | 0 | 0 |
| `produce_sessions` | 1823 | 1823 |
| `produce_items` | 28628 / `c20aaba3…` | 28628 / `c20aaba3…` |
| `inventory_movement_lines` | 4 / `fad7c2a5…` | 4 / `fad7c2a5…` |
| `inventory_cost_movement_lines` | 0 | 0 |
| `profitability_snapshots` | 0 | 0 |
| `produce_entry_validation_reviews` | 0 | 0 |
| `pending_sessions` (bound) | 40 (0) | 40 (0) |

No backfill, no historical repair, no P0–P3 accounting change, no secret
touched. The first round will be created by the first plain-text withdrawal
closed after this deployment — nothing was pre-created.

## Price-review bug found by Production UAT — 2026-08-10

Production UAT proved round binding, unknown-unit blocking and product-typo
blocking, then hit this in the Vercel log at ~17:42 Asia/Bangkok:

```
plain-text produce entry gate failed
validation review lookup failed: invalid input syntax for type bigint: "<uuid>"
```

**Cause.** `20260810090000` declared
`produce_entry_validation_reviews.session_generation` as `bigint`, and both
review RPCs took it as `bigint`. A pending generation is a **uuid**:
`PendingSessionService` mints it with `crypto.randomUUID()`, and every other
generation-scoped column in the schema is uuid —
`pending_sessions`, `pending_session_admission`, `pending_session_ingest`,
`produce_session_notifications`, `physical_inventory_sessions`,
`purchase_capture_sessions`, `purchase_capture_session_ingests`. The review
table was the only outlier. Every review lookup, record and confirm therefore
failed, so the price-review path could never present or acknowledge.

This was **never plain-text-specific**. The guided flow passes the same uuid
through `entryValidationRef`; it simply never reached the code, because until
round binding shipped there was no round to validate against.

**Fix.** `20260810112416_p4a_review_session_generation_uuid.sql` adopts the
identity the rest of the schema already uses: drop the `> 0` CHECK (meaningless
for a uuid), `ALTER COLUMN … TYPE uuid`, and recreate both RPCs with a `uuid`
parameter. No mapping, no hash, no truncation, no numeric surrogate — the audit
row carries the real generation or it audits nothing.

The migration **asserts the table is empty** and refuses otherwise: with rows
present a bigint→uuid change has no meaning-preserving `USING` clause, and
inventing one would be exactly the fabrication this rules out. It also asserts
`pending_sessions.session_generation` really is uuid before adopting that type.
The RPCs are dropped and recreated in one transaction rather than added as uuid
overloads, because two same-named functions differing in one parameter type
would make a named-argument PostgREST call ambiguous.

**Rollout.** The fix contains **no runtime code change** — the only non-test
source edit is a doc comment. The deployed build already sends uuid strings, so
the corrected schema turns a call that always failed into one that works;
old-app-on-corrected-schema and new-app-on-corrected-schema are the same code
path, and there is no window in which anything regresses.

## Human LINE UAT script

The round a return resolves comes from the operator's own pending row (trust 1),
which does not depend on the enforcement cutover. The whole script therefore
works on a **past** business date, so nothing lands in the current day's 08:00
or 08:10 reports. Use seller `เทส`, market `ทดสอบ`, date `20/1/2568`, and send
each line as its own LINE message.

```
A. withdrawal        เทส-ทดสอบ เบิก 20/1/2568
                     1.มังคุด45บาท
                     10โล
                     จบรายการเบิก            → summary, round created

B. unknown unit      เทส-ทดสอบ ชั่งคืน 20/1/2568
                     1.มังคุด45บาท
                     4โลก
                     จบรายการชั่งคืน          → ⛔ blocked, suggests โล

C. correction        4โล
                     จบรายการชั่งคืน          → accepted, 20/1/2568 unchanged

D. product typo      เทส-ทดสอบ เบิก 20/1/2568   (new round)
                     1.ทับทิม15บาท
                     10ลูก
                     จบรายการเบิก
                     เทส-ทดสอบ ชั่งคืน 20/1/2568
                     1.ทับทิบ15บาท
                     4ลูก
                     จบรายการชั่งคืน          → ⛔ blocked, suggests ทับทิม

E. price change      เทส-ทดสอบ เบิก 20/1/2568   (new round)
                     1.อะโวคาโด้100บาท
                     5โล
                     จบรายการเบิก
                     เทส-ทดสอบ ชั่งคืน 20/1/2568
                     1.อะโวคาโด้120บาท
                     2โล
                     จบรายการชั่งคืน          → ⚠️ review, shows 100 vs 120
                     จบรายการชั่งคืน          → accepted, 120 preserved

F. multi-price       เทส-ทดสอบ เบิก 20/1/2568   (new round)
                     1.หมอนทอง100บาท
                     5โล
                     2.หมอนทอง119บาท
                     5โล
                     จบรายการเบิก
                     เทส-ทดสอบ ชั่งคืน 20/1/2568
                     1.หมอนทอง100บาท
                     3โล
                     2.หมอนทอง119บาท
                     2โล
                     จบรายการชั่งคืน          → clean, no false price warning

G. impossible qty    เทส-ทดสอบ เบิก 20/1/2568   (new round)
                     1.แก้วมังกร35บาท
                     5โล
                     จบรายการเบิก
                     เทส-ทดสอบ ชั่งคืน 20/1/2568
                     1.แก้วมังกร35บาท
                     4โล
                     จบรายการชั่งคืน          → accepted
                     เทส-ทดสอบ คืนเสีย 20/1/2568
                     1.แก้วมังกร35บาท
                     2โล
                     จบรายการคืนเสีย          → ⛔ blocked, 4+2 > 5
```

Each new withdrawal opens its own round, so D–G do not interfere with each
other even though seller, market and date are identical — which is itself the
same-description-rounds proof, live.

"Return with no withdrawal" is deliberately not in the script: on a pre-cutover
date it is legacy-unbound by design, and proving it would need a business date
on or after `PLAIN_TEXT_ROUND_ENFORCEMENT_FROM`, which would touch current
reporting. It is covered by the PostgreSQL suite instead.

## Exact next action

Full regression, then commit / push / PR / CI, then the Production release order
in section 25 of the sprint prompt.
