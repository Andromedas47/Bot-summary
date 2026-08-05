# P2B Operational LINE Purchase Intake → P2B Receipt Confirmation → P2C First Real Inventory Posting

Status: **DESIGN AND DISCOVERY ONLY.** No application code, migration, or Production change is included in this document or its branch.

Base commit inspected: `origin/main` @ `8066d38a613905b4d935b5d03d0b5bc25ff276ae` (contains merged [PR #29](https://github.com/Andromedas47/Bot-summary/pull/29)). Production project `apjjsqibavjaitcedavn` inspected read-only on 2026-08-04; its applied migration ledger head is `20260803122757_priced_house_stock`, matching the repo's newest migration file byte-for-byte in name.

Labels used throughout: **CONFIRMED** (verified in repo or Production), **PROPOSED** (this document's recommendation, not yet built), **BLOCKER** (must be resolved before unrestricted first posting), **OWNER DECISION REQUIRED** (a choice this document cannot make alone).

---

## 1. Executive summary

The repository already has three of the four pieces a first real purchase posting needs, fully built, tested against a live Postgres instance, and verified present in Production:

- A pure, database-free P2B text parser (`src/lib/purchases/`) that turns strict Thai LINE text blocks into a structurally-validated `PurchaseAssemblyResult` — CONFIRMED.
- A P2B persistence contract (`src/lib/purchase-receipts/`, migration `0052_purchase_receipt_persistence.sql`) with full-replace drafts, an idempotent `confirm`, immutable confirmed receipts, and a correction-by-supersession model — CONFIRMED, and its schema/RPCs/grants were independently verified to exist in Production exactly as migrated.
- A P2C quantity ledger (`src/lib/inventory-ledger/`, migration `0053_inventory_movement_ledger.sql`) with idempotent posting, append-only movement lines, a derived (never stored) balance view, and hard RPC-level refusal of unresolved product/unit identity — CONFIRMED, also verified present in Production.

What does **not** exist yet, anywhere in the repo or Production, is the fourth piece: a **durable multi-message LINE capture session** that sits in front of the P2B parser — the thing that lets one purchase document arrive as several LINE messages, survives webhook redelivery/reordering/crashes, and hands the parser exactly one clean, ordered chunk set. This document designs that missing piece by direct adaptation of the Physical Inventory session/barrier pattern (`physical_inventory_sessions`, migration `0047_physical_inventory_capture.sql`), which is structurally the closest existing precedent and is itself explicitly modeled on the even older Produce pending-session barrier (`0032_pending_session_finalization_barrier.sql`).

The one genuine **BLOCKER** discovered is not architectural: **no product resolver, unit-alias resolver, or "Product Master" exists anywhere in this codebase or Production** (§10). `purchase_receipt_items.product_identity_status`/`unit_identity_status`/`price_unit_status` default to `'RESOLVED'`/`'RESOLVED'`/`'NOT_APPLICABLE'` if the caller does not set them explicitly — the ledger's RPC-level refusal of `UNRESOLVED` items (CONFIRMED, §3/§10) only protects the system if the P2B adapter is disciplined enough to never rely on any of those defaults, for the product key, the quantity unit, **and** the price unit separately (§10). This document proposes the smallest safe registry pair to close that gap (§10, §16) and treats it as a **hard prerequisite**, not an implementation detail to defer.

P2C posting is receipt-level and all-or-nothing (CONFIRMED, §2.3) — a confirmed receipt is posted whole or not at all, and a confirmed receipt is immutable (CONFIRMED, §2.2). This design therefore gates `ยืนยันซื้อ` itself on zero blocking blockers: a draft with any `UNRESOLVED` product, quantity unit, or price unit cannot be confirmed at all, not merely posted partially (§7, §11-§12) — confirming a blocked draft would otherwise create a permanently unpostable, immutable receipt. A new operator command, `ตรวจใบซื้อใหม่`, lets staff re-run the draft against the current registry state after fixing a registration gap, without re-sending the whole document (§11.3).

**Final recommendation: GO WITH PREREQUISITE.** See §25.

---

## 2. Current repository contracts discovered

### 2.1 P2B pure parser — `src/lib/purchases/`

CONFIRMED, database-free (enforced by an automated architecture test, not just convention):

- Directory: `architecture.test.ts`, `assemble.ts`, `assembler-and-boundary.test.ts`, `block-parsers.test.ts`, `chunks-and-segmentation.test.ts`, `classify.ts`, `commands.ts`, `exact-decimal.ts`, `exact-decimal.test.ts`, `index.ts`, `issues.ts`, `parse.ts`, `segment.ts`, `test-helpers.ts`, `text-adapter.ts`, `text-chunks.ts`, `types.ts`.
- `architecture.test.ts:35-90` asserts, per file: no import matching `/supabase/i`, `/database/i`, `/route(?:s|r)?\//i`, `/webhook/i`, `/physical-inventory/i`, `/weigh-session/i`, `/produce/i`, and no reference to `resolveUnitQuantity`/`normalizeUnitAlias`; `exact-decimal.ts` never calls `Number(`/`parseFloat(`/`parseInt(`; `assemble.ts` never imports the text/parse/classify/segment layer; `types.ts` never exposes receipt/stock-posting fields. This is a hard, CI-enforced boundary, not a style guideline.
- Pipeline types (`types.ts`): `PurchaseTextChunkInput` (`types.ts:71-79`) → `PurchaseTextChunk` (`types.ts:80-86`) → segmented into `PurchaseBlockInput` (`types.ts:88-104`) → parsed into `PurchaseCommandEnvelope` (`types.ts:265-281`, discriminated `PARSED`/`INVALID`, carrying `errors: PurchaseStructuralIssue[]` and `reviewFlags: PurchaseReviewFlag[]` separately) → `PurchaseAssemblyResult` (`types.ts:310-322`, `status: "COMPLETE" | "INCOMPLETE"`, derived only from `errors.length`, `assemble.ts:344-345`).
- Strict text contract, exact regexes:
  - Header opener `parse.ts:40`: `/^เริ่มซื้อ ([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}) ([0-9]{2}:[0-9]{2}|ไม่ทราบเวลา)$/u`, body fields `ผู้ขาย:`, `ใบอ้างอิง:`, `ปลายทาง: MAIN` (`INTENDED_WAREHOUSE_MAIN = "MAIN"`, `types.ts:2`).
  - Item opener `parse.ts:41`: `/^ซื้อรายการ ([0-9]+)$/u`, fields `สินค้า:`, `จำนวน: <qty> <unit>`, `ราคา: <rate> บาท/<unit>` or literal `ไม่ทราบ`.
  - Costs opener `classify.ts:16`: `/^สรุปค่าใช้จ่ายซื้อ$/u`, fields `ค่าขนส่ง:`, `ค่าจัดการ:`, `ส่วนลด:` (each `MONEY_VALUE = /^([^ \t]+) บาท$/u`, `parse.ts:45`), then `ภาษีมูลค่าเพิ่ม: ไม่มี` (5-line block) or an amount followed by mandatory `ภาษีรวมในราคาสินค้า: ใช่|ไม่ใช่` and `ภาษีขอคืนได้: ใช่|ไม่ใช่` (7-line block, `parse.ts:757-862`).
  - Close opener `parse.ts:42`: `/^ปิดซื้อ ([0-9]+) รายการ$/u`.
  - Exact-decimal grammar `exact-decimal.ts:27`: `/^([0-9]+)(?:\.([0-9]+))?$/` — unsigned, no exponent; parsed into `bigint` coefficient/scale, never `Number`/`parseFloat` (`exact-decimal.ts:33-80`). Money is additionally normalized to integer satang (`ExactDocumentMoney`, `types.ts:37-40`).
- **Accepted keywords are exhaustive and fixed** — `PURCHASE_RESERVED_PREFIXES` (`classify.ts:6-11`): `เริ่มซื้อ`, `ซื้อรายการ`, `สรุปค่าใช้จ่ายซื้อ`, `ปิดซื้อ`. **No alias (e.g. "เปิดใบซื้อ") exists anywhere in this module.** Anything else is `NOT_PURCHASE`; a near-miss on a reserved prefix is `INVALID_RESERVED_PURCHASE_BLOCK` (`classify.ts:30-33`).
- **Multiple blocks per LINE message are already supported and tested.** `segmentPurchaseChunk()` (`segment.ts:74-171`) loops over one chunk's lines and can emit several block candidates from a single chunk — a block boundary is triggered the moment a later line matches a reserved opener again (`segment.ts:110-116`), not by message boundaries. `test-helpers.ts:45-51`'s `COMPLETE_DOCUMENT` fixture joins five blocks with `"\n\n"` as one string and is exercised as a single-chunk case in `assembler-and-boundary.test.ts:155`. Conversely, a block is never allowed to *span* two chunks/messages — that produces a `BLOCK_SPLIT_ACROSS_CHUNKS` issue (`text-adapter.ts:36-53`, `types.ts:122`) rather than being silently stitched together.
- Blank lines are **not** an independent delimiter token; they are absorbed into whichever block they trail, per a structural per-block-kind line count (`requiredNonblankCount`, `segment.ts:31-46`: HEADER/ITEM = 4 meaningful lines, CLOSE = 1, COSTS = 5 or 7 depending on VAT branch).
- Close-count validation is two-layered: syntactic bounds-check of `N` in the close line itself (`parse.ts:899-938`, code `CLOSE_COUNT_MISMATCH` reused for a malformed number too), and the real comparison at assembly time (`assemble.ts:302-315`) — declared `N` vs. actual parsed item count, which forces `status = "INCOMPLETE"` on mismatch without dropping any already-parsed item.
- 30 structural issue codes exist (`types.ts:118-151`, full enum: `EMPTY_BLOCK`, `INVALID_RESERVED_PURCHASE_BLOCK`, `UNRECOGNIZED_LINE`, `BLOCK_SPLIT_ACROSS_CHUNKS`, `OUT_OF_ORDER_EVIDENCE`, `MISSING_HEADER`, `DUPLICATE_HEADER`, `HEADER_NOT_FIRST`, `INVALID_PURCHASE_DATE`, `INVALID_PURCHASE_TIME`, `MISSING_SUPPLIER`, `MISSING_REFERENCE_DECLARATION`, `INVALID_INTENDED_WAREHOUSE`, `ITEM_BEFORE_HEADER`, `MISSING_ITEM_FIELD`, `INVALID_ITEM_NUMBER`, `DUPLICATE_ITEM_NUMBER`, `ITEM_NUMBER_GAP`, `INVALID_QUANTITY`, `INVALID_UNIT_RATE`, `NUMERIC_SCALE_EXCEEDED`, `NUMERIC_VALUE_TOO_LARGE`, `MISSING_COSTS`, `DUPLICATE_COSTS`, `COSTS_BEFORE_ITEM`, `INVALID_DOCUMENT_MONEY`, `INVALID_VAT_DECLARATION`, `VAT_ZERO_MUST_USE_NONE`, `MISSING_CLOSE`, `DUPLICATE_CLOSE`, `CLOSE_NOT_LAST`, `CLOSE_COUNT_MISMATCH`, `COMMAND_AFTER_CLOSE`), each carrying `{code, message, chunkId, startLine, endLine, rawValue}` (`types.ts:153-160`).
- A separate, explicitly **non-blocking** `PurchaseReviewFlagCode` (`types.ts:162-167`, 5 codes: `UNKNOWN_PURCHASE_TIME`, `NO_REFERENCE`, `MISSING_UNIT_RATE`, `ZERO_UNIT_RATE`, `PRICE_UNIT_REQUIRES_RESOLUTION`) exists — review flags never flip `status` to `INCOMPLETE` (`assembler-and-boundary.test.ts:223`).
- **No product/unit normalization exists in this module.** `productText`/`unitText`/`priceUnitText` are stored as raw `CapturedText` (NFC + outer-whitespace trim only, `text-chunks.ts:15-21`). `normalizeUnitAlias`/`resolveUnitQuantity` exist elsewhere in the repo (`src/lib/parsers/weigh-session/units.ts`) but `architecture.test.ts` explicitly forbids `src/lib/purchases/` from importing them, and no file in this directory does.

### 2.2 P2B persistence — `src/lib/purchase-receipts/`, migration `0052_purchase_receipt_persistence.sql`

CONFIRMED:

- `PurchaseReceiptDraftInput` (`types.ts:143-194`) carries `documentNamespace`, `documentKey`, `contractVersion`, `businessDate`, `purchaseTime?`, `supplierKey?`, `supplierRaw?`, `supplierRef?`, `referenceText?`, `freightSatang`, `handlingSatang`, `discountSatang`, `vat` (`{kind:"NONE"}` | `{kind:"AMOUNT", satang, includedInItemPrices, recoverable}`), `items: PurchaseReceiptItemInput[]`, `sourceType?`, `sourceId?`, `senderLineUserId?`, `sourceLineEventId?`, `sourceRawMessageId?`, `sourceEvidence?`, `reviewFlags?`, `supersedesReceiptId?`, `actor?`. All money/quantity fields cross as decimal/integer **strings**, never JS numbers (`types.ts:8-19`).
- `PurchaseReceiptItemInput` (`types.ts:113-131`): `productKey`, `rawProductText`, `productIdentityStatus?` (`RESOLVED`|`UNRESOLVED`, **defaults to `RESOLVED` if unset** — receipt-service.ts:164), `quantity`, `unitKey`, `rawUnit`, `unitIdentityStatus?` (same default), `unitCost?`, `priceUnitText?`, `priceUnitStatus?` (`NOT_APPLICABLE`|`RESOLVED`|`UNRESOLVED`), `itemNumber?`, `sourceEvidence?`.
- **`documentNamespace` + `documentKey` are the document's identity, not a per-delivery event id** (`types.ts:145-147`). The exact contract quoted from the migration itself (`0052_purchase_receipt_persistence.sql:75-79`):

  > "multi-message LINE purchase document — All chunks of one document share one document_key (the caller derives it from the document-opening event, not from each message). Each subsequent write is a full replace of the assembled document, so partial assembly never accumulates."

  `document_key` is normalized server-side (NFC + collapsed whitespace + trim) before both lookup and insert, by `purchase_receipt_normalize_document_key` (`0052:208-220`). A draft key reused under a **different** `(source_type, source_id)` binding fails closed rather than silently replacing the existing document (`0052:63-66`, enforced in `upsert_purchase_receipt_draft`, `0052:992-1002,1043-1049`).
- **Draft writes are a full replace, never incremental.** `saveDraft()` (`receipt-service.ts:152-208`) calls RPC `upsert_purchase_receipt_draft` (`0052:919-1138`), which does `DELETE FROM purchase_receipt_items WHERE receipt_id = ...` (`0052:1088`) then re-inserts every item from the caller's array (`0052:1090-1121`) — "drafts are authored wholesale, never patched line by line" (`0052:1087`).
- `PurchaseReceiptService.confirm(params: { receiptId, confirmationKey, expectedDraftRevision?, actor? })` (`receipt-service.ts:217-232`) calls RPC `confirm_purchase_receipt` (`0052:1147-1259`, `SECURITY DEFINER`, `search_path = public, extensions, pg_temp`). Idempotency key is the caller-supplied **`confirmation_key`**, `UNIQUE` per receipt (`0052:364`). A redelivered confirm with the *same* key returns the original frozen snapshot with `replayed: true`, writing nothing (`0052:1179-1188`, `receipt-service.ts:213-215`). A different key against an already-confirmed receipt raises a conflict, mapped to `PurchaseReceiptConfirmationConflictError` (`receipt-service.ts:112-114`). `expectedDraftRevision` is an optional optimistic-concurrency guard against `draft_revision` (`0052:1195-1201`), mapped to `PurchaseReceiptStaleRevisionError` (`receipt-service.ts:111`).
- Identity/ownership columns on `purchase_receipts` (`0052:323-329`, verified present in Production with identical names): `source_type` (CHECK `user|group|room`), `source_id`, `sender_line_user_id`, `source_line_event_id`, `source_raw_message_id` (FK → `raw_messages`), `source_evidence`, `review_flags`. Index `purchase_receipts_source_idx (source_type, source_id)` (`0052:455-457`).
- Once `status = 'confirmed'`, the row is immutable except an explicit allow-list of lifecycle columns, enforced by trigger `purchase_receipts_transition_guard`/`purchase_receipt_guard_transition()` (`0052:596-631,663-665`); items become immutable once the receipt leaves `draft` (`purchase_receipt_items_draft_only`, `0052:563-594`). Correction model, quoted (`0052:130-133`): "a confirmed receipt is never edited. A correcting document is a NEW receipt declaring supersedes_receipt_id; confirming it stamps the superseded receipt's superseded_by_receipt_id ... The link is one-to-one in both directions." Columns `supersedes_receipt_id`/`superseded_by_receipt_id` are both unique FKs (`0052:349-350,365-366`).
- Every 0052 RPC is `SECURITY DEFINER` + fixed `search_path`; grants revoke `PUBLIC`/`anon`/`authenticated`, grant `EXECUTE` to `service_role` only (`0052:1439-1476`). Tables: `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role` then `GRANT SELECT ... TO service_role` only — **no direct DML even for `service_role`**, mutation only through the RPCs (`0052:161-167`). **Verified in Production** (§3): `pg_proc.prosecdef=true` and `proconfig` shows the exact `search_path` for all six 0052 RPCs; `information_schema.role_table_grants` shows only `postgres` (owner) has DML and `service_role` has `SELECT`-only on `purchase_receipts`/`purchase_receipt_items` — no `anon`/`authenticated` rows exist at all.

### 2.3 P2C ledger — `src/lib/inventory-ledger/`, migration `0053_inventory_movement_ledger.sql`, `docs/p2c-inventory-movement-ledger.md`

CONFIRMED:

- `InventoryLedgerService.postPurchaseReceipt(params: { receiptId, actor? })` (`ledger-service.ts:192-203`) calls RPC `post_purchase_receipt_inventory_movement` (`0053:674-1114`). Returns `InventoryPostingResult` (`types.ts:41-70`): `movementId`, `receiptId`, `dedupeKey`, `lineCount`, `replayed`, `reversedByMovementId`, `postingLockedAt`, `postingLockedBy`.
- **Idempotency key is P2B's own frozen dedupe identity, taken verbatim, never recomputed** (`0053:283`: "this is P2B's frozen p2c_dedupe_key verbatim, never recomputed here"; `0053:750-756`). Its exact construction, quoted from `0052:141-147` and confirmed by grep of the live RPC body (`0052:1426-1429`):

  ```
  p2c_dedupe_key = 'purchase-receipt-confirmation:v1:' || receipt_id || ':' || confirmation_hash
  ```

  `receipt_id` alone is deliberately insufficient — the hash pins the exact confirmed content, so a hypothetical future re-confirmation of the same receipt id under different content cannot collide.
- Idempotency mechanism is two-layered (`0053:73-89`): `UNIQUE(dedupe_key)` on `inventory_movements` ("re-posting the SAME confirmed content returns the original movement with `replayed:true` and writes nothing"), plus a partial unique index `inventory_movements_source_posting_uidx ON (source_document_type, source_document_id) WHERE reversal_of_movement_id IS NULL` ("a source document gets AT MOST ONE posting movement, ever"). The RPC does not trust a `dedupe_key` match alone — it re-verifies `movement_type`, `source_system`, `source_document_type/id/version`, `dedupe_key`, and P2B posting-lock ownership before returning `replayed:true` (`0053:760-822`); a different payload for an already-posted receipt fails closed (`0053:833-839`).
- **Unresolved product/unit identity is refused inside the RPC itself**, reading the frozen P2B payload per item (`0053:955-967`): `IF coalesce(v_item->>'product_identity_status','UNRESOLVED') <> 'RESOLVED' THEN RAISE EXCEPTION ...` and the same for `unit_identity_status`. This is **application/RPC business logic against the frozen contract, not a table `CHECK` constraint** — `inventory_movement_lines` itself only requires non-blank `product_key`/`unit_key` (`0053:314-315`). Mapped client-side to `InventoryUnresolvedIdentityError` (`ledger-service.ts:138-140`).
- `inventory_balances` is a **view**, not a table: `CREATE VIEW ... AS SELECT location_code, product_key, unit_key, sum(signed_quantity) ... GROUP BY ...` (`0053:609-617`) — "stock on hand is never stored as a mutable balance column ... a derived sum cannot drift" (`0053:26-31`). **Confirmed absent from Production's table list** — only `inventory_locations`, `inventory_movement_lines`, `inventory_movements` are real tables there.
- `inventory_locations` seeded with exactly one row, keyed by **text primary key** `'MAIN'` (`0053:216-217`): `('MAIN', 'Main warehouse', 'WAREHOUSE')`. Movement lines reference it via `location_code text REFERENCES inventory_locations(location_code)` (`0053:316`); the posting RPC hardcodes `'MAIN'` (`0053:1066`). "P2B already CHECKs `intended_warehouse_code = 'MAIN'`, so MAIN is the sole destination any 0053 adapter can post to" (`0053:214-215`).
- `post_purchase_receipt_inventory_movement`/`reverse_inventory_movement` are `SECURITY DEFINER`, fixed `search_path`; `get_inventory_balances` is deliberately `SECURITY INVOKER` ("it needs no elevation, so a leaked EXECUTE grant still cannot read past the caller's own table privileges", `docs/p2c-inventory-movement-ledger.md:313-315`). Grants follow the same `service_role`-EXECUTE-only, no-`anon`/`authenticated` pattern as 0052; trigger functions get **no** EXECUTE grant at all, not even to `service_role` (`0053:1315-1335`). **Verified in Production** identically via `pg_proc`/`role_table_grants` queries (§3).
- Locked scope, quoted (`docs/p2c-inventory-movement-ledger.md:14-24`, migration header `0053:6-8`): "0053 contains no monetary value of any kind. No cost, price, satang, amount, currency or valuation column exists on any ledger table ... Valuation, landed cost, FIFO/average costing and COGS are P2D / migration 0054." Also explicitly excluded: LINE/UX wiring, the Produce adapter, the P2A physical-count adapter, any Production apply/deploy.

### 2.4 Durable LINE session/barrier precedent — Physical Inventory (`src/lib/physical-inventory/`, migration `0047_physical_inventory_capture.sql`)

CONFIRMED, and independently re-verified against Production's live schema (§3):

- States: `open | closing | finalized | failed_closed | voided` (`session-service.ts:27-32`). Transition guard: `open`→`closing` on first close-kind ingest; `closing`→`finalized` requires a `snapshot_id` (CHECK, `0047:84-85`) or `closing`→`failed_closed` requires it be NULL (`0047:86-87`). Terminal statuses (`finalized`, `failed_closed`, `voided`) and several individually-set boundary columns are made immutable by trigger `physical_inventory_forbid_terminal_session_mutation` (`0047:332-373`).
- One active session per sender is a **partial unique index**, not application logic: `physical_inventory_sessions_one_active_per_sender_idx ON (source_id, sender_line_user_id) WHERE status IN ('open','closing')` (`0047:114-116`). Also unique: `(source_id, sender_line_user_id, session_generation)` (`0047:82`) and `opened_line_event_id` (`0047:83`).
- **Close barrier constants — identical in both existing subsystems that have one:** Physical Inventory `PHYSICAL_INVENTORY_CLOSE_QUIET_MS = 8_000` / `PHYSICAL_INVENTORY_CLOSE_DEADLINE_MS = 30_000` (`session-service.ts:23,25`, confirmed by direct grep), DB side `interval '8 seconds'`/`interval '30 seconds'` (`0047:828,833`); Produce pending sessions use the identical `interval '8 seconds'`/`interval '30 seconds'` (`0032_pending_session_finalization_barrier.sql:192,198-199`). `0047`'s own header states it "matches Produce 0032" (`0047:10-13,41-42`) — this is a deliberately repeated pattern, not a coincidence.
- Mechanism: the first close-kind event sets three **immutable** boundary fields — `close_event_timestamp_ms` (the LINE event's own timestamp), `close_quiet_until = clock_timestamp() + 8s`, `close_deadline_at = clock_timestamp() + 30s` (`0047:818-839`). Late events with `line_timestamp_ms <= close_event_timestamp_ms` may still admit until the deadline; later events are `after_close_boundary`; anything after the deadline is `deadline_elapsed` (`0047:749-756`). The DB clock (`clock_timestamp()`/`now()`), never app-side `Date.now()`, is the sole authority for whether the window has elapsed (`0047:1094-1099`).
- Completeness/ordering is tracked by a monotonic `ingest_revision` plus a content hash `physical_inventory_compute_ingest_set_hash()` (SHA-256 over ordered `(line_event_id, line_timestamp_ms, kind, raw_text)` tuples, `0047:400-434`); `finalize_physical_inventory_session` requires the caller's `p_expected_ingest_revision`/`p_expected_ingest_hash` to still match at commit time — an optimistic-concurrency guard between "read finalize candidate" and "actually finalize" (`0047:1085-1092`).
- Finalization is triggered two ways: (a) synchronously, best-effort, scheduled inline from the webhook handler via Next.js `after()` so it can run past the HTTP response (`webhook-service.ts:1318-1325` → `finalizer.ts:267-301`, polling until quiet/deadline, retrying stale revisions up to `MAX_STALE_RETRIES = 3`); (b) durably, by a cron sweep — route `src/app/api/cron/finalize-physical-inventory/route.ts` (Bearer/`x-cron-secret` auth against `CRON_SECRET`), scheduled every 5 minutes by `.github/workflows/finalize-physical-inventory.yml` (`cron: "1,6,11,16,21,26,31,36,41,46,51,56 * * * *"`), which re-evaluates every session with `status='closing' AND (close_quiet_until <= now() OR close_deadline_at <= now())` and separately re-delivers any terminal-but-undelivered LINE message from the last 24h (`finalizer.ts:303-334`).
- Idempotent outbound delivery reuses `session_generation` (already a UUID) as the LINE `X-Line-Retry-Key` (`finalizer.ts:159-171`).
- RLS is enabled on all five Physical Inventory tables with **no policies defined** — access is fully denied except through `SECURITY DEFINER` RPCs (`0047:297-301`). Grants: table access revoked from everyone except `service_role` `SELECT`; RPC `EXECUTE` granted to `service_role` only (`0047:1287-1322`). **Verified identically in Production.**

### 2.5 Raw LINE event persistence, retry-key convention, double-processing prevention

CONFIRMED:

- Every webhook event lands in `raw_messages` (`0001_initial_schema.sql:59-87`) keyed by `line_event_id` with `raw_messages_line_event_id_unique UNIQUE(line_event_id)` (`0001:84`) — the global idempotency anchor. `is_processed`/`processed_at` markers, CHECK `processed_at IS NULL OR is_processed = true` (`0001:79-86`).
- `WebhookService.saveRawMessage` (`webhook-service.ts:3095-3186`) inserts via `.from("raw_messages").insert(...)`, treating Postgres `23505` (unique violation) as duplicate/no-op (`webhook-service.ts:3176`). `markRawMessageProcessed` (`webhook-service.ts:3188-3196`) is a best-effort post-success marker — "leaving it unprocessed is the safe direction."
- The repo does **not** read LINE's inbound `X-Line-Retry-Key` header at all — LINE's own per-delivery `webhookEventId` + `deliveryContext.isRedelivery` (`src/lib/line/types.ts:19-20`) plus the `raw_messages` unique constraint is the entire inbound-redelivery defense. `X-Line-Retry-Key` is instead used **outbound**, when the bot pushes a message, in `pushLineMessage` (`src/lib/line/reply.ts:128-192`) — same UUID on retry causes LINE to 409 instead of re-sending; a 409 with a known retry key is treated as `already_accepted` (`reply.ts:170-176`).
- Double-processing is prevented by layering: (1) `raw_messages` global unique on `line_event_id`; (2) a feature-scoped unique ledger, e.g. `physical_inventory_session_ingests.line_event_id UNIQUE` (`0047:141`); (3) `SELECT ... FOR UPDATE` inside the mutating RPC with an `EXCEPTION WHEN unique_violation` fallback that converts a lost race into an idempotent "duplicate" response (`0047:774-808`).

### 2.6 Guided Operations identity/ownership rules — `docs/guided-operations-end-to-end.md`, migrations `0051_guided_menu_identity_and_state.sql`, `0057_atomic_guided_owner.sql`

CONFIRMED (relevant to any future guided-menu front end for this flow, not required for the V1 text-only design in this document):

- Ownership is asked source-wide, not per-operator, and fails closed on an unanswerable lookup — quoted (`docs/guided-operations-end-to-end.md` §2.6c): "The guards ask the source-wide question instead — does anyone own the round for this market and business date? ... An unanswerable lookup refuses."
- Cross-user/cross-group replay is refused by binding: `consume_line_menu_state` binds `line_user_id` and refuses `user_mismatch`; it also binds `source_type + source_id` and refuses a mismatch (`docs/guided-operations-end-to-end.md` §4).
- `0051` establishes `line_menu_states` with a constraint `line_menu_states_payload_no_trusted_labels` (`0051:297-301`) forbidding `staff_label`/`market_label` inside any postback payload — labels are always re-derived server-side, never trusted from the client. TTL is DB-authoritative (`guided_menu_ttl_interval`, `0051:105-116`): 10 minutes for mutating actions, 30 minutes otherwise.
- `0057` adds an atomic-owner wrapper using `pg_advisory_xact_lock(hashtextextended(...))` over `(source_id, normalized_market, business_date)` before delegating to the underlying open/rotate RPC (`0057:84-153`) — the reusable pattern for "exactly one owner may open/extend a session for this key" if a future guided front end for purchases is built.

### 2.7 Current webhook integration — `src/lib/line/webhook-service.ts` (read-only; not modified by this document)

CONFIRMED, read-only survey:

- `processEvents` (`webhook-service.ts:508-581`) persists every raw event first, then routes.
- `processOne` (`webhook-service.ts:583-1189`) is a single ordered interceptor chain: postback → non-text passthrough → test-message shortcut → guided plain-text triggers → guided round-close/settlement → **Physical Inventory (`tryProcessPhysicalInventory`, called at `webhook-service.ts:729-738`, comment at `726-727`: "This must precede remaining-stock and Produce routing")** → White Sheet close → White Sheet note session → manual slip commands → read-only report commands → slip session commands → generic Produce pending-session accumulate/close/finalize machinery (`851-1189`).
- The Physical Inventory sub-router (`tryProcessPhysicalInventory`, body starting `webhook-service.ts:1191`) is the closest existing precedent for how a new purchase-capture handler should plug in: a single call site inserted into the chain at the point where vocabulary would otherwise collide with a later, more generic handler, self-contained, ownership-checked via `dataEntrySessionOwnershipResolver.resolve` (`src/lib/line/data-entry-session-ownership.ts:50-107`), returning `null` to fall through or a claimed `WebhookProcessResult`.
- This document does **not** propose an edit to this file; §16 states the minimal future integration point precisely so the later implementation PR can add one call site without needing to re-discover this ordering.

---

## 3. Current Production schema findings

Inspected read-only via the Supabase MCP tools against project `apjjsqibavjaitcedavn` (`ap-northeast-2`, Postgres 17.6) on 2026-08-04. No data was mutated; no secret values were retrieved or displayed.

- **Migration ledger head matches the repo exactly**: `list_migrations` returns `20260803122757` / `priced_house_stock` as the newest applied version, identical in both version-id and name to the newest local file `supabase/migrations/20260803122757_priced_house_stock.sql`. **CONFIRMED: no schema drift at the current head.**
- **Naming discrepancy in the migration ledger for the P2B/P2C/guided-identity migrations (informational, not a blocker):** Production's `list_migrations` records these three under **timestamp** version ids — `20260729074617` / `guided_menu_identity_and_state`, `20260729084558` / `purchase_receipt_persistence`, `20260729172613` / `inventory_movement_ledger` — while the local repo files for the same content are named with legacy 4-digit numeric prefixes: `0051_guided_menu_identity_and_state.sql`, `0052_purchase_receipt_persistence.sql`, `0053_inventory_movement_ledger.sql`. Content is verified identical (schema, RPCs, and grants below match the migration files line-for-line); only the recorded **version identifier** differs from the local filename prefix for this range. Migrations `0055` onward in the repo similarly correspond to Production's `20260730090006` onward by content, not by filename prefix. This is why §16's proposed new migration uses the timestamped convention exclusively — it is the convention Production's own migration ledger actually uses for everything applied after `0050`.
- **Table inventory** (`list_tables`, 52 tables total): `purchase_receipts`, `purchase_receipt_items`, `purchase_receipt_document_namespaces`, `purchase_receipt_lifecycle_events`, `inventory_movements`, `inventory_movement_lines`, `inventory_locations`, `physical_inventory_sessions`, `physical_inventory_session_ingests`, `physical_inventory_snapshots`, `physical_inventory_items`, `physical_inventory_lifecycle_events`, `raw_messages`, `line_menu_states`, `line_operator_identities`, `line_guided_menu_markets`, and 36 others — all present as expected from the migrations. **`inventory_balances` is absent from the table list**, confirming it is a view in Production too, not a table. **No table resembling a product/unit master (`product_master`, `product_catalog`, or similar) exists in Production** — corroborates the repo-wide grep finding in §10.
- **RLS**: `rls_enabled: true` confirmed via `list_tables(verbose=true)` for `purchase_receipts`, `purchase_receipt_items`, `purchase_receipt_document_namespaces`, `purchase_receipt_lifecycle_events`, `inventory_movements`, `inventory_movement_lines`, `inventory_locations`, `physical_inventory_sessions` — all `true`, matching the migrations.
- **RPC security posture**, queried directly from `pg_proc`/`pg_namespace`: every mutating RPC in the purchase-receipt/inventory-movement/physical-inventory families (`confirm_purchase_receipt`, `upsert_purchase_receipt_draft`, `void_purchase_receipt`, `lock_purchase_receipt_for_posting`, `get_purchase_receipt_confirmation`, `purchase_receipt_build_confirmation_payload`, `post_purchase_receipt_inventory_movement`, `reverse_inventory_movement`, `open_physical_inventory_session`, `admit_physical_inventory_event`, `close_physical_inventory_open_event`, `get_physical_inventory_finalize_candidate`, `finalize_physical_inventory_session[_base]`) shows `prosecdef = true` with `proconfig` containing a fixed `search_path` (`public, extensions, pg_temp` for the 0052/0053 family, `public` for the 0047 family) — **CONFIRMED, matches the migration files exactly.**
- **Grants**, queried from `information_schema.role_table_grants` for `purchase_receipts`, `purchase_receipt_items`, `inventory_movements`, `inventory_movement_lines`, `inventory_locations`: only the table owner (`postgres`) holds `INSERT/UPDATE/DELETE/...`; `service_role` holds `SELECT` only; **no rows exist at all for `anon` or `authenticated`** on any of these five tables. **CONFIRMED — matches the documented "no direct table DML, mutation only via SECURITY DEFINER RPC" posture exactly.**

No Production data was read, displayed, or mutated beyond catalog/metadata queries (`pg_proc`, `information_schema`, table/column lists). No secret values were requested or returned.

---

## 4. Confirmed gaps

1. **No durable multi-message purchase-capture session exists.** Nothing in the repo persists an in-progress LINE purchase document across messages the way `physical_inventory_sessions`/`pending_sessions` do for their features. This is the entire subject of §7–§9 and Slice A.
2. **No adapter exists that turns a `PurchaseAssemblyResult` into a `PurchaseReceiptDraftInput`.** `src/lib/purchases/` and `src/lib/purchase-receipts/` are both fully built but nothing in the repo currently calls one from the other. Subject of §9 and Slice B.
3. **No product/unit resolver or Product Master exists anywhere in the codebase or Production** (§10). This is the one true **BLOCKER**.
4. **`webhook-service.ts` has no call site for a purchase-capture handler.** Read-only confirmed in §2.7; a future implementation PR must add exactly one call site, ordered before the generic Produce pending-session fallback, following the Physical Inventory precedent.
5. **No cron/finalizer route exists for a purchase-capture close barrier** — the Physical Inventory finalizer route and GitHub Actions schedule are feature-specific; a purchase-capture equivalent must be added (Slice A/C).

---

## 5. Exact V1 LINE message contract

**PROPOSED, using the existing parser contract unchanged.**

Per the task's default recommendation and confirmed by §2.1: the pure parser is already capable of everything V1 needs, and changing it is out of scope and unnecessary.

- **Keep `เริ่มซื้อ`, `ซื้อรายการ N`, `สรุปค่าใช้จ่ายซื้อ`, `ปิดซื้อ N รายการ` as the only accepted openers.** No alias (e.g. `เปิดใบซื้อ`) exists today (§2.1); none is added by this design. If staff ergonomics later demand a friendlier opener, it belongs in a **separate adapter layer** that translates an alias into the exact `เริ่มซื้อ ...` string *before* it reaches `src/lib/purchases/`, never as a second grammar inside the pure parser (this preserves the `architecture.test.ts` purity boundary and avoids two parsers drifting apart). **OWNER DECISION REQUIRED** on whether this is worth building for V1 — this document's default is no.
- **Both delivery shapes are supported without any change**: one block per LINE message (5 messages: header, item, item, costs, close) *and* multiple blocks pasted into one LINE message (verified tested, §2.1). The capture-session design (§8) must not assume either shape — it must accept whatever chunk-to-block mapping the parser already produces.
- **The pure parser remains unchanged.** No new file under `src/lib/purchases/` is proposed by this document. Any database/session adapter lives in a new module (§9, `src/lib/purchase-capture/` proposed) that imports `src/lib/purchases/` but is never imported back by it — `architecture.test.ts`'s existing assertions continue to hold with zero modification.
- Blank-line boundaries: unchanged, per §2.1 — absorbed per-block by `segmentPurchaseChunk`, not a message-level concern.

---

## 6. Session identity

**PROPOSED**, directly modeled on `physical_inventory_sessions` (§2.4), which already solves this exact problem for a different multi-message LINE document.

### 6.1 Identity tuple

```
source_type            -- 'user' | 'group' | 'room'   (same domain as purchase_receipts.source_type)
source_id              -- LINE source id (user/group/room)
sender_line_user_id    -- the operator who opened the document
session_generation     -- uuid, regenerated only on an explicit new open of a NEW document
opened_line_event_id   -- the LINE webhookEventId of the เริ่มซื้อ message; UNIQUE, immutable
```

### 6.2 One active session per sender — V1 rule, enforced in the database

**PROPOSED**: exactly the physical_inventory pattern — a **partial unique index**, not application-level checking alone:

```sql
CREATE UNIQUE INDEX purchase_capture_sessions_one_active_per_sender_idx
  ON purchase_capture_sessions (source_id, sender_line_user_id)
  WHERE status IN ('open', 'closing', 'awaiting_confirmation', 'confirming');
```

A sender with a session in any non-terminal state cannot open a second one; the `open` RPC must return a distinguishable `already_open` outcome (not silently rotate or replace) so the webhook handler can reply "you already have an open purchase — finish or cancel it first," mirroring `open_physical_inventory_session`'s `already_open` handling (`0047`, confirmed pattern). **No silent rotation or replacement of a live session, per the task's explicit instruction.**

**Can one sender have more than one live session in the same LINE source?** No — the V1 rule from the task (`one active purchase session per (source_id, sender_line_user_id)`) is adopted as-is; it is the same invariant Physical Inventory already enforces successfully in Production, so no new risk is introduced by copying it verbatim.

### 6.3 Document key construction

**PROPOSED**, directly satisfying the 0052 contract quoted in §2.2:

```
documentNamespace = "line-text"
documentKey        = opened_line_event_id
```

`opened_line_event_id` is: (a) already globally unique (backed by `raw_messages.line_event_id UNIQUE`, §2.5), (b) immutable once set (the opening event never changes), (c) derived from the document-opening event exactly as the 0052 comment requires, and (d) stable across every subsequent chunk/redelivery of the same document, because every later message in the same document belongs to the *same session*, and the session — not the message — is what supplies `documentKey` to every draft write. No hashing, concatenation, or additional derivation is needed; reusing the LINE event id directly is the simplest correct choice (ponytail: ladder step 2 — an existing globally-unique identifier already covers this, no synthetic key needed).

### 6.4 Cross-sender/cross-source isolation

Both the session `open` RPC and every subsequent `admit`/`close`/`finalize` RPC must take `p_expected_generation` (mirroring `admit_physical_inventory_event`'s `p_expected_generation`, §2.4) and re-verify `(source_type, source_id, sender_line_user_id)` under row lock before mutating — a staff member cannot append to or confirm another sender's session because the RPC itself refuses a generation/identity mismatch, not because the webhook handler happens to route correctly. This mirrors 0052's own fail-closed behavior on a document-key reused under a different source binding (§2.2).

---

## 7. State machine table

**PROPOSED.** All seven states from the task are used; none are added.

| State | Permitted incoming messages | Permitted commands | DB transition owner | Terminal? | Retry behavior | User-visible reply |
|---|---|---|---|---|---|---|
| `open` | header (already consumed to open), item, costs, **or** a single message containing all blocks including close (§8.4) | none (implicit: any recognized purchase block) | `admit_purchase_capture_event` RPC / `close_purchase_capture_open_event` for the one-message case | No | Redelivered `line_event_id` → no-op (unique ledger). **No idle-expiration timer exists.** A session that never receives `ปิดซื้อ N รายการ` simply stays `open` indefinitely — this is a deliberate V1 choice (§8.5), not an oversight; there is no `failed_closed`-on-timeout path | Ack per admitted block ("รับรายการที่ N แล้ว") or structural-error reply if the block itself is malformed |
| `closing` | late items/costs *before* `close_event_timestamp_ms`, redelivered close | `ปิดซื้อ N รายการ` (already received, sets the boundary) | `admit_purchase_capture_event` (late-admit path) / `close_purchase_capture_open_event` | No | Same event redelivered → no-op; late item after boundary → `after_close_boundary` rejection | None until quiet/deadline elapses, then the preview (§11) or a structural-failure summary |
| `awaiting_confirmation` | none accepted as document content (session is closed); `ยืนยันซื้อ`, `ตรวจใบซื้อใหม่`, `ยกเลิกซื้อ` only | `ยืนยันซื้อ` (the app computes the blocker state only to word the reply, §12 step 2; the **authoritative** check — zero blocking blockers, matching `receipt_id`/`draft_revision`, matching ownership — is re-done inside `begin_purchase_capture_confirmation` under lock, §12 step 3; refusal leaves the session at `awaiting_confirmation` and never calls `PurchaseReceiptService.confirm`), `ตรวจใบซื้อใหม่` (app re-runs the resolver + parser against the original ingest set to build a complete draft payload, then calls `replace_purchase_capture_draft` — ONE RPC that atomically re-validates and replaces the receipt AND advances the session's `draft_revision` in the same transaction, §11.3, §12), `ยกเลิกซื้อ` | Preview/draft written by `finalize_purchase_capture_session` (`closing`→`awaiting_confirmation`, Slice B, §21); re-written atomically by `replace_purchase_capture_draft` (`awaiting_confirmation`→`awaiting_confirmation`, §16.4 — locks the session first, refuses `invalid_state` immediately if the session is no longer `awaiting_confirmation`, **before touching the receipt at all**); the **only** path out of this state, to `confirming`, is owned by `begin_purchase_capture_confirmation` (§12, §16.4), which locks the session then the referenced receipt (same deterministic order `replace_purchase_capture_draft` uses, §12) and re-verifies revision/ownership/blockers itself before writing anything | No | Redelivered finalize → idempotent (same `ingest_revision`/hash check as §2.4); redelivered `ตรวจใบซื้อใหม่` with an unchanged registry → new draft revision with identical content, still idempotent at the P2B layer (§2.2's full-replace guarantee); a `ตรวจใบซื้อใหม่` that loses the race to a concurrent `ยืนยันซื้อ` is refused `invalid_state` before its receipt replacement is even attempted, because `replace_purchase_capture_draft` checks session status under lock as its first act (§12) | Full preview (§11), labeled either "รอยืนยัน" (zero blockers) or "รายการที่ต้องแก้ไขก่อนบันทึกเข้าสต๊อก" (blockers present, confirm refused) |
| `confirming` | none (further document text ignored/rejected with "purchase already confirmed, awaiting posting") | none (confirm already issued; not re-issuable) | Entered only via `begin_purchase_capture_confirmation` (§12, §16.4); then `PurchaseReceiptService.confirm` followed by `InventoryLedgerService.postPurchaseReceipt`, both called from this state | No | Crash before posting → cron sweep resumes posting using the same frozen `confirmationKey`/`receiptId` (§13) | "กำลังยืนยัน..." immediately, then final confirmation once posting completes |
| `posted` | none | none | — | **Yes** | Redelivered `ยืนยันซื้อ` → replayed confirm + replayed post, same result, no new state change | Final receipt summary + "บันทึกเข้าสต๊อกแล้ว" |
| `failed_closed` | none | none | `close_purchase_capture_open_event`/finalize path on structural failure (mirrors Physical Inventory's `fail_reason`, `0047:86-87`) | **Yes** | None — a new document must be opened | Structural error summary (which blocks/errors) |
| `cancelled` | none | none (already terminal) | `cancel_purchase_capture_session` RPC, callable only from `open`/`closing`/`awaiting_confirmation` | **Yes** | Redelivered `ยกเลิกซื้อ` on an already-cancelled session → idempotent no-op | "ยกเลิกใบซื้อแล้ว" |

State-transition edges:

```
open ──(close event admitted, or one message carrying header+items+costs+close, §8.4)──▶ closing
closing ──(quiet/deadline elapsed, parse.status=COMPLETE, draft saved)──▶ awaiting_confirmation
closing ──(quiet/deadline elapsed, parse.status=INCOMPLETE)──▶ failed_closed
open/closing/awaiting_confirmation ──(ยกเลิกซื้อ)──▶ cancelled
awaiting_confirmation ──(ตรวจใบซื้อใหม่: re-resolve + re-parse, then ONE atomic replace_purchase_capture_draft call)──▶ awaiting_confirmation (new draft_revision, same state, receipt and session updated together or not at all)
awaiting_confirmation ──(ยืนยันซื้อ, draft has zero blocking blockers)──▶ confirming
awaiting_confirmation ──(ยืนยันซื้อ, draft has ≥1 blocking blocker)──▶ awaiting_confirmation (refused; confirm() never called, §12)
confirming ──(P2B confirm + P2C post both succeed)──▶ posted
confirming ──(crash, resumed later by cron)──▶ confirming (no state change; recovery re-enters the same state and completes it)
```

**No idle-expiration edge exists from `open` or `closing`.** A session that never receives a close event, or whose close never reaches quiet/deadline eligibility, simply remains in that state; only an explicit `ปิดซื้อ N รายการ` (or the one-message open+close path, §8.4) or `ยกเลิกซื้อ` moves it forward (§8.5). This document does not design or claim an idle-timeout `failed_closed` transition.

There is no `confirming` → `failed_closed` edge: once `PurchaseReceiptService.confirm` has committed, the receipt is permanently confirmed (§2.2) — the only remaining work is posting, which is retried to success, never abandoned, because P2C's RPC-level identity-status refusal (§2.3) already guarantees posting cannot corrupt the ledger even under indefinite retry, and this design's own confirm-gate (§12) already refuses confirmation while any item is `UNRESOLVED`, so posting should never encounter that refusal in the first place. The confirm-vs-recheck race that could previously have produced this outcome is now fully closed by construction: `begin_purchase_capture_confirmation` and `replace_purchase_capture_draft` share one lock order and each re-verifies the receipt's current, locked state before acting (§12), so no interleaving of `ยืนยันซื้อ`/`ตรวจใบซื้อใหม่` can hand `confirm()` a stale draft. If a receipt still confirms with an `UNRESOLVED` item anyway, it can only be a bug elsewhere in the call path (e.g. an application code path that calls `PurchaseReceiptService.confirm` directly, bypassing `begin_purchase_capture_confirmation` entirely — §17 forbids this but a design document cannot enforce it) — the session must surface a distinct operator-visible stuck state rather than silently retrying forever; this is flagged as an **OWNER DECISION REQUIRED** in §24 rather than a new state.

---

## 8. Event-ingest and close-barrier design

### 8.1 Options considered

- **Option A — reuse/adapt the Physical Inventory 8s quiet / 30s deadline pattern.** Directly reuses a pattern already running in Production for a structurally identical problem (multi-message LINE document, redelivery, out-of-order arrival, close-vs-late-item race). Cost: three new migrations (§16, one per implementation slice) adding 3 session-layer tables closely mirroring `0047` plus 2 identity-registry tables.
- **Option B — immediate close without a durable barrier.** Rejected: the task explicitly requires safety under "close message arriving before an earlier item request finishes" and "messages arriving out of HTTP processing order." Without a quiet window, a close event processed by a fast worker while an earlier item's request is still in flight on a slower worker would finalize an incomplete document — exactly the race `0047`/`0032` were built to prevent. There is no cheaper mechanism in this repo that already solves this; inventing an ad hoc alternative would be strictly worse than reusing a pattern already proven in Production.
- **Option C — single-message-only purchase documents.** Rejected as a *requirement* (it would contradict §2.1's confirmed multi-message support and the task's explicit "block split across messages" test requirement), but is worth noting as **already a supported degenerate case** of Option A: a document sent entirely in one LINE message still opens a session, admits everything in one event, and closes on the same event — the quiet window elapses trivially fast in that case. No special-casing is needed.

**Recommendation: Option A**, adapted as a new, purchase-capture-scoped set of tables (not shared rows with `physical_inventory_sessions`) — mirroring how `0047` itself did not reuse Produce's `0032` tables even though it reused the exact timing constants and mechanism. Reasoning: sharing tables across features has historically been avoided in this repo (each capture feature owns its tables), and reusing *tables* would require a discriminator column and would complicate the terminal-state immutability triggers; reusing the *mechanism* (proven, tested, already running) while keeping tables feature-scoped is the established convention.

### 8.2 Design, mapped to the task's required coverage list

| Requirement | Design |
|---|---|
| Unique LINE event identity | `raw_messages.line_event_id` (existing, reused verbatim) plus a feature-scoped `purchase_capture_session_ingests.line_event_id UNIQUE` (global, mirrors `0047:141`) |
| Redelivery of the same event | Unique-violation on `line_event_id` → RPC returns the original ingest row idempotently (mirrors `0047:774-808`) |
| Conflicting reuse of one LINE event ID | If the same `line_event_id` is presented with different `raw_text`/`kind` than the first admission (should be impossible — LINE event ids are immutable — but guarded defensively exactly as `0047` does), reject with a distinct error rather than silently overwriting |
| LINE message ID | `line_message_id` column, stored alongside the event (mirrors `p_line_message_id` param on `admit_physical_inventory_event`) |
| Event timestamp | `line_timestamp_ms bigint`, the LINE-supplied event timestamp — used for late-item admission ordering, never server receipt time |
| Deterministic chunk ordinal | **Two separate, non-interchangeable concepts.** `ingest_ordinal` is an **admission-order/audit-only** counter, assigned by the RPC as `ingest_revision` increments — it records the order the DB happened to admit events in and is never used as document order. The parser adapter (§9) instead assigns `PurchaseTextChunk.chunkOrdinal` itself, by sorting the candidate ingest set by `(line_timestamp_ms ASC, line_event_id ASC)` — `line_timestamp_ms` first (the LINE-supplied event time), `line_event_id` as the deterministic tie-breaker when two events share a timestamp. Request-arrival order and `ingest_revision`/`ingest_ordinal` are never used as semantic document order |
| Ingest revision | `ingest_revision bigint DEFAULT 0` on the session row, incremented per admitted event (mirrors `0047`) — **concurrency/version counter only**, never a proxy for document order |
| Ingest-set hash | `purchase_capture_compute_ingest_set_hash(session_id)` — same SHA-256-over-ordered-tuples construction as `physical_inventory_compute_ingest_set_hash` (`0047:400-434`), computed over tuples sorted by the same `(line_timestamp_ms, line_event_id)` key as the chunk ordinal above (not by `ingest_ordinal`), so the hash is stable under any admission-order variation and changes only when the actual document content changes; used as the optimistic-concurrency guard on finalize |
| Close boundary | First `ปิดซื้อ` admission sets immutable `close_event_timestamp_ms`, `close_quiet_until = clock_timestamp() + interval '8 seconds'`, `close_deadline_at = clock_timestamp() + interval '30 seconds'` |
| Late item whose LINE timestamp is before the close timestamp | Admitted if `line_timestamp_ms <= close_event_timestamp_ms` and `now() < close_deadline_at`, exactly as `0047:749-756` |
| Event admitted after close | Rejected `after_close_boundary` if its own timestamp is after `close_event_timestamp_ms`, even if arriving before the deadline — this is what stops a race where a late-processed but *logically-after-close* item sneaks in |
| Quiet window | 8s of no new admissible ingest before finalize may proceed — DB-clock-authoritative check inside the finalize RPC itself (`NOT (now() >= close_quiet_until OR now() >= close_deadline_at) → RAISE 'close_quiet_window'`, mirrors `0047:1094-1099`) |
| Hard deadline | 30s absolute ceiling from the close event, regardless of ongoing quiet-window resets — mirrors `0047` exactly (Physical Inventory's window does not reset per-late-item; it is measured from the close event once) |
| Scheduler recovery | New cron route `src/app/api/cron/finalize-purchase-capture/route.ts` (same `CRON_SECRET` auth pattern as `finalize-physical-inventory`), new GitHub Actions schedule, sweeping `status='closing' AND (close_quiet_until <= now() OR close_deadline_at <= now())`, mirroring `finalizer.ts:303-317` |

### 8.3 Why this cannot persist an incomplete receipt on a close-race

Finalize (the `closing` → `awaiting_confirmation`/`failed_closed` transition) requires the caller to present `p_expected_ingest_revision`/`p_expected_ingest_hash` matching the *current* row state under `FOR UPDATE` — if any event was admitted between when the candidate was read and when finalize is called, the hash no longer matches and finalize is refused (retryable, mirrors `0047:1085-1092`). Combined with the DB-clock quiet/deadline check, no code path can call the P2B draft-save step (§9) before the ingest set is provably stable. This is the same guarantee that already protects Physical Inventory in Production.

### 8.4 One-message documents — the all-blocks-in-one-opening-event path

**PROPOSED.** §2.1 confirms the pure parser already accepts a single LINE message containing Header + Items + Costs + Close as one chunk with several blocks. The capture session must support that shape **without inserting the same LINE event twice.**

- `open_purchase_capture_session` persists the complete opening raw message as the session's **first and only** ingest row for that event, exactly once — identical to the multi-message case (§16.4).
- Application code (the webhook handler, after calling `open`) runs the pure parser's `segment`/`classify` step (read-only, no new DB write) against that same raw text to discover whether it also contains a `ปิดซื้อ` block.
- If it does, the handler calls a distinct RPC:

  ```
  close_purchase_capture_open_event(p_session_id, p_expected_generation, p_opened_line_event_id)
  ```

  which sets `close_event_timestamp_ms`/`close_quiet_until`/`close_deadline_at` from the **already-persisted** opening ingest row (looked up by `p_opened_line_event_id`, re-verified under `FOR UPDATE` to belong to this session/generation) — it does **not** call `admit_purchase_capture_event` and does **not** insert a second ingest row for the same `line_event_id`. `purchase_capture_session_ingests.line_event_id UNIQUE` (§13) makes a second insert attempt fail closed rather than silently duplicating the event.
- Redelivery of the same opening message: `open_purchase_capture_session` is already idempotent on `opened_line_event_id UNIQUE` (§6.1/§16.1); a redelivered `close_purchase_capture_open_event` call for the same session/event is idempotent because the boundary fields it sets are immutable once written (mirrors `0047`'s `close_event_timestamp_ms` immutability, §2.4) — a second call with the same arguments observes the fields already set and returns the existing boundary, not an error.
- The same event can never conflict with itself as both "open" and "close" in two different rows, because there is only ever one row for it — `close_purchase_capture_open_event` mutates boundary columns on the session, not the ingest table.
- **Convergence**: once the boundary is set, the one-message path and the multi-message path are indistinguishable to everything downstream — `get_purchase_capture_finalize_candidate` (§16.4), the quiet/deadline check (§8.2), and the parser adapter (§9) all operate on "the session's ingest set plus its boundary fields," with no branch anywhere for "was this a one-message or five-message document."

### 8.5 Missing close — V1 behavior (no idle-expiration state)

**PROPOSED, deliberately simple.** A session that never receives a `ปิดซื้อ N รายการ` (and is not the one-message case of §8.4) has no close boundary and therefore cannot become eligible for finalize — there is nothing for the quiet/deadline check to measure from. V1 does **not** design or claim an idle-timeout: the session simply remains `open` until the sender sends a valid close block or `ยกเลิกซื้อ`. No new state, no background job, no expiration column is added to satisfy an operational "missing close" test — see §19.1/§19.2 for how this is actually tested (parser-level `MISSING_CLOSE` vs. an operational "still open" assertion are two different things). If an idle-expiration contract is wanted later, it needs its own design pass (bound, notification, and — critically — what happens to any items already admitted); this document does not attempt one.

---

## 9. Parser-to-draft mapping

**PROPOSED.** New module `src/lib/purchase-capture/` (adapter layer, outside `src/lib/purchases/` per §5) is responsible for this mapping; it imports both `src/lib/purchases/` and `src/lib/purchase-receipts/` — neither of those modules imports it back, preserving the existing purity boundary (§2.1).

### 9.1 Admitted LINE messages → parser types

1. The finalize candidate's ingest rows (§8.2's `get_purchase_capture_finalize_candidate`) are sorted **in application code, not in SQL and not by admission order**, by `(line_timestamp_ms ASC, line_event_id ASC)`. Each sorted row is converted 1:1 into a `PurchaseTextChunkInput` (`chunkId` = the ingest row's id, `chunkOrdinal` = the row's **position in this sorted array** — never `ingest_ordinal`, never the RPC/HTTP-arrival order, §8.2 — `rawText` = the stored raw message text, `evidence` = `{lineEventId, lineMessageId, lineTimestampMs, rawMessageId}` — all already captured by §8's ingest ledger).
2. `src/lib/purchases/text-adapter.ts`'s existing chunk-construction path (already tested, §2.1) turns each into a `PurchaseTextChunk`, applying NFC normalization and BOM/whitespace handling exactly as today — **no change to this step**.
3. `classify` + `segment` + `parse` (unchanged, §2.1) produce `PurchaseCommandEnvelope[]` per chunk, in the **deterministic chunk order assigned in step 1** — `(line_timestamp_ms, line_event_id)` order, never client/webhook-arrival order and never `ingest_revision`/`ingest_ordinal`.
4. `assemble` (unchanged) combines all envelopes across all chunks into one `PurchaseAssemblyResult`.
5. **Identity resolution (new adapter logic, §10.3).** For every parsed item, the adapter looks up `rawProductText` against `purchase_intake_product_registry` and `rawUnit`/`priceUnitText` (when present) against `purchase_intake_unit_alias_registry`, producing `productKey`/`productIdentityStatus`, `quantityUnitKey`/`unitIdentityStatus`, and `priceUnitKey`/`priceUnitStatus` **explicitly for every item, every field, every time** — none of the three is ever left unset and allowed to fall back to `0052`'s column defaults (§10.2). Canonical quantity-unit-key/price-unit-key equality is enforced here per §10.3's exact rule.
6. Raw evidence (every original LINE message text, per chunk) is preserved by construction — it is never discarded, only ever added to `PurchaseEvidenceDraft.rawTextChunks` (§2.1) and, separately, kept in `purchase_capture_session_ingests` as the append-only audit trail (never deleted, mirrors `0047`'s ingest ledger).
7. **Close-count validation and structural errors are the parser's existing job, untouched** (§2.1) — the adapter does not re-implement or duplicate any of this logic; it only decides, based on `PurchaseAssemblyResult.status`, whether to proceed to draft-save (`COMPLETE`) or transition the session to `failed_closed` (`INCOMPLETE`), carrying the `errors`/`reviewFlags` arrays into the terminal reply. **A `COMPLETE` assembly is always saved as a draft**, regardless of whether step 5 found any `UNRESOLVED` identity — identity blockers never prevent a draft from existing or being previewed; they only prevent `ยืนยันซื้อ` from succeeding later (§12). There is no partial draft and no partial posting anywhere in this pipeline.
8. **Review flags** (§2.1, non-blocking) are carried through unchanged into `PurchaseReceiptDraftInput.reviewFlags` (§2.2's field exists for exactly this) and surfaced in the preview (§11) as non-blocking notes, never as reasons to refuse the draft. They remain distinct from the blocking identity statuses computed in step 5.

The pure parser under `src/lib/purchases` remains database-free — this adapter is the *only* new code that touches both a database session and the parser, and it lives outside `src/lib/purchases/`, satisfying the task's explicit constraint.

---

## 10. Product/unit identity decision — BLOCKER, with proposed resolution

**This is the one confirmed BLOCKER in this document.**

### 10.1 What exists today

- `purchase_receipt_items.product_identity_status`/`unit_identity_status`/`price_unit_status` are real, enforced columns (`0052:472-511`, confirmed present in Production, §3) with CHECK constraints restricting values to `RESOLVED`/`UNRESOLVED` (identity/unit) and `NOT_APPLICABLE`/`RESOLVED`/`UNRESOLVED` (price unit).
- P2C's `post_purchase_receipt_inventory_movement` RPC **does** refuse to post any item whose frozen `product_identity_status`/`unit_identity_status` is not exactly `'RESOLVED'` (`0053:955-967`, confirmed present in Production). This part of the system is already safe by construction.
- **But**: `PurchaseReceiptItemInput.productIdentityStatus`/`unitIdentityStatus`/`priceUnitStatus` **default (`RESOLVED`/`RESOLVED`/`NOT_APPLICABLE`) if the TypeScript caller does not set them explicitly** (`receipt-service.ts:164,168`, confirmed by direct read of `0052:472-511`'s column defaults). This means the safety of the entire system currently rests entirely on every future caller of `saveDraft` remembering to set all three statuses honestly — there is no code anywhere that actually verifies a raw product string, a raw quantity-unit string, or a raw price-unit string against anything.
- A repository-wide search for `product_master`, `product_catalog`, `resolveProduct`, `ProductIdentity`, `ProductMaster`, `CatalogProduct`, and separately for a unit-alias resolver scoped to purchases, returns **zero SQL tables and zero resolver functions**. The only two hits in the entire repo are explicit warnings that no such thing exists: `src/lib/physical-inventory/types.ts:17` ("Must NOT be treated by P2C as an authoritative product master key") and `src/lib/physical-inventory/types.ts:38` ("Capture-only NFC + whitespace collapse — never fuzzy / P0 aliases / product master"). Production's table list (§3) independently confirms no such table exists there either.
- `normalizeProductName`-style functions that do exist elsewhere in the repo (e.g. for weigh-session parsing) are **NFC/whitespace normalization only** — they do not resolve a raw string to a canonical, verified product or unit identity, and the task's instruction not to "pretend normalizeProductName alone is a Product Master" is correct: nothing in this repo currently does that job, under any name, for products or for units.
- Each purchase item carries **two, independently-sourced raw unit strings**: the quantity unit from `จำนวน <qty> <unit>`, and the price unit from `ราคา <rate> บาท/<unit>` (§2.1) — they are captured as separate fields (`rawUnit`, `priceUnitText`) and are not guaranteed to be written the same way even when they mean the same thing (e.g. `กก.` vs `โล`).

### 10.2 Why this blocks unrestricted posting

If the P2B adapter (§9) simply forwards raw parsed text as `productKey`/`unitKey` without setting explicit statuses, every item defaults to `RESOLVED`/`RESOLVED`/`NOT_APPLICABLE` and P2C's refusal check (§2.3) becomes a no-op — the one safety net this system has would never fire, defeating its purpose. This is a **design discipline requirement on the adapter**, not a missing database feature: the adapter must **never** allow `productIdentityStatus`, `unitIdentityStatus`, or `priceUnitStatus` to default; it must compute all three explicitly for every item (§9.1 step 5).

### 10.3 Proposed smallest safe resolution contract

**PROPOSED — two small, explicit, additive registries**, scoped only to what V1 needs, not a general product catalog. One registry resolves the product name; one resolves unit text — and the same unit registry is queried **twice per item** (once for the quantity unit, once for the price unit, when present), because a unit alias's meaning does not depend on which field it came from. This is the smallest design that still lets the two be compared: a single combined product+unit table (as originally proposed) cannot express "this quantity unit and this price unit must resolve to the *same* canonical key," because it would tie one unit string to one product row instead of letting any unit string resolve independently.

```sql
CREATE TABLE public.purchase_intake_product_registry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_product_text  text NOT NULL UNIQUE,  -- normalized (NFC + collapsed whitespace), matched exactly
  product_key       text NOT NULL,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.purchase_intake_unit_alias_registry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_unit_text  text NOT NULL UNIQUE,  -- normalized the same way
  unit_key       text NOT NULL,          -- canonical key, e.g. 'kg'
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

Both modeled directly on the existing allowlist pattern already proven for `line_guided_menu_markets`/`line_guided_menu_sellers` (§2.6: a small, manually-curated, `active`-flagged table, read via a `SECURITY INVOKER` lookup RPC or direct `service_role` `SELECT` — no elevated write path needed since these tables are maintained by an operator/admin flow, not by the LINE bot itself).

**Exact lookup algorithm, run by the adapter (§9.1 step 5) for every item:**

1. Normalize `rawProductText` (NFC + collapsed whitespace — the same normalization `CapturedText` already applies, §2.1) and look it up in `purchase_intake_product_registry.raw_product_text`. A match with `active=true` → `productKey` = the row's `product_key`, `productIdentityStatus = 'RESOLVED'`. No match, or `active=false` → `productIdentityStatus = 'UNRESOLVED'`, `productKey` = a deterministic placeholder derived from the normalized raw text (never null — `0052`'s CHECK requires non-blank `product_key` even when unresolved, confirmed §2.2).
2. Normalize `rawUnit` (the quantity unit) the same way and look it up in `purchase_intake_unit_alias_registry.raw_unit_text`. Match + active → `quantityUnitKey` = the row's `unit_key`, `unitIdentityStatus = 'RESOLVED'`. No match/inactive → `unitIdentityStatus = 'UNRESOLVED'`, `quantityUnitKey` = a deterministic placeholder, same construction as step 1.
3. If the item has no `priceUnitText` at all (unit cost is `ไม่ทราบ`, §2.1) → `priceUnitStatus = 'NOT_APPLICABLE'`, no lookup performed. Otherwise, normalize `priceUnitText` and look it up in the **same** `purchase_intake_unit_alias_registry`, independently of step 2's result. Match + active → `priceUnitKey` = the row's `unit_key`, tentatively `priceUnitStatus = 'RESOLVED'`. No match/inactive → `priceUnitStatus = 'UNRESOLVED'`.
4. **Canonical equality rule (V1):** if both `unitIdentityStatus` and the tentative `priceUnitStatus` from step 3 are `RESOLVED`, compare `quantityUnitKey === priceUnitKey`. Equal → `priceUnitStatus` stays `RESOLVED`. Not equal → `priceUnitStatus` is overwritten to `'UNRESOLVED'` (0052's existing three-value enum has no "mismatch" value, so a mismatch is represented as unresolved — it is exactly as blocking as an unknown unit, which is correct: V1 does not invent a conversion ratio between different units, so a mismatch is not postable). Exact aliases resolving to the same canonical key (e.g. `กก.` → `kg`, `โล` → `kg`) are therefore accepted as equal; no conversion arithmetic is ever performed.
5. **Blocking rule**: an item is postable only if `productIdentityStatus = 'RESOLVED'` **and** `unitIdentityStatus = 'RESOLVED'` **and** (`priceUnitStatus = 'NOT_APPLICABLE'` **or** `priceUnitStatus = 'RESOLVED'`). Any other combination is a blocking blocker for that item, which — per §12 — makes the *entire receipt* unconfirmable (all-or-nothing, not per-item).

**Unique constraints**: `raw_product_text` and `raw_unit_text` are each declared `UNIQUE` directly on their column (no composite key needed, since each registry now resolves exactly one raw string to exactly one canonical key, independent of context) — this also means the same alias row (e.g. `โล` → `kg`) is reused for both quantity-unit and price-unit lookups with no duplication.

- An `UNRESOLVED` item (any of the three statuses) does **not** block draft creation or the preview (§11/§9.1 step 7) — the draft/preview surfaces it as a visible blocker so staff see it *before* attempting to confirm — but it **does** block `ยืนยันซื้อ` for the whole receipt (§12), which corrects the earlier design's claim that only posting was blocked.
- **Scope for first posting**: seed both registries with only the exact product/unit pairs used in the UAT document (§20) — a handful of rows each, not a general catalog. This keeps the migration trivially small and reviewable while still closing the safety gap honestly (no item is ever silently marked `RESOLVED`/`NOT_APPLICABLE` by default).
- Migration impact: two new additive tables, no changes to `0052`/`0053`. Proposed as part of **Slice B** (§21), since they are needed exactly where the adapter decides identity status, not before.

**OWNER DECISION REQUIRED**: whether manually-curated registries (staff/admin edits rows directly, or a future tiny admin UI) are acceptable for V1, versus wanting a LINE-driven "register this product/unit" flow before any purchase can post. This document's default recommendation is the former — smallest safe thing, per the task's explicit instruction not to over-build.

---

## 11. Draft preview UX with full Thai examples

**PROPOSED.**

### 11.1 Successful draft preview (all items resolved, no blockers)

Sent after the session transitions `closing` → `awaiting_confirmation`:

```
สรุปใบซื้อ (รอยืนยัน)

วันที่ซื้อ: 4/8/2569 09:30
ผู้ขาย: ตลาดไท
ใบอ้างอิง: ไม่มี
ปลายทาง: MAIN

รายการที่ 1: หมอนทอง
  จำนวน: 50 โล
  ราคา: 100 บาท/โล
  รวม: 5,000.00 บาท

รายการที่ 2: ส้มไต้หวัน
  จำนวน: 20 โล
  ราคา: 40 บาท/โล
  รวม: 800.00 บาท

ค่าขนส่ง: 500.00 บาท
ค่าจัดการ: 0.00 บาท
ส่วนลด: 0.00 บาท
ภาษีมูลค่าเพิ่ม: ไม่มี

ยอดชำระสุทธิ: 6,300.00 บาท

ไม่มีรายการที่ต้องแก้ไข

พิมพ์ "ยืนยันซื้อ" เพื่อบันทึกเข้าสต๊อก
พิมพ์ "ยกเลิกซื้อ" เพื่อยกเลิก
```

### 11.2 Preview with blockers (unresolved product, unresolved/mismatched unit)

```
สรุปใบซื้อ (มีรายการต้องแก้ไข)

วันที่ซื้อ: 4/8/2569 09:30
ผู้ขาย: ตลาดไท
ใบอ้างอิง: ไม่มี
ปลายทาง: MAIN

รายการที่ 1: หมอนทองพันธุ์ใหม่ ⚠️ ยังไม่รู้จักชื่อสินค้านี้
  จำนวน: 50 โล
  ราคา: 100 บาท/โล
  รวม: 5,000.00 บาท

รายการที่ 2: ส้มไต้หวัน ⚠️ หน่วยราคาต่างจากหน่วยจำนวน
  จำนวน: 20 กก.
  ราคา: 40 บาท/โล
  รวม: 800.00 บาท

ค่าขนส่ง: 500.00 บาท
ค่าจัดการ: 0.00 บาท
ส่วนลด: 0.00 บาท
ภาษีมูลค่าเพิ่ม: ไม่มี

ยอดชำระสุทธิ: 6,300.00 บาท

รายการที่ต้องแก้ไขก่อนบันทึกเข้าสต๊อก:
  - รายการที่ 1: "หมอนทองพันธุ์ใหม่" ยังไม่ได้ลงทะเบียนสินค้า
  - รายการที่ 2: หน่วย "กก." กับ "โล" ต้องเป็นหน่วยเดียวกัน หรือยังไม่ได้ลงทะเบียนหน่วยนี้

ใบซื้อนี้ยังไม่สามารถยืนยันเข้าสต๊อกได้ จนกว่ารายการที่มีปัญหาจะได้รับการแก้ไขครบ

หลังแก้ไขข้อมูลลงทะเบียนแล้ว พิมพ์ "ตรวจใบซื้อใหม่" เพื่อตรวจสอบอีกครั้ง
พิมพ์ "ยกเลิกซื้อ" เพื่อยกเลิก
```

Every field the task requires is present: purchase date/time, supplier, reference, destination `MAIN`, every item with quantity/unit/unit cost/price unit, line amount (computable — freight/handling/discount/VAT are document-level, not per-line, so they are shown once, not per item, matching `0052`'s schema, §2.2), freight/handling/discount/VAT, payable total (computed client-side from `ExactDocumentMoney`/satang fields, never re-derived by a second, drifting calculation), and blocking blockers, shown as a single list that gates the whole receipt — there is no "review flag, still confirmable" case shown here because both example issues are blocking (§10.3); a non-blocking review flag (e.g. `ไม่ทราบเวลา`, §2.1) would appear as a separate, non-blocking note and would **not** prevent `ยืนยันซื้อ` (§11.1 shows the all-clear case). **This design never describes, and never allows, partial ledger posting** — a receipt with any blocking blocker cannot be confirmed at all, let alone posted partially (§12).

### 11.3 Confirmation commands

**PROPOSED**: `ยืนยันซื้อ`, `ตรวจใบซื้อใหม่`, `ยกเลิกซื้อ` — the task's candidate V1 commands plus one addition (`ตรวจใบซื้อใหม่`) needed to make the confirm-gate (§12) usable in practice. No ambiguity handling is needed beyond what §6.2 already guarantees: because only one active session can exist per `(source_id, sender_line_user_id)`, and confirmation is only accepted from `awaiting_confirmation`, there is never more than one candidate document for a given sender to act on.

- **`ยืนยันซื้อ`** — the handler loads the current draft's blocker state **only to word the reply** (§11.2 copy) and to decide whether it's even worth attempting the RPC call; this app-side read is **not** the authoritative gate and is never trusted as one, because it can be stale by the time the RPC runs (a concurrent `ตรวจใบซื้อใหม่` can change the draft between the handler's read and its RPC call). The actual gate is `begin_purchase_capture_confirmation` (§12, §16.4): a single RPC, under lock, that re-verifies ownership, `session_generation`, `receipt_id`/`draft_revision` match, and zero blocking blockers against the *current* authoritative row state, and only then transitions the session to `confirming`. Any refusal (stale revision, receipt mismatch, ownership mismatch, or a blocking blocker still present) leaves the session at `awaiting_confirmation` with no `PurchaseReceiptService.confirm` call ever made.
- **`ตรวจใบซื้อใหม่`** ("recheck the purchase") is the operator's path forward after fixing a registry gap (§10.3). Application code first re-reads the session's original, unchanged durable ingest set (§8), re-runs the unchanged pure parser (§9.1 steps 1-4) and identity resolution (§9.1 step 5) against the *current* registry state, and renders the fresh preview as an ordered array of message texts in memory — one string per LINE message the preview will need (usually one), never a single blob — none of this touches the database. It then makes exactly **one** RPC call, `replace_purchase_capture_draft` (§12, §16.4), passing the complete recomputed draft payload and that ordered array (`p_preview_payload_texts`). That single call, in one transaction: locks the session, re-checks it is still `awaiting_confirmation` and matches the expected `receipt_id`/`draft_revision` (refusing `invalid_state`/`stale_revision` immediately — before the receipt is touched at all — if a concurrent `ยืนยันซื้อ` already won the race, §12), locks the referenced `purchase_receipts` row, applies the full receipt/item replacement by invoking `0052`'s own `upsert_purchase_receipt_draft` validation/upsert logic (no bypass of any `0052` rule), records the resulting new `draft_revision` back onto the session row, and atomically creates the new preview's complete, ordered set of outbox part rows — one row per message, one `retry_key` per row (§16.3, §18) — all before committing. There is no window in which the receipt has a newer revision than the session believes, and no window in which a replaced receipt is left unattached to its session (§12). It never calls `confirm()` — recheck only ever produces a new draft, never a confirmation, even if every blocker happens to clear. **Application code no longer calls `PurchaseReceiptService.saveDraft` on its own for a recheck** — the old two-step "saveDraft, then a separate RPC to record the pointer" sequence is removed; `replace_purchase_capture_draft` is the only place a recheck's content reaches the database. Actually delivering the new preview to LINE is a separate step, per part, via the claim-and-send contract (§18.4) — not something this RPC call itself performs.
- Because `draft_revision` changes on every recheck, a later `ยืนยันซื้อ` always binds to the **newest** `draft_revision` the session has recorded — an operator cannot accidentally confirm a stale, already-superseded preview, because `begin_purchase_capture_confirmation`'s own re-check (§12 step 3) would refuse a mismatched revision.
- **Raw database UUIDs are never shown in the LINE reply** — the preview references items by their 1-based `รายการที่ N` ordinal, matching the parser's own numbering (§2.1's `ซื้อรายการ N`), never `receiptId`/`item id`.

---

## 12. Confirmation and posting sequence

**PROPOSED**, using both existing services exactly as designed (§2.2, §2.3), with one new RPC for the confirm-gate itself (§16.4) and no attempt to combine `confirm`/`postPurchaseReceipt` into an imaginary atomic transaction (per the task's explicit instruction — that part is unchanged).

```
1. Staff sends "ยืนยันซื้อ" while session.status = 'awaiting_confirmation'.
2. Handler loads the current draft's blocker state ONLY to word the reply if
   the command ends up refused (§11.2 copy). This read is advisory — it is
   never trusted as the gate, because it can already be stale by the time
   step 3 runs (a concurrent ตรวจใบซื้อใหม่ may have changed the draft in
   between, §11.3).
3. beginResult = begin_purchase_capture_confirmation({ sessionId,
     expectedGeneration, expectedReceiptId, expectedDraftRevision, sourceType,
     sourceId, senderLineUserId }) — ONE RPC call, ONE transaction, and the
     sole authoritative gate (§16.4):
   a. Lock the session row FOR UPDATE — session locked before receipt,
      always; `replace_purchase_capture_draft` (§11.3, §12.2) uses the identical
      order, so the two commands can never deadlock against each other.
   b. Re-check source_type/source_id/sender_line_user_id/session_generation
      match; refuse `ownership_mismatch`/`generation_mismatch` otherwise.
   c. Re-check status = 'awaiting_confirmation'; refuse `invalid_state`
      otherwise (covers "already confirming," "already posted," "cancelled").
   d. Re-check session.receipt_id = expectedReceiptId AND
      session.draft_revision = expectedDraftRevision under the lock; refuse
      `stale_revision` otherwise — this is exactly the race where a
      concurrent ตรวจใบซื้อใหม่ already advanced the draft.
   e. Lock the referenced purchase_receipts row FOR UPDATE — receipt locked
      strictly after the session, never before (same deterministic order).
   f. Re-check receipt.status = 'draft' and its draft_revision still matches;
      refuse `receipt_not_draft`/`stale_revision` otherwise.
   g. Evaluate blocking blockers directly from the now-locked
      purchase_receipt_items rows, per §10.3's exact rule — the authoritative
      re-evaluation, independent of step 2's read; refuse
      `blocking_blocker_present` (carrying per-item detail for the reply) if
      any exist.
   h. Only when a-g all pass: UPDATE session SET status = 'confirming', write
      a lifecycle event, commit. Return success with the exact
      receiptId/draftRevision the transition was performed against.
   Any refusal from beginResult leaves the session unchanged at
   'awaiting_confirmation' and calls `PurchaseReceiptService.confirm` for
   NOTHING — processing stops here. The reply is chosen from beginResult's
   reason: `stale_revision` → ask the operator to re-check the latest
   preview; `blocking_blocker_present` → the §11.2 copy; ownership/generation
   mismatch → a generic "not your purchase" error.
4. confirmationKey = 'purchase-capture:v1:' || session.opened_line_event_id
     (deterministic, derivable again on retry without any new state to remember —
      mirrors §6.3's reasoning for documentKey; identical retries always recompute
      the identical key).
5. actor = 'line:' || sender_line_user_id   (matches the existing `actor` field
     shape already accepted by both confirm() and postPurchaseReceipt(), §2.2/§2.3).
6. result = PurchaseReceiptService.confirm({ receiptId, confirmationKey,
     expectedDraftRevision, actor }).
   - expectedDraftRevision is the exact revision step 3h locked and returned —
     not a fresh read — so this call is confirming precisely the draft that
     was just proven current and unblocked, not a value that could have
     drifted between steps.
   - Because step 3 already authoritatively required zero blocking blockers
     against this exact draft revision under lock, confirm() is never called
     against a draft containing an UNRESOLVED item under normal operation —
     the RPC-level refusal at posting time (§2.3) remains a defense-in-depth
     backstop, not the primary gate (§10.2).
   - If this is a replay (same confirmationKey, already confirmed): result.replayed
     = true, no new row written (§2.2). Proceed to step 7 regardless — posting must
     still be attempted/verified, because confirm succeeding does not imply posting
     succeeded (this is exactly the partial-success case the task requires handling).
7. postResult = InventoryLedgerService.postPurchaseReceipt({ receiptId, actor }).
   - dedupeKey is P2B's own frozen p2c_dedupe_key (§2.3) — the ledger service does
     not need confirmationKey at all; it reads the frozen confirmation payload.
   - If this is a replay (same dedupeKey, already posted): postResult.replayed =
     true, no new movement (§2.3).
   - postPurchaseReceipt posts the ENTIRE receipt or fails entirely (§2.3) — there
     is no per-item partial posting path anywhere in this sequence.
8. Session → 'posted' (terminal), recording postResult.movementId.
9. Notification: parts = create_purchase_capture_notification_parts({
     sessionId, kind: 'posted_success', version: postResult.movementId,
     payloadTexts: [renderedPostedSuccessText] }) — idempotent, atomic
     part-set creation keyed on (session_id, kind, version), §16.3/§18.3 —
     normally a single part. Then, for each part in order: claim =
     claim_next_purchase_capture_notification_part({ sessionId, kind:
     'posted_success', version: postResult.movementId }) (§18.4); if claim
     returns nothing, stop (nothing eligible right now — a concurrent
     worker or a prior attempt already has it or already delivered it).
     Otherwise send claim.payloadText via LINE's reply API if still in the
     original request/response cycle, otherwise push using claim.retryKey.
     On a successful send (or a 409 replay with the same retry_key, §18.4),
     call mark_purchase_capture_notification_part_delivered(claim.id,
     claim.claimToken); on a failed attempt, call
     record_purchase_capture_notification_part_attempt(claim.id,
     claim.claimToken, error) so the part stays eligible for cron recovery
     (§18.4), then stop for this request (a later part is never claimed
     while an earlier one remains undelivered).
```

### 12.1 Partial-success recovery (crash between step 3 and step 8)

**Required property, satisfied by construction**: a retry must resume posting the *same* frozen confirmation and must not create a second receipt or movement. Recovery re-enters at step 4 of §12 (recomputing `confirmationKey`) — it never re-runs step 2's advisory read or step 3's `begin_purchase_capture_confirmation` transition, because by the time a session reaches `confirming` that authoritative check has already passed once and the transition has already committed; recovery is only ever finishing steps 4-9, never re-deciding whether to start.

- Step 6's idempotency (`confirmationKey` unique per receipt, §2.2) means retrying step 6 after a crash either replays the existing confirmation or is a no-op if it already succeeded — it can never create a second receipt.
- Step 7's idempotency (`dedupeKey` derived from the *confirmed* payload's hash, §2.3) means retrying step 7 either replays the existing movement or is a no-op if it already succeeded — it can never create a second movement.
- **Recovery trigger**: the same cron sweep proposed in §8.2 (or a dedicated companion route — implementation detail for Slice C) additionally scans `purchase_capture_sessions WHERE status = 'confirming' AND updated_at < now() - interval '1 minute'` and re-runs steps 4-9 exactly as above, using the same deterministic `confirmationKey`. No new column is needed to "remember" the key, because it is a pure function of `opened_line_event_id`, which is already immutable and stored.
- **What the user sees during retry**: nothing new is sent unless/until the sequence reaches step 9 — a crash mid-sequence produces no visible LINE message (the last message the user saw was the `awaiting_confirmation` preview or a transient "กำลังยืนยัน..." ack); the eventual success message (or, after some bounded number of cron sweeps, an operator-visible stuck notice — **OWNER DECISION REQUIRED**, §24, on the exact bound and escalation path) arrives once recovery completes, delivered part-by-part via the `posted_success`/`stuck_escalation` notification's own claim-and-send parts, each with its own `retry_key` (§18).
- **When the session becomes terminal**: only in step 8, after `postResult` is confirmed non-error (whether freshly posted or replayed) — never earlier, so a crash before step 8 leaves the session correctly non-terminal and eligible for the recovery sweep.
- **Movement ID persistence/rediscovery**: written to the session row in step 8 on success; if it is not yet known (crash before step 8 on this attempt), it is *rediscovered*, not regenerated, by calling `postPurchaseReceipt` again — the RPC's own dedupe lookup (§2.3, keyed on `dedupe_key`/`(source_document_type, source_document_id)`) returns the already-existing `movementId` with `replayed:true`, which the recovery path then persists onto the session row it was missing from.
- **Inventory balance verification**: because `inventory_balances` is a derived `SUM(signed_quantity)` view (§2.3), no separate verification step is needed or possible to get "out of sync" — the balance reflects whatever movement lines actually exist, which posting's own idempotency already guarantees is exactly one set per receipt.

### 12.2 Atomic draft replacement (`ตรวจใบซื้อใหม่`)

**PROPOSED.** This replaces an earlier two-step design (application `saveDraft`, then a separate RPC to record the new revision on the session) that left a window between the two calls in which a concurrent `ยืนยันซื้อ` could observe an old revision, or in which an application crash between the two calls could leave the receipt replaced but the session still pointing at the old revision. `replace_purchase_capture_draft(p_session_id, p_expected_generation, p_expected_receipt_id, p_expected_draft_revision, p_source_type, p_source_id, p_sender_line_user_id, p_draft_payload, p_preview_payload_texts)` closes that window by doing everything in one transaction (§16.4):

```
Application (no DB writes):
1. Read the session's original, unchanged durable ingest set (§8) via
   get_purchase_capture_finalize_candidate — the same candidate the original
   finalize used, never re-derived from anything that could have drifted.
2. Run the unchanged pure parser (§9.1 steps 1-4) and identity resolution
   (§9.1 step 5) against the CURRENT registry state, producing a complete
   draft payload (p_draft_payload) — the same shape saveDraft() would have
   taken directly.
3. Render the preview as an ordered array of message texts from that same
   computed result (p_preview_payload_texts — one string per LINE message
   the preview needs, usually one, §16.3, §18) — in memory, no DB write yet.

replace_purchase_capture_draft (one RPC call, one transaction):
4. Lock purchase_capture_sessions FOR UPDATE — session first, always.
5. Re-check source_type/source_id/sender_line_user_id/session_generation
   match; refuse ownership_mismatch/generation_mismatch otherwise.
6. Re-check status = 'awaiting_confirmation'; refuse invalid_state otherwise
   — this is the "confirmation already won the race" outcome (§12), and it
   is checked BEFORE the receipt is touched at all, so a losing recheck
   never mutates anything.
7. Re-check session.receipt_id = p_expected_receipt_id AND
   session.draft_revision = p_expected_draft_revision under the lock;
   refuse stale_revision otherwise.
8. Lock the referenced purchase_receipts row FOR UPDATE — receipt second,
   never before the session.
9. Re-check receipt.status = 'draft' and its draft_revision still matches;
   refuse receipt_not_draft/stale_revision otherwise.
10. Apply the full receipt/item replacement by invoking 0052's own
    upsert_purchase_receipt_draft validation/upsert logic as an internal
    step of this same transaction (a plain SQL function call, not a
    separate RPC round-trip) — every 0052 domain-validation, numeric-
    envelope, and identity rule still applies unmodified; nothing here
    bypasses it.
11. Read back the new draft_revision that step 10 produced.
12. UPDATE the already-locked session row: draft_revision = the new value
    (receipt_id unchanged — same document, §6.3).
13. Create the new preview_ready outbox part set (session_id,
    'preview_ready', new draft_revision, p_preview_payload_texts) — one
    row per array element, one retry_key per row — via the same atomic
    multipart-creation logic used elsewhere (§16.3, §18.3) — which, for
    this kind, also supersedes any older, still-unclaimed
    ('pending'/'failed') preview_ready parts for this session in the same
    statement, deliberately leaving any part already 'sending' alone
    (§18.5).
14. Commit. Steps 10-13 either all land or none do — Postgres transaction
    atomicity, not application-level coordination, is what guarantees this.
```

**Required race outcomes** (§14 has the full table): if a concurrent `begin_purchase_capture_confirmation` locks the session first and commits the transition to `confirming`, this call's step 6 sees `status <> 'awaiting_confirmation'` and refuses `invalid_state` — the receipt is never touched, so "no flow may modify a receipt after its session has entered `confirming`" holds by construction. If this call locks the session first and commits, a concurrent `begin_purchase_capture_confirmation` built against the old revision sees the mismatch at its own step 3d and refuses `stale_revision` — the session never enters `confirming` against stale content. Because steps 10-12 are one transaction, `session.draft_revision` and the attached receipt's actual revision can never disagree, and an application crash between "the call was made" and "the response was received" cannot leave a replaced receipt unattached to its session — the call either committed everything or nothing.

**One honestly-stated residual gap**: unlike `confirm`/`postPurchaseReceipt` (§2.2/§2.3), `replace_purchase_capture_draft` does not carry its own caller-supplied idempotency key — a literal retry of the exact same call after an *ambiguous* network failure (the transaction committed, but the app never received the response) will find `session.draft_revision` already advanced past `p_expected_draft_revision` and refuse `stale_revision`. This is a safe failure mode (refusal, not corruption or a duplicate write), and the operator-visible fix is simply to re-check the (now up-to-date) preview — but it is not the same fully-idempotent-under-retry guarantee the confirm/post RPCs have. **OWNER DECISION REQUIRED** in §24 only if this is judged insufficient; this document's default is that it is, since the failure mode is a clean refusal, never silent data loss.

---

## 13. Idempotency-key table

| Key | Constructed as | Scope | Enforced by |
|---|---|---|---|
| `line_event_id` (inbound) | LINE's own `webhookEventId` | Global, per raw LINE delivery | `raw_messages.line_event_id UNIQUE` (§2.5, CONFIRMED) |
| `purchase_capture_session_ingests.line_event_id` | Same LINE event id | Per purchase-capture ingest | New `UNIQUE(line_event_id)` (§8, PROPOSED, mirrors `0047:141`) |
| `documentKey` | `opened_line_event_id` (§6.3) | Per purchase document, namespace `line-text` | `0052`'s `(document_namespace, document_key)` uniqueness + source-binding fail-closed check (§2.2, CONFIRMED) |
| `confirmationKey` | `'purchase-capture:v1:' \|\| opened_line_event_id` (§12) | Per receipt confirm attempt | `purchase_receipts.confirmation_key UNIQUE` (§2.2, CONFIRMED) |
| `p2c_dedupe_key` | `'purchase-receipt-confirmation:v1:' \|\| receipt_id \|\| ':' \|\| confirmation_hash` (§2.3, exact quote from `0052:1428`) | Per ledger posting attempt | `inventory_movements.dedupe_key UNIQUE` + source-posting partial unique index (§2.3, CONFIRMED) |
| `(session_id, notification_kind, notification_version, part_index)` | E.g. `(session, 'preview_ready', draft_revision, 0)`, `(session, 'posted_success', movement_id, 0)`, `(session, 'stuck_escalation', escalation_version, 0)`, and `part_index 1, 2, ...` for any notification that needs more than one LINE message (§18) | Per **physical** LINE push request — a distinct row, a distinct immutable `retry_key`, and a distinct immutable `payload_text`, for every message that must actually be sent; the logical notification `(session_id, notification_kind, notification_version)` groups its ordered part rows but is never itself a row | New `purchase_capture_notifications` `UNIQUE(session_id, notification_kind, notification_version, part_index)`, with a server-computed `payload_hash` guarding against a same-identity/different-content call (`notification_identity_conflict`, §16.3, §16.4, §18, PROPOSED) |
| `(receipt_id, draft_revision)` at recheck time | Passed by the caller, re-verified against the locked session AND the locked `purchase_receipts` row (§12.2 steps 6-9) | Per recheck attempt — `replace_purchase_capture_draft`'s own optimistic-concurrency + ownership guard, symmetric to the confirm-gate's | `replace_purchase_capture_draft`'s in-transaction re-check under `FOR UPDATE` (§12.2, §16.4, PROPOSED) — authoritative, not an application-side read, and applied *before* the receipt is touched |
| `session_generation` | `gen_random_uuid()` at session open | Per live session lifetime; identity/ownership re-check only — **never** reused as a push retry key | Session row uniqueness + `p_expected_generation` re-check on every RPC (§6.4, PROPOSED, mirrors `0047`) |
| `ingest_revision`/`ingest_set_hash` | Monotonic admission counter / SHA-256 over ingest tuples sorted by `(line_timestamp_ms, line_event_id)` (§8.2) | Per finalize attempt — concurrency guard only, never document order (§8.2, §9.1) | Optimistic-concurrency check inside the finalize RPC (§8.3, PROPOSED, mirrors `0047:1085-1092`) |
| `(receipt_id, draft_revision)` at confirm time | Passed by the caller, re-verified against the locked session AND the locked `purchase_receipts` row (§12 step 3) | Per confirm attempt — the confirm-gate's own optimistic-concurrency + ownership guard | `begin_purchase_capture_confirmation`'s in-transaction re-check under `FOR UPDATE` (§12, §16.4, PROPOSED) — authoritative, not an application-side read |

---

## 14. Failure and recovery table

| Failure | Detection | Recovery |
|---|---|---|
| LINE webhook redelivers an already-admitted event | `line_event_id` unique-violation inside `admit_purchase_capture_event` | RPC returns the existing ingest row idempotently; no duplicate content, no error surfaced to the user |
| Concurrent webhook requests for two events in the same session | `SELECT ... FOR UPDATE` on the session row inside the admit RPC | Serialized by the row lock; second request waits, then proceeds against the now-current `ingest_revision` |
| Messages arrive out of HTTP processing order | `ingest_ordinal`/`ingest_revision` record admission order only; the parser adapter independently sorts the finalize candidate by `(line_timestamp_ms, line_event_id)` before assigning `chunkOrdinal` (§8.2, §9.1) | Parser adapter (§9) always derives `chunkOrdinal` from the sorted array, never from admission order or request-arrival order, so arrival order is irrelevant to the result |
| Close message arrives before an earlier item request finishes | Close sets `close_event_timestamp_ms` from its own LINE timestamp; the in-flight item, once it lands, is checked against that boundary, not against wall-clock "did close already happen" | If the item's own timestamp is before the close boundary, it is still admitted (quiet window exists precisely for this); the finalize RPC's hash re-check (§8.3) additionally refuses to finalize on stale state |
| `ยืนยันซื้อ` sent while a blocking blocker exists | `begin_purchase_capture_confirmation`'s own authoritative re-evaluation of the locked receipt/items state (§12 step 3g) — never the application's advisory read | Refused: session stays `awaiting_confirmation`, no `confirm()` call, reply explains the whole receipt is waiting; staff fix the registry and send `ตรวจใบซื้อใหม่` (§11.3) |
| **Race: `ตรวจใบซื้อใหม่` (`replace_purchase_capture_draft`) commits its new `draft_revision` while a concurrent `ยืนยันซื้อ` is in flight against the old one** | `begin_purchase_capture_confirmation` locks the session first and re-checks `receipt_id`/`draft_revision` under that lock (§12 step 3d) | If replace's commit lands first: confirm's RPC call sees the mismatch and refuses `stale_revision` — session stays `awaiting_confirmation`, no partial transition, no confirm() call. The stale confirm attempt must be retried by the caller against the new preview |
| **Race: `ยืนยันซื้อ` transitions the session to `confirming` while a concurrent `ตรวจใบซื้อใหม่` (`replace_purchase_capture_draft`) is in flight** | `replace_purchase_capture_draft` locks the session first and re-checks `status = 'awaiting_confirmation'` under that lock, *before touching the receipt at all* (§12.2) | If confirm's commit lands first: the replace call sees `status = 'confirming'` and refuses `invalid_state` immediately — the receipt is never modified, so a session that has already moved on can never have its confirmed-against draft silently changed underneath it. Both RPCs lock the session before anything else, in the same order, so this is a clean win/lose outcome, never a deadlock |
| Application crash between `replace_purchase_capture_draft`'s commit and the app receiving its response | The RPC is one transaction — receipt replacement and session `draft_revision` update either both landed or neither did (§12.2) | No recovery action is needed for correctness (there is no partial state to repair); if the app cannot tell whether its call succeeded, a naive retry with the same `p_expected_draft_revision` is refused `stale_revision` (safe, not silent data loss) — the operator simply re-checks the now-current preview and, if still needed, sends `ตรวจใบซื้อใหม่` again, which reads fresh state and succeeds correctly (§12.2's stated residual limitation) |
| Repeated confirmation (`ยืนยันซื้อ` sent twice after blockers already cleared) | `confirmationKey` uniqueness (§2.2) | Second call replays the frozen snapshot, `replayed:true`, no new receipt |
| Repeated `ตรวจใบซื้อใหม่` (sent twice, registry unchanged between calls) | Each call is its own `replace_purchase_capture_draft` transaction against the same `documentKey` (§2.2, §12.2) | Second call re-saves identical content as a new `draft_revision` (0052's full-replace is content-driven, not skipped just because nothing changed); a new `preview_ready` outbox part set is created for that new revision and supersedes the previous one's unclaimed parts, so staff only ever see the latest preview as deliverable, never a stale duplicate |
| Database retry (any RPC call retried by the client after a network timeout, actual server-side success) | Every mutating RPC in this design is idempotent under its own key (§13), except `replace_purchase_capture_draft`, which is safe-but-not-idempotent under retry (see the crash row above) | Retry is safe by construction for every idempotent RPC; no special client-side dedup needed beyond calling the same RPC again with the same key |
| Application failure after receipt confirmation but before ledger posting | Session stuck in `confirming` past a threshold | Cron sweep resumes posting using the same deterministic `confirmationKey`/derived `dedupeKey` (§12.1) |
| LINE reply/push failure on one part | `pushLineMessage`'s existing 409/retry-key handling (§2.5, reused unmodified); `record_purchase_capture_notification_part_attempt` releases the part's lease back to `'failed'` (§18.4) | Cron (or the next claim call) claims that same part again via `claim_next_purchase_capture_notification_part` — same `retry_key`, same stored `payload_text`, every time, because neither changes across claims of the same row; earlier, already-delivered parts of the same logical notification are never re-sent, and a different logical notification (different `notification_kind`/`notification_version`) always has its own rows and keys, so it can never be treated as a retry of this one |
| Worker crashes after claiming a part but before recording the outcome | `claim_expires_at` lease elapses with the part still `'sending'` (§16.3, §18.4) | The next `claim_next_purchase_capture_notification_part` call for that identity sees the expired lease and reclaims the same row (same `retry_key`, fresh `claim_token`) — no part is ever permanently stranded in `'sending'` |
| `create_purchase_capture_notification_parts` called with a part count or per-part content that conflicts with an already-inserted set for the same identity (includes the case of a previously left partially-inserted set) | Existing row count/`payload_hash` sequence compared against the new call's (§16.3, §18.3) | Refused `notification_identity_conflict`; nothing inserted, nothing overwritten — a partial or conflicting set is never silently completed or repaired by a later call |
| A new preview supersedes an undelivered old one (`ตรวจใบซื้อใหม่` runs before the previous preview push succeeded) | Creating the `preview_ready` row for the new `draft_revision` atomically sets `delivery_status = 'superseded'` on every other still-`'pending'`/`'failed'` `preview_ready` row for the same session, in the same transaction as the draft replacement itself (§12.2, §16.4, §18) — a database-enforced marker, not an application convention | The old row's key is never reused for the new content, so LINE cannot 409-suppress the updated preview; the old row is marked `'superseded'` and is never again selected by cron or sent by any sender that re-checks its status before delivery (below) |
| A part is superseded while still `'pending'`/`'failed'` (not yet claimed) | Supersession only ever targets `'pending'`/`'failed'` parts of an older `preview_ready` version (§18.5) | It is never claimable again — the claim query excludes `'superseded'` rows unconditionally |
| **A part is already claimed (`'sending'`) at the moment a newer preview version supersedes its siblings** | Supersession deliberately does not touch `'sending'` rows (§18.5) — this is a stated, accepted V1 limitation, not a guaranteed-impossible race | The claimed part **may still reach LINE** after the newer version already exists in the database; this cannot cause a stale confirmation or an incorrect posting, because `begin_purchase_capture_confirmation` (§12) binds to the receipt's current, locked `draft_revision`, never to any in-flight preview text — at worst, staff briefly see an outdated preview message before the new revision's own parts are delivered under their own keys |
| `create_purchase_capture_notification_parts` called twice for the same identity with genuinely different content | Server-computed `payload_hash` comparison, per `part_index`, against the already-stored rows (§16.4, §18.3) | The second call is refused `notification_identity_conflict`; the stored `payload_text`/`payload_hash` are never overwritten. This should not happen under correct application code (each identity is only ever constructed from one deterministic render), so a conflict here indicates an application bug, not a normal operational case |
| Staff accidentally opens another purchase while one is active | Partial unique index (§6.2) | `open` RPC returns `already_open`; webhook replies with the existing session's state instead of opening a second one |

---

## 15. Cancellation/correction boundaries

**PROPOSED**, using only what §2.2 already provides — no new authoritative contract is invented, per the task's explicit instruction.

- **Before confirmation** (`open`/`closing`/`awaiting_confirmation`): `ยกเลิกซื้อ` transitions the session to `cancelled` and, if a draft was already saved (§9), leaves the draft row in place with `status` unaffected by this document's session layer — the draft itself was never designed to be deleted (§2.2 shows no delete RPC), so "cancel" at the session level means "do not proceed to confirm," not "erase the draft." This is safe because an unconfirmed draft has no ledger effect whatsoever (§2.3's posting RPC only ever operates on confirmed receipts).
- **After confirmation, before posting** (`confirming`): **not cancellable.** Once `PurchaseReceiptService.confirm` has committed, the receipt is immutable (§2.2) — this document does not propose a cancel-after-confirm path, matching the task's explicit "confirmed receipt is immutable" constraint.
- **After posting**: **not cancellable, and no "cancel after posting" UX is promised**, per the task's explicit instruction. The only correction path that exists today is a *new* receipt declaring `supersedesReceiptId` (§2.2) — this document notes that path exists and is reusable, but designing the operational LINE UX for issuing a correction is out of scope for this slice (it would need its own preview/confirm flow analogous to §11-§12, applied to a correction document instead of an initial one).
- **Atomic document void + ledger reversal does not currently exist** as a single contract — `void_purchase_receipt` (P2B) and `reverse_inventory_movement` (P2C) are two separate RPCs (§2.2, §2.3) with no proof in this repo that calling both in sequence is safe/atomic for an already-posted receipt. This document does not propose using them together for this feature; if a future "undo a posted purchase" capability is wanted, it needs its own design pass explicitly reconciling the two RPCs' preconditions, which is out of scope here.

---

## 16. Proposed schema and RPC surface

**PROPOSED.** All additive, forward-only, matching Production's actual timestamped migration convention (§3). **Migration `0054` is not used (reserved for P2D).** Filenames follow the `YYYYMMDDHHMMSS_description.sql` pattern Production's ledger actually records for everything after `0050` — proposed identifiers (illustrative; the implementation PR must generate real current timestamps, not reuse these):

- `20260805000000_purchase_capture_sessions.sql` (Slice A — tables + Slice A RPCs only, §21)
- `20260805010000_purchase_capture_draft_finalization.sql` (Slice B — `finalize_purchase_capture_session`, `replace_purchase_capture_draft`, both product/unit registry tables, the `purchase_capture_notifications` outbox table, and its three general-purpose RPCs, §21)
- `20260805020000_purchase_capture_confirm_post.sql` (Slice C — `begin_purchase_capture_confirmation`, `mark_purchase_capture_session_posted`; no new tables, reuses Slice B's outbox for `posted_success`/`stuck_escalation`, §21)

No changes to `0052`/`0053` are proposed — both are reused exactly as they exist today.

### 16.1 Tables (Slice A)

- **`purchase_capture_sessions`** — mirrors `physical_inventory_sessions` (§2.4) field-for-field where applicable: `id`, `source_type` (CHECK `user|group|room`), `source_id`, `sender_line_user_id`, `opened_line_event_id` (UNIQUE, NOT NULL), `session_generation` (`gen_random_uuid()`), `status` (CHECK IN `'open','closing','awaiting_confirmation','confirming','posted','failed_closed','cancelled'`), `close_event_timestamp_ms`, `close_quiet_until`, `close_deadline_at`, `ingest_revision` (`DEFAULT 0`), `receipt_id` (nullable FK → `purchase_receipts(id)`, **stays NULL through all of Slice A**, first set in Slice B's `finalize_purchase_capture_session`), `draft_revision` (nullable, mirrors `receipt_id` — first set in Slice B, updated by every later `ตรวจใบซื้อใหม่`), `movement_id` (nullable, set once posting succeeds, §12.1 — first set in Slice C), `fail_reason`, `warnings jsonb`, `created_at`, `updated_at`. **No retry-key columns live on this table** — outbound-notification identity is owned entirely by `purchase_capture_notifications` (§16.3, §18), so a session row never needs to know how many logical notifications it has produced or which of them were delivered.
  - Constraints: `UNIQUE(source_id, sender_line_user_id, session_generation)`; partial unique `purchase_capture_sessions_one_active_per_sender_idx ON (source_id, sender_line_user_id) WHERE status IN ('open','closing','awaiting_confirmation','confirming')` (§6.2); a terminal-state immutability trigger mirroring `physical_inventory_forbid_terminal_session_mutation` (`0047:332-373`). The `status` CHECK permits all seven values from Slice A's migration (schema is defined once); which RPC can actually *write* `awaiting_confirmation`/`posted` is a Slice B/C code question, not a Slice A schema question (§21).
- **`purchase_capture_session_ingests`** — mirrors `physical_inventory_session_ingests`: `id`, `session_id` (FK), `session_generation`, `line_event_id` (UNIQUE globally), `line_message_id`, `line_timestamp_ms`, `ingest_ordinal`, `raw_text`, `raw_message_id` (FK → `raw_messages`), `created_at`. Append-only (forbid-mutation trigger), `UNIQUE(session_id, ingest_ordinal)`. **`ingest_ordinal` is admission-order/audit-only** — it records the sequence the DB happened to admit rows in and is never read by the parser adapter, which instead derives its own order by sorting on `(line_timestamp_ms, line_event_id)` at query time (§8.2, §9.1). It is retained here purely as an audit/debugging aid (e.g. "was this event admitted before or after that one, regardless of its LINE timestamp"), not because anything downstream depends on it.
- **`purchase_capture_lifecycle_events`** — mirrors `physical_inventory_lifecycle_events`: append-only audit of every state transition, `id`, `session_id`, `event`, `detail jsonb`, `created_at`.

### 16.2 Tables (Slice B)

- **`purchase_intake_product_registry`** and **`purchase_intake_unit_alias_registry`** — as specified in §10.3 (two tables, not one; the unit registry is queried once for the quantity unit and once for the price unit per item).

### 16.3 Table (Slice B) — durable notification outbox, one row per physical LINE push

**PROPOSED**, replacing the earlier per-session retry-key columns (§18), and further corrected here from an earlier draft of this table that stored one row per **logical** notification with a `payload_snapshot jsonb` array of every message in it. That shape was wrong: the repo's `pushLineMessage()` (§2.5) sends exactly one text message per HTTP request and `X-Line-Retry-Key` is scoped to that one request, so a multi-message preview stored as one row with one `retry_key` would have looped the same key across several distinct pushes — the first message would be accepted and every later message in the loop would be treated by LINE as a retry of the *first* request, and could 409 without ever being delivered. Introduced in **Slice B**, not Slice C — Slice B is the first slice that produces a `preview_ready` notification (from `finalize_purchase_capture_session` and `replace_purchase_capture_draft`), so the outbox and its general-purpose RPCs must exist there; Slice C only adds new *callers* (`posted_success`, `stuck_escalation`), not new schema (§21).

**Logical notification versus physical part — the two concepts this table now keeps separate:**

- A **logical notification** is identified by `(session_id, notification_kind, notification_version)` exactly as before (§13, §18) — "the preview for draft revision 7," "the posted-confirmation for movement X." It is never itself a row.
- A **physical part** is exactly one row, and exactly one `pushLineMessage()` (or reply-API send) call. One row = one LINE message = one immutable `retry_key`, never more. A logical notification that needs three LINE messages to render (a long preview, chunked the same way this repo already chunks other long reports) is three rows, three `retry_key`s, sent in order.

```sql
CREATE TABLE public.purchase_capture_notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES purchase_capture_sessions(id),
  notification_kind     text NOT NULL CHECK (notification_kind IN ('preview_ready','posted_success','stuck_escalation')),
  notification_version  text NOT NULL,
  part_index            integer NOT NULL CHECK (part_index >= 0),
  part_count            integer NOT NULL CHECK (part_count >= 1),
  payload_text          text NOT NULL,             -- exact Unicode text of THIS ONE message
  payload_hash          text NOT NULL,              -- server-computed sha256(payload_text)
  retry_key             uuid NOT NULL DEFAULT gen_random_uuid(),  -- immutable; one push request, forever
  delivery_status        text NOT NULL DEFAULT 'pending'
                           CHECK (delivery_status IN ('pending','sending','delivered','failed','superseded')),
  claim_token            uuid,             -- set only while delivery_status = 'sending'
  claim_expires_at       timestamptz,      -- lease expiry; an expired claim is reclaimable
  attempt_count          integer NOT NULL DEFAULT 0,
  last_attempt_at        timestamptz,
  delivered_at           timestamptz,
  superseded_at          timestamptz,
  last_error             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, notification_kind, notification_version, part_index)
);
```

- **Identity**: the logical notification remains `(session_id, notification_kind, notification_version)` (§13); its physical delivery is the ordered set of rows sharing that triple, one per `part_index`, `0`-based (fixed and documented here — never renumbered, never 1-based anywhere else in this design). `part_count` is copied onto every row of the set at creation time and must be identical across all of them — this is a creation-time invariant enforced by the RPC that inserts the set (§16.4), not a per-row `CHECK`, because no single row's own columns can see its siblings.
- **One row, one retry key, one push request — no exceptions.** No row's `payload_text` is ever an array or ever requires more than one `pushLineMessage()` call to deliver. This is what closes the problem this section opened with.
- **Exact payload, not just a hash**: `payload_text` holds the literal text of that one message — `payload_hash` exists purely to detect a same-identity/different-content conflict cheaply (§18); it is never itself resent.
- **`delivery_status = 'superseded'`** is the authoritative "do not send this part" marker, set on `preview_ready` parts only, when a newer `preview_ready` version's parts are created for the same session (§18) — and, honestly, only on parts still `'pending'`/`'failed'` at that moment; a part already `'sending'` (claimed by a worker, mid-flight to LINE) is deliberately left alone rather than superseded out from under an in-progress send (§18's stated V1 limitation). A superseded row is never deleted and never leaves `'superseded'`.
- **`delivery_status = 'sending'` plus `claim_token`/`claim_expires_at`** implement a claim/lease: a worker must claim a part (§16.4's claim RPC) before sending it, which atomically moves it `pending`/`failed` → `sending` and stamps a fresh `claim_token`/lease expiry — the row's `retry_key` never changes across claims of the same row, so a stolen/re-claimed lease still reuses the identical LINE retry key. No database transaction stays open during the actual outbound LINE call — the claim commits, then the network call happens, then a second, separate call records the outcome (§16.4, §18).
- **Not append-only**: unlike `purchase_capture_session_ingests`/`purchase_capture_lifecycle_events` (§16.6), `delivery_status`/`claim_token`/`claim_expires_at`/`attempt_count`/`last_attempt_at`/`delivered_at`/`superseded_at`/`last_error`/`updated_at` are mutated in place — the row's identity (`session_id`, `notification_kind`, `notification_version`, `part_index`, `retry_key`) and its `payload_text`/`payload_hash` are what stay immutable, never the whole row.

### 16.4 RPCs (`SECURITY DEFINER`, `search_path = public, extensions, pg_temp`, `service_role`-EXECUTE-only, mirroring §2.2/§2.4's exact grant pattern), grouped by the slice that introduces them

**Slice A** — session lifecycle up to a stable, eligible-for-finalize `closing` state; no parser, no draft, no `awaiting_confirmation`:

- `open_purchase_capture_session(p_source_type, p_source_id, p_sender_line_user_id, p_opened_line_event_id, p_line_timestamp_ms, p_raw_text, p_line_message_id, p_raw_message_id)` — mirrors `open_physical_inventory_session`; returns `already_open` if the partial unique index would be violated.
- `admit_purchase_capture_event(p_session_id, p_expected_generation, p_line_event_id, p_line_timestamp_ms, p_kind, p_raw_text, p_line_message_id, p_raw_message_id)` — mirrors `admit_physical_inventory_event`; handles `item`/`costs` admits and the multi-message close-boundary-setting admit (`p_kind = 'close'`).
- `close_purchase_capture_open_event(p_session_id, p_expected_generation, p_opened_line_event_id)` — **new (§8.4)**; sets the close boundary from the *already-persisted* opening ingest row for the one-message (Header+Items+Costs+Close-in-a-single-message) case, without inserting a second ingest row for the same `line_event_id`; idempotent on redelivery (the boundary fields are immutable once set, so a repeat call observes the existing boundary rather than erroring).
- `get_purchase_capture_finalize_candidate(p_session_id, p_expected_generation)` — mirrors `get_physical_inventory_finalize_candidate`; returns the current ingest set (rows only — ordering for parsing is the caller's job per §8.2/§9.1) + revision + hash + quiet/deadline eligibility flags, for the caller to run the parser adapter (§9) against. **Slice A's own tests exercise this RPC directly and assert eligibility is computed correctly; Slice A does not call any RPC that writes `awaiting_confirmation`.**
- `cancel_purchase_capture_session(p_session_id, p_expected_generation)` — any of `open/closing` → `cancelled` in Slice A (the `awaiting_confirmation` branch of this same RPC becomes reachable once Slice B exists, but the RPC signature and CHECK-guarded transition table are defined once, here).

**Slice B** — parser adapter, identity resolution, real draft persistence, and the notification outbox become available; this is the *only* slice that may write `awaiting_confirmation`:

- `finalize_purchase_capture_session(p_session_id, p_expected_generation, p_expected_ingest_revision, p_expected_ingest_hash, p_assembly_status, p_receipt_id_or_null, p_draft_revision_or_null, p_preview_payload_texts_or_null, p_fail_reason_or_null)` — mirrors `finalize_physical_inventory_session`; transitions `closing` → `awaiting_confirmation` **only when the caller supplies a real, non-null `receipt_id`/`draft_revision` already written by a preceding `upsert_purchase_receipt_draft` call** (§2.2) — the RPC does not accept a stub/placeholder outcome; a `NULL` receipt_id is only valid on the `→ failed_closed` branch. On the `awaiting_confirmation` branch, in the same transaction, also creates the session's first `preview_ready` outbox part set from `p_preview_payload_texts_or_null` (an ordered `text[]`, one element per LINE message the rendered preview needs — usually one, occasionally more for a long preview; via the same internal logic `create_purchase_capture_notification_parts` uses, §16.3) — there is nothing to supersede yet, since this is the document's first preview. This is the RPC that Slice A's schema defines space for but Slice A never calls with an `awaiting_confirmation` target (§21).
- `replace_purchase_capture_draft(p_session_id, p_expected_generation, p_expected_receipt_id, p_expected_draft_revision, p_source_type, p_source_id, p_sender_line_user_id, p_draft_payload, p_preview_payload_texts)` — **new (§11.3, §12.2), replaces the earlier two-step `saveDraft()` + `recheck_purchase_capture_draft()` design**. One RPC, one transaction: locks the session **first**, `FOR UPDATE`; refuses `invalid_state` if `status <> 'awaiting_confirmation'` (the "confirmation already won the race" outcome, §12) **before the receipt is touched at all**; refuses `stale_revision` if `receipt_id`/`draft_revision` don't match under the lock; locks the referenced `purchase_receipts` row **second**; applies the full replacement by invoking `0052`'s own `upsert_purchase_receipt_draft` validation/upsert logic internally (no bypass of any `0052` rule); records the resulting new `draft_revision` back onto the already-locked session row; creates the new `preview_ready` outbox part set from the ordered `p_preview_payload_texts`, which — for this kind — also supersedes every older, still-unclaimed (`'pending'`/`'failed'`) `preview_ready` part for the same session in the same statement, deliberately leaving any part already `'sending'` alone (§16.3, §18); commits all of it together, or none of it. `awaiting_confirmation` → `awaiting_confirmation` only (a self-transition, not a new state). Full step-by-step contract: §12.2.
- `create_purchase_capture_notification_parts(p_session_id, p_notification_kind, p_notification_version, p_payload_texts text[])` — **new (§18), introduced here in Slice B because `finalize_purchase_capture_session`/`replace_purchase_capture_draft` are its first two callers; replaces the earlier single-row `get_or_create_purchase_capture_notification`**. Atomically creates the complete, dense, ordered part set for one logical notification — one row per array element, `part_index` = the element's zero-based array position, `part_count` = `array_length(p_payload_texts, 1)` on every row, each with its own server-computed `payload_hash = sha256(payload_text)` and its own freshly generated `retry_key`. Because every row is derived directly from array position, the set is dense by construction — there is no way to call this RPC and produce a gap.
  - **No pre-existing rows for this identity** → insert all `part_count` rows in one statement; for `notification_kind = 'preview_ready'`, in the same transaction also supersede every other `preview_ready` part for this session still `'pending'`/`'failed'` (§16.3, §18) — never a part currently `'sending'`.
  - **Pre-existing rows for this identity, and their count and every `payload_hash` (in `part_index` order) exactly match this call's** → idempotent replay; return the existing rows unchanged, insert nothing, supersede nothing again (supersession already happened, once, at original creation).
  - **Pre-existing rows exist but the count differs, or any `payload_hash` differs** → refuse `notification_identity_conflict` and change nothing — this covers both "genuinely different content" and "a previous call for this identity was left partially inserted," treating a partial set exactly as a conflict rather than silently completing it.
  - Returns the full ordered row set (`id`, `part_index`, `part_count`, `retry_key`, `delivery_status`, `payload_text` per row).
- `claim_next_purchase_capture_notification_part(p_session_id, p_notification_kind, p_notification_version, p_claim_lease_seconds integer DEFAULT 60)` — **new (§18)**. The **only** sanctioned way application code selects a part to send — no caller ever picks an arbitrary `'pending'` row itself. In one short transaction: locks the candidate row `FOR UPDATE`, where the candidate is the row for this identity with the **smallest `part_index`** whose `delivery_status` is not `'delivered'` and not `'superseded'`. If that candidate is `'pending'` or `'failed'`, or is `'sending'` with an **expired** `claim_expires_at` (lease recovery), claim it: set `delivery_status = 'sending'`, `claim_token = gen_random_uuid()`, `claim_expires_at = now() + p_claim_lease_seconds`, and return `id`, `part_index`, `part_count`, `retry_key`, `payload_text`, `claim_token`. If the candidate is `'sending'` with an unexpired lease (another worker already has it), or no eligible candidate exists at all (every part `'delivered'`/`'superseded'` — the logical notification is complete, or every remaining part is superseded), return "nothing eligible right now" rather than blocking or picking a different part — this is what makes `part N eligible only when every earlier part is delivered` true by construction, since the query can never skip past an undelivered lower `part_index`. The transaction commits immediately after the claim; the actual `pushLineMessage()`/reply call happens afterward, outside any open database transaction.
- `record_purchase_capture_notification_part_attempt(p_notification_part_id, p_claim_token, p_error_or_null)` — **new (§18)**; requires `claim_token` to match the row's current, unexpired claim (refuses otherwise — the caller's lease was already stolen or the row moved on, and this call must not clobber whoever holds it now). On a valid match: increments `attempt_count`, sets `last_attempt_at = now()`/`last_error`, and releases the lease by moving `delivery_status` from `'sending'` back to `'failed'` and clearing `claim_token`/`claim_expires_at` immediately — the part becomes reclaimable right away rather than only after the lease naturally expires.
- `mark_purchase_capture_notification_part_delivered(p_notification_part_id, p_claim_token)` — **new (§18)**; requires `claim_token` to match the row's current, unexpired claim, exactly as the attempt RPC does. Sets `delivery_status = 'delivered'`, `delivered_at = now()`, clears `claim_token`/`claim_expires_at`. Called on a genuine LINE success **and** on a 409 that reuses the row's own `retry_key` (§18) — a stolen-and-reclaimed lease still carries the *same* `retry_key` across claims of the same row (§16.3), so a 409 from an earlier, presumed-lost attempt is still recognizable as "this part, already accepted" by whichever worker currently holds the claim. Refuses if the row is already `'superseded'` or `'delivered'`, or if `claim_token` no longer matches (someone else's lease) — a superseded or already-settled row cannot be retroactively marked delivered by a late, stale caller.

**Slice C** — the confirm-gate and posting; reuses Slice B's outbox for its own notifications, adds no new outbox schema:

- `begin_purchase_capture_confirmation(p_session_id, p_expected_generation, p_expected_receipt_id, p_expected_draft_revision, p_source_type, p_source_id, p_sender_line_user_id)` — **new, replaces the earlier `transition_purchase_capture_session_confirming` (§12 step 3)**. The **sole authoritative confirm-gate**, not an application-trusted transition: in one transaction, locks the session row `FOR UPDATE` (before the receipt — same order `replace_purchase_capture_draft` uses, so the two can never deadlock, §12), re-checks ownership/generation/status, re-checks `receipt_id`/`draft_revision` match under that lock, locks the referenced `purchase_receipts` row `FOR UPDATE`, re-checks its `status`/`draft_revision`, evaluates blocking blockers directly from the locked `purchase_receipt_items` rows per §10.3, and only transitions `awaiting_confirmation` → `confirming` if every check passes; otherwise refuses with a specific reason (`ownership_mismatch`, `generation_mismatch`, `invalid_state`, `stale_revision`, `receipt_not_draft`, `blocking_blocker_present`) and makes no change. Unlike the earlier design, **no RPC in this surface trusts an application-side blocker check** — every gate that matters is re-evaluated inside the RPC itself, under lock, against the authoritative row state.
- `mark_purchase_capture_session_posted(p_session_id, p_expected_generation, p_movement_id)` — `confirming` → `posted` (terminal), records `movement_id`. The caller separately calls Slice B's `create_purchase_capture_notification_parts(session_id, 'posted_success', movement_id, payload_texts)` (§12 step 9) — with `payload_texts` normally a single-element array, using the exact same part contract every other notification kind uses (§16.3) even though it almost always needs only one part — then claims and sends that one part via `claim_next_purchase_capture_notification_part`. `posted_success` is never subject to supersession (§18), so no special handling is needed here beyond reusing the existing general-purpose RPCs as-is.

### 16.5 RLS posture

RLS **enabled** on all six new tables (three from Slice A; two registries plus the notification outbox from Slice B), **no policies defined** — identical to `0047`'s posture (§2.4) — access exists only through the `SECURITY DEFINER` RPCs above, exactly matching the established convention.

### 16.6 Append-only/audit behavior

`purchase_capture_session_ingests` and `purchase_capture_lifecycle_events` are both forbid-mutation (insert-only) tables, mirroring `0047`'s equivalents — no update/delete path is ever needed or provided. `purchase_capture_notifications` (§16.3) is the one new table that is **not** append-only by design — its delivery-tracking columns are updated in place, never its identity columns.

### 16.7 Cleanup/retention policy

**PROPOSED**: none for V1. `physical_inventory_sessions` and its ingest ledger have no retention/purge job in the current repo (confirmed absent from `0047` and from any cron route found in §2.4's investigation) — this design follows the same precedent: terminal sessions, their ingests, and their notification rows are kept indefinitely as an audit trail, matching how `purchase_receipts`/`inventory_movements` themselves are permanent, append-only records. If retention becomes a concern later, it is a separate, feature-agnostic decision (it would apply equally to Physical Inventory's existing tables), not something this slice should solve alone.

---

## 17. Security model

**PROPOSED, matching the existing, Production-verified posture exactly (§2.2, §2.3, §2.4, §3) — no deviation.**

- **Service-role-only mutation**: every new RPC in §16.4 is callable only by `service_role`; `anon`/`authenticated` receive no grant at all (matching the confirmed absence of any such grant row on the existing tables, §3).
- **Fixed `search_path` on every `SECURITY DEFINER` RPC**: `public, extensions, pg_temp`, matching the 0052/0053 convention (confirmed in Production's `pg_proc.proconfig`, §3) rather than the older bare `public` used by 0047 — the newer convention is preferred for new code since it is what the two most recently added, most directly analogous features (P2B/P2C) actually use.
- **Revoked `PUBLIC`/`anon`/`authenticated` execution**: on both the RPCs and the tables themselves — no direct `SELECT`/DML grant beyond `service_role` `SELECT`, mirroring §2.2/§2.3's grant blocks exactly.
- **Source/sender ownership checks inside the authoritative mutation boundary**: every admit/finalize/confirm/post RPC re-verifies `(source_type, source_id, sender_line_user_id, session_generation)` under row lock, never trusting the caller's claim without a DB-side check (§6.4) — this is the same discipline `0047`/`0052` already apply.
- **The confirm-gate and the draft-replacement RPC both re-evaluate their own preconditions; neither trusts the caller.** `begin_purchase_capture_confirmation` and `replace_purchase_capture_draft` (§12, §12.2, §16.4) are the two places in this design where a wrong caller-side decision would have real consequences — an irreversibly confirmed receipt with an `UNRESOLVED` item, or a receipt silently replaced out from under a session that had already moved to `confirming`. Both share the same session-then-receipt lock order and both re-derive their gating decision from the locked row rather than accepting it as a trusted parameter: `begin_purchase_capture_confirmation` re-reads revision/ownership/blocking-blocker state; `replace_purchase_capture_draft` re-reads session status and revision before it will touch the receipt at all, then applies the replacement through `0052`'s own validated upsert rather than a bespoke write path. No other RPC in §16.4 needs this property, because none of the others gate an irreversible or exclusive-ownership transition the way these two do.
- **The notification outbox fails closed on a content mismatch.** `create_purchase_capture_notification_parts` (§16.3, §16.4, §18) never silently overwrites a stored `payload_text`/`payload_hash`, and never silently completes a partially-inserted part set — if a caller presents the same `(session_id, notification_kind, notification_version)` with a different part count or genuinely different per-part content than what is already stored, the call is refused (`notification_identity_conflict`), not merged or replaced. This protects the outbox's own core guarantee (§18): a `retry_key` always corresponds to exactly one physical LINE message, for its entire lifetime, and a logical notification's part set is never observed half-created.
- **A claim is a lease, not a grant, and is never held across a network call.** `claim_next_purchase_capture_notification_part`/`record_purchase_capture_notification_part_attempt`/`mark_purchase_capture_notification_part_delivered` (§16.3, §16.4, §18) each commit and return before the corresponding `pushLineMessage()`/reply call happens — no database transaction is ever open while waiting on LINE's network response. A claim's `claim_token` is single-use per lease window and expires automatically (`claim_expires_at`), so a worker that crashes mid-send never permanently strands a part; a later claim call simply reclaims it.
- **Replay protection before mutation**: every RPC checks its relevant unique key (§13) before performing any write, not after — a duplicate call is detected and short-circuited, never allowed to attempt-then-rollback.
- **No secrets in logs**: this design introduces no new secret material; `CRON_SECRET` (reused, §8.2) is handled exactly as the existing Physical Inventory cron route already handles it (Bearer/header comparison, never logged).
- **No client-controlled trusted labels or identities**: mirroring `0051`'s `line_menu_states_payload_no_trusted_labels` constraint (§2.6) — `productKey`, `quantityUnitKey`, and `priceUnitKey` are never taken from client-supplied "resolved" claims; all three are always derived server-side from the two registry lookups (§10.3), never trusted from the LINE message text itself beyond the raw strings used as lookup keys.
- **No direct table DML from webhook application code where an RPC owns the contract**: the webhook handler (future integration point, §2.7) calls only the RPCs in §16.4 plus the existing `PurchaseReceiptService`/`InventoryLedgerService` methods (§2.2/§2.3) — it never issues a direct `.from(...).insert/update/delete(...)` against any of the new or existing tables in this flow, matching the repo-wide convention already enforced for `purchase_receipts`/`inventory_movements` (§2.2/§2.3, confirmed zero DML grants outside `postgres`).

---

## 18. Notification delivery model

**PROPOSED, reusing existing conventions where they still fit (§2.4, §2.5) but replacing the earlier session-level retry-key columns with a durable, per-physical-message notification outbox, `purchase_capture_notifications` (§16.3), because neither a session-level key nor a single row per logical notification can safely represent delivery when one logical notification needs more than one LINE message.**

### 18.1 The problem this corrects

An earlier draft of this design stored one outbox row per logical notification, with a `payload_snapshot jsonb` array holding every message the notification needed, and one `retry_key` for the whole row. That does not match how `pushLineMessage()` (§2.5) actually works: it sends exactly one text message per HTTP request, and `X-Line-Retry-Key` is scoped to that one request. Looping over a multi-message array while reusing that single row's key would mean the first message is accepted normally and every later message in the loop is treated by LINE as a *retry of the first request* — LINE may 409 those later messages without ever delivering them. A chunked preview (or any notification that needs more than one message) could not reliably be delivered under that shape. §16.3 corrects the schema; this section corrects the delivery model built on it.

### 18.2 Logical notification versus physical part

- A **logical notification** is identified by `(session_id, notification_kind, notification_version)`, exactly as before (§13): "the preview for draft revision 7," "the posted-confirmation for movement X," "the stuck-escalation for this session." It groups content, not delivery.
- A **physical part** is one row in `purchase_capture_notifications` (§16.3), one exact `payload_text`, and one immutable `retry_key`. Delivering a logical notification means delivering every one of its parts, each via its own `pushLineMessage()`/reply call, each with its own key. `part_index` (`0`-based) fixes the order; `part_count` is the same on every row of one logical notification's part set.
- **One retry key per physical push request, always.** No row's content is ever sent across more than one HTTP request, and no HTTP request to LINE is ever made without a row (and therefore a key) behind it. This is the rule that closes §18.1's bug.

### 18.3 Multipart creation is atomic

`create_purchase_capture_notification_parts(session_id, notification_kind, notification_version, payload_texts)` (§16.3, §16.4) is called once, by whichever code path first needs the notification to exist (`finalize_purchase_capture_session`, `replace_purchase_capture_draft`, or the `posted_success`/`stuck_escalation` callers, §12/§12.2/§21) — never incrementally, never one part at a time. Given the complete ordered array of message texts to send:

- The **entire dense part set is inserted in one statement**, or nothing is — there is no code path that can commit part 1 of an intended 3-part notification without also committing parts 2 and 3 in the same transaction (§16.4).
- A repeat call with the **same identity and byte-identical per-part content** (same count, same `payload_hash` at every `part_index`) is an idempotent replay — the existing rows are returned unchanged, nothing is re-inserted, and (for `preview_ready`) supersession does not run a second time.
- A repeat call with the **same identity but a different part count, or a different `payload_hash` at any `part_index`**, is refused `notification_identity_conflict` and changes nothing — this is also how a partially-inserted set from an earlier, previously-failed call would be treated: as a conflict to refuse, never as something to silently top up.
- For `notification_kind = 'preview_ready'` specifically, a successful creation additionally supersedes, in the same transaction, every part belonging to an *older* `preview_ready` version for the same session that is still `'pending'`/`'failed'` (§18.5) — never a part that is `'sending'`.

For `posted_success`/`stuck_escalation`, the identical contract applies even though `payload_texts` is normally a single-element array — there is exactly one part-creation and part-delivery path in this design, not a single-message shortcut plus a separate multipart path.

### 18.4 Claim-and-send, and ordered recovery

Sending code — whether running synchronously inside the original webhook request, in the deferred `after()` continuation, or from the cron sweep (§8.2/§12.1) — never selects a row to send by querying `'pending'` rows directly. It always calls `claim_next_purchase_capture_notification_part(session_id, notification_kind, notification_version)` (§16.3, §16.4) first:

- The claim RPC returns the **single row with the smallest `part_index`** for that identity that is not yet `'delivered'`/`'superseded'`, atomically moving it to `'sending'` with a fresh `claim_token`/lease (§16.3), and commits before any network call is made.
- Because the query always looks at the smallest not-yet-settled `part_index`, **part N can never be claimed while any part before it is still `'pending'`/`'failed'`/actively `'sending'`** — ordered delivery is a property of the query, not a convention the caller has to remember.
- If the smallest-index candidate is already `'sending'` under an unexpired lease (another worker has it), or every remaining part is `'delivered'`/`'superseded'`, the claim RPC returns nothing to send right now — the caller simply does not send.
- After the network call: on success (or a 409 reusing this row's own `retry_key`, which — because a `retry_key` is stable across re-claims of the same row, §16.3 — still identifies "this exact part, already accepted") the caller calls `mark_purchase_capture_notification_part_delivered(part_id, claim_token)`; on failure it calls `record_purchase_capture_notification_part_attempt(part_id, claim_token, error)`, which releases the lease back to `'failed'` immediately so the next claim (this worker or another) can retry it without waiting out the full lease window. A crash between claim and either follow-up call is recovered automatically once `claim_expires_at` elapses — the next claim call for that identity sees the expired lease and reclaims the same row, same `retry_key`.
- **A failed part never causes an already-delivered earlier part to resend**, because delivered rows are permanently excluded from the claim query; **a later part never sends ahead of an earlier undelivered one**, for the same reason. The logical notification is complete exactly when every one of its non-superseded parts reads `'delivered'`.

### 18.5 Supersession, honestly

Creating a new `preview_ready` version's parts (§18.3) marks every older `preview_ready` part for the same session that is still `'pending'`/`'failed'` as `'superseded'`, in the same transaction (§16.3, §16.4) — this is the authoritative model, not a convention the application is trusted to honor.

- **Delivered historical parts are untouched** — a part already `'delivered'` never transitions to `'superseded'`; it remains a permanent, accurate audit record of what was actually sent, at the revision it was actually sent for.
- **Cron only ever selects `'pending'`/`'failed'` parts as claim candidates.** A `'superseded'` part is never claimable again, for any reason.
- **`posted_success` and `stuck_escalation` are never superseded by a preview change** — the supersession UPDATE only ever targets `notification_kind = 'preview_ready'` rows for the same session.
- **An updated preview's parts cannot be claimed before their own rows commit** — part creation happens inside the *same* transaction as the draft replacement that produced it (§12.2, §16.3), so there is no window where the database has a newer draft but the outbox still only offers the old preview's parts to claim.
- **The honest limitation, stated plainly: a part already claimed (`'sending'`) when a newer version is created is deliberately *not* superseded.** Superseding it out from under an in-flight send would create its own race (the worker could still deliver it to LINE a moment later, after the database had already disowned it, with no way to retroactively un-send it) — so instead the design accepts a narrower, better-understood one: a claimed-but-not-yet-settled old-revision part **may still be delivered to LINE** after a newer revision already exists in the database. This is a real, if narrow, time-of-check/time-of-use window between "claim" and "network call," and this document does **not** claim it is closed — closing it fully would require holding a lock across the outbound LINE call, which §17/§18.4 explicitly reject as unsafe (it would hold a transaction, or an equivalent exclusive claim, open for the duration of a network round-trip). The window does not create a data-integrity or inventory-correctness problem: `begin_purchase_capture_confirmation` (§12) binds confirmation and posting to the receipt's *current*, authoritative `draft_revision` under lock, never to whatever preview text a worker happened to have in flight, so a stale preview message reaching LINE late cannot cause a stale confirmation or an incorrect posting — it can only, in the rare case, show staff a momentarily-outdated preview text, and the new revision's own parts are still delivered afterward, under their own distinct `retry_key`s, unaffected by the old one's fate. This is recorded as an **accepted V1 UX limitation, not a data-integrity risk** — no owner decision is required to accept it, but it is called out here rather than glossed over.

### 18.6 Everything else, restated for the part model

- **Webhook reply vs. push**: while still inside the original webhook HTTP request/response cycle, use LINE's `reply` API for a claimed part exactly as the current handlers do for other features; a reply send does not depend on `X-Line-Retry-Key` collision semantics the way push does, but the part is still claimed first (§18.4) and marked delivered afterward through the same two RPCs — there is one claim-and-settle contract regardless of transport. Once work has been deferred past the response (background finalize via `after()`, or a cron-sweep-driven recovery, §8.2/§12.1), push with the claimed part's `retry_key`.
- **Key existence is not delivery status.** A row existing means "this exact message has been decided upon," not "LINE has it," and a claim existing means "a worker is currently trying," not "delivered." Only `mark_purchase_capture_notification_part_delivered` sets `delivery_status = 'delivered'`.
- **DB success vs. LINE delivery status stay in separate tables**: the session's `status`/`receipt_id`/`movement_id` (durable, DB-authoritative, §16.1) are never conflated with whether a given part actually reached LINE — that lives entirely in `purchase_capture_notifications.delivery_status`, never by mutating session `status`.
- **Processed-marker timing**: `raw_messages.is_processed` set only after the admit/finalize/confirm/post step it corresponds to has durably committed — mirrors `markRawMessageProcessed`'s existing "leaving it unprocessed is the safe direction" philosophy (§2.5).
- **Behavior if DB succeeds but LINE delivery fails**: the DB-side state (`posted`, `movement_id` set) is already correct and terminal; only the notification is missing, and that fact is durable and queryable — `SELECT * FROM purchase_capture_notifications WHERE delivery_status IN ('pending','failed')`. The cron sweep's "recent terminal sessions with an undelivered close message" pattern (`finalizer.ts:319-334`, §2.4) generalizes directly: for each session with any undelivered part, repeatedly claim-and-send the next eligible part (§18.4) until either every part is delivered or nothing more is currently claimable, reading each part's own stored `payload_text` (never re-rendered from the current, possibly-newer, mutable draft state — that reconstruction is exactly what this design forbids).
- **Scheduler recovery**: same cron route proposed in §8.2/§12.1 covers this — one sweep, multiple responsibilities (finalize-due, resume-posting, redeliver-outbox-parts), mirroring how the existing Physical Inventory sweep already does more than one job per pass (`finalizer.ts:336-394`). The sweep never needs to guess which key to use, or which part is next — the claim RPC (§18.4) answers both.
- **Duplicate notification prevention**: LINE's own `X-Line-Retry-Key` 409 semantics (§2.5, reused unmodified), now scoped correctly to exactly one message per key (§18.2) — a redelivery attempt with a part's own `retry_key` either succeeds once or 409s harmlessly (both outcomes mark that one part delivered); a different part (different `part_index`) or a different logical notification (different kind or version) always has its own row and key, so it can never collide with or be mistaken for a retry of another.

---

## 19. Required tests

**PROPOSED** as the required focused-test list for the later implementation PR. Grouped exactly per the task's four categories; no category is skipped.

### 19.1 Parser/application integration
- Valid complete multi-message document (5 separate messages) → `awaiting_confirmation` with a correct preview, zero blocking blockers.
- All blocks in one message, via `close_purchase_capture_open_event` (§8.4) → identical result to the 5-message case, with exactly one ingest row for the whole document (the test proves the capture-session layer doesn't accidentally impose a one-block-per-message assumption, and doesn't create a duplicate ingest for the opening event).
- Missing header (close otherwise present, so the session does reach `closing`) → `failed_closed`, `MISSING_HEADER` surfaced.
- Missing costs (close otherwise present) → `failed_closed`, `MISSING_COSTS` surfaced.
- **Missing close is NOT tested as an operational `failed_closed` transition.** A session that never receives a close event (and isn't the one-message case) never reaches `closing` at all, so finalize is never invoked — the operational test asserts the session **remains `open`** indefinitely (§8.5), distinct from the existing parser-level unit test (already in `src/lib/purchases`, §2.1) that proves `MISSING_CLOSE` when the parser is called directly on incomplete evidence. These are two different test subjects and this document does not claim the operational one produces `failed_closed`.
- Close count mismatch → `failed_closed`, `CLOSE_COUNT_MISMATCH`.
- Malformed quantity / malformed unit cost / unknown unit cost (i.e., `ราคา: ไม่ทราบ`) → correct review-flag vs. error classification per §2.1.
- VAT variants (`ไม่มี`, amount + both boolean fields) → correct draft VAT mapping.
- Out-of-order block evidence (item message's HTTP request lands before the header message's, despite header being sent first) → correct assembly, because `chunkOrdinal` is derived from sorting the ingest set by `(line_timestamp_ms, line_event_id)`, not from arrival order or `ingest_revision` (§9).
- Two ingests sharing the same `line_timestamp_ms` (clock-resolution collision) → tie-broken deterministically by `line_event_id`, same result on every replay.
- Block split across messages (a field's value literally cut mid-line across two LINE messages) → `BLOCK_SPLIT_ACROSS_CHUNKS`, not silently merged (§2.1 confirms this is already a distinct, tested error path in the pure parser; the integration test proves the adapter surfaces it correctly).
- Product resolved, quantity unit resolved, price unit resolved, canonical keys equal (e.g. `จำนวน ... กก.` / `ราคา ... บาท/โล`, both alias to `kg`) → zero blockers, `ยืนยันซื้อ` accepted.
- Product resolved, quantity unit resolved, price unit resolved but canonical keys differ (e.g. quantity unit resolves to `kg`, price unit resolves to a different canonical unit) → `price_unit_status = 'UNRESOLVED'`, blocking blocker, `ยืนยันซื้อ` refused.
- Unregistered raw unit text on either the quantity or the price side → that side's status `UNRESOLVED`, blocking blocker.
- No unit cost present (`ราคา: ไม่ทราบ`) → `price_unit_status = 'NOT_APPLICABLE'`, not a blocker by itself.

### 19.2 Session/concurrency
- Duplicate open event (same `opened_line_event_id` redelivered) → idempotent, no second session.
- Duplicate item event → idempotent, no duplicate item admitted.
- Conflicting event reuse (same `line_event_id`, different content — defensive case) → rejected, not silently accepted.
- Two concurrent item admissions → both admitted, correct `ingest_revision` sequencing, no lost update.
- Close arrives while an earlier item request is still running → both ultimately admitted or the late one correctly time-boundary-checked, no incomplete finalize (§8.3).
- Late pre-close item accepted during the quiet window → admitted, included in the finalized document.
- Post-close item (timestamp after `close_event_timestamp_ms`) rejected even if it arrives before the deadline.
- Sender ownership isolation — sender B cannot admit/confirm sender A's session.
- Source isolation — the same sender in two different LINE groups gets two independent sessions.
- Stale generation — an RPC call carrying a superseded `session_generation` is refused.
- Stale revision/hash — finalize refused if the ingest set changed since the candidate was read (§8.3).
- Finalizer retry — cron sweep resumes a `closing` session past its deadline and reaches the correct terminal state.
- Redelivered `close_purchase_capture_open_event` for the one-message case (§8.4) → idempotent, boundary fields unchanged on the second call, no second ingest row.
- `open_purchase_capture_session` followed immediately by a redelivered copy of the *same* opening message → exactly one ingest row exists, not two, whether or not `close_purchase_capture_open_event` has been called yet.
- **Confirm-vs-recheck race, recheck wins first**: interleave `replace_purchase_capture_draft` (committing a new `draft_revision`) ahead of a concurrent `begin_purchase_capture_confirmation` call built against the old revision → the confirm call refuses `stale_revision`, session remains `awaiting_confirmation`, no transition to `confirming` occurred (§12).
- **Confirm-vs-recheck race, confirmation wins first**: interleave `begin_purchase_capture_confirmation` (committing the transition to `confirming`) ahead of a concurrent `replace_purchase_capture_draft` call → the replace call refuses `invalid_state` **before touching the receipt row at all** — assert the receipt's content/revision is byte-identical to what it was before the losing call, not merely that the session pointer is untouched (§12.2).
- **No deadlock under concurrent confirm + replace**: both RPCs lock the session row before the receipt row, in the same order (§12, §12.2) — run many concurrent pairs against the same session in a stress test and assert every call either succeeds or refuses cleanly, never blocks indefinitely or raises a Postgres deadlock error.
- **No path leaves a stale draft in `confirming`**: after any confirm-vs-replace interleaving, assert that whichever draft revision the session ends up `confirming` against (if any) is exactly the revision `begin_purchase_capture_confirmation` itself locked and verified — never a revision superseded by a replace that committed first.
- **No blocked draft reaches `confirming`**: construct a draft with a blocking blocker and call `begin_purchase_capture_confirmation` directly (bypassing any application-side check) → refused `blocking_blocker_present`, proving the gate is enforced inside the RPC itself, not only by well-behaved callers.
- **Receipt and session revision never disagree**: after any successful `replace_purchase_capture_draft` call (in isolation or under concurrency), assert `session.draft_revision` exactly equals the confirmed current `purchase_receipts.draft_revision` for `session.receipt_id` — the two can never be read as different values, because they are written in the same transaction (§12.2).
- **No application-level `saveDraft` call precedes the RPC**: an architecture-style test (mirroring `architecture.test.ts`, §2.1, and §19.4's DML test) asserting the `ตรวจใบซื้อใหม่` handler code path never calls `PurchaseReceiptService.saveDraft`/`upsert_purchase_receipt_draft` directly — the only sanctioned entry point for recheck content is `replace_purchase_capture_draft` (§12.2).

### 19.3 Persistence/posting
- Draft full-replace idempotency (repeated identical draft save → same content, no duplication) — reusing `0052`'s existing guarantee (§2.2), tested at the adapter-integration level.
- **Blocking blocker prevents confirmation, not just posting** — a draft with a still-`UNRESOLVED` item, when `ยืนยันซื้อ` is sent: `begin_purchase_capture_confirmation` refuses `blocking_blocker_present` under its own authoritative check (§12 step 3g), `PurchaseReceiptService.confirm` is never called, no receipt is created, session stays `awaiting_confirmation`, correct refusal reply sent. This replaces any earlier notion of "confirm succeeds, only posting is blocked," and is tested against the RPC directly, not only through the application's advisory read (§12 step 2), so an app-level bug in that read cannot silently defeat the gate.
- `ตรวจใบซื้อใหม่` clears a blocker — seed the registry, send `ตรวจใบซื้อใหม่` on a session with a prior blocking item, assert: resolver re-run against the *original* durable ingest set (no re-parsing of new LINE text), `replace_purchase_capture_draft` applied the replacement and the new `draft_revision` atomically, previously-blocking item now `RESOLVED`, a new `preview_ready` outbox part set exists for that revision, session still `awaiting_confirmation` (never auto-confirmed).
- `ยืนยันซื้อ` after `ตรวจใบซื้อใหม่` binds to the newest `draft_revision` — an attempt using a stale (pre-replace) revision is refused by `begin_purchase_capture_confirmation`'s own re-check, the same authoritative mechanism as any other stale-revision confirm attempt.
- Stale draft confirmation rejected (`expectedDraftRevision` mismatch) — including the case where the mismatch comes from an intervening `ตรวจใบซื้อใหม่`, not just a concurrent write.
- Confirmation replay (`ยืนยันซื้อ` sent twice after blockers are already clear) → same receipt, `replayed:true`, no duplicate.
- **Defense-in-depth**: unresolved identity is still refused at the P2C RPC boundary even if somehow reached — direct test of §2.3's existing RPC-level refusal, exercised through this new flow's actual call path (not just the existing `0053` unit tests) by constructing a test harness that bypasses `begin_purchase_capture_confirmation` entirely (calling `PurchaseReceiptService.confirm` directly against a blocked draft) to prove the P2C-level backstop still fires independently; this is a should-never-happen path under normal operation (§10.2, §16.4), not a documented user-reachable one.
- Confirmed receipt posts exactly once.
- Repeated posting returns the same movement (`replayed:true`, same `movementId`).
- Inventory balance increases exactly once (via the derived view, §2.3).
- Application crash after confirm before post → recovery sweep completes posting without a second receipt or movement (§12.1).
- **Three-part preview creates three rows and three different retry keys** — a preview whose rendered text needs chunking into 3 LINE messages, passed to `create_purchase_capture_notification_parts` as a 3-element array → exactly 3 rows exist, `part_index` 0/1/2, `part_count = 3` on all three, three distinct `retry_key` values, none shared (§18.2, §18.3).
- **Part 1 success, part 2 failure, retry sends part 2 only** — claim and successfully deliver part 0; claim part 1 and record a failed attempt; a subsequent claim for the same identity returns part 1 again (same `retry_key`), never part 0 (already `'delivered'`, permanently excluded) and never part 2 (§18.4).
- **Part 3 cannot send before part 2 succeeds** — with part 0 delivered and part 1 still `'pending'`/`'failed'`, a claim call for the identity returns part 1, never part 2, regardless of how many times it is called (§18.4).
- **409 on part 2 marks only part 2 delivered** — a push of part 1's content 409s using part 1's own `retry_key`; only part 1 transitions to `'delivered'`; part 0 (already delivered) and part 2 (not yet claimed) are unaffected (§18.4).
- **Logical notification completes after all three parts deliver** — after parts 0, 1, 2 all read `'delivered'`, a further claim call for the identity returns nothing eligible (§18.4).
- **Same logical version, a missing or conflicting part fails closed** — call `create_purchase_capture_notification_parts` once with a 3-element array, then again for the same `(session_id, notification_kind, notification_version)` with only 2 elements, or with 3 elements where one `payload_text` differs → refused `notification_identity_conflict`; the original 3 rows are unchanged, and no 2-row or mixed set is ever left in the table (§18.3).
- **A new preview revision supersedes every undelivered part of the old revision** — with an old revision's parts 0 (`'delivered'`) and 1 (`'pending'`) present, create a new revision's parts → old part 0 stays `'delivered'`, old part 1 becomes `'superseded'`, new revision's parts are freshly `'pending'` with their own keys (§18.3, §18.5).
- **Delivered historical parts remain audit history** — a `'delivered'` part is never mutated to `'superseded'` by a later supersession, and remains queryable indefinitely (§18.5).
- **Claim/lease recovery after a crash** — claim a part (moves to `'sending'`), simulate a crash (neither `mark_..._delivered` nor `record_..._attempt` is ever called), advance past `claim_expires_at` → the next claim call for that identity reclaims the same row, same `retry_key`, fresh `claim_token` (§18.4).
- **A claim held by another worker is not claimable again while its lease is live** — claim a part, then attempt a second concurrent claim for the same identity before the lease expires → the second claim returns nothing eligible, never the same row twice at once (§18.4).
- **`create_purchase_capture_notification_parts` used uniformly for single-part kinds** — a `posted_success` notification created with a single-element `payload_texts` array produces exactly one row (`part_index 0`, `part_count 1`) and goes through the identical claim/mark-delivered path as any multipart `preview_ready` notification — no separate single-message code path exists (§18.3).
- **Same identity, same payload, all parts** — two `create_purchase_capture_notification_parts` calls with identical `(session_id, notification_kind, notification_version)` and byte-identical `payload_texts` (same count, same per-part content) → same rows, same `retry_key`s, no error, supersession does not re-run (§16.4, §18.3).
- **Same identity, different payload fails closed** — a second call with the same identity but a different part count or a different `payload_text` at any `part_index` → refused `notification_identity_conflict`; the originally-stored rows are unchanged (§16.4, §18.3).
- **Retry uses the stored payload, not a re-render** — after the underlying receipt has moved to a later `draft_revision` (a newer `preview_ready` part set now exists), a recovery pass for an *older*, still-undelivered part (before it is marked superseded) sends exactly the `payload_text` stored on that row — never a freshly re-rendered message derived from the receipt's current, later state (§18.4, §18.6).
- **Thai Unicode payload survives storage/readback exactly** — a `payload_text` containing full Thai text (including combining marks/tone marks) round-trips through insert and read-back with zero byte difference; `payload_hash` recomputed from the read-back value matches the stored `payload_hash` exactly.
- **A claimed-but-superseded part is honestly allowed to still deliver** — claim an old revision's part (moves to `'sending'`), then, before marking it delivered, create a new revision's parts (supersession runs but deliberately does not touch the `'sending'` row, §18.5) → assert the old part is still claimable-outcome-wise (i.e. it stays `'sending'`, not `'superseded'`) and can still be marked `'delivered'` afterward; assert the new revision's own parts were still created and are independently claimable with their own keys.
- **`posted_success` remains unaffected by preview supersession** — create parts for a `preview_ready` notification and a `posted_success` notification for the same session, then trigger another `ตรวจใบซื้อใหม่`/new preview revision → assert every `posted_success` row's `delivery_status` is completely untouched by the preview's supersession UPDATE (the supersession clause only ever targets `notification_kind = 'preview_ready'`, §18.3, §18.5).

### 19.4 Migration/security
- Grants: `anon`/`authenticated` have zero access to every new table/RPC.
- RLS: enabled, no policies, on every new table.
- RPC `search_path`: fixed on every new `SECURITY DEFINER` function.
- Uniqueness and ownership constraints: the partial unique active-session index, the ingest-ledger unique keys, the session-generation re-check, all independently exercised.
- No direct DML: a static/architecture-style test (mirroring `architecture.test.ts`, §2.1) asserting the new webhook integration point never calls `.from(...).insert/update/delete(...)` on any purchase-capture or purchase-receipt or inventory-movement table directly.
- Deterministic local replay: the same fixture document, replayed twice against a disposable local Postgres instance (mirroring `migration-0052.pg.test.ts`/`migration-0053.pg.test.ts`'s existing pattern, §2.2/§2.3), produces byte-identical final state both times.

---

## 20. Production UAT plan

**PROPOSED — designed here, not performed in this task, per the explicit instruction.**

### 20.1 Setup
- Seed `purchase_intake_product_registry` and `purchase_intake_unit_alias_registry` (§10.3) with exactly the product/unit pairs the UAT document will use (e.g. products `หมอนทอง`, `ส้มไต้หวัน`; unit alias `โล` → `kg`) — nothing else, keeping the blast radius minimal.
- Use a dedicated test LINE group/user not used for real operations, or a clearly-marked test business date, per whatever convention the team already uses for UAT (not specified in the inspected repo — **OWNER DECISION REQUIRED** on the exact isolation mechanism if one doesn't already exist for other features' UATs).

### 20.2 Execution (one purchase document, exactly the example in the task)
Send the header/2-items/costs/close sequence from the task's own example, either as 5 messages or however the team wants to exercise the multi-message path, and confirm via `ยืนยันซื้อ`.

### 20.3 Verification queries (read-only)
- **Exactly one `purchase_receipts` row** for the document's `documentKey`, `status = 'confirmed'`.
- **Expected `purchase_receipt_items` rows** — exactly 2, matching the two `ซื้อรายการ` blocks, both `product_identity_status = 'RESOLVED'`, `unit_identity_status = 'RESOLVED'`, and `price_unit_status` either `'RESOLVED'` (with matching canonical quantity/price unit keys) or `'NOT_APPLICABLE'` (since both registries were seeded for exactly these product/unit pairs).
- **Frozen confirmation** — `confirmation_payload`/`confirmation_hash` present and non-null, `confirmed_at`/`confirmed_by` set.
- **Exactly one `PURCHASE_RECEIPT` `inventory_movements` row**, `source_document_id = ` the receipt's id, `dedupe_key` matching the derived `p2c_dedupe_key` formula (§2.3).
- **One `inventory_movement_lines` row per item** (2 rows), `location_code = 'MAIN'`, `signed_quantity` positive and equal to the declared quantities.
- **MAIN balance increase** — query `inventory_balances` (the view) for the two `product_key`/`unit_key` pairs before and after, confirming the delta matches exactly.
- **Retry produces no additional movement** — re-run the confirm/post sequence (or re-send `ยืนยันซื้อ`) and re-verify the movement count is still exactly 1 and the balance is unchanged.
- **No P2D cost/COGS rows** — confirm no row was written to any P2D-scoped table (none exist yet, per §2.3's confirmed locked scope — this check is really "confirm nothing new was invented," trivially true if this design was followed).

### 20.4 Cleanup/correction plan (does not delete ledger history)

- **Do not delete** the `purchase_receipts`, `purchase_receipt_items`, or `inventory_movements`/`inventory_movement_lines` rows created by the UAT — deletion would contradict the append-only/immutable design this entire system relies on (§2.2, §2.3), and there is no delete RPC for any of them (confirmed absent from both migrations).
- If the UAT quantities must be removed from the *effective* balance afterward, the only sanctioned mechanism is `reverse_inventory_movement` (§2.3, exists today) applied to the UAT's movement — this produces a `REVERSAL` movement, not a deletion, and the balance view (§2.3) then correctly nets to zero for those product/unit pairs while preserving full history.
- The UAT receipt itself remains a permanent, clearly-dated record; if desired, label it via `sourceEvidence`/`referenceText` (e.g. `ใบอ้างอิง: UAT-2026-08-04`) at execution time so it is trivially identifiable later without needing any special-case cleanup tooling.

---

## 21. Implementation slices in dependency order

**PROPOSED**, per the task's recommended shape, confirmed as the right shape by this discovery (no evidence found that combining slices would be safer).

### Slice A — Durable purchase capture session + ingest barrier
- **Files/components**: new `supabase/migrations/<timestamp>_purchase_capture_sessions.sql` (§16.1; RPCs `open_purchase_capture_session`, `admit_purchase_capture_event`, `close_purchase_capture_open_event`, `get_purchase_capture_finalize_candidate`, `cancel_purchase_capture_session` only — **not** `finalize_purchase_capture_session`, `replace_purchase_capture_draft`, `begin_purchase_capture_confirmation`, `mark_..._posted`, or any notification-outbox RPC, all of which belong to later slices, §16.4); new `src/lib/purchase-capture/session-service.ts` (mirrors `src/lib/physical-inventory/session-service.ts` shape, covering only the RPCs above); new cron route `src/app/api/cron/finalize-purchase-capture/route.ts` scoped in this slice to computing/logging quiet-window and deadline eligibility only (no finalize call yet) + GitHub Actions schedule.
- **Migration dependency**: none (purely additive, new tables only).
- **Tests**: §19.2 in full, plus the migration/security tests in §19.4 scoped to the new tables/RPCs only.
- **Definition of Done**: a session can be opened, admitted to (multi-message and the one-message open+close path, §8.4), and reach a stable, correctly-ordered `closing` state whose finalize candidate (ingest set + `ingest_revision` + `ingest_set_hash` + quiet/deadline eligibility, §8.2-§8.3) is provably correct under concurrency, replay, and ownership tests (§19.2) — entirely through RPC calls exercised against a disposable local Postgres. **This slice never creates a session in `awaiting_confirmation`, never writes a `receipt_id`, and never calls a finalize RPC that would do either** — there is no stub/placeholder outcome anywhere in this slice, because there is no finalize-to-`awaiting_confirmation` RPC available to call yet.
- **Explicit non-goals**: no parser integration, no identity resolution, no draft persistence, no `awaiting_confirmation`/`posted` transitions of any kind (real or stubbed), no LINE webhook wiring, no confirm/post sequence.
- **Rollback/recovery**: purely additive migration — rollback is "do not ship the migration"; no existing table or RPC is touched, so there is no forward-compatibility risk to any other feature.

### Slice B — Parser adapter + identity resolution + atomic draft persistence + preview outbox foundation
- **Files/components**: new `supabase/migrations/<timestamp>_purchase_capture_draft_finalization.sql` adding: `finalize_purchase_capture_session` (extended to also create the first `preview_ready` outbox part set transactionally, §16.4); `replace_purchase_capture_draft` (§12.2, §16.4 — the sole entry point for `ตรวจใบซื้อใหม่` content, locking the session first, `FOR UPDATE`, refusing `invalid_state` before the receipt is ever touched if the session is no longer `awaiting_confirmation`, then applying the full replacement and the new `preview_ready` part set in the same transaction — the lock-ordering discipline the confirm-gate in Slice C depends on, §12); both `purchase_intake_product_registry`/`purchase_intake_unit_alias_registry` tables (§10.3, §16.2); the **`purchase_capture_notifications` outbox table (one row per physical LINE message, §16.3) and its four general-purpose RPCs** — `create_purchase_capture_notification_parts` (atomic multipart creation, identity-conflict fail-closed, `preview_ready`-scoped supersession of unclaimed parts), `claim_next_purchase_capture_notification_part` (the sole ordered claim/lease RPC), `record_purchase_capture_notification_part_attempt`, `mark_purchase_capture_notification_part_delivered` (§16.3, §16.4, §18) — **introduced here because this slice is the first to produce `preview_ready` content, not deferred to Slice C**; new `src/lib/purchase-capture/parser-adapter.ts` (§9, including the `(line_timestamp_ms, line_event_id)` chunk-ordering step and the identity-resolution step); new `src/lib/purchase-capture/preview.ts` (§11, rendering both the human-readable Thai text and the ordered `payload_texts` array passed to the outbox RPCs, chunking into multiple messages where needed); wiring the cron route (from Slice A) so an eligible `closing` session now actually calls the adapter → resolver → `finalize_purchase_capture_session` with a **real, non-null** `receipt_id`/`draft_revision`/`preview_payload_texts`, and so the outbox-redelivery half of §18's recovery sweep can already claim-and-send undelivered `preview_ready` parts even before Slice C exists (there is simply nothing yet to escalate to `posted_success`/`stuck_escalation`).
- **Migration dependency**: Slice A's tables and RPCs must exist; the new registry tables and the notification outbox are independent of both and of each other.
- **Tests**: §19.1 in full; §19.2's `replace_purchase_capture_draft` atomicity/race/no-`saveDraft`-before-RPC tests; §19.3's draft/replace-related and outbox/payload/supersession cases in full (full-replace idempotency, stale revision, `ตรวจใบซื้อใหม่` clearing a blocker, identity-conflict fail-closed, Thai Unicode round-trip, supersession); §19.4 scoped to the two registry tables and the notification outbox.
- **Definition of Done**: a `closing` session that reaches quiet/deadline eligibility is finalized to a real `purchase_receipts` draft row (`COMPLETE` assembly) or `failed_closed` (`INCOMPLETE` assembly) — **this is the first slice in which `closing` → `awaiting_confirmation` can happen at all**, and it happens only after parser status is `COMPLETE`, identity resolution has run for every item, `PurchaseReceiptService.saveDraft` has succeeded with a real `receipt_id`/`draft_revision`, and the first `preview_ready` outbox part set exists transactionally alongside it. The preview reply is correct, including per-item `RESOLVED`/`UNRESOLVED`/`NOT_APPLICABLE` status per §10.3, and correctly labels whether the receipt has any blocking blocker. `ตรวจใบซื้อใหม่` (RPC-level only in this slice — see Slice C for the LINE command wiring) atomically re-resolves and replaces the draft via `replace_purchase_capture_draft`, superseding any prior undelivered preview's unclaimed parts in the same transaction. The full notification-outbox reliability model (§18) — one `retry_key` per physical push request, atomic multipart creation, identity-conflict fail-closed, ordered claim/lease delivery, supersession of unclaimed parts — is exercised and correct here, not deferred. Still **no confirm/posting wiring**.
- **Explicit non-goals**: no `ยืนยันซื้อ`/`ยกเลิกซื้อ`/`ตรวจใบซื้อใหม่` LINE command handling yet (that is webhook wiring, Slice C's exclusive territory per §2.7), no P2C posting, no `posted_success`/`stuck_escalation` notifications (nothing to post yet).
- **Rollback/recovery**: additive only; if either registry is empty, every item is correctly `UNRESOLVED` (fail-safe default direction) rather than broken.

### Slice C — Confirmation gate + idempotent P2C posting + recovery
- **Files/components**: new `supabase/migrations/<timestamp>_purchase_capture_confirm_post.sql` adding only `begin_purchase_capture_confirmation`/`mark_purchase_capture_session_posted` RPCs (§16.4) — **no new tables and no new notification RPCs**, since Slice B already introduced the outbox; this migration is smaller than an earlier draft of this design because of that move; `src/lib/purchase-capture/confirm-flow.ts` implementing §12's exact sequence, including step 2's **advisory-only** blocker read (used purely to word an early refusal reply; the actual gate is `begin_purchase_capture_confirmation`, called in step 3, which is the only thing permitted to transition the session) and the `ตรวจใบซื้อใหม่`/`ยืนยันซื้อ`/`ยกเลิกซื้อ` LINE command dispatch; posting success calls Slice B's existing `create_purchase_capture_notification_parts`/`claim_next_purchase_capture_notification_part` with `notification_kind = 'posted_success'` (§12 step 9) — reusing the outbox, not extending its schema; extending the Slice A cron route to also perform §12.1's recovery sweep and to widen §18's already-existing outbox-redelivery sweep to also cover `posted_success`/`stuck_escalation` rows; the single new call site into `webhook-service.ts`'s `processOne` chain (§2.7) — this is the only slice that touches the existing webhook file, and only by adding one call, not modifying existing branches.
- **Migration dependency**: Slices A and B.
- **Tests**: §19.2's confirm-vs-replace race tests (replace-wins-first and confirmation-wins-first outcomes, no deadlock, receipt/session revision agreement); §19.3 in full (posting-specific, confirm-gate, and `posted_success`-scoped outbox cases); the crash-recovery case exercised explicitly (kill the process between confirm and post in a test harness, then run the recovery sweep).
- **Definition of Done**: the full journey in the task's stated goal works end-to-end against a disposable local Postgres, including: a blocked draft correctly refusing `ยืนยันซื้อ` via `begin_purchase_capture_confirmation`'s own authoritative check (not the app-side read); `ตรวจใบซื้อใหม่` clearing the block atomically; the confirm-vs-replace race resolving deterministically in both directions with no deadlock, no stale draft ever reaching `confirming`, and no receipt ever modified after its session entered `confirming`; a `posted_success` notification correctly reusing Slice B's outbox without being affected by preview supersession; and the crash-recovery case. `webhook-service.ts`'s existing routing order/behavior for every other feature is unchanged (regression-tested by the existing suite, §2.4's test list).
- **Explicit non-goals**: no cancellation-after-posting, no correction/supersession LINE UX (§15).
- **Rollback/recovery**: the webhook call-site addition is the only slice with any blast radius on existing behavior; it must be reviewed against the existing ordering comment (`webhook-service.ts:726-727`) to confirm no vocabulary collision with Physical Inventory or Produce routing, exactly as that comment already warns future authors to check.

### Slice D — Operational UAT activation
- **Files/components**: none (no code) — this slice is the execution of §20 against Production, plus whatever small operational runbook the team wants (out of this document's scope to author unless requested).
- **Migration dependency**: Slices A-C fully deployed.
- **Tests**: the verification queries in §20.3, run manually or via a one-off script.
- **Definition of Done**: §20.3's checklist passes in full against Production.
- **Explicit non-goals**: no new code.
- **Rollback/recovery**: §20.4's reversal-not-deletion plan.

---

## 22. Definition of Done for "P2C First Real Posting"

**PROPOSED.** All of the following, together:

1. A staff member can send the task's example purchase document (any supported message shape, §5, including the one-message open+close path, §8.4) through LINE and receive a preview matching §11.
2. `ยืนยันซื้อ` is refused, with no state change and no `confirm()` call, whenever `begin_purchase_capture_confirmation`'s own authoritative, under-lock re-evaluation finds any blocking blocker, a stale draft revision, or an ownership/generation mismatch (§12 step 3) — never decided by the application's advisory read alone (§12 step 2). It succeeds only when that RPC's own checks all pass. There is no path in this design by which a receipt with a blocking blocker is ever confirmed, and no path by which a receipt is posted partially — posting is always whole-receipt, all-or-nothing (§2.3, §12).
3. A `ตรวจใบซื้อใหม่` (`replace_purchase_capture_draft`) racing a `ยืนยันซื้อ` (`begin_purchase_capture_confirmation`) against the same session always resolves deterministically and without deadlock: whichever RPC locks the session row first wins, the other is refused (`stale_revision` or `invalid_state`, §12, §12.2) — and the losing `ตรวจใบซื้อใหม่` refuses **before it ever touches the receipt row**, so no interleaving can modify a receipt after its session has entered `confirming`, leave `session.draft_revision` disagreeing with the attached receipt's actual revision, or leave a stale draft sitting in `confirming` (§19.2's race tests pass in full).
4. After a registry fix, one atomic `replace_purchase_capture_draft` call re-resolves the original ingest set and replaces the receipt AND advances the session's `draft_revision` together — never as two separately-committed steps — without requiring the document to be re-sent, and a subsequent `ยืนยันซื้อ` correctly binds to that newest revision (§11.3, §12.2).
5. Once confirmed, `ยืนยันซื้อ` posts exactly one `PURCHASE_RECEIPT` movement with exactly one line per item, increasing the MAIN balance by exactly the declared quantities, exactly once, even under redelivery/retry/crash (§12, §14 all pass as tests, §19 in full).
6. No item is ever posted with `UNRESOLVED` product identity, quantity-unit identity, or price-unit identity, and no item is ever posted with mismatched canonical quantity/price unit keys (§10.3's resolution contract, backstopped by §2.3's RPC-level refusal, exercised end-to-end through this flow, not just at the existing unit-test level).
7. Every distinct piece of outbound content is delivered as one or more **physical parts**, each its own durable `purchase_capture_notifications` row, each its own immutable `retry_key`, each mapped to exactly one `pushLineMessage()`/reply call and never more (§16.3, §18) — no key is ever reused across two distinct LINE messages, whole part sets are created atomically or not at all, a same-identity/different-content or partial-set call fails closed (`notification_identity_conflict`) rather than overwriting or completing stored content, parts are only ever selected for sending through the ordered claim/lease RPC (never an arbitrary `'pending'` query), an obsolete undelivered (`'pending'`/`'failed'`) part of an older preview is database-marked `'superseded'` the moment a newer revision's parts are created, delivered parts remain immutable audit history, and cron recovery only ever claims parts still `'pending'`/`'failed'`, in order, using each row's own stored `payload_text` rather than re-deriving one from the current, possibly-newer draft state. The one honestly-scoped exception — a part already claimed (`'sending'`) at the moment of supersession may still be delivered — is documented as an accepted V1 limitation with no confirmation/posting safety impact, not silently assumed away (§18.5, §19.3's outbox tests pass in full).
8. `webhook-service.ts`'s existing behavior for every other feature is unchanged (full existing test suite green, §2.4's concurrency/idempotency test list specifically re-verified).
9. §20's UAT checklist passes against Production for one real document.
10. Grants/RLS/search_path on every new table and RPC match §17 exactly, verified the same way §3 verified the existing ones (live `pg_proc`/`information_schema` query, not just migration-file inspection).

---

## 23. Explicit out-of-scope list

Restated from the task, unchanged, and confirmed by this discovery to require no exception:

P2D weighted-average cost; landed-cost allocation; FIFO; COGS; profit/loss P3; product issue from warehouse to markets; good-return ledger adapter; damaged-return ledger adapter; physical-count adjustment movement; warehouse transfer; Dashboard purchasing UI; OCR purchase invoices; supplier payment; accounts payable; editing confirmed receipts; deleting ledger movements; automatic purchase recommendations; broad Guided Menu redesign; real LINE message sending (this task); Production migration apply (this task); Production deployment (this task).

Additionally, out of scope for this document specifically (though noted where relevant above): a LINE-driven product/unit self-registration flow (§10.3 assumes manual/admin curation); an alias opener like `เปิดใบซื้อ` (§5); a correction-document LINE UX built on `supersedesReceiptId` (§15); atomic void+reversal (§15).

---

## 24. Open decisions requiring owner approval

1. **§5**: Is a friendlier opener alias (`เปิดใบซื้อ`) worth building as a pre-parser adapter for V1, or does `เริ่มซื้อ` ship as-is? Default: ship as-is.
2. **§10.3**: Are manually-curated `purchase_intake_product_registry`/`purchase_intake_unit_alias_registry` tables (no LINE-driven self-service registration) acceptable for first posting, or is a registration flow required before go-live? Default: manual curation, scoped to UAT's exact SKUs/units.
3. **§7/§12.1**: What is the bound (number of cron sweeps / elapsed time) after which a session stuck in `confirming` should surface an operator-visible stuck notice rather than silently keep retrying, and who receives that notice? Default not specified — needs an owner's operational input, not an engineering guess.
4. **§20.1**: What isolation mechanism (dedicated test LINE group, marked business date, or something else already used for this team's other UATs) should the purchase-capture UAT use? Not discoverable from the repo; needs the team's existing UAT convention, if any exists outside this repo.
5. **§15**: Should a correction-document LINE UX (using the existing `supersedesReceiptId` contract) be scoped as a near-term follow-up slice, or deferred indefinitely? Not required for first posting either way, but affects backlog sequencing.
6. **§12.2**: `replace_purchase_capture_draft` is safe-but-not-idempotent under an ambiguous network failure (a retry after a lost response is refused `stale_revision` rather than silently replaying) — is that acceptable for V1, or does `ตรวจใบซื้อใหม่` need its own caller-supplied idempotency key (mirroring `confirmationKey`) before shipping? Default: acceptable, since the failure mode is a clean, operator-recoverable refusal, never silent data loss or duplication.

---

## 25. Final recommendation

**GO WITH PREREQUISITE.**

The durable-session, parser, persistence, and ledger layers this flow needs are either already fully built and Production-verified (P2B parser, P2B persistence, P2C ledger — §2.1-§2.3, §3) or are a direct, low-risk adaptation of a pattern already running successfully in Production for a structurally identical problem (the Physical Inventory close barrier — §2.4, §8, extended with the one-message inline-close path, §8.4). No part of this design requires inventing a new safety mechanism from scratch; every idempotency and ownership guarantee in §13/§17 is either reused verbatim or built by copying an existing, tested shape. Five correctness gaps found across earlier drafts of this design are now closed: the confirm-gate is authoritative and race-safe (`begin_purchase_capture_confirmation`, §12, §16.4); the recheck path is a single atomic transaction rather than two separately-committed steps, so a receipt can never be replaced without its session revision advancing in the same commit, and can never be modified after its session has entered `confirming` (`replace_purchase_capture_draft`, §12.2, §16.4); the notification outbox stores the exact, immutable content to send, not merely a hash, and fails closed on a same-identity/different-content conflict rather than silently overwriting it (§16.3, §18); an obsolete undelivered preview is marked `'superseded'` in the database the instant a newer one exists, so it can never be sent by a late-arriving retry (§18); and notification delivery is now scoped to one `retry_key` per physical LINE push request rather than one key per logical (possibly multi-message) notification, with ordered claim-and-send recovery, so a chunked preview can no longer have its later messages 409-suppressed by a key already spent on its first message (§16.3, §18.2-§18.4).

The single prerequisite is §10: **build the minimal `purchase_intake_product_registry` and `purchase_intake_unit_alias_registry` (Slice B) before allowing any item to be marked `RESOLVED`/`RESOLVED`/anything other than the honest computed status.** Without them, the adapter has no honest way to decide product, quantity-unit, or price-unit identity, and the system's one real safety net (P2C's RPC-level refusal of `UNRESOLVED` items, §2.3, already CONFIRMED present and working in Production, backstopped now by the confirm-time gate itself, §12) would either never fire (if the adapter defaults every status to resolved) or always fire (if the adapter defaults everything to unresolved, which is safe but means nothing can ever post — not a usable V1). The registries are small, additive, and scoped to exactly the SKUs/units needed for first posting (§10.3, §20.1) — neither is a general Product Master and neither needs to become one before this feature can ship.

With that one prerequisite satisfied, implementation may proceed through Slices A → B → C → D (§21) in order, each independently reviewable and each leaving the system safe if work stops after that slice: a half-built capture session with no finalize RPC yet (end of Slice A) cannot create a draft, let alone post anything; a half-built registry with zero rows (during Slice B) fails safe to `UNRESOLVED`, not to `RESOLVED`, and the confirm-gate (introduced fully in Slice C) means an empty registry simply blocks every `ยืนยันซื้อ` rather than allowing an unsafe confirmation.
