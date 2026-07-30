# Guided Operations — end-to-end LINE UX

One guided journey from `เมนู` to a closed round, built entirely on the
services, RPCs and barriers that already exist. This document records the
contracts that were **discovered** before any code was written, the state
machine those contracts imply, and the gaps where the requested design has no
authoritative implementation to reuse.

Base: PR #9 head `6b0089a973710a224e8511049231300cff4c1d92`
(`feat/guided-menu-seller-market-catalog-0055`, additive `0055` + strict
cleanup `0056`).

---

## 1. Discovery — what actually exists

### 1.1 Guided Menu state (0051 → 0055 → 0056)

| Concern | Contract | Where |
|---|---|---|
| Token | opaque `gpm1:` wire token; only the SHA-256 hash is stored | `menu-token.ts`, `line_menu_states.token_hash` |
| Create | `create_line_menu_state(p_token_hash, p_action_type, p_line_user_id, p_source_type, p_source_id, p_session_key, p_payload)` | 0051 |
| Consume | `consume_line_menu_state(...)` → `consumed` \| `replay` \| `already_consumed` \| `invalid_or_expired` | 0051, replaced by 0055 |
| Record | `record_line_menu_state_result(...)` → `recorded` \| `replay` \| `result_conflict` \| `invalid_or_expired` | 0051 |
| TTL | DB-authoritative: 30 min navigation, **10 min mutating** (`confirm_open`, `request_close`, `confirm_finalize`) | `guided_menu_ttl_interval` |
| Payload validation | `guided_menu_payload_valid(action, payload)` — exact key sets, active seller / active market / **active assignment** re-checked at consume time | 0055 → 0056 |
| Label safety | `line_menu_states_payload_no_trusted_labels` — payloads may never carry `staff_label` / `market_label` | 0051 |

Allowed `action_type` values after 0055:
`menu_root`, `choose_transaction_type`, `choose_seller`, `choose_market`,
`choose_date`, `confirm_open`, `view_status`, `request_close`,
`confirm_finalize`.

**Consequence for this epic:** the four guided capture actions of Slice 3B
(`ดูรายการที่บันทึกแล้ว`, `แก้ไข`, `ยกเลิก`, `จบรายการ`) map onto
`view_status` / `menu_root` / `request_close` / `confirm_finalize`, which
0051 already allows. Slices 3C and 3D add no action type at all: the read-only
`view_status` renders whichever stage the operator is in, and every mutating
step is an existing text command (§2.5). **The whole epic needs no migration.**

### 1.2 Pending / produce sessions

Two ways in, one storage model:

* **Legacy text** — a header line (`findProduceSessionHeader`) creates a
  `pending_sessions` row with `entry_origin IS NULL`; subsequent messages are
  appended as raw text; `จบรายการ` marks close.
* **Structured (0049)** — `ProduceSessionCommandService.execute({kind:"open"})`
  → `open_or_rotate_produce_structured_session`, which sets
  `entry_origin = 'structured_menu'` plus the frozen metadata
  (`business_date`, `transaction_time`, `transaction_time_source`,
  `staff_label`, `market_label`, `session_kind`, `initial_transaction_type`,
  `opened_line_event_id`).

Key invariants observed and reused:

* `staff_label` is **คนขาย — the seller**, not the operator. It becomes
  `produce_sessions.staff_name`. `market_label` becomes `session_title`.
* The canonical session key is derived by the RPC itself from the source
  triple and mirrors `getPendingSessionKey` exactly; a caller cannot name an
  arbitrary key.
* Ownership (`source_id`, `line_user_id`) is checked **before** the
  same-event idempotency shortcut, which is checked **before** any mutation.
* `p_expected_session_generation` gives optimistic concurrency.
* The RPC is open-**or-rotate**: reaching it with a live row silently discards
  that round. Guarding that is the caller's job (see §3.1).
* `terminalized = true` is the authoritative end state; 0050 sets it on every
  terminal path (finalized, failed_closed, duplicate, deadline elapsed).
* A text header arriving inside a structured session is refused before
  append/admit/ingest (`structured_header_refused`), and plain-text
  `จบรายการ` cannot close a structured session
  (`STRUCTURED_TEXT_CLOSE_REFUSED_REPLY`).

### 1.3 Parser

`parseWeighSession(text, businessDate)` with an optional `WeighSessionSeed`.
A seeded parse **starts in the item state**, so seeded metadata can never be
overwritten by a later text line. `initial_transaction_type` is the only
representation a guided `ชั่งคืน` / `คืนเสีย` main session has — there is no
textual section marker to recover it from.

Base transaction types: `เบิก`, `คืน`, `คืนเสีย` (note: the menu label is
`ชั่งคืน`, the stored base type is `คืน`).

### 1.4 Finalization barrier (0032 → 0050)

`close_produce_structured_session` (control event: no admission row, no
ingest row, no synthetic text) → readiness check
(`check_pending_close_ready`: admission/ingest **set** equality, not counts)
→ 0050 hold → `confirm_produce_structured_finalization` →
`try_finalize_pending_generation` → `produce_sessions` + notification outbox.

### 1.5 Digital White Sheet

Storage is `digital_white_sheet_cash_entries`, identity
**`(source_id, market_label_normalized, business_date)`**.

Operator-entered fields: `labor`, `location_fee`, `bag`, `snack`, `other`,
`other_note`, `actual_cash_submitted`. Everything else is computed by
`calculateDigitalWhiteSheet` from produce data — the LINE parser never
supplies arithmetic.

Lifecycle: `not_submitted` → `submitted` → `finalized`
(`finalize_white_sheet_cash_entry`, `reopen_white_sheet_cash_entry`,
audited in `white_sheet_lifecycle_events`). A FINALIZED sheet blocks the
operator upsert path.

**There is no seller column and no work-round column on the white sheet.**

### 1.6 Slips, settlement, reconciliation

* Evidence → `slip_evidences`; batches → `slip_batches`
  (`get_or_create_slip_batch`); checks → `slip_checks`; manual entries →
  `manual_slip_sessions` / `manual_slip_entries`.
* `reconcile()` and `loadMarketScopedAiVerifiedTransfers` /
  `loadMarketScopedManualSlipTotal` own the money definitions.
* `tryFinalizeSettlement` + `settlement_finalizations`
  (`source_id`, `business_date`, `line_retry_key`) own settlement closure.
* `settlement_entries` is written by exactly one contract, the `source_id`
  branch of `POST /api/settlement`: **reconcile → upsert → finalize**.
  * Required: `settlement_date`. Optional with defaults: `settlement_time`
    (`""`), `staff_name`, `market_name`, `money_transfer`, `money_cash`,
    `expenses`, `labor`, `notes`, `source_id`.
  * Update rule: `upsert` on
    `(settlement_date, settlement_time, staff_name, market_name)`. There is no
    row-level finalized flag and no reject-on-duplicate — the conflict target
    **is** the update rule. The Dashboard form writes `settlement_time = ""`.
  * `reconcile()` runs first and refuses while a manual slip session is open,
    so a blocked submission writes nothing.
  * Money precision: `numeric(10,2)`; operator strings go through
    `parseCloseMoneyAmount` (the White Sheet rule — no negatives, ≤ 2 decimals,
    optional thousands commas) and reconciliation rounds to satang.
  * `tryFinalizeSettlement` reads the result by `(source_id, settlement_date)`
    and treats **more than one row as `ambiguous`** — permanently. Any second
    writer must therefore land on the same upsert key or refuse.
  * `labor` / `expenses` here do **not** overlap the White Sheet:
    `digital_white_sheet_cash_entries` records the market's own
    ค่าแรง/ค่าที่/ค่าถุง/ค่าขนม/ค่าอื่น/เงินสด, and its loader states
    explicitly that the boundary never writes `settlement_entries`. No value is
    carried between them — see §2.7.

### 1.7 LINE limits

`assertGuidedMenuMessageLimits` is the single authority: 1–5 reply messages,
text ≤ 5000 code points, buttons-template text ≤ 160 and ≤ 4 actions,
template/quick-reply labels ≤ 20 code points, Flex button labels ≤ 40, Flex
bubble ≤ 30 KiB UTF-8, postback data ≤ 300 chars and always a `gpm1:` token.

### 1.8 Migration numbering

Repo `main` ends at `0053_inventory_movement_ledger`. `0054` is **reserved
for P2D and is not consumed here**. `0055` / `0056` belong to PR #9. The next
free number for this epic is **0057**.

---

## 2. Gaps — where the requested design has no contract to reuse

These are recorded rather than invented. Nothing below was implemented by
guessing a business rule.

### 2.1 `work_rounds` is orphaned Production drift — not revived

| Object | Repo at PR #9 base | Production `apjjsqibavjaitcedavn` |
|---|---|---|
| `work_rounds` | no migration, **zero TypeScript references** | table exists, 19 rows, last write **2026-06-27** |
| `work_round_selections` | none | 11 rows, last write 2026-06-27 |
| `work_round_events` | none | **does not exist** |
| `produce_round_events` | none | 796 rows, last write 2026-06-27 |
| `produce_sessions.work_round_id` | not in repo schema | nullable column exists |
| `settlement_finalizations.work_round_id` | not in repo schema | nullable column exists |
| open/close-round RPC | none | only `claim_work_round_selection` — **no close or finalize function** |

Origin: the unmerged branch `feat/v2-work-round`, whose migrations
`0036_transaction_type_append` … `0040_v2_work_round_integrity` **collide by
number** with mainline `0036_additional_produce_entries` …
`0040_central_selling_prices`. Mainline `0036` names these objects explicitly
as things "the repo never declared".

Because there is no authoritative round lifecycle — nothing opens a round in
current code, and no function closes one — this epic **does not bind state to
`work_round_id`**. Guided state is instead bound to the tuple the live schema
actually keys on:

```
(source_id, line_user_id, seller, market, business_date, transaction_type,
 session_key, session_generation)
```

and persistence uses the existing keys: white sheet
`(source_id, market_label_normalized, business_date)`, settlement
`(source_id, business_date)`, slip batch as issued by
`get_or_create_slip_batch`. `produce_sessions.work_round_id` is left NULL, as
every row written since 2026-06-27 already is.

**Decision owner:** confirmed by the repository owner on 2026-07-30 —
"bind to (source, market, date), drop work_round". Reviving the v2 round
lifecycle remains an open, separate decision.

### 2.2 White sheet cannot record the seller

The guided flow knows the seller; `digital_white_sheet_cash_entries` has no
column for it. The sheet is therefore prefilled with market + business date
only, and the seller is carried in guided state for display and for the
produce session, not persisted onto the sheet. Adding a seller dimension to
the white sheet is a schema and reporting change beyond this epic.

### 2.3 There is no cancel-open-round contract

`produce/void.ts` voids a **finalized** `produce_sessions` row and requires
admin authentication; it cannot void a pending round. The only way to discard
an open pending row in existing code is `PendingSessionService.delete`, which
has no barrier, no audit trail and no ownership check of its own.

Slice 3B therefore does **not** offer a "cancel this round" write. `ยกเลิก`
dismisses the menu and says so explicitly
(`GUIDED_MENU_COPY.menuDismissedSessionOpen`) — the copy must never read as a
voided round. Recovering from a mistaken open still requires an administrator.
A real guided cancel needs an authoritative, audited pending-void contract
that does not exist yet.

### 2.4 The guided journey has no state table

`line_menu_states` is single-use token storage keyed by token hash, not a
per-operator accumulator, and this epic adds no table. The journey stage is
therefore **derived on every press** from state the existing subsystems already
own (`GuidedJourneyService`):

| Stage | Derived from |
|---|---|
| `capture` / `awaiting_confirm` | `pending_sessions` structured metadata + `close_event_timestamp_ms` |
| `white_sheet` | produce confirmed, `digital_white_sheet_cash_entries` not submitted |
| `slips` | sheet submitted, a `slip_batches` row still collecting/closing/processing or a manual session open |
| `reconcile` | sheet submitted, no open slip work |

Seller, market, business date and transaction type all come from the produce
session's own frozen metadata, so a later stage can never drift onto a
different round. `produce_sessions.work_round_id` is left NULL throughout.

### 2.5 Mutating steps are text commands, not shared tokens

Slices 3C and 3D need no new `action_type` because the single read-only
`view_status` action renders whichever stage the operator is actually in — the
stage is re-derived server-side and never carried in the token, so a button
minted earlier always renders the current stage.

The mutating steps deliberately do **not** share a token that way. Reusing
`request_close` / `confirm_finalize` across stages would mean a stale produce
button could trigger a settlement finalization, and the 0051 payload contract
(`keys.length === 0` for those actions) leaves nowhere to put a stage
discriminator. So each mutating step is the text command that already exists,
which the bot hands the operator verbatim at the moment they need it:

| Step | Command | Owner |
|---|---|---|
| Submit the white sheet | `<market> ปิดยอด <date>` … `จบปิดยอด` | existing `processWhiteSheetCloseCommand` |
| Open the slip batch | `<seller> <market> สลิปเงินโอน <date>` | existing `parseSlipSessionHeader` |
| Close the slip batch | `จบสลิป` | existing slip close |
| Manual slips | existing `สลิปมือ` flow | existing manual slip session |
| Submit the settlement | `<seller> <market> ส่งยอด <date>` … `จบส่งยอด` | **new application-only template**, routes to the existing `POST /api/settlement` boundary |
| Close the round | `ปิดรอบ` | **new application-only command**, routes to `tryFinalizeSettlement` |

`ปิดรอบ` is exact-match only and adds no schema. `ส่งยอด` claims a message only
when it carries the guided header or the `จบส่งยอด` line, so no existing command
loses its text. Both are printed for the operator by the bot, so neither has to
be remembered.

### 2.6 Cold subsystems

`slip_batches` last wrote 2026-06-30, `settlement_entries` 2026-07-16,
`settlement_drafts` 2026-06-26, while `produce_sessions` is live
(2026-07-29). Slice 3D is built against these pipelines on the repository
owner's confirmation (2026-07-30) that they remain the operational route.

### 2.6b Releasing the 0050 hold is not proof that produce was saved

`confirm_produce_structured_finalization` is a CONTROL event. The produce rows
are written afterwards by the deferred `try_finalize_pending_generation`, which
can still terminalize the round as `failed_closed` — a validation failure,
missing items, an unconfirmed close. `pending_sessions.finalization_status` is
therefore the only authority on whether the item list exists, and
`terminalized` alone says nothing about success.

Successful statuses, by allowlist
(`SUCCESSFUL_PRODUCE_FINALIZATION_STATUSES`):

| Status | Meaning | Guided outcome |
|---|---|---|
| `finalized` | produce session written | **succeeded** |
| `duplicate` | same generation already written; rows exist | **succeeded** |
| `pending` / `processing` | deferred finalizer has not reported | pending |
| `failed_closed` | terminal, nothing saved | failed |
| anything else | unrecognised | pending while live, **failed** once terminalized |

The last row is the fail-closed rule: an unknown or future status (a
`validation_failed`, say) is never read as success.

### 2.6c Guided templates are plain text in a shared group

Both the White Sheet closing message and the transfer-slip batch header are
ordinary text the bot hands over for the operator to copy. Anyone else in the
LINE group can copy them too, and the journey key is per operator
(`group:<source>:user:<user>`), so a second member resolves `idle`.

Asking only "does the sender have a round?" therefore let operator B file
operator A's sheet and fall through to the shared legacy writer. The guards ask
the source-wide question instead — *does anyone own the round for this market and
business date?* — and legacy fallback survives only when the answer is nobody.
An unanswerable lookup refuses; treating it as `not_guided` is precisely the
hole that existed.

### 2.7 The White Sheet cannot supply the settlement amounts

`digital_white_sheet_cash_entries` and `settlement_entries` both carry money
called ค่าแรง, and both carry a cash figure, but nothing in the codebase
equates them: the White Sheet loader states outright that its boundary never
writes `settlement_entries`, and no view, RPC or service derives one from the
other. Slice 3D.1 therefore prefills every settlement amount as `0` rather
than copying a White Sheet value across. Deriving them would be a new business
rule, and this epic does not invent business rules.

### 2.8 The guided settlement accepts a SUBMITTED white sheet

The 3D.1 brief asks the settlement to be refused unless the white sheet is
FINALIZED. `finalize_white_sheet_cash_entry` is **admin-only** (§1.5), so that
reading would replace the Dashboard blocker this slice exists to remove with an
admin blocker in the same position, and the journey would still not be
LINE-only. The implemented rule is therefore: the sheet must be `submitted`
**or** `finalized`, i.e. only `not_submitted` is refused — the same threshold
the existing `white_sheet_not_submitted` close blocker already uses. Both
states are covered by test. If FINALIZED must be mandatory, an admin
finalization step has to enter the journey and the LINE-only property is lost.

---

## 3. State machine

### 3.1 Slice 3A — confirmation opens a real session

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> TransactionType: text "เมนู" + operator mapped
    Idle --> Unmapped: operator unmapped/inactive

    TransactionType --> Seller: choose_transaction_type
    Seller --> Market: choose_seller (active seller + assignments)
    Market --> Date: choose_market (assignment still active)
    Date --> ConfirmPreview: choose_date (today | yesterday, Bangkok)

    ConfirmPreview --> Opening: confirm_open consumed once
    ConfirmPreview --> Invalid: token expired / already consumed / wrong user / wrong source

    state Opening {
        [*] --> Revalidate
        Revalidate --> Refuse: operator, seller, market, assignment or date invalid now
        Revalidate --> GuardLiveSession
        GuardLiveSession --> AlreadyOpen: pending row exists and terminalized = false
        GuardLiveSession --> OpenRpc: no row, or terminalized row
        OpenRpc --> Opened: opened | rotated | idempotent
        OpenRpc --> Conflict: ownership_conflict | generation_conflict
    }

    Opening --> SessionOpen: เปิดรายการ…แล้ว ✅
    Opening --> Idle: AlreadyOpen / Conflict / Refuse — nothing written

    SessionOpen --> [*]: parser now appends to this session
```

Write points, in order, all fail-closed:

1. `consume_line_menu_state` — exactly once per token; a redelivered LINE
   event takes the `replay` branch and re-renders the recorded reply.
2. `pending_sessions` lookup — read only; a live row ends the flow with
   `session_already_open` and **zero writes**.
3. `open_or_rotate_produce_structured_session` — the only mutation, carrying
   the generation observed in step 2 so a concurrent rotation refuses instead
   of overwriting.
4. `record_line_menu_state_result` — stores the rendered reply for replay.

### 3.2 Slices 3B / 3C / 3D — the complete journey

Buttons are `[…]`; text the bot hands the operator verbatim is `"…"`. The
stage is re-derived server-side on every press, never carried in a token.

```mermaid
stateDiagram-v2
    SessionOpen --> SessionOpen: free-text product lines (existing parser, append RPC)
    SessionOpen --> Status: [ดูรายการ] view_status
    Status --> SessionOpen
    SessionOpen --> MenuDismissed: [ออกจากเมนู] — round stays OPEN
    SessionOpen --> Closing: [จบรายการ] request_close
    Closing --> Held: 0050 finalization hold armed
    Held --> Held: confirm_finalize → not_ready (barrier unsatisfied)
    Held --> ValidationFailed: confirm_finalize → session cannot finalize (refused BEFORE the RPC, zero writes)
    ValidationFailed --> Held: operator resends the corrected line
    Held --> Finalizing: [ยืนยันจบรายการ] confirm_finalize — hold released
    Finalizing --> Finalizing: [ดูสถานะ] → finalization_status still pending/processing
    Finalizing --> Finalized: finalization_status finalized / duplicate
    Finalizing --> FinalizeFailed: terminal without a successful status
    FinalizeFailed --> FinalizeFailed: [ดูสถานะ] — never offers กรอกใบขาว; recovery is an admin
    Finalized --> WhiteSheet: [กรอกใบขาว] view_status

    state WhiteSheet {
        [*] --> Template
        Template --> Guard: operator sends the edited template
        Guard --> Refused: market/date ≠ the open round — zero writes
        Guard --> Refused: another operator in the source owns this market/date
        Guard --> Refused: ownership cannot be determined (lookup failed)
        Guard --> LegacyCommand: nobody owns this market/date — pre-existing path
        Guard --> ExistingCommand: matches the round
        ExistingCommand --> Submitted: processWhiteSheetCloseCommand
        ExistingCommand --> FinalizedSheet: already FINALIZED — never overwritten
    }

    WhiteSheet --> Slips: handoff prints the slip header + "ปิดรอบ"
    Slips --> SlipOpenRefused: header edited / copied / wrong group / assignment revoked — no slip_batches row
    SlipOpenRefused --> Slips: operator resends the header the bot gave them
    Slips --> Slips: images → existing evidence / batch / OCR pipeline
    Slips --> Slips: "จบสลิป" closes the batch, "สลิปมือ" is the fallback
    Slips --> Settlement: [กรอกยอดส่ง] view_status — settlement still missing

    state Settlement {
        [*] --> SettlementTemplate
        SettlementTemplate --> SettlementGuard: operator sends the edited template
        SettlementGuard --> SettlementRefused: seller/market/date ≠ the open round — zero writes
        SettlementGuard --> SettlementRefused: produce unfinished, sheet not submitted, round already closed, foreign entry key
        SettlementGuard --> SettlementSaved: POST /api/settlement boundary (reconcile → upsert)
        SettlementSaved --> SettlementSaved: resend → same row updated, never a second row
    }

    Settlement --> Reconcile: receipt + the ตรวจยอด report in the same reply
    Slips --> Reconcile: [ตรวจยอด] view_status — settlement already recorded

    state Reconcile {
        [*] --> Report
        Report --> Blocked: any existing lifecycle blocker
        Report --> Ready: no blockers
    }

    Reconcile --> RoundClosed: "ปิดรอบ" → tryFinalizeSettlement
    Reconcile --> Blocked: receipt lists exactly what remains
    RoundClosed --> RoundClosed: repeat "ปิดรอบ" → already_done
```

Per-slip status, from existing evidence truth only, in classification order:

| Status | Condition |
|---|---|
| `รอตรวจมือ` | check status not EXTRACTED/PARTIAL_EXTRACTED, **or** verified with no reference id (BR-02) |
| `สลิปซ้ำ` | verified, but its reference already has a global winner |
| `ตลาดไม่ชัด` | evidence market missing, or not a known produce market for the source/date |
| *(not listed)* | evidence attributed to a **different known** market — another round's; the money loader skips it, so this round omits it entirely |
| `วันที่ไม่ตรง` | transaction time outside `startUtc <= t < endUtc`. Informational only: the money loaders scope by `received_at`, so the amount is still inside this round's total |
| `อ่านสำเร็จ` | survives all of the above |

The list has exactly the loaders' scope: `received_at` is half-open
(`startUtc <= received_at < endUtc`), and only VERIFIED-status checks contribute
references to the global-winner resolution — passing a `NEED_REVIEW` reference in
makes `resolveGloballyAcceptedCheckIds` throw, which would collapse every genuine
winner into `สลิปซ้ำ`. A slip shown as `อ่านสำเร็จ` is therefore always one that
contributes to `checked_slip_total`.

Close blockers, every one an existing lifecycle state:
`white_sheet_not_submitted`, `slip_batch_open`, `ocr_pending`,
`manual_slip_open`, `attribution_ambiguous`, `settlement_missing`,
`settlement_ambiguous`, `difference_non_zero` — plus whatever
`tryFinalizeSettlement` itself refuses on.

Money definitions, reused verbatim, never recomputed:

```
checked_slip_total       = ai_verified_total + manual_slip_total
submitted_transfer_total = existing submitted money-transfer amount
difference               = submitted_transfer_total - checked_slip_total
```

---

## 4. Idempotency and security guarantees

| Property | Mechanism |
|---|---|
| One press = one write | `consume_line_menu_state` single-consume; the same LINE event id replays the recorded result |
| LINE webhook retry | replay branch at the menu layer, plus `opened_line_event_id` equality inside the open RPC |
| Stale button | DB TTL (10 min for mutating actions) + `already_consumed` → generic invalid reply |
| Revoked catalog row | `guided_menu_payload_valid` re-checks active seller / market / assignment at consume time; the handler re-reads the catalog again before opening |
| Cross-user replay | `consume_line_menu_state` binds `line_user_id`; the open RPC refuses `user_mismatch` |
| Cross-group replay | consume binds `source_type` + `source_id`; the open RPC derives the canonical key and refuses a mismatch |
| No label leakage | payloads carry codes only; the `no_trusted_labels` CHECK enforces it; labels are re-read from the catalog server-side |
| No silent data loss | live-session guard before the open-or-rotate RPC; optimistic generation on rotation |
| No exception leakage | every refusal path returns Thai operator copy; internal reasons stay in the recorded result and logs |
| One settlement row per round | the guided write uses the Dashboard's own upsert key (`settlement_time = ""`, seller, market); a resend updates it, and an entry stored under any other key is refused instead of added beside — `tryFinalizeSettlement` would otherwise be permanently `ambiguous` |
| Settlement retry is safe | the same LINE message resubmitted returns the identical receipt and leaves one row; a round whose settlement message already went out (`status = 'sent'` / `message_sent_at`) is refused, never silently rewritten |
| Settlement binding | seller, market and business date must equal the round's frozen metadata; `source_id` and operator come from the resolved journey, never from the message text |
| No success claimed before produce exists | `finalization_status` allowlist (§2.6b); the confirm reply re-reads the authoritative row, and `ดูสถานะ` re-reads it on every press |
| No produce write on a session that cannot finalize | `getWeighSessionFinalizationErrors` runs BEFORE the confirm RPC; a partial parse or invalid quantity/unit is refused with the hold still armed |
| Cross-operator template reuse | source-wide `findRoundOwner(source, market, business_date)`; a round owned by another operator refuses, and an unanswerable lookup refuses rather than falling back to legacy |
| Cross-group template reuse | ownership is scoped by `source_id`; a copied template in another group finds no owner for its own source and cannot touch this one |
| Guided slip batch cannot be opened for the wrong round | pre-write guard on source, operator, seller, market, business date, produce success, White Sheet submitted, and a still-active seller→market assignment — refusal creates no `slip_batches` row |
| Legacy paths stay legacy | a market/date no guided round owns still runs the pre-existing White Sheet command and slip open, unchanged |

---

## 5. Delivery status

| Slice | Status |
|---|---|
| 3A — open real produce session | **delivered** |
| 3B — guided capture and finalize | **delivered** |
| 3C — digital white sheet | **delivered** (guided template through the existing close command) |
| 3D — slips, reconciliation, close round | **delivered** |
| 3D.1 — guided settlement submission | **delivered** (guided template through the existing `POST /api/settlement` boundary) |

With 3D.1 the journey is LINE-only end to end:
`ทำรายการ → รายการสินค้า → จบรายการ → ใบขาว → ส่งสลิป → กรอกยอดส่ง → ตรวจยอด → ปิดรอบ`.
The Dashboard is no longer required at any step.

**No migration.** `0054` remains reserved for P2D and untouched; `0055`/`0056`
belong to PR #9. Nothing in slices 3A–3D.1 changes SQL, so no PostgreSQL 17
harness run was required. 3D.1 needed no schema change because
`settlement_entries` already carries every field the operator supplies, and the
existing upsert key is enough to keep LINE and the Dashboard on one row.

Production is untouched: no migration applied, no deployment, no LINE message
sent and no Production data written by this work.

### 5.1 Deterministic LINE evidence — the happy path

Every message below is produced by the committed builders and asserted in
`slice3a-open-session.test.ts`, `slice3b-capture-finalize.test.ts`,
`slice3c-white-sheet.test.ts` and `slice3d-round-close.test.ts`.

**1. `เมนู` → เบิก → กี้ → วัดทุ่งลานนา → วันนี้ → ยืนยัน**

```
เปิดรายการเบิกแล้ว ✅
คนขาย: กี้
ตลาด: วัดทุ่งลานนา
วันที่: 29/07/2569

ส่งรายการสินค้าได้เลย
เมื่อครบแล้วกด “จบรายการ”
```
Buttons: `[ดูรายการ] [จบรายการ] [ออกจากเมนู]`

**2. Product lines sent as free text, then `[จบรายการ]` → `[ยืนยันจบรายการ]`**

```
บันทึกรายการสินค้าเรียบร้อย ✅

<summary from buildWeighSessionSummary>

ขั้นต่อไป: กรอกใบขาว
```
Buttons: `[กรอกใบขาว] [ออกจากเมนู]`

**3. `[กรอกใบขาว]` — two messages, the template isolated for copying**

```
กรอกใบขาว
คัดลอกข้อความด้านล่าง แก้เฉพาะตัวเลข แล้วส่งกลับมา
บรรทัดไหนไม่มีค่าใช้จ่าย ใส่ 0 ไว้

คนขาย: กี้
ตลาด: วัดทุ่งลานนา
วันที่: 29/07/2569
```
```
วัดทุ่งลานนา ปิดยอด 29/07/2569
ค่าแรง 0
ค่าที่ 0
ค่าถุง 0
ค่าขนม 0
ค่าอื่น 0
เงินสด 0
จบปิดยอด
```

**4. The edited template is sent → existing White Sheet reply, then the handoff**

```
ส่งสลิป

ส่งสลิปเงินโอน
ส่งข้อความด้านล่างก่อน แล้วส่งรูปสลิปตามได้เลย
เมื่อส่งครบ พิมพ์ "จบสลิป"
ถ้ามีสลิปที่ระบบอ่านไม่ได้ ใช้ "สลิปมือ" ตามวิธีเดิม
```
```
กี้ วัดทุ่งลานนา สลิปเงินโอน 29/07/2569
```
```
เมื่อตรวจสลิปครบแล้ว พิมพ์ "ปิดรอบ" เพื่อปิดรอบ
```

**5. Slips uploaded, `จบสลิป`, then `[กรอกยอดส่ง]` — the round still has no settlement**

```
ตรวจยอดรอบขาย

คนขาย: กี้
ตลาด: วัดทุ่งลานนา
วันที่: 29/07/2569
ยอดส่งตามใบขาว: —
ยอดสลิปที่ตรวจแล้ว: 1,250 บาท
ผลต่าง: —

สลิป:
- อ่านสำเร็จ: 2

ยังปิดรอบไม่ได้ เพราะ:
- ยังไม่มียอดส่งเงินของรอบนี้ในระบบ
- กรอกแบบฟอร์มยอดส่งด้านล่าง แก้เฉพาะตัวเลข แล้วส่งกลับมา
```
```
กรอกยอดส่ง
คัดลอกข้อความด้านล่าง แก้เฉพาะตัวเลข แล้วส่งกลับมา
บรรทัดไหนไม่มียอด ใส่ 0 ไว้

คนขาย: กี้
ตลาด: วัดทุ่งลานนา
วันที่: 29/07/2569
```
```
กี้ วัดทุ่งลานนา ส่งยอด 29/07/2569
ยอดโอน 0
เงินสด 0
ค่าใช้จ่าย 0
ค่าแรง 0
จบส่งยอด
```

**6. The edited `ส่งยอด` template is sent → receipt, then the ตรวจยอด report**

```
บันทึกยอดส่งเรียบร้อย ✅

ยอดโอน: 1,250 บาท
เงินสด: 0 บาท
ค่าใช้จ่าย: 0 บาท
ค่าแรง: 0 บาท

ขั้นต่อไป: ตรวจยอด
```
```
ตรวจยอดรอบขาย

คนขาย: กี้
ตลาด: วัดทุ่งลานนา
วันที่: 29/07/2569
ยอดส่งตามใบขาว: 1,250 บาท
ยอดสลิปที่ตรวจแล้ว: 1,250 บาท
ผลต่าง: 0 บาท

สลิป:
- อ่านสำเร็จ: 2

ยังปิดรอบไม่ได้ เพราะ:
- พิมพ์ "ปิดรอบ" เพื่อปิดรอบ
```

**7. `ปิดรอบ` with an exact match**

```
ปิดรอบเรียบร้อย ✅

คนขาย: กี้
ตลาด: วัดทุ่งลานนา
วันที่: 29/07/2569
ยอดส่งตามใบขาว: 1,250 บาท
ยอดสลิปที่ตรวจแล้ว: 1,250 บาท
ผลต่าง: 0 บาท

สลิป:
- อ่านสำเร็จ: 2
```

### 5.2 Failure evidence — one blocked reconciliation

One verified slip of 1,000, one slip still `NEED_REVIEW`, and a settlement
entry of 1,500. `ปิดรอบ` refuses and writes no finalization row:

```
ตรวจยอดรอบขาย

คนขาย: กี้
ตลาด: วัดทุ่งลานนา
วันที่: 29/07/2569
ยอดส่งตามใบขาว: 1,500 บาท
ยอดสลิปที่ตรวจแล้ว: 1,000 บาท
ผลต่าง: 500 บาท

สลิป:
- อ่านสำเร็จ: 1
- รอตรวจมือ: 1

ยังปิดรอบไม่ได้ เพราะ:
- ระบบยังอ่านสลิปไม่เสร็จ กรุณารอสักครู่
- ยอดสลิปกับยอดส่งเงินยังไม่ตรงกัน
- แก้ไขแล้วพิมพ์ "ปิดรอบ" อีกครั้ง
```

A missing settlement renders `—`, never a guessed `0`.

---

## 6. Rollout and rollback

**Rollout**

1. Merge PR #9 (`0055`, `0056`) and apply both to Production first — this
   epic's branch is stacked on them and `choose_seller` is not yet an allowed
   `action_type` in Production. **This is the only migration step in the whole
   rollout; slices 3A–3D add none.**
2. Deploy the application. Everything is inert until an operator presses
   `ยืนยัน`: no scheduled job changes, and nothing changes for text-command
   users.
3. Walk one real round in a pilot LINE group before widening —
   `เมนู` → confirm → items → `จบรายการ` → `ยืนยันจบรายการ` → `กรอกใบขาว` →
   send the template → send slips → `จบสลิป` → `กรอกยอดส่ง` → send the `ส่งยอด`
   template → `ปิดรอบ`. The Dashboard is not needed at any point.
4. Watch for `guided round close handled` in the logs: `closed: false` on the
   first attempt is the expected, correct outcome while any blocker remains.
   `guided settlement handled` with `saved: false` is likewise the correct
   outcome for a refused submission — nothing was written. `slip open refused —
   guided round mismatch` and `white sheet close refused — journey mismatch` are
   the guards doing their job.

### 6.0 Production UAT checklist

Run in a pilot group, with a second LINE account in the SAME group as
"operator B". Every ✗ row must leave the database untouched — check the named
table after each one.

**Happy path (operator A)**

| # | Step | Expect |
|---|---|---|
| 1 | `เมนู` → เบิก → seller → market → today → `[ยืนยัน]` | round opened, one `pending_sessions` row |
| 2 | send product lines, each with its quantity/unit line | appended; `[ดูรายการ]` shows them |
| 3 | `[จบรายการ]` | close boundary set, hold armed |
| 4 | `[ยืนยันจบรายการ]` | either "กำลังบันทึกรายการสินค้า ยังไม่เสร็จ" or the saved receipt — **never** a saved receipt while `finalization_status` is `pending`/`processing` |
| 5 | `[ดูสถานะ]` until it advances | when `finalization_status = finalized`, the White Sheet template appears |
| 6 | send the edited White Sheet template | existing reply, then the slip handoff |
| 7 | send the slip header the bot gave you | "เปิดชุดสลิปเงินโอนแล้ว", one `slip_batches` row |
| 8 | send slip images, then `จบสลิป` | existing OCR/summary behaviour |
| 9 | `[ตรวจยอด]` → `[กรอกยอดส่ง]` | reconciliation plus the `ส่งยอด` template |
| 10 | send the edited `ส่งยอด` template | "บันทึกยอดส่งเรียบร้อย ✅" + the ตรวจยอด report; ONE `settlement_entries` row, `settlement_time = ''` |
| 11 | `ปิดรอบ` | "ปิดรอบเรียบร้อย ✅", one `settlement_finalizations` row |
| 12 | `ปิดรอบ` again | same receipt, still ONE finalization row |

**Refusals — verify zero writes**

| # | Step | Expect | Check |
|---|---|---|---|
| ✗1 | at step 2, send a product line with no quantity/unit, then `[ยืนยันจบรายการ]` | "ยังยืนยันไม่ได้ ระบบยังอ่านรายการไม่ครบ", no `กรอกใบขาว` offered | `finalize_confirmed_at` still NULL |
| ✗2 | operator B copies A's White Sheet template | "รอบนี้เป็นของผู้ใช้อีกคนในกลุ่ม" | no new `digital_white_sheet_cash_entries` row |
| ✗3 | operator B copies A's slip header | same refusal | no new `slip_batches` row |
| ✗4 | A edits the seller, market or date in the slip header | "ไม่ตรงกับรอบที่เปิดอยู่" | no new `slip_batches` row |
| ✗5 | A sends the slip header before the White Sheet | "ยังไม่ได้บันทึกใบขาวของรอบนี้" | no new `slip_batches` row |
| ✗6 | A edits the market or date in the `ส่งยอด` template | "ไม่ตรงกับรอบที่เปิดอยู่" | no new `settlement_entries` row |
| ✗7 | A resends `ส่งยอด` after `ปิดรอบ` succeeded | "รอบนี้ปิดและส่งสรุปไปแล้ว" | `money_transfer` unchanged |
| ✗8 | revoke the seller→market assignment, then resend the slip header | "ไม่ได้ผูกกันในระบบแล้ว" | no new `slip_batches` row |

**Legacy regression (a market/date with no guided round)**

| # | Step | Expect |
|---|---|---|
| L1 | send a direct White Sheet closing message | behaves exactly as before |
| L2 | send a direct slip header | opens as before |
| L3 | `POST /api/settlement` from the Dashboard | unchanged response, still finalizes on submit |

**Rollback**

* **Application-only rollback is sufficient for every slice.** 3A–3D.1 add no
  migration, no table and no column, so reverting the deploy is the complete
  rollback and no data migration is required in either direction.
* Settlements submitted from LINE stay valid: they were written through the same
  `POST /api/settlement` boundary on the same upsert key the Dashboard uses, so
  after a rollback the Dashboard form loads and edits them normally.
* Rounds already opened stay valid: they were opened through the same RPC the
  text flow uses and finalize identically.
* White sheets already submitted stay valid: they were written by the existing
  `processWhiteSheetCloseCommand`, exactly as a hand-typed message would.
* Settlements already closed stay closed: `tryFinalizeSettlement` is the same
  function the web API calls, and its rows are unchanged by this work.
* After a rollback the operator falls back to typing the same commands the bot
  had been handing them, because the guided flow never introduced a syntax of
  its own — only `ปิดรอบ` disappears, and the round can still be closed from
  the web settlement path.

### 6.1 Known operational limitations

1. **No cancel for an open round.** `ออกจากเมนู` dismisses the guided controls
   and says the round is still open. Recovering from a mistaken open needs an
   administrator — see §2.3.
2. ~~**`ปิดรอบ` needs a settlement entry that only the web API writes.**~~
   **Closed by Slice 3D.1**: `กรอกยอดส่ง` hands the operator a `ส่งยอด` template
   that writes `settlement_entries` through the existing `POST /api/settlement`
   boundary, so the round can now be closed from LINE alone. What remains:
   * the guided submission always writes `settlement_time = ""` with the round's
     seller and market. A round whose settlement was already stored under a
     different key (e.g. a Dashboard entry saved with a clock time) is refused
     rather than duplicated, and needs an administrator;
   * `notes` is not editable from LINE — the guided submission writes `""`;
   * the guided submission deliberately does **not** finalize. `POST
     /api/settlement` finalizes on submit; the guided path passes
     `finalize: false` so closing stays with `ปิดรอบ`, which applies the guided
     blockers (a non-zero difference among them) before calling the same
     finalizer. Without this, submitting a settlement would close a round whose
     slips do not add up.
3. **The guided receipt suppresses the finalizer's push.** `closeGuidedRound`
   passes a no-op push so the receipt is not delivered twice; the record still
   moves to `sent`. A LINE-initiated close therefore notifies only the group
   that typed `ปิดรอบ`.
4. **The captured-item preview can differ from the final persist.** The preview
   parses `accumulated_text`; the finalizer additionally intersects the
   admission and ingest ledgers through the close boundary, so a straggler
   still in flight is visible in the preview but excluded from the round.
5. **The white sheet cannot record the seller** — there is no column. It is
   keyed `(source_id, market_label_normalized, business_date)` only (§2.2).
6. **`produce_sessions.work_round_id` stays NULL**, as every row written since
   2026-06-27 already is (§2.1).
7. **A failed produce finalization can only be recovered by an administrator.**
   The reply says plainly that the item list was not saved and offers no
   `กรอกใบขาว`; there is no cancel or reopen RPC to call and none was invented, so
   the operator needs a fresh round opened for them (same root cause as §2.3).
8. **Finalization is not awaited synchronously.** The webhook cannot block on the
   deferred finalizer, so `[ยืนยันจบรายการ]` normally answers "กำลังบันทึก… ยังไม่
   เสร็จ" and the operator presses `ดูสถานะ` once. The reply is honest rather than
   optimistic; the alternative would be claiming a save that may not happen.
9. **Ownership is by `(source_id, market, business_date)` and does not lapse.**
   Once an operator opens a guided round for a market/date, nobody else in that
   source can submit the White Sheet or open the slip batch for it — including
   after the round closes. A genuine handover needs an administrator.
10. **A `วันที่ไม่ตรง` slip is still inside the round's total.** The money loaders
    scope by `received_at`, not by the bank's `transaction_time`, so the status is
    a warning to check the slip, not a claim that it was excluded (§3.2).
