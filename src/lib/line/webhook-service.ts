import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  LineEvent,
  LineImageMessage,
  LineMessageEvent,
  LineMessage,
  LineTextMessage,
} from "@/lib/line/types";
import type { Database, LineMessageType } from "@/types/database";
import { getSourceId, getUserId, getPendingSessionKey } from "@/lib/line/verify";
import { parserRegistry } from "@/lib/parsers/registry";
import { logger } from "@/lib/logger";
import { replyLineMessage, replyLineMessages, buildWeighSessionSummary } from "@/lib/line/reply";
import {
  parseWeighSession,
  parseBuddhistDate,
  getWeighSessionFinalizationErrors,
  buildWeighSessionValidationReply,
} from "@/lib/parsers/weigh-session/parser";
import { RE } from "@/lib/parsers/weigh-session/regex";
import {
  PendingSessionService,
  PendingSessionAfterCloseBoundaryError,
  PendingSessionClosedError,
  PendingSessionGenerationConflictError,
} from "@/lib/line/pending-session-service";
import { DailySummaryService } from "@/lib/line/daily-summary-service";
import { SessionDedupService } from "@/lib/line/session-dedup-service";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { parseManualSlipAmounts } from "@/lib/parsers/manual-slip-amount";
import { ManualSlipSessionService } from "@/lib/line/manual-slip-session-service";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import type { SlipEvidenceIngestor } from "@/lib/slips/types";
import {
  SlipCheckService,
  type SlipCheckProcessor,
} from "@/lib/slips/check-service";
import { SlipBatchService, type SlipBatchIngestor } from "@/lib/slips/batch-service";
import { tryFinalizeSettlement } from "@/lib/settlement-finalizer";
import { parseRemainingFruitCommandFromMessage } from "@/lib/summary/remaining-fruit-command";
import { fetchRemainingFruitRows } from "@/lib/summary/remaining-fruit-data";
import { buildRemainingFruitMessagesFromRows } from "@/lib/summary/remaining-fruit-message";
import { parseSalesSummaryCommandFromMessage } from "@/lib/sales/command";
import { loadSalesReport } from "@/lib/sales/load";
import { buildSalesSummaryMessages } from "@/lib/sales/message";
import { previousBangkokBusinessDate } from "@/lib/sales/cron";
import {
  SlipSessionService,
  parseSlipSessionHeader,
  isSlipCloseCommand,
  type SlipSessionIngestor,
  type SlipSessionHeader,
} from "@/lib/slips/slip-session-service";
import { parseWhiteSheetCloseCommandFromMessage } from "@/lib/line/white-sheet-close-command";
import { processWhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-service";
import { isPhysicalInventoryLineGroupAllowed } from "@/lib/physical-inventory/config";
import {
  classifyPhysicalInventoryStandaloneIntent,
  isRecognizedPhysicalInventoryItemBlock,
  matchesPhysicalInventoryCloseLine,
  parsePhysicalInventoryDocument,
} from "@/lib/physical-inventory";
import {
  PhysicalInventoryAfterCloseBoundaryError,
  PhysicalInventoryAfterCloseError,
  PhysicalInventoryGenerationConflictError,
  PhysicalInventorySessionService,
} from "@/lib/physical-inventory/session-service";
import { finalizePhysicalInventoryAfterClose } from "@/lib/physical-inventory/finalizer";
import {
  DefaultDataEntrySessionOwnershipResolver,
  type DataEntrySessionOwnershipResolver,
} from "@/lib/line/data-entry-session-ownership";

type Supabase      = SupabaseClient<Database>;
type ChildLogger   = ReturnType<typeof logger.child>;
type ReplyLineMessage = (replyToken: string, text: string) => Promise<void>;
type ReplyLineMessages = (replyToken: string, texts: string[]) => Promise<void>;
type ScheduleBackgroundTask = (task: () => Promise<void>) => void;
type PhysicalInventoryFinalizer = (params: {
  sessionId: string;
  expectedGeneration: string;
}) => Promise<unknown>;
type PhysicalInventorySessionGateway = Pick<
  PhysicalInventorySessionService,
  "findOpenSession" | "openSession" | "registerIngest"
>;

const BATCH_FIRST_IMAGE_REPLY = [
  "รับรูปหลักฐานแล้วครับ",
  "ถ้ามีหลายใบ ส่งต่อได้เลย",
  `พิมพ์ "จบสลิป" เมื่อส่งครบ`,
].join("\n");

const EVIDENCE_FAILED_REPLY = "รับรูปไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง";

const BATCH_FINALIZED_LATE_IMAGE_REPLY =
  "รูปนี้ไม่ถูกรวมในชุดสลิป เนื่องจากระบบเริ่มสรุปแล้ว กรุณาเปิดชุดใหม่ก่อนส่งรูป";

const NO_SESSION_IMAGE_REPLY = [
  "กรุณาพิมพ์หัวชุดสลิปก่อนส่งรูป เช่น",
  "กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569",
].join("\n");

const NO_ACTIVE_BATCH_REPLY = [
  "ยังไม่มีชุดสลิปที่เปิดอยู่",
  "กรุณาพิมพ์หัวชุดก่อน เช่น:",
  "กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569",
].join("\n");

const SESSION_ALREADY_OPEN_REPLY = [
  "มีชุดสลิปที่เปิดอยู่แล้ว",
  `กรุณาพิมพ์ "จบสลิป" ก่อน เพื่อปิดชุดสลิปปัจจุบัน`,
].join("\n");

const SLIP_CLOSE_ACKNOWLEDGED_REPLY =
  "รับคำสั่งจบชุดแล้ว กำลังตรวจสอบสลิปทั้งหมด กรุณารอสรุปผล";

const ALREADY_CLOSING_REPLY = "รับทราบแล้ว กำลังสรุปสลิปอยู่ กรุณารอสักครู่";

const STALE_PRODUCE_SESSION_REPLY =
  "พบรายการเดิมที่ยังปิดไม่สมบูรณ์ กรุณาให้ทีมงานเคลียร์รายการเดิมก่อนเริ่มรายการใหม่";

const NEW_HEADER_REQUIRED_REPLY =
  "ไม่พบรายการที่เปิดอยู่ กรุณาพิมพ์หัวรายการใหม่ก่อนส่งรายการ";

const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";

const PRODUCE_AFTER_BOUNDARY_REPLY =
  "รายการนี้ส่งหลังคำสั่งจบ จึงไม่ถูกรวมในรายการเดิม กรุณาเริ่มหัวรายการใหม่";

interface WebhookServiceDependencies {
  evidenceIngestor?: SlipEvidenceIngestor;
  checkProcessor?: SlipCheckProcessor;
  batchService?: SlipBatchIngestor;
  slipSessionService?: SlipSessionIngestor;
  replyMessage?: ReplyLineMessage;
  replyMessages?: ReplyLineMessages;
  scheduleBackgroundTask?: ScheduleBackgroundTask;
  physicalInventoryFinalizer?: PhysicalInventoryFinalizer;
  physicalInventoryService?: PhysicalInventorySessionGateway;
  dataEntrySessionOwnershipResolver?: DataEntrySessionOwnershipResolver;
}

export interface WebhookProcessResult {
  eventId:   string;
  eventType: string;
  status:    "saved" | "duplicate" | "error";
  parsed?:   boolean;
  error?:    string;
  pendingSessionClosed?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bangkokToday(): string {
  return bangkokBusinessDateNow();
}

function formatPhysicalInventoryBusinessDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function hasSessionEnd(text: string): boolean {
  return text.split("\n").some((l) => RE.SESSION_END.test(l.trim()));
}

export function parseExpectedItemCount(text: string): number | null {
  for (const rawLine of text.split("\n")) {
    const line = normalizeLine(rawLine).trim();
    const raw = line.match(RE.SESSION_END_COUNT)?.[1]
      ?? line.match(RE.ADDITIONAL_END)?.[2];
    if (raw === undefined) continue;
    const count = Number.parseInt(raw, 10);
    return Number.isSafeInteger(count) && count > 0 ? count : null;
  }
  return null;
}

function hasItemLine(text: string): boolean {
  return text.split("\n").some((l) => RE.ITEM.test(l.trim()));
}

// SESSION_END lines like "จบรายการคืน" contain "คืน" which also matches SESSION_START.
// Skip SESSION_END lines before testing so pure closing messages are never treated as headers.
export function hasSessionStart(text: string): boolean {
  return text.split("\n").some((l) => {
    const line = l.trim();
    return !RE.SESSION_END.test(line) && RE.SESSION_START.test(line);
  });
}

function canonicalSessionHeader(line: string): string {
  return normalizeLine(line).trim().replace(/\s+/g, " ");
}

function isProduceSessionHeaderLine(line: string): boolean {
  if (!line || RE.SESSION_END.test(line) || !RE.SESSION_START.test(line)) {
    return false;
  }

  return (
    RE.SELLER_MARKET.test(line)
    || line.startsWith("รายการ")
    || RE.DATE_IN_TEXT.test(line)
  );
}

export function findProduceSessionHeader(text: string): string | null {
  for (const rawLine of text.split("\n")) {
    const line = canonicalSessionHeader(rawLine);
    if (isProduceSessionHeaderLine(line)) return line;
  }
  return null;
}

export function requiresFreshPendingGeneration(
  accumulatedText: string,
  incomingHeader: string,
): boolean {
  const normalizedPending = normalizeText(accumulatedText);
  if (hasSessionEnd(normalizedPending)) return true;

  const expectedHeader = canonicalSessionHeader(incomingHeader);
  const pendingHeaders = normalizedPending
    .split("\n")
    .map(canonicalSessionHeader)
    .filter(isProduceSessionHeaderLine);

  return (
    pendingHeaders.length === 0
    || pendingHeaders.some((header) => header !== expectedHeader)
  );
}

// Strip LINE export prefix "HH:MM sender " or "HH.MM sender " from each line so that
// hasSessionEnd / SESSION_START / ITEM checks work on clean content.
export function normalizeLine(line: string): string {
  return line.replace(/^\d{1,2}[:.]\d{2}\s+\S+\s+/, "");
}

export function normalizeText(text: string): string {
  return text.split("\n").map(normalizeLine).join("\n");
}

// ── Service ───────────────────────────────────────────────────────────────────

export class WebhookService {
  private readonly evidenceIngestor: SlipEvidenceIngestor;
  private readonly checkProcessor: SlipCheckProcessor;
  private readonly batchService: SlipBatchIngestor;
  private readonly slipSessionService: SlipSessionIngestor;
  private readonly replyMessage: ReplyLineMessage;
  private readonly replyMessages: ReplyLineMessages;
  private readonly scheduleBackgroundTask: ScheduleBackgroundTask;
  private readonly physicalInventoryFinalizer: PhysicalInventoryFinalizer;
  private readonly physicalInventoryService: PhysicalInventorySessionGateway;
  private readonly dataEntrySessionOwnershipResolver: DataEntrySessionOwnershipResolver;

  constructor(
    private readonly supabase: Supabase,
    dependencies: WebhookServiceDependencies = {},
  ) {
    this.evidenceIngestor =
      dependencies.evidenceIngestor ?? new SlipEvidenceService(supabase);
    this.checkProcessor =
      dependencies.checkProcessor ?? new SlipCheckService(supabase);
    this.batchService =
      dependencies.batchService ?? new SlipBatchService(supabase);
    this.slipSessionService =
      dependencies.slipSessionService ?? new SlipSessionService(supabase);
    this.replyMessage = dependencies.replyMessage ?? replyLineMessage;
    this.replyMessages = dependencies.replyMessages ?? replyLineMessages;
    this.scheduleBackgroundTask =
      dependencies.scheduleBackgroundTask
      ?? ((task) => {
        void task().catch((error) => {
          logger.error("background webhook task failed", {
            error: error instanceof Error ? error.message : "unknown_error",
          });
        });
      });
    this.physicalInventoryService =
      dependencies.physicalInventoryService
      ?? new PhysicalInventorySessionService(this.supabase);
    this.dataEntrySessionOwnershipResolver =
      dependencies.dataEntrySessionOwnershipResolver
      ?? new DefaultDataEntrySessionOwnershipResolver(
        this.supabase,
        this.physicalInventoryService,
      );
    this.physicalInventoryFinalizer =
      dependencies.physicalInventoryFinalizer
      ?? ((params) => finalizePhysicalInventoryAfterClose(this.supabase, params));
  }

  async processEvents(events: LineEvent[], destination: string): Promise<WebhookProcessResult[]> {
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const results: WebhookProcessResult[] = [];

    for (const [eventIndex, event] of sorted.entries()) {
      results.push(await this.processOne(event, destination, eventIndex, sorted.length));
    }

    return results;
  }

  private async processOne(
    event: LineEvent,
    destination: string,
    eventIndex: number,
    eventCount: number,
  ): Promise<WebhookProcessResult> {
    const eventId = event.webhookEventId;
    const log     = logger.child({
      eventId,
      eventType: event.type,
      eventIndex,
      eventCount,
    });

    log.info("processing event");

    // ── 1. Persist raw event ──────────────────────────────────────────────────
    const rawMessageId = await this.saveRawMessage(event, destination);

    if (rawMessageId === null) {
      log.info("duplicate event — skipped");
      return { eventId, eventType: event.type, status: "duplicate" };
    }
    if (rawMessageId === "error") {
      return { eventId, eventType: event.type, status: "error", error: "db insert failed" };
    }

    log.debug("raw message saved", { rawMessageId });

    // ── 2. Only process text messages ─────────────────────────────────────────
    if (event.type !== "message") {
      log.debug("non-message event — no parsing needed");
      return { eventId, eventType: event.type, status: "saved" };
    }

    const msgEvent = event as LineMessageEvent;
    const message  = msgEvent.message;

    if (message.type === "image") {
      return this.processImageMessage(
        msgEvent,
        message as LineImageMessage,
        rawMessageId,
        eventId,
        log,
      );
    }

    if (message.type !== "text") {
      log.debug("non-text message — skipping parse", { messageType: message.type });
      await this.recordUnsupportedType(rawMessageId, message);
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 3. Test-message shortcut (before any parser) ──────────────────────────
    const text           = (message as LineTextMessage).text;
    const normalizedText = normalizeText(text);
    const replyToken     = msgEvent.replyToken;
    const sourceId       = getSourceId(msgEvent.source);
    const lineUserId     = getUserId(msgEvent.source);


    if (text.trim().toLowerCase() === "test") {
      if (replyToken) await replyLineMessage(replyToken, "Bot รับข้อความได้แล้ว ✅");
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 3.1. P2A Physical Inventory (allowlisted LINE groups only) ───────────
    // This must precede remaining-stock and Produce routing because the
    // Physical Inventory header intentionally contains overlapping fruit/stock
    // vocabulary. Outside the explicit group allowlist this is a no-op.
    const physicalInventoryResult = await this.tryProcessPhysicalInventory(
      msgEvent,
      text,
      message.id,
      rawMessageId,
      eventId,
      event.type,
      log,
    );
    if (physicalInventoryResult !== null) return physicalInventoryResult;

    // ── 3.2. White Sheet close command (high-level control; before session appenders)
    // Must take priority over pending produce append, manual-slip amounts, and
    // weigh/return item text so a full closing message is never misrouted.
    const closeParse = parseWhiteSheetCloseCommandFromMessage(text);
    if (closeParse.kind !== "not_command") {
      return this.processWhiteSheetClose(
        msgEvent,
        closeParse,
        eventId,
        event.type,
        log,
      );
    }

    // ── 3.3. Manual slip session commands ────────────────────────────────────
    // Regex has no ^ anchor — matches even with a sender-name prefix on the line.
    const manualOpenMatch = RE.MANUAL_SLIP_OPEN.exec(text);
    if (manualOpenMatch) {
      // Extract market label: text on the same line before ส่งสลิปมือ.
      const matchStart  = manualOpenMatch.index;
      const lineStart   = text.lastIndexOf("\n", matchStart - 1) + 1;
      const labelRaw    = text.slice(lineStart, matchStart).trim();
      const marketLabel = labelRaw || null;
      const marketKey   = labelRaw.toLowerCase().trim() || "default";
      return this.processManualSlipOpen(
        msgEvent, manualOpenMatch[1], marketLabel, marketKey, text, message.id, eventId, event.type, log,
      );
    }

    if (RE.MANUAL_SLIP_CLOSE.test(text.trim())) {
      return this.processManualSlipClose(msgEvent, message.id, eventId, event.type, log);
    }

    const manualEntryResult = await this.tryAppendManualSlipEntry(
      msgEvent, text, message.id, eventId, event.type, log,
    );
    if (manualEntryResult !== null) return manualEntryResult;

    // Read-only report command — must bypass pending produce-session append/close.
    const remainingCmd = parseRemainingFruitCommandFromMessage(text);
    if (remainingCmd) {
      return this.processRemainingFruitCommand(
        msgEvent,
        remainingCmd,
        eventId,
        event.type,
        log,
      );
    }

    // P1 Daily Sales — read-only, same bypass as the remaining-stock command.
    const salesCmd = parseSalesSummaryCommandFromMessage(text);
    if (salesCmd) {
      return this.processSalesSummaryCommand(msgEvent, salesCmd, eventId, event.type, log);
    }

    // ── 3.5. Slip session commands (checked before produce session logic) ─────
    if (isSlipCloseCommand(text)) {
      return this.processSlipClose(msgEvent, eventId, event.type, log);
    }

    const slipOpenHeader = parseSlipSessionHeader(text);
    if (slipOpenHeader !== null) {
      return this.processSlipOpen(msgEvent, slipOpenHeader, eventId, event.type, log);
    }

    // ── 4. Pending session flow ───────────────────────────────────────────────
    // Group/room sources are shared by every member — a produce event with no
    // userId cannot be attributed to a sender, so it must not be allowed to
    // fall back onto a shared/group-only key (see getPendingSessionKey).
    const pendingSessionKey = getPendingSessionKey(msgEvent.source);
    if (pendingSessionKey === null) {
      log.warn("produce event rejected — group/room source has no userId", {
        sourceType: msgEvent.source.type,
        sourceId,
      });
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }
    const sessionKey = pendingSessionKey;

    const pendingService = new PendingSessionService(this.supabase);
    const lookup = await pendingService.lookup(sessionKey);
    const pending = lookup.session;
    const expired = pending ? pendingService.isExpired(pending) : false;
    log.info("pending session lookup completed", {
      sessionKey,
      sessionFound: Boolean(pending),
      reason: lookup.reason,
      sessionStatus: pending ? (expired ? "stale_active" : "active") : null,
      expiresAt: pending ? pendingService.expiresAt(pending) : null,
      error: lookup.error,
    });

    if (lookup.reason === "db_error") {
      return {
        eventId,
        eventType: event.type,
        status: "error",
        parsed: false,
        error: lookup.error ?? "pending session lookup failed",
      };
    }

    if (pending) {
      const markClose = hasSessionEnd(normalizedText);
      const expectedItemCount = markClose
        ? parseExpectedItemCount(normalizedText)
        : null;
      const incomingHeader = findProduceSessionHeader(normalizedText);

      if (
        incomingHeader
        && !pending.terminalized
        && pending.close_event_timestamp_ms !== null
      ) {
        if (replyToken) await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      let updated;
      if (
        incomingHeader
        && (
          pending.terminalized
          || requiresFreshPendingGeneration(pending.accumulated_text, incomingHeader)
        )
      ) {
        try {
          updated = await pendingService.replaceGeneration({
            sessionKey,
            sourceId,
            expectedSessionGeneration: pending.session_generation,
            text,
            replyToken,
            lineUserId,
            lineEventId: eventId,
            lineTimestampMs: event.timestamp,
            markClose,
            expectedItemCount: expectedItemCount ?? undefined,
          });

          if (!updated) {
            log.warn("pending session generation replacement lost concurrency race", {
              sessionKey,
              staleSessionGeneration: pending.session_generation,
            });
            if (replyToken) {
              await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
            }
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }

          log.info("pending session generation replaced by new header", {
            sessionKey,
            staleSessionGeneration: pending.session_generation,
            replacementSessionGeneration: updated.session_generation,
            incomingHeader,
            markClose,
          });
        } catch (replaceError) {
          const errorMessage = replaceError instanceof Error
            ? replaceError.message
            : String(replaceError);
          log.error("pending session generation replacement failed", {
            sessionKey,
            staleSessionGeneration: pending.session_generation,
            error: errorMessage,
          });
          if (replyToken) {
            try {
              await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
            } catch (replyError) {
              log.error("pending session replacement fail-closed reply failed", {
                error: String(replyError),
              });
            }
          }
          return { eventId, eventType: event.type, status: "saved", parsed: false };
        }
      } else {
        try {
          updated = await pendingService.append(
            sessionKey, text, replyToken, eventId, event.timestamp, markClose,
            pending.session_generation, expectedItemCount ?? undefined,
          );
          const appendParse = parseWeighSession(updated.accumulated_text, bangkokToday());
          log.info("pending session append succeeded", {
            sessionKey,
            appendSuccess: true,
            markClose,
            parsedItemCount: appendParse.items.length,
            parseErrorCount: appendParse.parse_errors.length,
          });
          for (const parseError of appendParse.parse_errors) {
            log.warn("pending session parse error after append", {
              sessionKey,
              rawLine: parseError,
            });
          }
        } catch (appendError) {
          if (
            appendError instanceof PendingSessionGenerationConflictError
            || appendError instanceof PendingSessionClosedError
          ) {
            log.warn("pending session append rejected — generation conflict", {
              sessionKey,
              staleSessionGeneration: pending.session_generation,
              error: appendError.message,
            });
            if (replyToken) {
              try {
                await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
              } catch (replyError) {
                log.error("generation conflict reply failed", { error: String(replyError) });
              }
            }
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }
          if (appendError instanceof PendingSessionAfterCloseBoundaryError) {
            log.info("pending session item rejected after immutable close boundary", {
              sessionKey,
              sessionGeneration: pending.session_generation,
              lineTimestampMs: event.timestamp,
              closeEventTimestampMs: pending.close_event_timestamp_ms,
            });
            if (replyToken) {
              try {
                await this.replyMessage(replyToken, PRODUCE_AFTER_BOUNDARY_REPLY);
              } catch (replyError) {
                log.error("after-boundary rejection reply failed", {
                  error: String(replyError),
                });
              }
            }
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }
          const errorMessage = appendError instanceof Error
            ? appendError.message
            : String(appendError);
          log.error("pending session append failed", {
            sessionKey,
            appendSuccess: false,
            error: errorMessage,
          });
          return {
            eventId,
            eventType: event.type,
            status: "error",
            parsed: false,
            error: errorMessage,
          };
        }
      }

      if (!markClose) {
        log.debug("message appended to pending session — waiting for session end", { sessionKey });
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      log.info("pending session end command received", {
        sessionKey,
        endCommandReceived: true,
        sessionGeneration: updated.session_generation,
        expectedItemCount,
        nextAttemptAt: updated.next_attempt_at,
        closeDeadlineAt: updated.close_deadline_at,
      });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, PRODUCE_CLOSE_PENDING_REPLY);
        } catch (replyError) {
          log.error("produce close acknowledgement failed", {
            error: String(replyError),
          });
        }
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 5. No active pending session ──────────────────────────────────────────
    // Uses the same strict header predicate as rotation (findProduceSessionHeader)
    // so creation and rotation always agree on what counts as a valid header.
    const incomingSessionHeader = findProduceSessionHeader(normalizedText);
    if (incomingSessionHeader !== null) {
      if (RE.ADDITIONAL_HEADER.test(incomingSessionHeader)) {
        // Additional batches never take the legacy direct parser/persist path —
        // even a pasted complete block goes through pending generation →
        // deferred finalizer → authoritative RPC → notification outbox.
        return this.startAdditionalPendingSession(
          msgEvent, pendingService, sessionKey, sourceId, lineUserId,
          text, normalizedText, eventId, log,
        );
      }

      if (hasSessionEnd(normalizedText) || hasItemLine(normalizedText)) {
        // Complete single-message: has SESSION_END or item lines → parse directly
        log.info("single complete message detected (has SESSION_END or items), parsing directly");
        return this.runParser(msgEvent, rawMessageId, eventId, event.type, log);
      }

      // Header-only → start accumulating (store raw text so parser sees TIME_PREFIX sender)
      log.info("session header detected — starting pending session", { sessionKey });
      try {
        await pendingService.create(sessionKey, sourceId, text, replyToken, lineUserId);
      } catch (createErr) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr);
        log.error("pending session create failed", { sessionKey, error: msg });
      }
      // Register the header event in the barrier ledger so its text is counted
      // when the close barrier checks ingest vs admission parity.
      try {
        await pendingService.admit(sessionKey, eventId, event.timestamp);
        await pendingService.registerIngest(sessionKey, eventId, event.timestamp, text);
      } catch (barrierErr) {
        log.warn("pending session header barrier registration failed", {
          sessionKey,
          eventId,
          error: barrierErr instanceof Error ? barrierErr.message : String(barrierErr),
        });
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    if (hasSessionEnd(normalizedText)) {
      log.warn("SESSION_END received without active pending session", { sessionKey });
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    if (hasItemLine(normalizedText)) {
      // An item line with no active session — most commonly a continuation
      // sent after the prior generation was terminalized (parser/validation
      // failure, or fail-closed reconstruction). Must not silently create or
      // append; the sender needs to restart with a fresh header.
      log.info("item line received without active pending session", { sessionKey });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, NEW_HEADER_REQUIRED_REPLY);
        } catch (e) {
          log.error("new-header-required reply failed", { error: String(e) });
        }
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    log.debug("no parser matched text message — left unprocessed");
    return { eventId, eventType: event.type, status: "saved", parsed: false };
  }

  private async tryProcessPhysicalInventory(
    event: LineMessageEvent,
    text: string,
    lineMessageId: string,
    rawMessageId: string,
    eventId: string,
    eventType: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult | null> {
    if (event.source.type !== "group") return null;

    const sourceId = getSourceId(event.source);
    if (!isPhysicalInventoryLineGroupAllowed(sourceId)) return null;

    const standaloneIntent = classifyPhysicalInventoryStandaloneIntent(text);
    const senderLineUserId = getUserId(event.source);
    if (!senderLineUserId) {
      if (standaloneIntent === "header") {
        log.warn("Physical Inventory header ignored — group sender is missing", {
          sourceId,
        });
        return { eventId, eventType, status: "saved", parsed: false };
      }
      return null;
    }

    let ownership;
    try {
      ownership = await this.dataEntrySessionOwnershipResolver.resolve({
        source: event.source,
        sourceId,
        senderLineUserId,
      });
    } catch (error) {
      log.error("interactive data-entry ownership lookup failed", {
        sourceId,
        senderLineUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fail closed for P2A while preserving the established legacy router.
      return null;
    }

    if (ownership.hasOverlap) {
      log.warn("interactive data-entry session overlap detected", {
        sourceId,
        senderLineUserId,
        legacyKinds: ownership.legacyKinds,
        physicalInventorySessionId: ownership.physicalInventorySession?.id,
        legacyProduceSessionId: ownership.legacyProduceSession?.id ?? null,
        legacyManualSlipSessionId: ownership.legacyManualSlipSession?.id ?? null,
      });
    }

    const incomingLegacyHeader =
      findProduceSessionHeader(normalizeText(text)) !== null
      || RE.MANUAL_SLIP_OPEN.test(text);
    if (
      incomingLegacyHeader
      && ownership.physicalInventorySession
      && !ownership.hasLegacySession
    ) {
      await this.markRawMessageProcessed(rawMessageId, log);
      if (event.replyToken) {
        await this.replyMessage(
          event.replyToken,
          "มีรายการสต๊อกผลไม้กำลังเปิดอยู่ กรุณาปิดรายการสต๊อกก่อนเริ่มรายการอื่น",
        );
      }
      log.info("legacy data-entry session open blocked by Physical Inventory owner", {
        sourceId,
        senderLineUserId,
        physicalInventorySessionId: ownership.physicalInventorySession.id,
      });
      return { eventId, eventType, status: "saved", parsed: false };
    }

    // Existing legacy ownership always wins, including defensive overlap.
    // Returning null preserves the established legacy router unchanged.
    if (ownership.hasLegacySession) return null;

    const service = this.physicalInventoryService;
    const replyToken = event.replyToken;

    if (standaloneIntent === "header") {
      const parsed = parsePhysicalInventoryDocument(text);
      try {
        const opened = await service.openSession({
          sourceType: "group",
          sourceId,
          senderLineUserId,
          openedLineEventId: eventId,
          lineTimestampMs: event.timestamp,
          rawText: text,
          lineMessageId,
          rawMessageId,
          businessDate: parsed.businessDate,
        });
        await this.markRawMessageProcessed(rawMessageId, log);

        if (replyToken && opened.opened && !opened.idempotent) {
          const businessDate = parsed.businessDate ?? opened.session.business_date;
          const displayDate = businessDate
            ? formatPhysicalInventoryBusinessDate(businessDate)
            : null;
          await this.replyMessage(
            replyToken,
            displayDate
              ? `เริ่มบันทึกสต๊อกผลไม้คงเหลือวันที่ ${displayDate} แล้ว`
              : "เริ่มรายการแล้ว แต่ไม่พบวันที่ที่ถูกต้อง กรุณาตรวจสอบวันที่ก่อนปิดรายการ",
          );
        }

        log.info("Physical Inventory session opened", {
          sourceId,
          senderLineUserId,
          sessionId: opened.session.id,
          sessionGeneration: opened.session.session_generation,
          opened: opened.opened,
          idempotent: opened.idempotent,
        });
        return { eventId, eventType, status: "saved", parsed: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Physical Inventory open failed", { sourceId, error: message });
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            "เริ่มรายการสต๊อกผลไม้ไม่สำเร็จ กรุณาลองอีกครั้ง",
          );
        }
        return {
          eventId,
          eventType,
          status: "error",
          parsed: false,
          error: message,
        };
      }
    }

    const session = ownership.physicalInventorySession;
    if (!session) return null;

    const close = matchesPhysicalInventoryCloseLine(text);
    const item = !close && isRecognizedPhysicalInventoryItemBlock(text);
    if (!close && !item) return null;

    try {
      const admitted = await service.registerIngest({
        sessionId: session.id,
        expectedGeneration: session.session_generation,
        lineEventId: eventId,
        lineTimestampMs: event.timestamp,
        lineMessageId,
        rawMessageId,
        kind: close ? "close" : "item",
        rawText: text,
      });
      // Item evidence is fully handled once admitted. The close raw-message
      // marker is deliberately held until the terminal LINE push is accepted;
      // that gives the recovery worker a durable delivery checkpoint.
      if (!close) await this.markRawMessageProcessed(rawMessageId, log);

      if (close) {
        this.scheduleBackgroundTask(async () => {
          await this.physicalInventoryFinalizer({
            sessionId: admitted.session.id,
            expectedGeneration: admitted.session.session_generation,
          });
        });
      }

      log.info("Physical Inventory event admitted", {
        sourceId,
        senderLineUserId,
        sessionId: admitted.session.id,
        sessionGeneration: admitted.session.session_generation,
        kind: close ? "close" : "item",
        accepted: admitted.accepted,
        inserted: admitted.inserted,
        reason: admitted.reason,
      });
      return { eventId, eventType, status: "saved", parsed: true };
    } catch (error) {
      if (
        error instanceof PhysicalInventoryAfterCloseBoundaryError
        || error instanceof PhysicalInventoryAfterCloseError
        || error instanceof PhysicalInventoryGenerationConflictError
      ) {
        await this.markRawMessageProcessed(rawMessageId, log);
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            error instanceof PhysicalInventoryAfterCloseBoundaryError
              ? "รายการนี้ส่งหลังคำสั่งจบ จึงไม่ถูกรวมในสต๊อกที่ปิดแล้ว"
              : "รายการสต๊อกนี้ปิดแล้ว กรุณาเริ่มรายการใหม่",
          );
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const message = error instanceof Error ? error.message : String(error);
      log.error("Physical Inventory admission failed", {
        sourceId,
        senderLineUserId,
        sessionId: session.id,
        error: message,
      });
      return {
        eventId,
        eventType,
        status: "error",
        parsed: false,
        error: message,
      };
    }
  }

  // ── Additional produce batch: open (append-only, no direct persist) ──────
  // Creates a fresh pending generation for an additional batch and, when the
  // message already carries its closer, marks the close so the Release B
  // deferred finalizer picks it up. No produce rows are written here.
  private async startAdditionalPendingSession(
    event:          LineMessageEvent,
    pendingService: PendingSessionService,
    sessionKey:     string,
    sourceId:       string,
    lineUserId:     string | null,
    text:           string,
    normalizedText: string,
    eventId:        string,
    log:            ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken ?? null;
    const markClose = hasSessionEnd(normalizedText);
    const expectedItemCount = markClose ? parseExpectedItemCount(normalizedText) : null;

    try {
      // create() seeds the row; replaceGeneration() then rotates to a fresh
      // generation, registers this event in the admission/ingest ledgers, and
      // applies the close boundary — the same tested path header rotation uses.
      await pendingService.create(sessionKey, sourceId, text, replyToken, lineUserId);
      const created = await pendingService.get(sessionKey);
      if (!created) throw new Error("pending session missing after create");

      const replaced = await pendingService.replaceGeneration({
        sessionKey,
        sourceId,
        expectedSessionGeneration: created.session_generation,
        text,
        replyToken,
        lineUserId,
        lineEventId: eventId,
        lineTimestampMs: event.timestamp,
        markClose,
        expectedItemCount: expectedItemCount ?? undefined,
      });
      if (!replaced) throw new Error("additional pending session lost concurrency race");

      log.info("additional produce session opened as pending generation", {
        sessionKey,
        sessionGeneration: replaced.session_generation,
        markClose,
        expectedItemCount,
      });

      if (markClose && replyToken) {
        try {
          await this.replyMessage(replyToken, PRODUCE_CLOSE_PENDING_REPLY);
        } catch (replyError) {
          log.error("additional close acknowledgement failed", {
            error: String(replyError),
          });
        }
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("additional pending session open failed", {
        sessionKey,
        error: errorMessage,
      });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
        } catch (replyError) {
          log.error("additional open fail-closed reply failed", {
            error: String(replyError),
          });
        }
      }
      return {
        eventId,
        eventType: event.type,
        status: "error",
        parsed: false,
        error: errorMessage,
      };
    }
  }

  // ── Manual slip session: open ─────────────────────────────────────────────
  private async processManualSlipOpen(
    event:         LineMessageEvent,
    dateStr:       string,
    marketLabel:   string | null,
    marketKey:     string,
    fullText:      string,
    lineMessageId: string,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId    = getSourceId(event.source);
    const lineUserId  = getUserId(event.source);
    const replyToken  = event.replyToken;
    const labelDisplay = marketLabel ?? "ไม่ระบุ";

    // Parse Buddhist date from captured string e.g. "17/06/2569"
    const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/((?:25)?\d{2})$/);
    if (!parts) {
      log.warn("manual slip open: invalid date string", { dateStr });
      if (replyToken) {
        await this.replyMessage(replyToken, "รูปแบบวันที่ไม่ถูกต้อง เช่น ส่งสลิปมือ 17/06/2569");
      }
      return { eventId, eventType, status: "saved", parsed: false };
    }
    const businessDate = parseBuddhistDate(parts[1], parts[2], parts[3]);

    log.info("manual slip open command", { sourceId, businessDate, marketKey });

    try {
      const svc    = new ManualSlipSessionService(this.supabase);
      const result = await svc.openSession({ sourceId, businessDate, marketKey, marketLabel, lineUserId, lineMessageId });

      if (!result.opened) {
        if (result.reason === "other_market_open") {
          // Another market's session is still open — block with clear message.
          const existingLabel = result.session?.market_label ?? result.session?.market_key ?? "ไม่ทราบ";
          log.info("manual slip open: blocked by other open session", { sourceId, existingLabel });
          if (replyToken) {
            await this.replyMessage(
              replyToken,
              `ยังมีสลิปมือของ ${existingLabel} ที่ยังไม่จบ กรุณาพิมพ์ จบสลิปมือ ก่อนเปิดตลาดใหม่`,
            );
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // reason === "same_market_exists"
        const session = result.session!;
        log.info("manual slip open: session already exists", { sourceId, businessDate, marketKey, status: session.status });

        if (session.status !== "open") {
          // Closed session — can't reopen.
          if (replyToken) {
            await this.replyMessage(
              replyToken,
              `มีสลิปมือสำหรับวันที่ ${dateStr} ของ ${labelDisplay} อยู่แล้ว (ปิดแล้ว)`,
            );
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // Existing open session — if this message carries amounts/close, reuse it.
        const { amounts, hasClose } = this.extractBatchLines(fullText);
        if (amounts.length === 0 && !hasClose) {
          if (replyToken) {
            await this.replyMessage(
              replyToken,
              `มีสลิปมือสำหรับวันที่ ${dateStr} ของ ${labelDisplay} อยู่แล้ว`,
            );
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        log.info("manual slip open: reusing existing open session", { sessionId: session.id });
        await this.processSessionBatch(
          svc, session.id, dateStr, amounts, hasClose,
          sourceId, businessDate, lineMessageId, lineUserId, replyToken, false, log,
        );
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // New session successfully opened.
      const { amounts, hasClose } = this.extractBatchLines(fullText);
      if (amounts.length > 0 || hasClose) {
        await this.processSessionBatch(
          svc, result.session!.id as string, dateStr, amounts, hasClose,
          sourceId, businessDate, lineMessageId, lineUserId, replyToken, true, log,
        );
      } else {
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            `เปิดสลิปมือ ${dateStr} แล้ว\nส่งจำนวนเงินได้เลย เช่น\n1. 100 บาท\n2. 300 บาท\nพิมพ์ จบสลิปมือ เมื่อส่งครบ`,
          );
        }
      }
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("manual slip open failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, "เปิดสลิปมือไม่สำเร็จ กรุณาลองอีกครั้ง");
        } catch { /* ignore reply error */ }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // Lines in fullText after the open-command line, parsed for amounts + close flag.
  private extractBatchLines(fullText: string): {
    amounts:  Array<{ rawLine: string; amount: number }>;
    hasClose: boolean;
  } {
    const lines   = fullText.split("\n");
    const openIdx = lines.findIndex(l => RE.MANUAL_SLIP_OPEN.test(l));
    const after   = openIdx >= 0 ? lines.slice(openIdx + 1) : [];
    return {
      amounts:  parseManualSlipAmounts(after.join("\n")),
      hasClose: after.some(l => RE.MANUAL_SLIP_CLOSE.test(l.trim())),
    };
  }

  // Append amounts + close if requested, then send the reply.
  // isNew: include "เปิดสลิปมือ…" prefix in the partial-amounts reply.
  private async processSessionBatch(
    svc:           ManualSlipSessionService,
    sessionId:     string,
    dateStr:       string,
    amounts:       Array<{ rawLine: string; amount: number }>,
    hasClose:      boolean,
    sourceId:      string,
    businessDate:  string,
    lineMessageId: string,
    lineUserId:    string | null,
    replyToken:    string | undefined,
    isNew:         boolean,
    log:           ChildLogger,
  ): Promise<void> {
    if (amounts.length > 0) {
      await svc.appendEntries({ sessionId, entries: amounts, lineMessageId, lineUserId });
    }
    if (hasClose) {
      const { total } = await svc.closeSession({ sessionId, lineUserId, lineMessageId });
      if (replyToken) {
        await this.replyMessage(
          replyToken,
          `จบสลิปมือ ${dateStr} แล้ว\nรับ ${amounts.length} รายการ รวม ${total.toLocaleString("th-TH")} บาท`,
        );
      }
      log.info("manual slip batch completed", { sessionId, total });
      tryFinalizeSettlement(this.supabase, sourceId, businessDate).catch(
        (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
      );
    } else if (amounts.length > 0) {
      const runTotal = amounts.reduce((s, a) => s + a.amount, 0);
      if (replyToken) {
        const prefix = isNew ? `เปิดสลิปมือ ${dateStr} แล้ว\n` : "";
        await this.replyMessage(
          replyToken,
          `${prefix}รับ ${amounts.length} รายการ รวม ${runTotal.toLocaleString("th-TH")} บาท\nพิมพ์ จบสลิปมือ เมื่อส่งครบ`,
        );
      }
    }
  }

  // ── White Sheet closing command ───────────────────────────────────────────
  private async processWhiteSheetClose(
    event: LineMessageEvent,
    parseResult: Exclude<
      ReturnType<typeof parseWhiteSheetCloseCommandFromMessage>,
      { kind: "not_command" }
    >,
    eventId: string,
    eventType: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    const sourceId = getSourceId(event.source);

    if (parseResult.kind === "invalid") {
      log.info("white sheet close command invalid", { sourceId });
      if (replyToken) await this.replyMessage(replyToken, parseResult.message);
      return { eventId, eventType, status: "saved", parsed: false };
    }

    log.info("white sheet close command", {
      sourceId,
      market: parseResult.command.marketLabelNormalized,
      businessDate: parseResult.command.businessDate,
    });

    try {
      const outcome = await processWhiteSheetCloseCommand(this.supabase, {
        sourceId,
        command: parseResult.command,
      });
      if (replyToken) await this.replyMessages(replyToken, outcome.replyMessages);
      return { eventId, eventType, status: "saved", parsed: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("white sheet close command failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(
            replyToken,
            "บันทึกปิดยอดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อผู้ดูแลระบบ",
          );
        } catch { /* ignore reply error */ }
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }
  }

  // ── Remaining fruit summary command ───────────────────────────────────────
  private async processRemainingFruitCommand(
    event:         LineMessageEvent,
    command:       ReturnType<typeof parseRemainingFruitCommandFromMessage> & object,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken   = event.replyToken;
    const businessDate = command.businessDate ?? bangkokToday();

    log.info("remaining fruit command", {
      businessDate,
      marketFilter: command.marketFilter,
    });

    try {
      const rows = await fetchRemainingFruitRows(
        this.supabase,
        businessDate,
        command.marketFilter,
      );
      const messages = buildRemainingFruitMessagesFromRows(businessDate, rows, {
        marketFilter: command.marketFilter,
        includeOverall: !command.marketFilter,
      });
      if (replyToken) await this.replyMessages(replyToken, messages);
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("remaining fruit command failed", { error: errorMessage });
      if (replyToken) {
        await this.replyMessage(replyToken, "ไม่สามารถสร้างสรุปคงเหลือได้ กรุณาลองใหม่");
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }
  }

  // ── P1 Daily Sales summary command ────────────────────────────────────────
  private async processSalesSummaryCommand(
    event:     LineMessageEvent,
    command:   ReturnType<typeof parseSalesSummaryCommandFromMessage> & object,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    // With no date the command reports the day that just closed — the same
    // business date the scheduled 08:10 report uses, so the two never disagree.
    const businessDate = command.businessDate ?? previousBangkokBusinessDate();

    log.info("sales summary command", { businessDate });

    try {
      const report = await loadSalesReport(this.supabase, businessDate);
      const messages = buildSalesSummaryMessages(report);
      if (replyToken) await this.replyMessages(replyToken, messages);
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("sales summary command failed", { error: errorMessage });
      if (replyToken) {
        await this.replyMessage(replyToken, "ไม่สามารถสร้างสรุปยอดขายได้ กรุณาลองใหม่");
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }
  }

  // ── Manual slip session: close ────────────────────────────────────────────
  private async processManualSlipClose(
    event:         LineMessageEvent,
    lineMessageId: string,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;

    log.info("manual slip close command", { sourceId });

    try {
      const svc    = new ManualSlipSessionService(this.supabase);
      const session = await svc.findOpenSession(sourceId);

      if (!session) {
        log.info("manual slip close: no open session", { sourceId });
        if (replyToken) {
          await this.replyMessage(replyToken, "ไม่มีสลิปมือที่เปิดอยู่");
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const { total, alreadyClosed } = await svc.closeSession({
        sessionId: session.id, lineUserId, lineMessageId,
      });

      if (alreadyClosed) {
        if (replyToken) await this.replyMessage(replyToken, "สลิปมือปิดไปแล้ว");
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const dateStr   = session.business_date;
      const labelPart = session.market_label ? ` (${session.market_label})` : "";
      if (replyToken) {
        await this.replyMessage(
          replyToken,
          `จบสลิปมือ ${dateStr}${labelPart} แล้ว\nยอดรวมสลิปมือ: ${total.toLocaleString("th-TH")} บาท`,
        );
      }
      log.info("manual slip session closed", { sessionId: session.id, total });
      tryFinalizeSettlement(this.supabase, sourceId, session.business_date).catch(
        (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
      );
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("manual slip close failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, "ปิดสลิปมือไม่สำเร็จ กรุณาลองอีกครั้ง");
        } catch { /* ignore reply error */ }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── Manual slip session: append amount entries ────────────────────────────
  // Returns null if no open session (caller falls through to existing handlers).
  private async tryAppendManualSlipEntry(
    event:         LineMessageEvent,
    text:          string,
    lineMessageId: string,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult | null> {
    const amounts = parseManualSlipAmounts(text);
    if (amounts.length === 0) return null;

    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;

    const svc     = new ManualSlipSessionService(this.supabase);
    const session = await svc.findOpenSession(sourceId);
    if (!session) return null; // no open session — fall through

    try {
      await svc.appendEntries({ sessionId: session.id, entries: amounts, lineMessageId, lineUserId });
      log.info("manual slip entries appended", {
        sessionId: session.id,
        count: amounts.length,
        lineMessageId,
      });

      if (replyToken) {
        const total = amounts.reduce((s, a) => s + a.amount, 0);
        await this.replyMessage(
          replyToken,
          `รับ ${amounts.length} รายการ รวม ${total.toLocaleString("th-TH")} บาท`,
        );
      }
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("manual slip entry append failed", { error: errorMessage });
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // Image evidence is processed independently from the text-session parser.
  // Multiple images from the same source within SLIP_BATCH_QUIET_SECONDS are
  // grouped into a batch; only the first image triggers a reply.
  private async processImageMessage(
    event: LineMessageEvent,
    message: LineImageMessage,
    rawMessageId: string,
    eventId: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId = getSourceId(event.source);
    const senderId = getUserId(event.source);

    try {
      const result = await this.evidenceIngestor.ingest({
        rawMessageId,
        lineMessageId: message.id,
        sourceId,
        sourceType: event.source.type,
        lineUserId: senderId,
        eventTimestamp: event.timestamp,
      });

      if (result.status === "RECEIVED" && result.evidenceId) {
        const evidenceId = result.evidenceId;

        let shouldReply = false;
        // Only schedule OCR after evidence is successfully attached to a batch.
        // If attachEvidence throws, the evidence row exists but has no batch_id;
        // running OCR on it would produce a floating result with no parent.
        let scheduleOcr = false;

        try {
          const activeSession = await this.slipSessionService.findActiveSession(sourceId);

          if (!activeSession) {
            // No open session — instruct user to open one first.
            // Evidence is saved but not processed; no OCR scheduled.
            log.info("image received but no active slip session", { sourceId });
            if (event.replyToken) {
              try {
                await this.replyMessage(event.replyToken, NO_SESSION_IMAGE_REPLY);
              } catch (replyErr) {
                log.error("no-session reply failed", {
                  error: replyErr instanceof Error ? replyErr.message : String(replyErr),
                });
              }
            }
            return {
              eventId,
              eventType: event.type,
              status: "saved",
              parsed: false,
            };
          }

          try {
            await this.batchService.attachEvidence(activeSession.batchId, evidenceId);
            shouldReply = activeSession.imageCount === 0; // first image in this session
            scheduleOcr = true; // attach succeeded — safe to process
            log.info("image attached to active slip session", {
              batchId:      activeSession.batchId,
              imageCount:   activeSession.imageCount + 1,
              isFirstImage: shouldReply,
            });
          } catch (attachError) {
            const errMsg = attachError instanceof Error ? attachError.message : String(attachError);
            const isBatchFinalized = errMsg.includes("not in collecting/closing status");

            if (isBatchFinalized) {
              // Finalizer claimed the batch before this image arrived.
              // The evidence row exists (traceable) but is not part of the batch.
              // Do NOT schedule OCR; reply with an explicit rejection.
              log.info("image rejected: batch already processing/finalized", {
                batchId:         activeSession.batchId,
                evidenceId,
                rejectionReason: "batch_already_processing",
              });
              if (event.replyToken) {
                try {
                  await this.replyMessage(event.replyToken, BATCH_FINALIZED_LATE_IMAGE_REPLY);
                } catch (replyErr) {
                  log.error("batch-finalized rejection reply failed", {
                    error: replyErr instanceof Error ? replyErr.message : String(replyErr),
                  });
                }
              }
              return {
                eventId,
                eventType: event.type,
                status: "saved",
                parsed: false,
              };
            }

            // Other attach failure (network, unexpected DB error): fall back to
            // plain ack so the sender knows the image was received.
            log.error("slip evidence attach failed — sending plain ack", {
              error: errMsg,
            });
            shouldReply = true;
            // scheduleOcr stays false — do NOT process an unattached evidence
          }

        } catch (batchError) {
          // findActiveSession threw
          log.error("slip session lookup failed — sending plain ack", {
            error: batchError instanceof Error ? batchError.message : String(batchError),
          });
          shouldReply = true;
          // scheduleOcr stays false — do NOT process an unattached evidence
        }

        if (shouldReply && event.replyToken) {
          try {
            await this.replyMessage(event.replyToken, BATCH_FIRST_IMAGE_REPLY);
          } catch (error) {
            log.error("slip evidence reply failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (scheduleOcr) {
          this.scheduleBackgroundTask(
            () => this.checkProcessor.processEvidence(evidenceId),
          );
        }
      } else {
        // Ingest failed — reply with error so sender knows to retry.
        if (event.replyToken) {
          try {
            await this.replyMessage(event.replyToken, EVIDENCE_FAILED_REPLY);
          } catch (error) {
            log.error("slip evidence reply failed", {
              evidenceStatus: result.status,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return {
        eventId,
        eventType: event.type,
        status: "saved",
        parsed: false,
        error: result.status === "RECEIVED" ? undefined : result.status,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("slip evidence ingestion failed", { error: errorMessage });

      if (event.replyToken) {
        try {
          await this.replyMessage(event.replyToken, EVIDENCE_FAILED_REPLY);
        } catch (replyError) {
          log.error("slip evidence failure reply failed", {
            error: replyError instanceof Error ? replyError.message : String(replyError),
          });
        }
      }

      return {
        eventId,
        eventType: event.type,
        status: "saved",
        parsed: false,
        error: errorMessage,
      };
    }
  }

  // ── Slip session: open ────────────────────────────────────────────────────
  private async processSlipOpen(
    event:     LineMessageEvent,
    header:    SlipSessionHeader,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId  = getSourceId(event.source);
    const senderId  = getUserId(event.source);
    const replyToken = event.replyToken;

    log.info("slip session open command received", {
      sourceId,
      sellerName: header.sellerName,
      marketName: header.marketName,
      slipDate:   header.slipDate,
    });

    try {
      const result = await this.slipSessionService.openSession(
        sourceId, event.source.type, senderId, header,
      );

      if (!result.opened) {
        log.info("slip open: session already open", { existingBatchId: result.existingBatchId });
        if (replyToken) await this.replyMessage(replyToken, SESSION_ALREADY_OPEN_REPLY);
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const dateStr = header.slipDate ?? "ไม่ระบุวันที่";
      const confirmText = [
        "เปิดชุดสลิปเงินโอนแล้ว",
        `${header.sellerName} — ${header.marketName} — ${dateStr}`,
        "",
        "ส่งรูปสลิปต่อได้เลย",
        `พิมพ์ "จบสลิป" เมื่อส่งครบ`,
      ].join("\n");

      if (replyToken) await this.replyMessage(replyToken, confirmText);

      log.info("slip session opened", { batchId: result.batchId });
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("slip session open failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, "เปิดชุดสลิปไม่สำเร็จ กรุณาลองอีกครั้ง");
        } catch (replyErr) {
          log.error("slip open error reply failed", {
            error: replyErr instanceof Error ? replyErr.message : String(replyErr),
          });
        }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── Slip session: close ───────────────────────────────────────────────────
  //
  // Transitions the batch to 'closing' and immediately replies with an ack.
  // The actual summary is sent by the cron finalizer once the quiet period
  // has elapsed and all OCR checks have reached a terminal state.
  private async processSlipClose(
    event:     LineMessageEvent,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId   = getSourceId(event.source);
    const replyToken = event.replyToken;

    log.info("slip close command received", { sourceId });

    try {
      // findActiveSession returns collecting OR closing batches.
      const active = await this.slipSessionService.findActiveSession(sourceId);

      if (!active) {
        log.info("slip close: no active batch found", { sourceId });
        if (replyToken) await this.replyMessage(replyToken, NO_ACTIVE_BATCH_REPLY);
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // Atomic claim: collecting → closing.
      // If the batch is already closing, the WHERE status='collecting' predicate
      // fails and claimed is null — we reply with the already-closing message.
      const { data: claimed, error: claimError } = await this.supabase
        .from("slip_batches")
        .update({ status: "closing", closing_at: new Date().toISOString() })
        .eq("id", active.batchId)
        .eq("status", "collecting")
        .select("id")
        .single();

      if (claimError || !claimed) {
        // Batch is already closing (a previous "จบสลิป" was accepted).
        log.info("slip close: batch already closing", { batchId: active.batchId });
        if (replyToken) await this.replyMessage(replyToken, ALREADY_CLOSING_REPLY);
        return { eventId, eventType, status: "saved", parsed: false };
      }

      log.info("slip batch transitioned to closing", {
        batchId:    active.batchId,
        imageCount: active.imageCount,
      });

      // Immediate ack — summary will arrive via the cron finalizer.
      if (replyToken) await this.replyMessage(replyToken, SLIP_CLOSE_ACKNOWLEDGED_REPLY);

      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("slip session close failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, "เกิดข้อผิดพลาดในการสรุปสลิป กรุณาลองอีกครั้ง");
        } catch (replyErr) {
          log.error("slip close error reply failed", {
            error: replyErr instanceof Error ? replyErr.message : String(replyErr),
          });
        }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── Single-message parser flow (backward compat) ──────────────────────────
  private async runParser(
    msgEvent:     LineMessageEvent,
    rawMessageId: string,
    eventId:      string,
    eventType:    string,
    log:          ChildLogger,
  ): Promise<WebhookProcessResult> {
    const parser     = parserRegistry.findParser(msgEvent);
    const replyToken = msgEvent.replyToken;
    let weighSessionData: WeighSession | null = null;
    let rawTextForDedup:  string | null       = null;

    if (!parser) {
      log.debug("no parser matched");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    log.info("running parser", { parser: parser.name, version: parser.version });

    try {
      const result = await parser.parse(msgEvent);

      // Fix 2 + 3: weigh-session specific guards before any DB writes
      if (parser.name === "weigh-session" && result.data) {
        const ws = result.data as unknown as WeighSession;

        const validationErrors = getWeighSessionFinalizationErrors(ws);
        if (validationErrors.length > 0) {
          log.warn("produce session validation failed — aborting before persistence", {
            errors: validationErrors,
          });
          await this.recordProduceValidationError(rawMessageId, validationErrors, log);
          if (replyToken) {
            try {
              await this.replyMessage(replyToken, buildWeighSessionValidationReply(ws));
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // Fix 2: empty items guard
        if (ws.items.length === 0) {
          log.warn("parsed session has no items — aborting");
          await this.recordProduceValidationError(
            rawMessageId,
            ["parsed session has no items"],
            log,
          );
          if (replyToken) {
            try {
              await replyLineMessage(replyToken, "อ่านรายการไม่สำเร็จ กรุณาตรวจสอบรูปแบบข้อความ");
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // Fix 3: dedup check. Old failures may have reserved a hash before any
        // produce_items were inserted; release those ghost reservations.
        const rawText   = (msgEvent.message as import("@/lib/line/types").LineTextMessage).text;
        const dedup     = new SessionDedupService(this.supabase);
        let isDuplicate = await dedup.isDuplicate(ws);
        if (isDuplicate && !(await dedup.hasPersistedItems(ws))) {
          await dedup.release(ws);
          isDuplicate = false;
        }
        if (isDuplicate) {
          log.info("duplicate session — skipping insert");
          // The produce IS recorded, under the message that first carried it.
          // Marking this one processed keeps "unprocessed complete produce
          // message" meaning exactly one thing — produce that never landed —
          // which is what the daily report relies on.
          await this.markRawMessageProcessed(rawMessageId, log);
          if (replyToken) {
            try {
              await replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว");
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        weighSessionData = ws;
        rawTextForDedup  = rawText;
      }

      // Fix 4: persist first, then mark processed
      await result.persist(this.supabase, rawMessageId);

      if (parser.name === "weigh-session" && weighSessionData) {
        const dedup = new SessionDedupService(this.supabase);
        const duplicateAfterPersist = await dedup.record(weighSessionData, rawTextForDedup ?? undefined);
        if (duplicateAfterPersist) {
          log.info("duplicate session recorded concurrently after persist");
          await this.markRawMessageProcessed(rawMessageId, log);
          if (replyToken) {
            try {
              await replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว");
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }
      }

      await this.supabase
        .from("raw_messages")
        .update({ is_processed: true })
        .eq("id", rawMessageId);

      log.info("parse succeeded", { parser: parser.name });

      if (parser.name === "weigh-session" && result.data) {
        const ws = result.data as unknown as WeighSession;
        await new DailySummaryService(this.supabase).recalculate(
          ws.date ?? bangkokToday(),
          ws.staff_name,
          ws.session_title ?? null,
        );
      }

      if (replyToken && result.data) {
        const summaryText = parser.name === "weigh-session"
          ? buildWeighSessionSummary(result.data as unknown as WeighSession)
          : null;

        if (summaryText) {
          try {
            await replyLineMessage(replyToken, summaryText);
          } catch (e) {
            log.error("reply failed", { error: String(e) });
          }
        }
      }

      return { eventId, eventType, status: "saved", parsed: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("parser crashed", { parser: parser.name, error: errorMessage });

      await this.supabase.from("parse_errors").insert({
        raw_message_id: rawMessageId,
        parser_name:    parser.name,
        parser_version: parser.version,
        error_type:     "parser_crash",
        error_message:  errorMessage,
        error_detail:   err instanceof Error ? { stack: err.stack } : null,
      });

      if (replyToken) {
        try {
          await replyLineMessage(replyToken, "ยังอ่านรายการนี้ไม่ได้ครับ กรุณาตรวจรูปแบบข้อความอีกครั้ง");
        } catch (e) {
          log.error("reply failed", { error: String(e) });
        }
      }

      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── DB helpers ────────────────────────────────────────────────────────────
  private async saveRawMessage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any,
    destination: string
  ): Promise<string | null | "error"> {
    const source  = event.source  ?? {};
    const message = event.message as LineMessage | undefined;

    const { data, error } = await this.supabase
      .from("raw_messages")
      .insert({
        line_event_id: event.webhookEventId,
        destination,
        event_type:   event.type,
        source_type:  source.type ?? "user",
        source_id:    getSourceId(source),
        user_id:      getUserId(source),
        message_id:   message?.id   ?? null,
        message_type: (message?.type ?? null) as LineMessageType | null,
        raw_text:     message && "text" in message ? (message as { text: string }).text : null,
        payload:      event,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505") return null;
      logger.error("failed to insert raw_message", {
        code:    error.code,
        message: error.message,
        eventId: event.webhookEventId,
      });
      return "error";
    }

    return data.id;
  }

  private async markRawMessageProcessed(rawMessageId: string, log: ChildLogger): Promise<void> {
    const { error } = await this.supabase
      .from("raw_messages")
      .update({ is_processed: true })
      .eq("id", rawMessageId);
    // Leaving it unprocessed is the safe direction: the report then treats the
    // message as unaccounted for and blocks, rather than assuming it landed.
    if (error) log.warn("failed to mark raw message processed", { error: error.message });
  }

  /**
   * Durable evidence that a weighing message was understood but rejected.
   *
   * Without this the path is silent: the parser handles the message, validation
   * fails, the webhook replies to the sender and returns — no produce_session,
   * no pending_session, nothing in parse_errors. A daily report can then never
   * know produce was lost. The existing validation_error type carries it, so no
   * migration is needed.
   *
   * Best-effort by design: a failure to record must not change the reply the
   * sender already gets, and the LINE flow is unchanged either way. Retries of
   * the same webhook event can write more than one row for a raw message;
   * readers count distinct raw_message_id, so a retry cannot inflate anything.
   *
   * Losing this write does NOT lose the blocker. The raw message stays
   * is_processed = false with no produce_session behind it, and P1 reports an
   * unprocessed complete produce message as evidence in its own right (see
   * auditLostProduceMessages). This row is the readable explanation, not the
   * only proof.
   */
  private async recordProduceValidationError(
    rawMessageId: string,
    errors: string[],
    log: ChildLogger,
  ): Promise<void> {
    try {
      const { error } = await this.supabase.from("parse_errors").insert({
        raw_message_id: rawMessageId,
        parser_name:    "weigh-session",
        parser_version: "1.1.0",
        error_type:     "validation_error",
        error_message:  `weigh session validation failed: ${errors.join("; ")}`,
        error_detail:   { validationErrors: errors },
      });
      if (error) {
        log.error("failed to record produce validation error", { error: error.message });
      }
    } catch (err) {
      // Recording evidence must never cost the sender their reply.
      log.error("failed to record produce validation error", { error: String(err) });
    }
  }

  private async recordUnsupportedType(rawMessageId: string, message: LineMessage): Promise<void> {
    await this.supabase.from("parse_errors").insert({
      raw_message_id: rawMessageId,
      parser_name:    "registry",
      parser_version: "1.0.0",
      error_type:     "unsupported_type",
      error_message:  `No parser registered for message type: ${message.type}`,
      error_detail:   { messageType: message.type },
    });
  }
}
