/**
 * P2A Slice B — Physical Stock session + persistence service.
 *
 * Does NOT route LINE webhooks (Slice C).
 * Does NOT write produce_sessions / produce_items / inventory ledger.
 * Admit/finalize go through service_role RPCs with close-barrier + immutability.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import {
  PHYSICAL_INVENTORY_PARSER_VERSION,
  PHYSICAL_INVENTORY_WAREHOUSE_MAIN,
  type PhysicalInventoryParsedItem,
  type PhysicalInventoryParsedSession,
  type PhysicalInventoryParseIssue,
} from "./types";

type Supabase = SupabaseClient<Database>;

/** Quiet window after first close before finalize may run (matches migration default). */
export const PHYSICAL_INVENTORY_CLOSE_QUIET_MS = 8_000;
/** Hard deadline after first close; later admits fail. */
export const PHYSICAL_INVENTORY_CLOSE_DEADLINE_MS = 30_000;

export type PhysicalInventorySessionStatus =
  | "open"
  | "closing"
  | "finalized"
  | "failed_closed"
  | "voided";

export type PhysicalInventorySessionRow =
  Database["public"]["Tables"]["physical_inventory_sessions"]["Row"];
export type PhysicalInventorySnapshotRow =
  Database["public"]["Tables"]["physical_inventory_snapshots"]["Row"];
export type PhysicalInventoryItemRow =
  Database["public"]["Tables"]["physical_inventory_items"]["Row"];

export class PhysicalInventoryGenerationConflictError extends Error {
  constructor(message = "generation_conflict") {
    super(message);
    this.name = "PhysicalInventoryGenerationConflictError";
  }
}

export class PhysicalInventoryStaleRevisionError extends Error {
  constructor(message = "stale_ingest_revision") {
    super(message);
    this.name = "PhysicalInventoryStaleRevisionError";
  }
}

export class PhysicalInventoryAfterCloseError extends Error {
  constructor(message = "session_closed") {
    super(message);
    this.name = "PhysicalInventoryAfterCloseError";
  }
}

export class PhysicalInventoryAfterCloseBoundaryError extends Error {
  constructor(message = "after_close_boundary") {
    super(message);
    this.name = "PhysicalInventoryAfterCloseBoundaryError";
  }
}

export class PhysicalInventoryCloseQuietWindowError extends Error {
  constructor(message = "close_quiet_window") {
    super(message);
    this.name = "PhysicalInventoryCloseQuietWindowError";
  }
}

function issuesToJson(issues: PhysicalInventoryParseIssue[]): Json {
  return issues.map((i) => ({
    code: i.code,
    message: i.message,
    ...(i.line != null ? { line: i.line } : {}),
  })) as unknown as Json;
}

function itemsToJson(items: PhysicalInventoryParsedItem[]): Json {
  return items.map((it) => ({
    staff_sequence: it.sequence,
    raw_text: it.rawText,
    raw_product_description: it.rawProductDescription,
    normalized_product: it.normalizedProduct,
    quantity: it.quantity,
    raw_unit: it.rawUnit,
    normalized_unit: it.normalizedUnit,
    resolution_status: it.resolutionStatus,
    reason: it.reason,
  })) as unknown as Json;
}

function mapAdmitError(message: string): Error {
  if (message.includes("generation_conflict")) return new PhysicalInventoryGenerationConflictError();
  if (message.includes("session_closed")) return new PhysicalInventoryAfterCloseError();
  if (message.includes("after_close_boundary")) return new PhysicalInventoryAfterCloseBoundaryError();
  if (message.includes("deadline_elapsed")) {
    return new PhysicalInventoryAfterCloseBoundaryError("deadline_elapsed");
  }
  return new Error(`admit failed: ${message}`);
}

export class PhysicalInventorySessionService {
  constructor(private readonly supabase: Supabase) {}

  async findOpenSession(
    sourceId: string,
    senderLineUserId: string,
  ): Promise<PhysicalInventorySessionRow | null> {
    const sender = senderLineUserId.trim();
    if (!sender) throw new Error("sender_line_user_id required");
    const { data, error } = await this.supabase
      .from("physical_inventory_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("sender_line_user_id", sender)
      .in("status", ["open", "closing"])
      .maybeSingle();
    if (error) throw new Error(`findOpenSession failed: ${error.message}`);
    return data;
  }

  async getSession(sessionId: string): Promise<PhysicalInventorySessionRow | null> {
    const { data, error } = await this.supabase
      .from("physical_inventory_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw new Error(`getSession failed: ${error.message}`);
    return data;
  }

  async openSession(params: {
    sourceType: string;
    sourceId: string;
    senderLineUserId: string;
    businessDate?: string | null;
    parserVersion?: string;
    headerRawMessageId?: string | null;
  }): Promise<{ opened: boolean; session: PhysicalInventorySessionRow; reason?: "already_open" }> {
    const sender = params.senderLineUserId.trim();
    if (!sender) throw new Error("sender_line_user_id required");

    const existing = await this.findOpenSession(params.sourceId, sender);
    if (existing) {
      return { opened: false, session: existing, reason: "already_open" };
    }

    const { data, error } = await this.supabase
      .from("physical_inventory_sessions")
      .insert({
        source_type: params.sourceType,
        source_id: params.sourceId,
        sender_line_user_id: sender,
        business_date: params.businessDate ?? null,
        warehouse_code: PHYSICAL_INVENTORY_WAREHOUSE_MAIN,
        status: "open",
        parser_version: params.parserVersion ?? PHYSICAL_INVENTORY_PARSER_VERSION,
        header_raw_message_id: params.headerRawMessageId ?? null,
      })
      .select("*")
      .single();

    if (error) throw new Error(`openSession failed: ${error.message}`);
    return { opened: true, session: data };
  }

  /**
   * Admit a LINE event via RPC (close-boundary aware, idempotent).
   */
  async registerIngest(params: {
    sessionId: string;
    expectedGeneration: string;
    lineEventId: string;
    lineTimestampMs: number;
    lineMessageId?: string | null;
    rawMessageId?: string | null;
    kind: "header" | "item" | "close" | "other";
    rawText: string;
    asOf?: string;
    quietMs?: number;
    deadlineMs?: number;
  }): Promise<{
    accepted: boolean;
    inserted: boolean;
    reason: string;
    session: PhysicalInventorySessionRow;
  }> {
    const { data, error } = await this.supabase.rpc("admit_physical_inventory_event", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_line_event_id: params.lineEventId,
      p_line_timestamp_ms: params.lineTimestampMs,
      p_kind: params.kind,
      p_raw_text: params.rawText,
      p_line_message_id: params.lineMessageId ?? null,
      p_raw_message_id: params.rawMessageId ?? null,
      p_quiet_ms: params.quietMs ?? PHYSICAL_INVENTORY_CLOSE_QUIET_MS,
      p_deadline_ms: params.deadlineMs ?? PHYSICAL_INVENTORY_CLOSE_DEADLINE_MS,
      p_as_of: params.asOf ?? new Date().toISOString(),
    });

    if (error) throw mapAdmitError(error.message ?? "");

    const row = data as {
      accepted: boolean;
      inserted: boolean;
      reason: string;
      session_id: string;
    };
    const session = await this.getSession(row.session_id);
    if (!session) throw new Error("session missing after admit");
    return {
      accepted: row.accepted,
      inserted: row.inserted,
      reason: row.reason,
      session,
    };
  }

  async listIngestTexts(sessionId: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .from("physical_inventory_session_ingests")
      .select("raw_text, ingest_revision")
      .eq("session_id", sessionId)
      .order("ingest_revision", { ascending: true });
    if (error) throw new Error(`listIngestTexts failed: ${error.message}`);
    return (data ?? []).map((r) => r.raw_text);
  }

  /**
   * Atomic finalize or fail-closed via RPC.
   * Successful finalize requires close boundary + quiet window elapsed (pass asOf).
   */
  async finalize(params: {
    sessionId: string;
    expectedGeneration: string;
    expectedIngestRevision: number;
    parsed: PhysicalInventoryParsedSession;
    failClosed?: boolean;
    failReason?: string;
    /** Clock for quiet-window checks (ISO). Tests advance this past quiet. */
    asOf?: string;
  }): Promise<{
    ok: boolean;
    idempotent: boolean;
    status: "finalized" | "failed_closed";
    snapshotId: string | null;
    sessionId: string;
    failReason?: string | null;
    itemCount?: number;
    countedAt?: string | null;
  }> {
    const failClosed =
      params.failClosed === true ||
      !params.parsed.businessDate ||
      params.parsed.items.length === 0 ||
      params.parsed.errors.some((e) =>
        ["missing_header", "missing_or_invalid_date"].includes(e.code),
      );

    const { data, error } = await this.supabase.rpc("finalize_physical_inventory_session", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_expected_ingest_revision: params.expectedIngestRevision,
      p_business_date: params.parsed.businessDate,
      p_parser_version: params.parsed.parserVersion || PHYSICAL_INVENTORY_PARSER_VERSION,
      p_warnings: issuesToJson([
        ...params.parsed.warnings,
        ...params.parsed.errors,
      ]),
      p_items: failClosed ? ([] as unknown as Json) : itemsToJson(params.parsed.items),
      p_fail_closed: failClosed,
      p_fail_reason: failClosed
        ? params.failReason ??
          params.parsed.errors[0]?.code ??
          (!params.parsed.businessDate
            ? "missing_or_invalid_date"
            : params.parsed.items.length === 0
              ? "no_items"
              : "failed_closed")
        : null,
      p_as_of: params.asOf ?? new Date().toISOString(),
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("generation_conflict")) throw new PhysicalInventoryGenerationConflictError();
      if (msg.includes("stale_ingest_revision")) throw new PhysicalInventoryStaleRevisionError();
      if (msg.includes("close_quiet_window")) throw new PhysicalInventoryCloseQuietWindowError();
      throw new Error(`finalize failed: ${msg}`);
    }

    const row = data as {
      ok: boolean;
      idempotent: boolean;
      status: "finalized" | "failed_closed";
      snapshot_id: string | null;
      session_id: string;
      fail_reason?: string | null;
      item_count?: number;
      counted_at?: string | null;
    };

    return {
      ok: row.ok,
      idempotent: row.idempotent,
      status: row.status,
      snapshotId: row.snapshot_id,
      sessionId: row.session_id,
      failReason: row.fail_reason,
      itemCount: row.item_count,
      countedAt: row.counted_at ?? null,
    };
  }

  async getSnapshot(snapshotId: string): Promise<PhysicalInventorySnapshotRow | null> {
    const { data, error } = await this.supabase
      .from("physical_inventory_snapshots")
      .select("*")
      .eq("id", snapshotId)
      .maybeSingle();
    if (error) throw new Error(`getSnapshot failed: ${error.message}`);
    return data;
  }

  async listSnapshotItems(snapshotId: string): Promise<PhysicalInventoryItemRow[]> {
    const { data, error } = await this.supabase
      .from("physical_inventory_items")
      .select("*")
      .eq("snapshot_id", snapshotId)
      .order("item_ordinal", { ascending: true });
    if (error) throw new Error(`listSnapshotItems failed: ${error.message}`);
    return data ?? [];
  }
}

/** Explicit Slice B boundary: void/supersede admin API is NOT implemented here. */
export const PHYSICAL_INVENTORY_VOID_SUPERSEDE_SLICE = "E" as const;
