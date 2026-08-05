/**
 * P2B Purchase Capture Slice A — durable session + ingest/close-barrier service.
 *
 * Does NOT parse purchase documents (Slice B).
 * Does NOT write purchase_receipts drafts or transition to
 * awaiting_confirmation/confirming/posted (Slice B/C).
 * Open/admit/close/candidate/cancel go through service_role SECURITY DEFINER RPCs.
 *
 * Barrier timing is DB-authoritative (clock_timestamp): quiet 8s / deadline 30s,
 * mirroring the Physical Inventory session/barrier pattern this design adapts
 * (src/lib/physical-inventory/session-service.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

type Supabase = SupabaseClient<Database>;

/** Matches the Physical Inventory / Produce close barrier (plan §8.2). */
export const PURCHASE_CAPTURE_CLOSE_QUIET_MS = 8_000;
export const PURCHASE_CAPTURE_CLOSE_DEADLINE_MS = 30_000;

export type PurchaseCaptureSessionStatus =
  | "open"
  | "closing"
  | "awaiting_confirmation"
  | "confirming"
  | "posted"
  | "failed_closed"
  | "cancelled";

export type PurchaseCaptureIngestKind = "header" | "item" | "costs" | "close" | "other";

export type PurchaseCaptureSessionRow =
  Database["public"]["Tables"]["purchase_capture_sessions"]["Row"];
export type PurchaseCaptureIngestRow =
  Database["public"]["Tables"]["purchase_capture_session_ingests"]["Row"];

export type PurchaseCaptureFinalizeCandidate = {
  sessionId: string;
  sessionGeneration: string;
  status: PurchaseCaptureSessionStatus;
  ingestRevision: number;
  ingestSetHash: string;
  closeEventTimestampMs: number | null;
  closeQuietUntil: string | null;
  closeDeadlineAt: string | null;
  quietElapsed: boolean;
  deadlineElapsed: boolean;
  eligibleForFinalize: boolean;
  ingests: Array<{
    line_event_id: string;
    line_timestamp_ms: number;
    kind: PurchaseCaptureIngestKind;
    raw_text: string;
    ingest_ordinal: number;
    line_message_id?: string | null;
    raw_message_id?: string | null;
  }>;
};

export class PurchaseCaptureGenerationConflictError extends Error {
  constructor(message = "generation_conflict") {
    super(message);
    this.name = "PurchaseCaptureGenerationConflictError";
  }
}

export class PurchaseCaptureSessionClosedError extends Error {
  constructor(message = "session_closed") {
    super(message);
    this.name = "PurchaseCaptureSessionClosedError";
  }
}

export class PurchaseCaptureAfterCloseBoundaryError extends Error {
  constructor(message = "after_close_boundary") {
    super(message);
    this.name = "PurchaseCaptureAfterCloseBoundaryError";
  }
}

export class PurchaseCaptureLineEventConflictError extends Error {
  constructor(message = "line_event_conflict") {
    super(message);
    this.name = "PurchaseCaptureLineEventConflictError";
  }
}

export class PurchaseCaptureInvalidStateError extends Error {
  constructor(message = "invalid_state") {
    super(message);
    this.name = "PurchaseCaptureInvalidStateError";
  }
}

export class PurchaseCaptureStaleIngestRevisionError extends Error {
  constructor(message = "stale_ingest_revision") {
    super(message);
    this.name = "PurchaseCaptureStaleIngestRevisionError";
  }
}

export class PurchaseCaptureStaleIngestHashError extends Error {
  constructor(message = "stale_ingest_hash") {
    super(message);
    this.name = "PurchaseCaptureStaleIngestHashError";
  }
}

export class PurchaseCaptureCloseQuietWindowError extends Error {
  constructor(message = "close_quiet_window") {
    super(message);
    this.name = "PurchaseCaptureCloseQuietWindowError";
  }
}

export class PurchaseCaptureStaleRevisionError extends Error {
  constructor(message = "stale_revision") {
    super(message);
    this.name = "PurchaseCaptureStaleRevisionError";
  }
}

export class PurchaseCaptureReceiptNotDraftError extends Error {
  constructor(message = "receipt_not_draft") {
    super(message);
    this.name = "PurchaseCaptureReceiptNotDraftError";
  }
}

export class PurchaseCaptureOwnershipMismatchError extends Error {
  constructor(message = "ownership_mismatch") {
    super(message);
    this.name = "PurchaseCaptureOwnershipMismatchError";
  }
}

/** Shared ownership re-check every mutating (and the one reading) RPC below requires. */
type PurchaseCaptureExpectedOwnership = {
  expectedSourceType: "user" | "group" | "room";
  expectedSourceId: string;
  expectedSenderLineUserId: string;
};

function mapRpcError(
  message: string,
  kind: "open" | "admit" | "close" | "candidate" | "cancel",
): Error {
  if (message.includes("generation_conflict")) return new PurchaseCaptureGenerationConflictError();
  if (message.includes("ownership_mismatch")) return new PurchaseCaptureOwnershipMismatchError();
  if (message.includes("session_closed")) return new PurchaseCaptureSessionClosedError();
  if (message.includes("after_close_boundary") || message.includes("deadline_elapsed")) {
    return new PurchaseCaptureAfterCloseBoundaryError(
      message.includes("deadline_elapsed") ? "deadline_elapsed" : "after_close_boundary",
    );
  }
  if (message.includes("line_event_conflict")) return new PurchaseCaptureLineEventConflictError();
  if (message.includes("invalid_state")) return new PurchaseCaptureInvalidStateError();
  if (message.includes("stale_ingest_revision")) return new PurchaseCaptureStaleIngestRevisionError();
  if (message.includes("stale_ingest_hash")) return new PurchaseCaptureStaleIngestHashError();
  if (message.includes("close_quiet_window")) return new PurchaseCaptureCloseQuietWindowError();
  if (message.includes("stale_revision") || message.includes("draft_revision moved")) {
    return new PurchaseCaptureStaleRevisionError();
  }
  if (message.includes("receipt_not_draft")) return new PurchaseCaptureReceiptNotDraftError();
  return new Error(`${kind} failed: ${message}`);
}

export class PurchaseCaptureSessionService {
  constructor(private readonly supabase: Supabase) {}

  async findOpenSession(
    sourceId: string,
    senderLineUserId: string,
  ): Promise<PurchaseCaptureSessionRow | null> {
    const sender = senderLineUserId.trim();
    if (!sender) throw new Error("sender_line_user_id required");
    const { data, error } = await this.supabase
      .from("purchase_capture_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("sender_line_user_id", sender)
      .in("status", ["open", "closing", "awaiting_confirmation", "confirming"])
      .maybeSingle();
    if (error) throw new Error(`findOpenSession failed: ${error.message}`);
    return data;
  }

  async getSession(sessionId: string): Promise<PurchaseCaptureSessionRow | null> {
    const { data, error } = await this.supabase
      .from("purchase_capture_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw new Error(`getSession failed: ${error.message}`);
    return data;
  }

  /**
   * Atomic open via RPC. Same opened LINE event → idempotent same session.
   * A different sender/source's already-active session → distinct `already_open`.
   */
  async openSession(params: {
    sourceType: "user" | "group" | "room";
    sourceId: string;
    senderLineUserId: string;
    openedLineEventId: string;
    lineTimestampMs: number;
    rawText: string;
    lineMessageId?: string | null;
    rawMessageId?: string | null;
  }): Promise<{
    opened: boolean;
    idempotent: boolean;
    reason: string;
    session: PurchaseCaptureSessionRow;
  }> {
    const sender = params.senderLineUserId.trim();
    if (!sender) throw new Error("sender_line_user_id required");
    const eventId = params.openedLineEventId.trim();
    if (!eventId) throw new Error("opened_line_event_id required");

    const { data, error } = await this.supabase.rpc("open_purchase_capture_session", {
      p_source_type: params.sourceType,
      p_source_id: params.sourceId,
      p_sender_line_user_id: sender,
      p_opened_line_event_id: eventId,
      p_line_timestamp_ms: params.lineTimestampMs,
      p_raw_text: params.rawText,
      p_line_message_id: params.lineMessageId ?? null,
      p_raw_message_id: params.rawMessageId ?? null,
    });

    if (error) throw mapRpcError(error.message ?? "", "open");

    const row = data as { opened: boolean; idempotent: boolean; reason: string; session_id: string };
    const session = await this.getSession(row.session_id);
    if (!session) throw new Error("session missing after open");
    return { opened: row.opened, idempotent: row.idempotent, reason: row.reason, session };
  }

  /** Admit a LINE event via RPC (close-boundary aware, globally idempotent). */
  async registerIngest(params: {
    sessionId: string;
    expectedGeneration: string;
    lineEventId: string;
    lineTimestampMs: number;
    lineMessageId?: string | null;
    rawMessageId?: string | null;
    kind: PurchaseCaptureIngestKind;
    rawText: string;
  } & PurchaseCaptureExpectedOwnership): Promise<{
    accepted: boolean;
    inserted: boolean;
    reason: string;
    session: PurchaseCaptureSessionRow;
  }> {
    const { data, error } = await this.supabase.rpc("admit_purchase_capture_event", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_expected_source_type: params.expectedSourceType,
      p_expected_source_id: params.expectedSourceId,
      p_expected_sender_line_user_id: params.expectedSenderLineUserId,
      p_line_event_id: params.lineEventId,
      p_line_timestamp_ms: params.lineTimestampMs,
      p_kind: params.kind,
      p_raw_text: params.rawText,
      p_line_message_id: params.lineMessageId ?? null,
      p_raw_message_id: params.rawMessageId ?? null,
    });

    if (error) throw mapRpcError(error.message ?? "", "admit");

    const row = data as { accepted: boolean; inserted: boolean; reason: string; session_id: string };
    const session = await this.getSession(row.session_id);
    if (!session) throw new Error("session missing after admit");
    return { accepted: row.accepted, inserted: row.inserted, reason: row.reason, session };
  }

  /** Close a complete document carried entirely by its already-persisted open event. */
  async closeOpenEvent(params: {
    sessionId: string;
    expectedGeneration: string;
    openedLineEventId: string;
  } & PurchaseCaptureExpectedOwnership): Promise<{ idempotent: boolean; session: PurchaseCaptureSessionRow }> {
    const { data, error } = await this.supabase.rpc("close_purchase_capture_open_event", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_expected_source_type: params.expectedSourceType,
      p_expected_source_id: params.expectedSourceId,
      p_expected_sender_line_user_id: params.expectedSenderLineUserId,
      p_opened_line_event_id: params.openedLineEventId,
    });
    if (error) throw mapRpcError(error.message ?? "", "close");
    const row = data as { idempotent: boolean; session_id: string };
    const session = await this.getSession(row.session_id);
    if (!session) throw new Error("session missing after inline close");
    return { idempotent: row.idempotent, session };
  }

  async getFinalizeCandidate(params: {
    sessionId: string;
    expectedGeneration: string;
  } & PurchaseCaptureExpectedOwnership): Promise<PurchaseCaptureFinalizeCandidate> {
    const { data, error } = await this.supabase.rpc("get_purchase_capture_finalize_candidate", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_expected_source_type: params.expectedSourceType,
      p_expected_source_id: params.expectedSourceId,
      p_expected_sender_line_user_id: params.expectedSenderLineUserId,
    });
    if (error) throw mapRpcError(error.message ?? "", "candidate");
    const row = data as {
      session_id: string;
      session_generation: string;
      status: PurchaseCaptureSessionStatus;
      ingest_revision: number;
      ingest_set_hash: string;
      close_event_timestamp_ms: number | null;
      close_quiet_until: string | null;
      close_deadline_at: string | null;
      quiet_elapsed: boolean;
      deadline_elapsed: boolean;
      eligible_for_finalize: boolean;
      ingests: PurchaseCaptureFinalizeCandidate["ingests"];
    };
    return {
      sessionId: row.session_id,
      sessionGeneration: row.session_generation,
      status: row.status,
      ingestRevision: Number(row.ingest_revision),
      ingestSetHash: row.ingest_set_hash,
      closeEventTimestampMs: row.close_event_timestamp_ms,
      closeQuietUntil: row.close_quiet_until,
      closeDeadlineAt: row.close_deadline_at,
      quietElapsed: row.quiet_elapsed,
      deadlineElapsed: row.deadline_elapsed,
      eligibleForFinalize: row.eligible_for_finalize,
      ingests: row.ingests ?? [],
    };
  }

  /** Cancel from open/closing/awaiting_confirmation; idempotent if already cancelled. */
  async cancelSession(params: {
    sessionId: string;
    expectedGeneration: string;
  } & PurchaseCaptureExpectedOwnership): Promise<{ idempotent: boolean; session: PurchaseCaptureSessionRow }> {
    const { data, error } = await this.supabase.rpc("cancel_purchase_capture_session", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_expected_source_type: params.expectedSourceType,
      p_expected_source_id: params.expectedSourceId,
      p_expected_sender_line_user_id: params.expectedSenderLineUserId,
    });
    if (error) throw mapRpcError(error.message ?? "", "cancel");
    const row = data as { idempotent: boolean; session_id: string };
    const session = await this.getSession(row.session_id);
    if (!session) throw new Error("session missing after cancel");
    return { idempotent: row.idempotent, session };
  }

  async finalizeSession(params: {
    sessionId: string;
    expectedGeneration: string;
    expectedSourceType: "user" | "group" | "room";
    expectedSourceId: string;
    expectedSenderLineUserId: string;
    expectedIngestRevision: number;
    expectedIngestHash: string;
    assemblyStatus: "success" | "failed";
    receiptId?: string | null;
    draftRevision?: string | null;
    previewPayloadTexts?: readonly string[] | null;
    failReason?: string | null;
  }): Promise<{
    ok: boolean;
    idempotent: boolean;
    status: PurchaseCaptureSessionStatus;
    sessionId: string;
    receiptId?: string;
    draftRevision?: string;
    failReason?: string | null;
  }> {
    const { data, error } = await this.supabase.rpc("finalize_purchase_capture_session", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_expected_source_type: params.expectedSourceType,
      p_expected_source_id: params.expectedSourceId,
      p_expected_sender_line_user_id: params.expectedSenderLineUserId,
      p_expected_ingest_revision: params.expectedIngestRevision,
      p_expected_ingest_hash: params.expectedIngestHash,
      p_assembly_status: params.assemblyStatus,
      p_receipt_id_or_null: params.receiptId ?? null,
      p_draft_revision_or_null: params.draftRevision ? Number(params.draftRevision) : null,
      p_preview_payload_texts_or_null: params.previewPayloadTexts
        ? [...params.previewPayloadTexts]
        : null,
      p_fail_reason_or_null: params.failReason ?? null,
    });
    if (error) throw mapRpcError(error.message ?? "", "candidate");
    const row = data as Record<string, unknown>;
    return {
      ok: row.ok === true,
      idempotent: row.idempotent === true,
      status: row.status as PurchaseCaptureSessionStatus,
      sessionId: String(row.session_id),
      receiptId: row.receipt_id == null ? undefined : String(row.receipt_id),
      draftRevision: row.draft_revision == null ? undefined : String(row.draft_revision),
      failReason: row.fail_reason == null ? null : String(row.fail_reason),
    };
  }

  async replaceDraft(params: {
    sessionId: string;
    expectedGeneration: string;
    expectedReceiptId: string;
    expectedDraftRevision: string;
    sourceType: "user" | "group" | "room";
    sourceId: string;
    senderLineUserId: string;
    draftPayload: Record<string, unknown>;
    previewPayloadTexts: readonly string[];
  }): Promise<{
    sessionId: string;
    status: PurchaseCaptureSessionStatus;
    receiptId: string;
    draftRevision: string;
  }> {
    const { data, error } = await this.supabase.rpc("replace_purchase_capture_draft", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_expected_receipt_id: params.expectedReceiptId,
      p_expected_draft_revision: Number(params.expectedDraftRevision),
      p_source_type: params.sourceType,
      p_source_id: params.sourceId,
      p_sender_line_user_id: params.senderLineUserId,
      p_draft_payload: params.draftPayload as Json,
      p_preview_payload_texts: [...params.previewPayloadTexts],
    });
    if (error) throw mapRpcError(error.message ?? "", "candidate");
    const row = data as Record<string, unknown>;
    return {
      sessionId: String(row.session_id),
      status: row.status as PurchaseCaptureSessionStatus,
      receiptId: String(row.receipt_id),
      draftRevision: String(row.draft_revision),
    };
  }
}

/** Slice B extends Slice A with parser adapter, draft finalization, and outbox delivery. */
export const PURCHASE_CAPTURE_SLICE = "B" as const;
