/**
 * P2A Slice B — Physical Stock session + persistence service.
 *
 * Does NOT route LINE webhooks (Slice C).
 * Does NOT write produce_sessions / produce_items / inventory ledger.
 * Finalization goes through finalize_physical_inventory_session RPC.
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

export class PhysicalInventorySessionService {
  constructor(private readonly supabase: Supabase) {}

  async findOpenSession(
    sourceId: string,
    senderLineUserId: string,
  ): Promise<PhysicalInventorySessionRow | null> {
    const { data, error } = await this.supabase
      .from("physical_inventory_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("sender_line_user_id", senderLineUserId)
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

  /**
   * Open a new Physical Stock session for source + sender.
   * Fails soft if another open/closing session already exists for that pair.
   */
  async openSession(params: {
    sourceType: string;
    sourceId: string;
    senderLineUserId: string;
    businessDate?: string | null;
    parserVersion?: string;
    headerRawMessageId?: string | null;
  }): Promise<{ opened: boolean; session: PhysicalInventorySessionRow; reason?: "already_open" }> {
    const existing = await this.findOpenSession(params.sourceId, params.senderLineUserId);
    if (existing) {
      return { opened: false, session: existing, reason: "already_open" };
    }

    const { data, error } = await this.supabase
      .from("physical_inventory_sessions")
      .insert({
        source_type: params.sourceType,
        source_id: params.sourceId,
        sender_line_user_id: params.senderLineUserId,
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
   * Idempotent LINE event ingest. Duplicate line_event_id for the same session is a no-op.
   * Stale appends after finalized/failed_closed raise AfterClose.
   * Generation pin prevents cross-sender/generation confusion.
   */
  async registerIngest(params: {
    sessionId: string;
    expectedGeneration: string;
    lineEventId: string;
    lineMessageId?: string | null;
    rawMessageId?: string | null;
    kind: "header" | "item" | "close" | "other";
    rawText: string;
  }): Promise<{ inserted: boolean; session: PhysicalInventorySessionRow }> {
    const session = await this.getSession(params.sessionId);
    if (!session) throw new Error("session not found");
    if (session.session_generation !== params.expectedGeneration) {
      throw new PhysicalInventoryGenerationConflictError();
    }
    if (session.status === "finalized" || session.status === "failed_closed" || session.status === "voided") {
      throw new PhysicalInventoryAfterCloseError();
    }

    const { data: existing } = await this.supabase
      .from("physical_inventory_session_ingests")
      .select("id")
      .eq("session_id", params.sessionId)
      .eq("line_event_id", params.lineEventId)
      .maybeSingle();
    if (existing) {
      return { inserted: false, session };
    }

    const nextRev = Number(session.ingest_revision) + 1;
    const { error: insErr } = await this.supabase
      .from("physical_inventory_session_ingests")
      .insert({
        session_id: params.sessionId,
        line_event_id: params.lineEventId,
        line_message_id: params.lineMessageId ?? null,
        raw_message_id: params.rawMessageId ?? null,
        kind: params.kind,
        raw_text: params.rawText,
        ingest_revision: nextRev,
      });
    if (insErr) {
      // Unique race → treat as idempotent
      if (insErr.code === "23505") {
        const fresh = await this.getSession(params.sessionId);
        return { inserted: false, session: fresh! };
      }
      throw new Error(`registerIngest failed: ${insErr.message}`);
    }

    const patch: Database["public"]["Tables"]["physical_inventory_sessions"]["Update"] = {
      ingest_revision: nextRev,
      updated_at: new Date().toISOString(),
    };
    if (params.kind === "close") {
      patch.status = "closing";
      patch.close_requested_at = new Date().toISOString();
      patch.close_line_event_id = params.lineEventId;
      if (params.rawMessageId) patch.close_raw_message_id = params.rawMessageId;
    }
    if (params.kind === "header" && params.rawMessageId) {
      patch.header_raw_message_id = params.rawMessageId;
    }

    const { data: updated, error: updErr } = await this.supabase
      .from("physical_inventory_sessions")
      .update(patch)
      .eq("id", params.sessionId)
      .eq("session_generation", params.expectedGeneration)
      .in("status", ["open", "closing"])
      .select("*")
      .single();

    if (updErr) throw new Error(`registerIngest session update failed: ${updErr.message}`);
    return { inserted: true, session: updated };
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
   * Never creates a partial finalized snapshot.
   */
  async finalize(params: {
    sessionId: string;
    expectedGeneration: string;
    expectedIngestRevision: number;
    parsed: PhysicalInventoryParsedSession;
    failClosed?: boolean;
    failReason?: string;
  }): Promise<{
    ok: boolean;
    idempotent: boolean;
    status: "finalized" | "failed_closed";
    snapshotId: string | null;
    sessionId: string;
    failReason?: string | null;
    itemCount?: number;
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
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("generation_conflict")) {
        throw new PhysicalInventoryGenerationConflictError();
      }
      if (msg.includes("stale_ingest_revision")) {
        throw new PhysicalInventoryStaleRevisionError();
      }
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
    };

    return {
      ok: row.ok,
      idempotent: row.idempotent,
      status: row.status,
      snapshotId: row.snapshot_id,
      sessionId: row.session_id,
      failReason: row.fail_reason,
      itemCount: row.item_count,
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
