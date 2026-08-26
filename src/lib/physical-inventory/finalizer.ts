import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { houseStockImmediateRetryKey } from "@/lib/summary/daily-stock-cron";
import { parsePhysicalInventoryDocument } from "./parse";
import {
  buildHouseStockInvalidMessage,
  buildHouseStockReport,
} from "./house-stock-report";
import { HOUSE_STOCK_PRICED_PARSER_VERSION } from "./types";
import {
  PHYSICAL_INVENTORY_CLOSE_DEADLINE_MS,
  PhysicalInventoryCloseQuietWindowError,
  PhysicalInventorySessionService,
  PhysicalInventoryStaleIngestHashError,
  PhysicalInventoryStaleRevisionError,
  type PhysicalInventorySessionRow,
} from "./session-service";

type Supabase = SupabaseClient<Database>;
type PushMessage = (
  to: string,
  text: string,
  retryKey?: string,
) => Promise<unknown>;
type PhysicalInventoryFinalizationGateway = Pick<
  PhysicalInventorySessionService,
  "getFinalizeCandidate" | "finalize" | "getSession" | "getSnapshot" | "listSnapshotItems"
>;

const DEFAULT_SWEEP_LIMIT = 25;
const MAX_STALE_RETRIES = 3;
const RECENT_TERMINAL_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type PhysicalInventoryFinalizerResult =
  | { status: "finalized"; sessionId: string; idempotent: boolean }
  | { status: "failed_closed"; sessionId: string; idempotent: boolean }
  | { status: "pending"; sessionId: string; reason: string }
  | { status: "skipped"; sessionId: string; reason: string };

export interface PhysicalInventoryFinalizerRun {
  due: number;
  finalized: number;
  failedClosed: number;
  pending: number;
  skipped: number;
  errors: number;
}

function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

export function buildPhysicalInventorySuccessMessage(params: {
  businessDate: string;
  itemCount: number;
  rejectedCount: number;
}): string {
  const lines = [
    `บันทึกสต๊อกผลไม้คงเหลือวันที่ ${formatBusinessDate(params.businessDate)} แล้ว ✅`,
    `รับทั้งหมด ${params.itemCount} รายการ`,
  ];
  if (params.rejectedCount > 0) {
    lines.push(
      `⚠️ มี ${params.rejectedCount} รายการที่อ่านไม่สมบูรณ์และไม่ได้ยืนยันเป็นสต๊อกที่ใช้ได้`,
    );
  }
  return lines.join("\n");
}

export function buildPhysicalInventoryFailedMessage(reason: string | null): string {
  const detail = reason === "missing_or_invalid_date"
    ? "ไม่พบวันที่หรือรูปแบบวันที่ไม่ถูกต้อง"
    : reason === "missing_header"
      ? "ไม่พบหัวรายการสต๊อก"
      : reason === "no_items"
        ? "ไม่พบรายการผลไม้ที่บันทึกได้"
        : reason === "explicit_empty_conflict"
          ? "ระบุว่าไม่มีผลไม้คงเหลือและมีสินค้าในรายการเดียวกัน"
          : "ข้อมูลรายการไม่สมบูรณ์";
  return `ปิดรายการสต๊อกผลไม้ไม่สำเร็จ: ${detail} กรุณาเริ่มรายการใหม่และตรวจสอบข้อมูลอีกครั้ง`;
}

function candidateDocument(
  ingests: Array<{ raw_text: string }>,
): string {
  return ingests.map((ingest) => ingest.raw_text).join("\n");
}

async function closeRawMessageProcessed(
  supabase: Supabase,
  rawMessageId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("raw_messages")
    .select("is_processed")
    .eq("id", rawMessageId)
    .maybeSingle();
  if (error) throw new Error(`close raw message lookup failed: ${error.message}`);
  return data?.is_processed === true;
}

async function markCloseRawMessageProcessed(
  supabase: Supabase,
  rawMessageId: string,
): Promise<void> {
  const { error } = await supabase
    .from("raw_messages")
    .update({ is_processed: true })
    .eq("id", rawMessageId)
    .eq("is_processed", false);
  if (error) throw new Error(`close raw message completion failed: ${error.message}`);
}

async function deliverTerminalMessage(
  supabase: Supabase,
  session: PhysicalInventorySessionRow,
  push: PushMessage,
  service: PhysicalInventoryFinalizationGateway,
): Promise<void> {
  if (!session.close_raw_message_id) {
    throw new Error("terminal Physical Inventory session has no close raw message");
  }
  if (await closeRawMessageProcessed(supabase, session.close_raw_message_id)) return;

  let messages: string[];
  if (session.status === "finalized" && session.snapshot_id) {
    const snapshot = await service.getSnapshot(session.snapshot_id);
    if (!snapshot) throw new Error("finalized Physical Inventory snapshot not found");
    if (snapshot.parser_version === HOUSE_STOCK_PRICED_PARSER_VERSION) {
      const items = await service.listSnapshotItems(snapshot.id);
      messages = buildHouseStockReport(snapshot.business_date, items).messages;
    } else {
      messages = [buildPhysicalInventorySuccessMessage({
        businessDate: snapshot.business_date,
        itemCount: snapshot.item_count,
        rejectedCount: snapshot.rejected_count,
      })];
    }
  } else if (session.status === "failed_closed") {
    const warningObjects = Array.isArray(session.warnings)
      ? session.warnings.filter((warning) =>
        Boolean(warning) && typeof warning === "object" && !Array.isArray(warning))
        .map((warning) => warning as { [key: string]: unknown })
      : [];
    const invalidItems = warningObjects
      .filter((warning) => warning.code === "invalid_item")
      .map((warning) => ({
        sequence: typeof warning.sequence === "number" ? warning.sequence : null,
        reason: typeof warning.reason === "string" ? warning.reason : null,
      }));
    messages = invalidItems.length
      ? [buildHouseStockInvalidMessage(invalidItems)]
      : [buildPhysicalInventoryFailedMessage(session.fail_reason)];
  } else {
    return;
  }

  // session_generation is a UUID and therefore a valid LINE retry key.
  // If delivery succeeded but the worker died before the raw-message marker,
  // recovery sends the same retry key and LINE returns already_accepted rather
  // than delivering a duplicate.
  for (const [index, message] of messages.entries()) {
    await push(
      session.source_id,
      message,
      session.parser_version === HOUSE_STOCK_PRICED_PARSER_VERSION
        ? houseStockImmediateRetryKey(session.session_generation, index)
        : session.session_generation,
    );
  }
  await markCloseRawMessageProcessed(supabase, session.close_raw_message_id);
}

export async function finalizePhysicalInventorySession(
  supabase: Supabase,
  params: { sessionId: string; expectedGeneration: string },
  push: PushMessage = pushLineMessage,
  gateway?: PhysicalInventoryFinalizationGateway,
): Promise<PhysicalInventoryFinalizerResult> {
  const service = gateway ?? new PhysicalInventorySessionService(supabase);

  for (let attempt = 1; attempt <= MAX_STALE_RETRIES; attempt += 1) {
    const candidate = await service.getFinalizeCandidate(params);

    if (candidate.status === "finalized" || candidate.status === "failed_closed") {
      const terminal = await service.getSession(candidate.sessionId);
      if (terminal) await deliverTerminalMessage(supabase, terminal, push, service);
      return {
        status: candidate.status,
        sessionId: candidate.sessionId,
        idempotent: true,
      };
    }
    if (candidate.status !== "closing") {
      return {
        status: "skipped",
        sessionId: candidate.sessionId,
        reason: "not_closing",
      };
    }

    const activeSession = await service.getSession(candidate.sessionId);
    const priced = activeSession?.parser_version === HOUSE_STOCK_PRICED_PARSER_VERSION;
    const parsed = parsePhysicalInventoryDocument(candidateDocument(candidate.ingests), {
      requireUnitPrice: priced,
    });
    const hasInvalidPricedItem = priced
      && parsed.items.some((item) => item.resolutionStatus === "REJECTED");
    const emptyConflict = parsed.errors.some((error) => error.code === "explicit_empty_conflict");
    const emptyWithoutDeclaration = parsed.items.length === 0 && !parsed.explicitEmpty;
    const failClosed = hasInvalidPricedItem || emptyConflict || emptyWithoutDeclaration;
    const failReason = hasInvalidPricedItem
      ? "invalid_items"
      : emptyConflict
        ? "explicit_empty_conflict"
        : emptyWithoutDeclaration
          ? "no_items"
          : undefined;

    try {
      const result = await service.finalize({
        sessionId: candidate.sessionId,
        expectedGeneration: candidate.sessionGeneration,
        expectedIngestRevision: candidate.ingestRevision,
        expectedIngestHash: candidate.ingestSetHash,
        parsed,
        failClosed,
        failReason,
      });
      const terminal = await service.getSession(candidate.sessionId);
      if (terminal) await deliverTerminalMessage(supabase, terminal, push, service);
      return {
        status: result.status,
        sessionId: candidate.sessionId,
        idempotent: result.idempotent,
      };
    } catch (error) {
      if (
        error instanceof PhysicalInventoryStaleRevisionError
        || error instanceof PhysicalInventoryStaleIngestHashError
      ) {
        if (attempt < MAX_STALE_RETRIES) continue;
        return {
          status: "pending",
          sessionId: candidate.sessionId,
          reason: "stale_candidate_retry_exhausted",
        };
      }
      if (error instanceof PhysicalInventoryCloseQuietWindowError) {
        return {
          status: "pending",
          sessionId: candidate.sessionId,
          reason: "close_quiet_window",
        };
      }
      throw error;
    }
  }

  return {
    status: "pending",
    sessionId: params.sessionId,
    reason: "bounded_retry_exhausted",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prompt post-response attempt. Next.js `after()` keeps this invocation alive
 * after LINE receives its webhook acknowledgement. The database remains the
 * clock authority; a separate cron sweep recovers any interrupted invocation.
 */
export async function finalizePhysicalInventoryAfterClose(
  supabase: Supabase,
  params: { sessionId: string; expectedGeneration: string },
  push: PushMessage = pushLineMessage,
): Promise<PhysicalInventoryFinalizerResult> {
  const service = new PhysicalInventorySessionService(supabase);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= PHYSICAL_INVENTORY_CLOSE_DEADLINE_MS + 5_000) {
    const candidate = await service.getFinalizeCandidate(params);
    if (candidate.status !== "closing") {
      return finalizePhysicalInventorySession(supabase, params, push);
    }

    const quietAt = candidate.closeQuietUntil
      ? Date.parse(candidate.closeQuietUntil)
      : Date.now();
    const deadlineAt = candidate.closeDeadlineAt
      ? Date.parse(candidate.closeDeadlineAt)
      : quietAt;
    const dueAt = Math.min(quietAt, deadlineAt);
    const waitMs = dueAt - Date.now();
    if (waitMs > 0) await delay(Math.min(waitMs, 1_000));

    const result = await finalizePhysicalInventorySession(supabase, params, push);
    if (result.status !== "pending") return result;
    if (result.reason !== "close_quiet_window") return result;
  }

  return {
    status: "pending",
    sessionId: params.sessionId,
    reason: "background_deadline_elapsed",
  };
}

async function listDueClosingSessions(
  supabase: Supabase,
  limit: number,
): Promise<PhysicalInventorySessionRow[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("physical_inventory_sessions")
    .select("*")
    .eq("status", "closing")
    .or(`close_quiet_until.lte.${now},close_deadline_at.lte.${now}`)
    .order("close_requested_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`due Physical Inventory lookup failed: ${error.message}`);
  return data ?? [];
}

async function listRecentTerminalSessions(
  supabase: Supabase,
  limit: number,
): Promise<PhysicalInventorySessionRow[]> {
  const since = new Date(Date.now() - RECENT_TERMINAL_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("physical_inventory_sessions")
    .select("*")
    .in("status", ["finalized", "failed_closed"])
    .gte("closed_at", since)
    .not("close_raw_message_id", "is", null)
    .order("closed_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`terminal Physical Inventory lookup failed: ${error.message}`);
  return data ?? [];
}

export async function finalizeDuePhysicalInventorySessions(
  supabase: Supabase,
  push: PushMessage = pushLineMessage,
  limit = DEFAULT_SWEEP_LIMIT,
): Promise<PhysicalInventoryFinalizerRun> {
  const [closing, terminal] = await Promise.all([
    listDueClosingSessions(supabase, limit),
    listRecentTerminalSessions(supabase, limit),
  ]);
  const sessions = new Map<string, PhysicalInventorySessionRow>();
  for (const session of [...closing, ...terminal]) sessions.set(session.id, session);

  const run: PhysicalInventoryFinalizerRun = {
    due: sessions.size,
    finalized: 0,
    failedClosed: 0,
    pending: 0,
    skipped: 0,
    errors: 0,
  };

  for (const session of sessions.values()) {
    try {
      const result = session.status === "closing"
        ? await finalizePhysicalInventorySession(
          supabase,
          {
            sessionId: session.id,
            expectedGeneration: session.session_generation,
          },
          push,
        )
        : (await deliverTerminalMessage(
          supabase,
          session,
          push,
          new PhysicalInventorySessionService(supabase),
        ), {
          status: session.status,
          sessionId: session.id,
          idempotent: true,
        } as const);

      if (result.status === "finalized") run.finalized += 1;
      else if (result.status === "failed_closed") run.failedClosed += 1;
      else if (result.status === "pending") run.pending += 1;
      else run.skipped += 1;
    } catch (error) {
      run.errors += 1;
      logger.error("Physical Inventory finalizer failed", {
        sessionId: session.id,
        sessionGeneration: session.session_generation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return run;
}
