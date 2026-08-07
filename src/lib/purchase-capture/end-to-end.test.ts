/**
 * P2C Slice C5 — TypeScript orchestration-level end-to-end tests.
 *
 * Real modules throughout (webhook-handler, confirm-flow, finalizer,
 * notification-push-worker, finalization-sweep, confirmation-recovery) —
 * NONE of them are `mock.module`-replaced here, unlike webhook-handler.test.ts
 * (which stubs out confirm-flow/finalizer as call-tracking mocks) or
 * confirm-flow.test.ts (which stubs RPC handlers directly). This file proves
 * the WIRING between those modules: which one calls what, in what order,
 * under which flags — with a single in-memory fake Supabase standing in for
 * every RPC/table the whole chain touches. SQL-level correctness (money/stock
 * proofs, idempotency, races) is Part A's job (integration-slice-c2.pg.test.ts);
 * nothing here is asserted as a substitute for that.
 *
 * No sleeps, no real network, no real DB. `process.env` is never mutated —
 * flag state is passed via `tryHandlePurchaseCaptureMessage`'s own `enabled`
 * override parameter instead.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import {
  tryHandlePurchaseCaptureMessage,
  PURCHASE_CAPTURE_CONFIRM_COMMAND,
} from "./webhook-handler";
import { finalizePurchaseCaptureSession } from "./finalizer";
import { sweepPurchaseCaptureFinalization } from "./finalization-sweep";

// ── Fixed proof constants (mirror confirm-flow.test.ts's proven-valid shape) ─

const HASH = "a".repeat(64);
const CONTRACT_VERSION = "p2b-purchase-confirm-v1";
const CANONICAL_FORM = "purchase-receipt-canonical-json-v1";
const HASH_ALGORITHM = "sha256";

// A known-good purchase document: header + one RESOLVED item + close, all in
// the grammar webhook-handler/parser-adapter already recognise (see
// src/lib/purchases/test-helpers.ts, reused by parser-adapter.test.ts).
const HEADER_TEXT = `เริ่มซื้อ 28/07/2569 06:30\nผู้ขาย: ร้านเจ๊แดง\nใบอ้างอิง: INV-123\nปลายทาง: MAIN`;
const ITEM_TEXT = `ซื้อรายการ 1\nสินค้า: หมอนทอง\nจำนวน: 120 โล\nราคา: 85 บาท/โล`;
// A costs block is required for a COMPLETE assembly (parser-adapter.ts).
const COSTS_TEXT = `สรุปค่าใช้จ่ายซื้อ\nค่าขนส่ง: 0 บาท\nค่าจัดการ: 0 บาท\nส่วนลด: 0 บาท\nภาษีมูลค่าเพิ่ม: ไม่มี`;
const CLOSE_TEXT = "ปิดซื้อ 1 รายการ";

const PRODUCT_RAW = "หมอนทอง";
const PRODUCT_KEY = "pk-durian";
const UNIT_RAW = "โล";
const UNIT_KEY = "unit-lo";

const PRODUCT_REGISTRY = [{ raw_product_text: PRODUCT_RAW, product_key: PRODUCT_KEY, active: true }];
const UNIT_REGISTRY = [{ raw_unit_text: UNIT_RAW, unit_key: UNIT_KEY, active: true }];

const SOURCE_TYPE = "user" as const;
const SOURCE_ID = "U-source";
const SENDER_ID = "U-sender";

type Json = Record<string, unknown>;

type FakeSessionRow = {
  id: string;
  source_type: "user" | "group" | "room";
  source_id: string;
  sender_line_user_id: string;
  opened_line_event_id: string;
  session_generation: string;
  status: string;
  ingest_revision: number;
  close_event_timestamp_ms: number | null;
  close_quiet_until: string | null;
  close_deadline_at: string | null;
  receipt_id: string | null;
  draft_revision: number | null;
  movement_id: string | null;
  fail_reason: string | null;
  warnings: unknown[];
  created_at: string;
  updated_at: string;
  ingests: Array<{
    line_event_id: string;
    line_timestamp_ms: number;
    kind: string;
    raw_text: string;
    ingest_ordinal: number;
    line_message_id: string | null;
    raw_message_id: string | null;
  }>;
};

type FakeReceiptItem = {
  id: string;
  productKey: string;
  rawProductText: string;
  productIdentityStatus: string;
  quantity: string;
  unitKey: string;
  rawUnit: string;
  unitIdentityStatus: string;
  unitCost: string | null;
  priceUnitText: string | null;
  priceUnitStatus: string;
};

type FakeReceipt = {
  id: string;
  documentNamespace: string;
  documentKey: string;
  status: "draft" | "confirmed";
  draftRevision: number;
  businessDate: string;
  sourceType: string;
  sourceId: string;
  senderLineUserId: string;
  items: FakeReceiptItem[];
  confirmationKey?: string;
};

type NotificationPart = {
  id: string;
  part_index: number;
  part_count: number;
  payload_text: string;
  retry_key: string;
  delivery_status: "pending" | "sending" | "delivered" | "failed" | "superseded";
  claim_token: string | null;
};

function fail(message: string): never {
  throw new Error(message);
}

function buildPayloadForReceipt(receipt: FakeReceipt): Json {
  return {
    contract_version: CONTRACT_VERSION,
    receipt_id: receipt.id,
    document_namespace: receipt.documentNamespace,
    document_key: receipt.documentKey,
    parser_contract_version: "p2b-slice-a-v1",
    source: {
      source_type: receipt.sourceType,
      source_id: receipt.sourceId,
      sender_line_user_id: receipt.senderLineUserId,
      source_line_event_id: receipt.documentKey,
      source_raw_message_id: null,
      source_evidence: {},
    },
    business_date: receipt.businessDate,
    purchase_time: null,
    supplier_key: null,
    supplier_raw: null,
    supplier_ref: null,
    reference_text: null,
    intended_warehouse_code: "MAIN",
    vat_kind: "NONE",
    vat_included_in_item_prices: null,
    vat_recoverable: null,
    item_count: receipt.items.length,
    items: receipt.items.map((item, index) => ({
      receipt_item_id: item.id,
      item_ordinal: index + 1,
      item_number: null,
      product_key: item.productKey,
      raw_product_text: item.rawProductText,
      product_identity_status: item.productIdentityStatus,
      quantity: item.quantity,
      unit_key: item.unitKey,
      raw_unit: item.rawUnit,
      unit_identity_status: item.unitIdentityStatus,
      unit_cost: item.unitCost,
      price_unit_text: item.priceUnitText,
      price_unit_status: item.priceUnitStatus,
      line_amount_satang: "0",
      source_evidence: {},
    })),
    totals: {
      line_subtotal_satang: "0",
      freight_satang: "0",
      handling_satang: "0",
      discount_satang: "0",
      vat_satang: null,
      payable_total_satang: "0",
      declared_total_satang: null,
      reconciliation_status: "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
    },
    blockers: [],
    has_blocking_blockers: false,
    posts_inventory_movement: false,
    posts_valuation: false,
  };
}

function buildConfirmationRow(receipt: FakeReceipt): Json {
  const dedupeKey = `purchase-receipt-confirmation:v1:${receipt.id}:${HASH}`;
  return {
    receipt_id: receipt.id,
    confirmation: {
      contract_version: CONTRACT_VERSION,
      canonical_form: CANONICAL_FORM,
      hash_algorithm: HASH_ALGORITHM,
      hash: HASH,
      confirmation_key: receipt.confirmationKey ?? "unset",
      confirmed_at: "2026-08-01T00:00:00.000Z",
      confirmed_by: "line:U-sender",
      payload: buildPayloadForReceipt(receipt),
    },
    lifecycle: { status: "confirmed", posting_locked_at: null, posting_locked_by: null },
    void: null,
    correction: { supersedes_receipt_id: null, superseded_by_receipt_id: null },
    p2c_dedupe_key: dedupeKey,
  };
}

/**
 * A single in-memory fake standing in for the entire RPC/table surface this
 * chain touches: session-service, receipt-service, inventory-ledger,
 * notification-service, and the two lookup tables the parser adapter's
 * identity resolution reads. State transitions mirror the REAL SQL functions
 * (proven correct in integration-slice-c2.pg.test.ts) closely enough to prove
 * ordering and idempotency; they are not a re-implementation of the SQL.
 */
function makeFullFakeSupabase() {
  const sessions = new Map<string, FakeSessionRow>();
  const lineEventToSession = new Map<string, string>();
  const receiptsById = new Map<string, FakeReceipt>();
  const receiptsByDocKey = new Map<string, string>();
  const movementByReceipt = new Map<string, { id: string }>();
  const notifications = new Map<string, NotificationPart[]>();
  const callLog: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const pushCalls: Array<{ to: string; text: string; retryKey?: string }> = [];

  function notifKey(sessionId: string, kind: string, version: string): string {
    return `${sessionId}:${kind}:${version}`;
  }

  function createNotificationParts(sessionId: string, kind: string, version: string, texts: string[]): boolean {
    const key = notifKey(sessionId, kind, version);
    if (notifications.has(key)) return false;
    notifications.set(
      key,
      texts.map((text, index) => ({
        id: randomUUID(),
        part_index: index,
        part_count: texts.length,
        payload_text: text,
        retry_key: randomUUID(),
        delivery_status: "pending",
        claim_token: null,
      })),
    );
    return true;
  }

  function handleOpen(args: Record<string, unknown>): Json {
    const evt = String(args.p_opened_line_event_id);
    const existingId = lineEventToSession.get(evt);
    if (existingId) {
      const s = sessions.get(existingId)!;
      return {
        opened: false, idempotent: true, reason: "duplicate_open_event",
        session_id: s.id, session_generation: s.session_generation, status: s.status, ingest_revision: s.ingest_revision,
      };
    }
    for (const s of sessions.values()) {
      if (
        s.source_id === args.p_source_id
        && s.sender_line_user_id === args.p_sender_line_user_id
        && ["open", "closing", "awaiting_confirmation", "confirming"].includes(s.status)
      ) {
        return {
          opened: false, idempotent: true, reason: "already_open",
          session_id: s.id, session_generation: s.session_generation, status: s.status, ingest_revision: s.ingest_revision,
        };
      }
    }
    const now = new Date().toISOString();
    const row: FakeSessionRow = {
      id: randomUUID(),
      source_type: args.p_source_type as FakeSessionRow["source_type"],
      source_id: String(args.p_source_id),
      sender_line_user_id: String(args.p_sender_line_user_id),
      opened_line_event_id: evt,
      session_generation: randomUUID(),
      status: "open",
      ingest_revision: 1,
      close_event_timestamp_ms: null,
      close_quiet_until: null,
      close_deadline_at: null,
      receipt_id: null,
      draft_revision: null,
      movement_id: null,
      fail_reason: null,
      warnings: [],
      created_at: now,
      updated_at: now,
      ingests: [{
        line_event_id: evt,
        line_timestamp_ms: Number(args.p_line_timestamp_ms),
        kind: "header",
        raw_text: String(args.p_raw_text),
        ingest_ordinal: 1,
        line_message_id: (args.p_line_message_id as string | null) ?? null,
        raw_message_id: (args.p_raw_message_id as string | null) ?? null,
      }],
    };
    sessions.set(row.id, row);
    lineEventToSession.set(evt, row.id);
    return {
      opened: true, idempotent: false, reason: "opened",
      session_id: row.id, session_generation: row.session_generation, status: row.status, ingest_revision: row.ingest_revision,
    };
  }

  function requireSession(id: unknown): FakeSessionRow {
    const s = sessions.get(String(id));
    if (!s) fail("purchase capture session not found");
    return s;
  }

  function checkGeneration(s: FakeSessionRow, expected: unknown) {
    if (s.session_generation !== expected) fail("generation_conflict");
  }

  function handleAdmit(args: Record<string, unknown>): Json {
    const s = requireSession(args.p_session_id);
    checkGeneration(s, args.p_expected_generation);
    if (s.source_id !== args.p_expected_source_id || s.sender_line_user_id !== args.p_expected_sender_line_user_id) {
      fail("ownership_mismatch");
    }
    const evt = String(args.p_line_event_id);
    // Global line_event_id identity (admit_purchase_capture_event's real
    // behavior): the SAME LINE event redelivered — even one originally used
    // to open the session — is idempotent, never a second ingest row.
    const owningSession = lineEventToSession.get(evt);
    if (owningSession !== undefined) {
      if (owningSession !== s.id) fail("line_event_conflict");
      return { accepted: true, inserted: false, reason: "duplicate_event", session_id: s.id, ingest_revision: s.ingest_revision, status: s.status };
    }
    lineEventToSession.set(evt, s.id);
    s.ingests.push({
      line_event_id: evt,
      line_timestamp_ms: Number(args.p_line_timestamp_ms),
      kind: String(args.p_kind),
      raw_text: String(args.p_raw_text),
      ingest_ordinal: s.ingests.length + 1,
      line_message_id: (args.p_line_message_id as string | null) ?? null,
      raw_message_id: (args.p_raw_message_id as string | null) ?? null,
    });
    s.ingest_revision += 1;
    s.updated_at = new Date().toISOString();
    if (args.p_kind === "close") {
      s.status = "closing";
      s.close_event_timestamp_ms = Number(args.p_line_timestamp_ms);
      // Quiet/deadline already elapsed — this fake proves wiring, not the
      // real DB-authoritative timing (proven in integration-slice-c2.pg.test.ts).
      s.close_quiet_until = new Date(0).toISOString();
      s.close_deadline_at = new Date(0).toISOString();
    }
    return { accepted: true, inserted: true, reason: "accepted", session_id: s.id };
  }

  function handleCloseOpenEvent(args: Record<string, unknown>): Json {
    const s = requireSession(args.p_session_id);
    checkGeneration(s, args.p_expected_generation);
    s.status = "closing";
    s.close_event_timestamp_ms = s.ingests[0]?.line_timestamp_ms ?? 0;
    s.close_quiet_until = new Date(0).toISOString();
    s.close_deadline_at = new Date(0).toISOString();
    s.updated_at = new Date().toISOString();
    return { idempotent: false, session_id: s.id };
  }

  function handleCandidate(args: Record<string, unknown>): Json {
    const s = requireSession(args.p_session_id);
    checkGeneration(s, args.p_expected_generation);
    return {
      session_id: s.id,
      session_generation: s.session_generation,
      status: s.status,
      ingest_revision: s.ingest_revision,
      ingest_set_hash: `hash-${s.ingest_revision}`,
      close_event_timestamp_ms: s.close_event_timestamp_ms,
      close_quiet_until: s.close_quiet_until,
      close_deadline_at: s.close_deadline_at,
      quiet_elapsed: true,
      deadline_elapsed: false,
      eligible_for_finalize: s.status === "closing",
      ingests: s.ingests,
    };
  }

  function handleFinalize(args: Record<string, unknown>): Json {
    const s = requireSession(args.p_session_id);
    checkGeneration(s, args.p_expected_generation);

    // Short-circuit is handled at the TypeScript layer (finalizer.ts checks
    // candidate.status === "awaiting_confirmation" before ever calling this
    // RPC again) — so by the time this fake is reached a SECOND time for the
    // same session, status must already be something this RPC accepts.
    if (s.status !== "closing") fail("invalid_state");

    if (args.p_assembly_status === "failed") {
      s.status = "failed_closed";
      s.fail_reason = (args.p_fail_reason_or_null as string | null) ?? "assembly_failed";
      s.updated_at = new Date().toISOString();
      return { ok: true, idempotent: false, status: "failed_closed", session_id: s.id, fail_reason: s.fail_reason };
    }

    s.status = "awaiting_confirmation";
    s.receipt_id = String(args.p_receipt_id_or_null);
    s.draft_revision = Number(args.p_draft_revision_or_null);
    s.updated_at = new Date().toISOString();
    createNotificationParts(
      s.id,
      "preview_ready",
      String(s.draft_revision),
      (args.p_preview_payload_texts_or_null as string[]) ?? [],
    );
    return {
      ok: true, idempotent: false, status: "awaiting_confirmation",
      session_id: s.id, receipt_id: s.receipt_id, draft_revision: String(s.draft_revision),
    };
  }

  function handleCancel(args: Record<string, unknown>): Json {
    const s = requireSession(args.p_session_id);
    checkGeneration(s, args.p_expected_generation);
    if (s.status === "cancelled") return { ok: true, idempotent: true, session_id: s.id, status: s.status };
    if (!["open", "closing", "awaiting_confirmation"].includes(s.status)) fail("invalid_state");
    s.status = "cancelled";
    return { ok: true, idempotent: false, session_id: s.id, status: s.status };
  }

  function handleBegin(args: Record<string, unknown>): Json {
    const s = requireSession(args.p_session_id);
    checkGeneration(s, args.p_expected_generation);
    if (s.status !== "awaiting_confirmation") fail("invalid_state");
    if (
      s.receipt_id !== args.p_expected_receipt_id
      || String(s.draft_revision) !== String(args.p_expected_draft_revision)
    ) {
      fail("stale_revision");
    }
    s.status = "confirming";
    s.updated_at = new Date().toISOString();
    return {
      ok: true, idempotent: false, session_id: s.id, status: "confirming",
      receipt_id: s.receipt_id, draft_revision: String(s.draft_revision),
    };
  }

  function handleComplete(args: Record<string, unknown>): Json {
    const s = requireSession(args.p_session_id);
    checkGeneration(s, args.p_expected_generation);
    const texts = args.p_posted_success_payload_texts as string[];
    if (s.status === "posted") {
      if (s.movement_id !== args.p_movement_id) fail("invalid_state");
      const key = notifKey(s.id, "posted_success", String(args.p_movement_id));
      const existing = notifications.get(key);
      if (existing) {
        const changed = existing.length !== texts.length || existing.some((p, i) => p.payload_text !== texts[i]);
        if (changed) fail("notification_identity_conflict");
      }
      createNotificationParts(s.id, "posted_success", String(args.p_movement_id), texts);
      return { ok: true, idempotent: true, session_id: s.id, status: "posted", movement_id: s.movement_id, notification: { created: false } };
    }
    if (s.status !== "confirming") fail("invalid_state");
    createNotificationParts(s.id, "posted_success", String(args.p_movement_id), texts);
    s.status = "posted";
    s.movement_id = String(args.p_movement_id);
    s.updated_at = new Date().toISOString();
    return { ok: true, idempotent: false, session_id: s.id, status: "posted", movement_id: s.movement_id, notification: { created: true } };
  }

  function handleUpsertDraft(args: Record<string, unknown>): Json {
    const key = `${args.p_document_namespace}:${args.p_document_key}`;
    let receipt = receiptsByDocKey.has(key) ? receiptsById.get(receiptsByDocKey.get(key)!) : undefined;
    if (!receipt) {
      receipt = {
        id: randomUUID(),
        documentNamespace: String(args.p_document_namespace),
        documentKey: String(args.p_document_key),
        status: "draft",
        draftRevision: 1,
        businessDate: String(args.p_business_date),
        sourceType: String(args.p_source_type),
        sourceId: String(args.p_source_id),
        senderLineUserId: String(args.p_sender_line_user_id),
        items: [],
      };
      receiptsById.set(receipt.id, receipt);
      receiptsByDocKey.set(key, receipt.id);
    } else {
      receipt.draftRevision += 1;
    }
    const items = args.p_items as Array<Record<string, unknown>>;
    receipt.items = items.map((item) => ({
      id: randomUUID(),
      productKey: String(item.product_key),
      rawProductText: String(item.raw_product_text),
      productIdentityStatus: String(item.product_identity_status ?? "RESOLVED"),
      quantity: String(item.quantity),
      unitKey: String(item.unit_key),
      rawUnit: String(item.raw_unit),
      unitIdentityStatus: String(item.unit_identity_status ?? "RESOLVED"),
      unitCost: item.unit_cost == null ? null : String(item.unit_cost),
      priceUnitText: item.price_unit_text == null ? null : String(item.price_unit_text),
      priceUnitStatus: String(item.price_unit_status ?? "NOT_APPLICABLE"),
    }));
    return {
      receipt_id: receipt.id,
      document_namespace: receipt.documentNamespace,
      document_key: receipt.documentKey,
      status: receipt.status,
      draft_revision: String(receipt.draftRevision),
      item_count: receipt.items.length,
    };
  }

  function requireReceipt(id: unknown): FakeReceipt {
    const r = receiptsById.get(String(id));
    if (!r) fail("purchase receipt not found");
    return r;
  }

  function handleConfirm(args: Record<string, unknown>): Json {
    const receipt = requireReceipt(args.p_receipt_id);
    if (receipt.status === "confirmed") {
      if (receipt.confirmationKey !== args.p_confirmation_key) {
        fail("already confirmed under a different confirmation_key");
      }
      return { ...buildConfirmationRow(receipt), replayed: true };
    }
    if (receipt.status !== "draft") fail("receipt cannot be confirmed");
    if (
      args.p_expected_draft_revision != null
      && String(args.p_expected_draft_revision) !== String(receipt.draftRevision)
    ) {
      fail("draft_revision moved underneath the caller");
    }
    receipt.status = "confirmed";
    receipt.confirmationKey = String(args.p_confirmation_key);
    return { ...buildConfirmationRow(receipt), replayed: false };
  }

  function handleGetConfirmation(args: Record<string, unknown>): Json {
    const receipt = requireReceipt(args.p_receipt_id);
    if (receipt.status !== "confirmed") fail("purchase receipt not found");
    return buildConfirmationRow(receipt);
  }

  function handleBuildConfirmationPayload(args: Record<string, unknown>): Json {
    const receipt = requireReceipt(args.p_receipt_id);
    return buildPayloadForReceipt(receipt);
  }

  function handlePost(args: Record<string, unknown>): Json {
    const receipt = requireReceipt(args.p_receipt_id);
    if (receipt.status !== "confirmed") fail("receipt is not confirmed");
    const dedupeKey = `purchase-receipt-confirmation:v1:${receipt.id}:${HASH}`;
    const existing = movementByReceipt.get(receipt.id);
    if (existing) {
      return {
        movement_id: existing.id, receipt_id: receipt.id, dedupe_key: dedupeKey,
        line_count: receipt.items.length, replayed: true, reversed_by_movement_id: null,
        posting_locked_at: "2026-08-01T00:00:00.000Z", posting_locked_by: "p2c-inventory-ledger",
      };
    }
    const movement = { id: randomUUID() };
    movementByReceipt.set(receipt.id, movement);
    return {
      movement_id: movement.id, receipt_id: receipt.id, dedupe_key: dedupeKey,
      line_count: receipt.items.length, replayed: false, reversed_by_movement_id: null,
      posting_locked_at: "2026-08-01T00:00:00.000Z", posting_locked_by: "p2c-inventory-ledger",
    };
  }

  function findPart(id: unknown): { key: string; part: NotificationPart } {
    for (const [key, parts] of notifications.entries()) {
      const part = parts.find((p) => p.id === id);
      if (part) return { key, part };
    }
    fail("notification part not found");
  }

  function handleClaim(args: Record<string, unknown>): Json {
    const key = notifKey(String(args.p_session_id), String(args.p_notification_kind), String(args.p_notification_version));
    const parts = notifications.get(key) ?? [];
    const next = parts.find((p) => p.delivery_status !== "delivered" && p.delivery_status !== "superseded");
    if (!next) return { claimed: false, reason: "nothing_eligible" };
    next.delivery_status = "sending";
    next.claim_token = randomUUID();
    return {
      claimed: true, id: next.id, part_index: next.part_index, part_count: next.part_count,
      retry_key: next.retry_key, payload_text: next.payload_text, claim_token: next.claim_token,
    };
  }

  function handleMarkDelivered(args: Record<string, unknown>): Json {
    const { part } = findPart(args.p_notification_part_id);
    if (part.claim_token !== args.p_claim_token) fail("claim_token_mismatch");
    part.delivery_status = "delivered";
    part.claim_token = null;
    return { ok: true, id: part.id, delivery_status: "delivered" };
  }

  function handleRecordAttempt(args: Record<string, unknown>): Json {
    const { part } = findPart(args.p_notification_part_id);
    if (part.claim_token !== args.p_claim_token) fail("claim_token_mismatch");
    part.delivery_status = "failed";
    part.claim_token = null;
    return { ok: true, id: part.id, delivery_status: "failed" };
  }

  const handlers: Record<string, (args: Record<string, unknown>) => Json> = {
    open_purchase_capture_session: handleOpen,
    admit_purchase_capture_event: handleAdmit,
    close_purchase_capture_open_event: handleCloseOpenEvent,
    get_purchase_capture_finalize_candidate: handleCandidate,
    finalize_purchase_capture_session: handleFinalize,
    cancel_purchase_capture_session: handleCancel,
    begin_purchase_capture_confirmation: handleBegin,
    complete_purchase_capture_posting: handleComplete,
    upsert_purchase_receipt_draft: handleUpsertDraft,
    confirm_purchase_receipt: handleConfirm,
    get_purchase_receipt_confirmation: handleGetConfirmation,
    purchase_receipt_build_confirmation_payload: handleBuildConfirmationPayload,
    post_purchase_receipt_inventory_movement: handlePost,
    claim_next_purchase_capture_notification_part: handleClaim,
    mark_purchase_capture_notification_part_delivered: handleMarkDelivered,
    record_purchase_capture_notification_part_attempt: handleRecordAttempt,
  };

  function fromSessionsTable() {
    const filters: { eq: Record<string, unknown>; inStatus?: string[] } = { eq: {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (col: string, val: unknown) => { filters.eq[col] = val; return api; };
    api.in = (col: string, vals: string[]) => { if (col === "status") filters.inStatus = vals; return api; };
    api.order = () => api;
    api.limit = () => api;
    api.maybeSingle = async () => {
      let rows = [...sessions.values()];
      for (const [k, v] of Object.entries(filters.eq)) rows = rows.filter((r) => (r as Record<string, unknown>)[k] === v);
      if (filters.inStatus) rows = rows.filter((r) => filters.inStatus!.includes(r.status));
      return { data: rows[0] ?? null, error: null };
    };
    return api;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = {
    from(table: string) {
      callLog.push({ name: `from:${table}` });
      if (table === "purchase_intake_product_registry") {
        return { select: () => Promise.resolve({ data: PRODUCT_REGISTRY, error: null }) };
      }
      if (table === "purchase_intake_unit_alias_registry") {
        return { select: () => Promise.resolve({ data: UNIT_REGISTRY, error: null }) };
      }
      if (table === "purchase_capture_sessions") return fromSessionsTable();
      throw new Error(`unexpected table ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      callLog.push({ name: `rpc:${name}`, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected rpc ${name}`);
      return Promise.resolve().then(() => {
        try {
          return { data: handler(args), error: null };
        } catch (error) {
          return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
        }
      });
    },
  };

  const push = async (to: string, text: string, retryKey?: string) => {
    pushCalls.push({ to, text, retryKey });
    return { status: "delivered" as const };
  };

  return { supabase, sessions, receiptsById, callLog, pushCalls, push };
}

function rpcNames(callLog: Array<{ name: string }>): string[] {
  return callLog.filter((c) => c.name.startsWith("rpc:")).map((c) => c.name.slice(4));
}

function rpcCallCount(callLog: Array<{ name: string }>, name: string): number {
  return rpcNames(callLog).filter((n) => n === name).length;
}

function baseOwnership() {
  return { sourceType: SOURCE_TYPE, sourceId: SOURCE_ID, senderLineUserId: SENDER_ID };
}

async function runFullOpenItemClose(env: ReturnType<typeof makeFullFakeSupabase>, eventPrefix: string) {
  const { supabase, push } = env;
  const opened = await tryHandlePurchaseCaptureMessage(
    supabase,
    { ...baseOwnership(), lineEventId: `${eventPrefix}-open`, lineTimestampMs: 1_700_000_000_000, text: HEADER_TEXT, enabled: true },
    push,
  );
  expect(opened?.action).toBe("opened");
  const sessionId = opened!.sessionId!;

  const itemResult = await tryHandlePurchaseCaptureMessage(
    supabase,
    { ...baseOwnership(), lineEventId: `${eventPrefix}-item`, lineTimestampMs: 1_700_000_001_000, text: ITEM_TEXT, enabled: true },
    push,
  );
  expect(itemResult?.action).toBe("admitted");

  const costsResult = await tryHandlePurchaseCaptureMessage(
    supabase,
    { ...baseOwnership(), lineEventId: `${eventPrefix}-costs`, lineTimestampMs: 1_700_000_001_500, text: COSTS_TEXT, enabled: true },
    push,
  );
  expect(costsResult?.action).toBe("admitted");

  const closeResult = await tryHandlePurchaseCaptureMessage(
    supabase,
    { ...baseOwnership(), lineEventId: `${eventPrefix}-close`, lineTimestampMs: 1_700_000_002_000, text: CLOSE_TEXT, enabled: true },
    push,
  );
  expect(closeResult?.action).toBe("closed");

  const admitCall = env.callLog.find((c) => c.name === "rpc:admit_purchase_capture_event" && c.args?.p_kind === "close");
  expect(admitCall).toBeDefined();

  return { sessionId };
}

describe("end-to-end: full purchase-capture app path (real modules, fake Supabase)", () => {
  test("header -> item -> close -> finalizer produces awaiting_confirmation + preview_ready -> confirm posts -> posted_success delivered exactly once", async () => {
    const env = makeFullFakeSupabase();
    const { sessionId } = await runFullOpenItemClose(env, "e2e-happy");

    const session = env.sessions.get(sessionId)!;
    expect(session.status).toBe("closing");

    const finalizeResult = await finalizePurchaseCaptureSession(
      env.supabase,
      { sessionId, expectedGeneration: session.session_generation },
      env.push,
    );
    expect(finalizeResult.status).toBe("awaiting_confirmation");
    expect(session.status).toBe("awaiting_confirmation");
    expect(session.receipt_id).toBeTruthy();
    expect(session.draft_revision).toBeTruthy();

    const receipt = env.receiptsById.get(session.receipt_id as string)!;
    expect(receipt.items).toHaveLength(1);
    expect(receipt.items[0]?.productIdentityStatus).toBe("RESOLVED");
    expect(receipt.items[0]?.unitIdentityStatus).toBe("RESOLVED");

    // preview_ready delivered inline by the finalizer.
    expect(env.pushCalls.length).toBe(1);
    expect(env.pushCalls[0]?.to).toBe(SOURCE_ID);

    // ยืนยันซื้อ drives confirm-flow through to outcome:"posted".
    const confirmResult = await tryHandlePurchaseCaptureMessage(
      env.supabase,
      { ...baseOwnership(), lineEventId: "e2e-happy-confirm", lineTimestampMs: 1_700_000_003_000, text: PURCHASE_CAPTURE_CONFIRM_COMMAND, enabled: true },
      env.push,
    );
    expect(confirmResult?.action).toBe("confirmed");
    expect(confirmResult?.replyTexts).toEqual([]);
    expect(session.status).toBe("posted");
    expect(session.movement_id).toBeTruthy();

    // posted_success delivered exactly once through the SAME push worker.
    expect(env.pushCalls.length).toBe(2);
    expect(env.pushCalls[1]?.to).toBe(SOURCE_ID);
    expect(env.pushCalls[1]?.text).toContain("ยืนยันใบซื้อแล้ว");

    expect(rpcCallCount(env.callLog, "begin_purchase_capture_confirmation")).toBe(1);
    expect(rpcCallCount(env.callLog, "confirm_purchase_receipt")).toBe(1);
    expect(rpcCallCount(env.callLog, "post_purchase_receipt_inventory_movement")).toBe(1);
    expect(rpcCallCount(env.callLog, "complete_purchase_capture_posting")).toBe(1);
  }, 20_000);

  test("duplicate LINE webhook (same lineEventId delivered twice) is one logical effect — no second ingest, no second session", async () => {
    const env = makeFullFakeSupabase();
    const params = { ...baseOwnership(), lineEventId: "e2e-dup-open", lineTimestampMs: 1_700_000_000_000, text: HEADER_TEXT, enabled: true };

    const first = await tryHandlePurchaseCaptureMessage(env.supabase, params, env.push);
    const second = await tryHandlePurchaseCaptureMessage(env.supabase, params, env.push);

    expect(first?.action).toBe("opened");
    // The session now exists, so the redelivered event is routed through the
    // content-admit path (not re-opened) — but admit_purchase_capture_event's
    // own global line_event_id identity makes it a no-op: no second ingest
    // row, no second session, no ingest_revision bump.
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(env.sessions.size).toBe(1);
    const session = env.sessions.get(first!.sessionId!)!;
    expect(session.ingests).toHaveLength(1);
    expect(session.ingest_revision).toBe(1);
  });

  test("duplicate close and duplicate finalizer invocation: idempotent, no second draft revision", async () => {
    const env = makeFullFakeSupabase();
    const { sessionId } = await runFullOpenItemClose(env, "e2e-dupfin");
    const session = env.sessions.get(sessionId)!;

    // duplicate close: same lineEventId re-admitted -> no second ingest/status flip.
    const closeAgain = await tryHandlePurchaseCaptureMessage(
      env.supabase,
      { ...baseOwnership(), lineEventId: "e2e-dupfin-close", lineTimestampMs: 1_700_000_002_000, text: CLOSE_TEXT, enabled: true },
      env.push,
    );
    expect(closeAgain?.action).toBe("closed");
    expect(session.ingests).toHaveLength(4); // header + item + costs + close, never 5 (the redelivered close is deduped)

    // duplicate finalizer invocation.
    const first = await finalizePurchaseCaptureSession(env.supabase, { sessionId, expectedGeneration: session.session_generation }, env.push);
    const draftRevisionAfterFirst = session.draft_revision;
    const second = await finalizePurchaseCaptureSession(env.supabase, { sessionId, expectedGeneration: session.session_generation }, env.push);

    expect(first.status).toBe("awaiting_confirmation");
    expect(second.status).toBe("awaiting_confirmation");
    if (second.status !== "awaiting_confirmation") throw new Error("unreachable");
    expect(second.idempotent).toBe(true);
    expect(session.draft_revision).toBe(draftRevisionAfterFirst);

    // The finalizer short-circuits on the second call — draft creation and
    // session finalization each ran exactly once.
    expect(rpcCallCount(env.callLog, "upsert_purchase_receipt_draft")).toBe(1);
    expect(rpcCallCount(env.callLog, "finalize_purchase_capture_session")).toBe(1);
  }, 20_000);

  test("duplicate confirm: second ยืนยันซื้อ takes the posted-replay path — post_purchase_receipt_inventory_movement is NOT called a second time", async () => {
    const env = makeFullFakeSupabase();
    const { sessionId } = await runFullOpenItemClose(env, "e2e-dupconfirm");
    const session = env.sessions.get(sessionId)!;
    await finalizePurchaseCaptureSession(env.supabase, { sessionId, expectedGeneration: session.session_generation }, env.push);

    const confirmParams = (eventId: string) => ({
      ...baseOwnership(), lineEventId: eventId, lineTimestampMs: 1_700_000_003_000, text: PURCHASE_CAPTURE_CONFIRM_COMMAND, enabled: true,
    });

    const firstConfirm = await tryHandlePurchaseCaptureMessage(env.supabase, confirmParams("e2e-dupconfirm-c1"), env.push);
    expect(firstConfirm?.action).toBe("confirmed");
    expect(session.status).toBe("posted");

    const secondConfirm = await tryHandlePurchaseCaptureMessage(env.supabase, confirmParams("e2e-dupconfirm-c2"), env.push);
    expect(secondConfirm?.action).toBe("confirm_replayed");

    expect(rpcCallCount(env.callLog, "begin_purchase_capture_confirmation")).toBe(1);
    expect(rpcCallCount(env.callLog, "confirm_purchase_receipt")).toBe(1);
    expect(rpcCallCount(env.callLog, "post_purchase_receipt_inventory_movement")).toBe(1);
    expect(rpcCallCount(env.callLog, "complete_purchase_capture_posting")).toBe(2); // fresh + idempotent replay
  }, 20_000);

  test("feature flag absent -> null, zero Supabase calls; flag enabled -> routing works — same fixture text", async () => {
    const env = makeFullFakeSupabase();
    const disabled = await tryHandlePurchaseCaptureMessage(
      env.supabase,
      { ...baseOwnership(), lineEventId: "e2e-flag-off", lineTimestampMs: 1_700_000_000_000, text: HEADER_TEXT, enabled: false },
      env.push,
    );
    expect(disabled).toBeNull();
    expect(env.callLog).toEqual([]);

    const envEnabled = makeFullFakeSupabase();
    const enabled = await tryHandlePurchaseCaptureMessage(
      envEnabled.supabase,
      { ...baseOwnership(), lineEventId: "e2e-flag-on", lineTimestampMs: 1_700_000_000_000, text: HEADER_TEXT, enabled: true },
      envEnabled.push,
    );
    expect(enabled?.action).toBe("opened");
    expect(envEnabled.callLog.length).toBeGreaterThan(0);
  });

  test("the single durable sending path: content only ever leaves through the injected push, posted_success content never rides the reply acks", async () => {
    const env = makeFullFakeSupabase();
    const { sessionId } = await runFullOpenItemClose(env, "e2e-sending");
    const session = env.sessions.get(sessionId)!;
    await finalizePurchaseCaptureSession(env.supabase, { sessionId, expectedGeneration: session.session_generation }, env.push);

    const confirmResult = await tryHandlePurchaseCaptureMessage(
      env.supabase,
      { ...baseOwnership(), lineEventId: "e2e-sending-confirm", lineTimestampMs: 1_700_000_003_000, text: PURCHASE_CAPTURE_CONFIRM_COMMAND, enabled: true },
      env.push,
    );

    // Two durable parts delivered (preview_ready, posted_success), both
    // through the one injected push — never through replyTexts.
    expect(env.pushCalls).toHaveLength(2);
    expect(env.pushCalls.some((c) => c.text.includes("ยืนยันใบซื้อแล้ว"))).toBe(true);
    // The confirm command's own reply is a short ack (empty on success) —
    // the posted_success CONTENT is never in it.
    expect(confirmResult?.replyTexts).toEqual([]);
    for (const replyText of confirmResult?.replyTexts ?? []) {
      expect(replyText).not.toContain("ยืนยันใบซื้อแล้ว");
    }
  }, 20_000);
});

describe("end-to-end: finalization sweep runs all three stages (real modules, empty backlog)", () => {
  test("sweepPurchaseCaptureFinalization queries closing sessions, then stuck-confirming sessions, then posted_success backlog, in order", async () => {
    const callLog: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = {
      from(table: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api: any = {};
        api.select = () => api;
        api.eq = (col: string, val: unknown) => {
          callLog.push(`${table}.eq(${col}=${val})`);
          return api;
        };
        api.neq = () => api;
        api.or = () => api;
        api.lt = () => api;
        api.order = () => api;
        api.limit = async () => ({ data: [], error: null });
        api.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
        return api;
      },
      rpc: () => Promise.resolve({ data: null, error: { message: "unexpected rpc" } }),
    };
    const push = async () => ({ status: "delivered" as const });

    const result = await sweepPurchaseCaptureFinalization(supabase, push, 25);

    expect(result.due).toBe(0);
    expect(result.confirmingDue).toBe(0);
    expect(result.postedSuccessDelivered).toBe(0);
    expect(result.errors).toBe(0);

    // Stage 1 (finalizeDuePurchaseCaptureSessions) queries closing sessions
    // first, THEN stage 2 (recoverStuckConfirmingSessions) queries confirming
    // sessions, and stage 3 reuses listUndeliveredNotificationWork again —
    // the ordering below is exactly stage1 -> stage2 -> stage3.
    const sessionStatusQueries = callLog.filter((c) => c.startsWith("purchase_capture_sessions.eq(status="));
    expect(sessionStatusQueries[0]).toBe("purchase_capture_sessions.eq(status=closing)");
    expect(sessionStatusQueries[1]).toBe("purchase_capture_sessions.eq(status=confirming)");
  });
});
