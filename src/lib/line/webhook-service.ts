import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  LineEvent,
  LineImageMessage,
  LineMessageEvent,
  LineMessage,
  LineTextMessage,
} from "@/lib/line/types";
import type { Database, LineMessageType } from "@/types/database";
import { getSourceId, getUserId } from "@/lib/line/verify";
import { parserRegistry } from "@/lib/parsers/registry";
import { logger } from "@/lib/logger";
import { replyLineMessage, buildWeighSessionSummary } from "@/lib/line/reply";
import { parseWeighSession, bangkokTimeFromTimestamp, parseBuddhistDate, buildParseReviewReply, hasParseReviewBlockers } from "@/lib/parsers/weigh-session/parser";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import { DailySummaryService } from "@/lib/line/daily-summary-service";
import { SessionDedupService, computeItemHash } from "@/lib/line/session-dedup-service";
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
import { SlipBatchService, SLIP_BATCH_QUIET_SECONDS, type SlipBatchIngestor } from "@/lib/slips/batch-service";
import { tryFinalizeSettlement } from "@/lib/settlement-finalizer";
import { tryFinalizeWorkRound } from "@/lib/work-round/finalizer";
import { computeRoundTotals } from "@/lib/work-round/expected-sales";
import {
  SlipSessionService,
  parseSlipSessionHeader,
  isSlipCloseCommand,
  type SlipSessionIngestor,
  type SlipSessionHeader,
} from "@/lib/slips/slip-session-service";
import {
  WorkRoundService,
  SETTLEMENT_ELIGIBLE_STATUSES,
  EVIDENCE_ELIGIBLE_STATUSES,
  PRODUCE_APPEND_ELIGIBLE_STATUSES,
  RETURN_APPEND_ELIGIBLE_STATUSES,
} from "@/lib/work-round/work-round-service";
import { classifyHeader, hasExplicitProduceAppendStart, isExplicitProduceAppendHeader, isIncompleteProduceHeader, isProduceAppendLine, type TxIntent } from "@/lib/parsers/work-round-header";
import {
  SettlementIntakeService,
  parseSettlementCommand,
  parseSettlementAmounts,
  hasAnyAmount,
  isConfirmCommand,
} from "@/lib/line/settlement-intake-service";
import {
  WorkRoundSelectionService,
  parseNumericSelection,
  buildSelectionMessage,
} from "@/lib/work-round/selection-service";
import { WorkRoundStatusService } from "@/lib/work-round/status";
import type { SelectionCandidate, SelectionIntent, WorkRound, WorkRoundStatus } from "@/lib/work-round/types";

type Supabase      = SupabaseClient<Database>;
type ChildLogger   = ReturnType<typeof logger.child>;
type ReplyLineMessage = (replyToken: string, text: string) => Promise<void>;
type ScheduleBackgroundTask = (task: () => Promise<void>) => void;
type Sleep = (ms: number) => Promise<void>;

const BATCH_FIRST_IMAGE_REPLY = [
  "รับรูปหลักฐานแล้วครับ",
  "ถ้ามีหลายใบ ส่งต่อได้เลย",
  `พิมพ์ "จบสลิป" เมื่อส่งครบ`,
].join("\n");

const EVIDENCE_FAILED_REPLY = "รับรูปไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง";

const BATCH_FINALIZED_LATE_IMAGE_REPLY =
  "รูปนี้ไม่ถูกรวมในชุดสลิป เนื่องจากระบบเริ่มสรุปแล้ว กรุณาเปิดชุดใหม่ก่อนส่งรูป";

const NO_SESSION_IMAGE_REPLY = [
  "กรุณาพิมพ์หัวชุดสลิปก่อนส่งรูป เพื่อระบุว่าเป็นสลิปของใครและตลาดไหน",
  "",
  "รูปแบบ:",
  "ชื่อคนขาย ชื่อตลาด สลิปเงินโอน วันที่",
  "",
  "ตัวอย่าง:",
  "กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569",
  "",
  "จากนั้นส่งรูปสลิปได้หลายรูป แล้วพิมพ์ `จบสลิป` เมื่อส่งครบครับ",
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

const CLOSE_ROUND_CMD_RE = /^ปิดรอบ\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})\s*$/;
const CLOSE_ROUND_CONFIRM_RE = /^ยืนยันปิดรอบ\s*$/;

function parseCloseRoundCommand(text: string): string | null {
  const m = text.trim().match(CLOSE_ROUND_CMD_RE);
  return m ? m[1] : null;
}

function isCloseRoundConfirmCommand(text: string): boolean {
  return CLOSE_ROUND_CONFIRM_RE.test(text.trim());
}

function businessDateFromText(text: string, fallbackBusinessDate: string): string {
  const m = text.match(RE.DATE_IN_TEXT);
  if (!m) return fallbackBusinessDate;
  return parseBuddhistDate(m[1], m[2], m[3]);
}

function allowedProduceStatusesForIntent(txIntent: TxIntent): WorkRoundStatus[] {
  if (txIntent === "ชั่งคืนเพิ่ม") return RETURN_APPEND_ELIGIBLE_STATUSES;
  return PRODUCE_APPEND_ELIGIBLE_STATUSES;
}

function buildBorrowOpenedReply(firstLine: string): string {
  const hdr    = classifyHeader(firstLine);
  const seller = hdr?.type === "explicit" || hdr?.type === "seller_only" ? hdr.sellerName : "—";
  const market = hdr?.type === "explicit" ? hdr.marketName : "—";
  return [
    "รับหัวเบิกแล้ว ✅",
    `${seller} — ${market}`,
    "ส่งรายการสินค้าได้เลย",
    "ปิดรายการด้วย: จบรายการเบิก",
  ].join("\n");
}

function buildReturnHeaderOpenedReply(
  sellerName: string,
  marketName: string,
  txIntent:   TxIntent,
): string {
  const ack = txIntent === "คืนเสีย"
    ? "รับหัวคืนเสียแล้ว ✅"
    : "รับหัวชั่งคืนแล้ว ✅";
  return [
    ack,
    `${sellerName} — ${marketName}`,
    "ส่งรายการสินค้าได้เลย",
    "ปิดรายการด้วย: จบรายการ",
  ].join("\n");
}

function buildIncompleteHeaderReply(firstLine: string): string {
  const hdr    = classifyHeader(firstLine);
  const seller = hdr?.type === "seller_only" ? hdr.sellerName : "ชื่อ";
  const dm     = firstLine.match(RE.DATE_IN_TEXT);
  const date   = dm ? `${dm[1]}/${dm[2]}/${dm[3]}` : "25/6/2569";
  return [
    "หัวเบิกยังขาดชื่อตลาด",
    "กรุณาพิมพ์ เช่น:",
    `${seller}-วัดทุ่งลานนา เบิก ${date}`,
  ].join("\n");
}

function buildMissingDateReply(firstLine: string): string {
  const hdr    = classifyHeader(firstLine);
  const seller = hdr?.type === "explicit" || hdr?.type === "seller_only" ? hdr.sellerName : "ชื่อ";
  const market = hdr?.type === "explicit" ? hdr.marketName : "ตลาด";
  const intent = hdr?.type === "explicit" ? hdr.txIntent : "เบิก";
  const today  = bangkokToday();
  const [yr, mo, dy] = today.split("-").map(Number);
  const dateEx = `${dy}/${mo}/${yr + 543}`;
  return [
    "หัวเบิกยังขาดวันที่",
    "กรุณาพิมพ์ เช่น:",
    `${seller}-${market} ${intent} ${dateEx}`,
  ].join("\n");
}

interface WebhookServiceDependencies {
  evidenceIngestor?: SlipEvidenceIngestor;
  checkProcessor?: SlipCheckProcessor;
  batchService?: SlipBatchIngestor;
  slipSessionService?: SlipSessionIngestor;
  replyMessage?: ReplyLineMessage;
  scheduleBackgroundTask?: ScheduleBackgroundTask;
  sleep?: Sleep;
  produceEndSettleMs?: number;
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

function hasSessionEnd(text: string): boolean {
  return text.split("\n").some((l) => RE.SESSION_END.test(l.trim()));
}

function hasItemLine(text: string): boolean {
  return text.split("\n").some((l) => RE.ITEM.test(l.trim()));
}

// SESSION_END lines like "จบรายการคืน" contain "คืน" which also matches SESSION_START.
// Skip SESSION_END lines before testing so pure closing messages are never treated as headers.
// Standalone "รายการเบิกเพิ่ม" is an append marker — not a new session header.
export function hasSessionStart(text: string): boolean {
  return text.split("\n").some((l) => {
    const line = l.trim();
    return !RE.SESSION_END.test(line)
      && !isProduceAppendLine(line)
      && !isExplicitProduceAppendHeader(line)
      && RE.SESSION_START.test(line);
  });
}

export function hasProduceAppendStart(text: string): boolean {
  return text.split("\n").some((l) => isProduceAppendLine(l.trim()));
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
  private readonly scheduleBackgroundTask: ScheduleBackgroundTask;
  private readonly sleep: Sleep;
  private readonly produceEndSettleMs: number;
  private readonly noSessionImageGuidanceSentAt = new Map<string, number>();

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
    this.scheduleBackgroundTask =
      dependencies.scheduleBackgroundTask
      ?? ((task) => {
        void task().catch((error) => {
          logger.error("background slip check failed", {
            error: error instanceof Error ? error.message : "unknown_error",
          });
        });
      });
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.produceEndSettleMs = dependencies.produceEndSettleMs ?? 750;
  }

  private noSessionImageGuidanceKey(sourceId: string, senderId: string | null): string {
    return `${sourceId}:${senderId ?? ""}`;
  }

  private shouldReplyNoSessionImageGuidance(sourceId: string, senderId: string | null, nowMs: number): boolean {
    const key = this.noSessionImageGuidanceKey(sourceId, senderId);
    const lastSentAt = this.noSessionImageGuidanceSentAt.get(key);
    const windowMs = SLIP_BATCH_QUIET_SECONDS * 1000;

    if (lastSentAt !== undefined && nowMs - lastSentAt < windowMs) return false;

    this.noSessionImageGuidanceSentAt.set(key, nowMs);
    return true;
  }

  private resetNoSessionImageGuidance(sourceId: string, senderId: string | null): void {
    this.noSessionImageGuidanceSentAt.delete(this.noSessionImageGuidanceKey(sourceId, senderId));
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
    const sessionKey     = getSourceId(msgEvent.source);
    const lineUserId     = getUserId(msgEvent.source);

    console.log("incoming text (raw):", text);
    console.log("incoming text (normalized):", normalizedText);
    console.log("replyToken exists:", !!replyToken);
    console.log("hasSessionStart:", hasSessionStart(normalizedText));
    console.log("hasSessionEnd:", hasSessionEnd(normalizedText));

    if (text.trim().toLowerCase() === "test") {
      console.log("test reply triggered");
      if (replyToken) await replyLineMessage(replyToken, "Bot รับข้อความได้แล้ว ✅");
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 3.1. Pending Work Round selection (numeric reply) ────────────────────
    // A bare "1".."99" resolves an active numbered selection for THIS sender.
    // Runs before all produce/slip/settlement logic so it always wins.
    const selectionNum = parseNumericSelection(text);
    if (selectionNum !== null) {
      const handled = await this.tryResolveSelection(
        msgEvent, selectionNum, eventId, event.type, log,
      );
      if (handled !== null) return handled;
      // No active selection — fall through (numeric could be unrelated).
    }

    // ── 3.2. Explicit Work Round close command (V2) ─────────────────────────
    const closeRoundDateStr = parseCloseRoundCommand(text);
    if (closeRoundDateStr !== null) {
      return this.processCloseRoundCommand(
        msgEvent, closeRoundDateStr, eventId, event.type, log,
      );
    }

    if (isCloseRoundConfirmCommand(text)) {
      return this.processCloseRoundConfirmation(msgEvent, eventId, event.type, log);
    }

    // ── 3.3. Settlement command (V2) ─────────────────────────────────────────
    // "ส่งเงิน 24/06/2569" or "ปิดยอด 24/06/2569"
    // Processed before manual slip commands to avoid confusion with amount lines.
    const settlementDateStr = parseSettlementCommand(text);
    if (settlementDateStr !== null) {
      return this.processSettlementCommand(
        msgEvent, text, settlementDateStr, eventId, event.type, log,
      );
    }

    // ── 3.2b. Settlement follow-up (amounts / confirm in a later message) ────
    // Only acts when THIS sender has an open draft; otherwise falls through.
    if (isConfirmCommand(text) || hasAnyAmount(text)) {
      const followup = await this.trySettlementFollowup(
        msgEvent, text, eventId, event.type, log,
      );
      if (followup !== null) return followup;
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

    // ── 3.5. Slip session commands (checked before produce session logic) ─────
    if (isSlipCloseCommand(text)) {
      return this.processSlipClose(msgEvent, eventId, event.type, log);
    }

    const slipOpenHeader = parseSlipSessionHeader(text);
    if (slipOpenHeader !== null) {
      return this.processSlipOpen(msgEvent, slipOpenHeader, eventId, event.type, log);
    }

    // ── 4. Pending session flow ───────────────────────────────────────────────
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

    const firstLine = normalizedText.split("\n")[0] ?? "";
    const appendStart = hasProduceAppendStart(normalizedText);
    const explicitAppendStart = hasExplicitProduceAppendStart(normalizedText);

    if (hasSessionStart(normalizedText) && isIncompleteProduceHeader(firstLine)) {
      log.info("incomplete produce header rejected", { sessionKey, firstLine });
      if (pending) {
        await pendingService.delete(sessionKey);
        log.info("pending session aborted due to incomplete header", { sessionKey });
      }
      if (replyToken) {
        await this.replyMessage(replyToken, buildIncompleteHeaderReply(firstLine));
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    if (pending) {
      if (hasSessionStart(normalizedText) && !appendStart && !explicitAppendStart) {
        const gate = await this.canCollectProduceHeader(firstLine, sessionKey, log);
        if (!gate.ok) {
          await pendingService.delete(sessionKey);
          log.info("pending session aborted — new header blocked by Work Round gate", { sessionKey });
          if (replyToken) await this.replyMessage(replyToken, gate.reply);
          return { eventId, eventType: event.type, status: "saved", parsed: false };
        }

        let updated;
        try {
          await pendingService.create(sessionKey, text, replyToken, lineUserId);
          updated = (await pendingService.lookup(sessionKey)).session!;
          log.info("pending_session_replaced_by_new_header", {
            sessionKey,
            hadPriorPending: true,
            priorAccumulatedChars: pending.accumulated_text.length,
            newAccumulatedChars: updated.accumulated_text.length,
          });
        } catch (replaceError) {
          const errorMessage = replaceError instanceof Error
            ? replaceError.message
            : String(replaceError);
          log.error("pending session replace failed", { sessionKey, error: errorMessage });
          return {
            eventId,
            eventType: event.type,
            status: "error",
            parsed: false,
            error: errorMessage,
          };
        }

        if (hasSessionEnd(normalizedText)) {
          return this.finalizePendingSession(
            pendingService,
            updated,
            sessionKey,
            text,
            replyToken,
            lineUserId,
            rawMessageId,
            eventId,
            event.type,
            event.timestamp,
            log,
          );
        }

        log.debug("pending session replaced by header — waiting for session end", { sessionKey });
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      // Append raw text so the parser can extract senderName from TIME_PREFIX
      let updated;
      try {
        updated = await pendingService.append(sessionKey, text, replyToken);
        const appendParse = parseWeighSession(updated.accumulated_text, bangkokToday());
        log.info("pending session append succeeded", {
          sessionKey,
          appendSuccess: true,
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

      if (hasSessionEnd(normalizedText)) {
        return this.finalizePendingSession(
          pendingService,
          updated,
          sessionKey,
          text,
          replyToken,
          lineUserId,
          rawMessageId,
          eventId,
          event.type,
          event.timestamp,
          log,
        );
      }

      log.debug("message appended to pending session — waiting for session end", { sessionKey });
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 5. No active pending session ──────────────────────────────────────────
    if (explicitAppendStart) {
      const appendGate = await this.canCollectExplicitProduceAppend(firstLine, sessionKey, log);
      if (!appendGate.ok) {
        log.info("explicit produce append blocked", { sessionKey, firstLine });
        if (replyToken) await this.replyMessage(replyToken, appendGate.reply);
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      if (hasSessionEnd(normalizedText) || hasItemLine(normalizedText)) {
        log.info("complete explicit produce-append message — parsing directly", { sessionKey });
        return this.finalizeAccumulated(
          text,
          replyToken,
          lineUserId,
          rawMessageId,
          eventId,
          event.type,
          log,
          bangkokTimeFromTimestamp(event.timestamp),
          sessionKey,
          businessDateFromText(firstLine, bangkokToday()),
        );
      }

      log.info("explicit produce append marker — starting pending session", { sessionKey });
      try {
        await pendingService.create(sessionKey, text, replyToken, lineUserId);
      } catch (createErr) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr);
        log.error("pending session create failed for explicit produce append", { sessionKey, error: msg });
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    if (appendStart) {
      const appendGate = await this.canCollectProduceAppend(sessionKey, log);
      if (!appendGate.ok) {
        log.info("produce append blocked — no identifiable Work Round", { sessionKey });
        if (replyToken) await this.replyMessage(replyToken, appendGate.reply);
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      if (hasSessionEnd(normalizedText) || hasItemLine(normalizedText)) {
        log.info("complete produce-append message — parsing directly", { sessionKey });
        return this.finalizeAccumulated(
          text,
          replyToken,
          lineUserId,
          rawMessageId,
          eventId,
          event.type,
          log,
          bangkokTimeFromTimestamp(event.timestamp),
          sessionKey,
          bangkokToday(),
        );
      }

      log.info("produce append marker — starting pending session", { sessionKey });
      try {
        await pendingService.create(sessionKey, text, replyToken, lineUserId);
      } catch (createErr) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr);
        log.error("pending session create failed for produce append", { sessionKey, error: msg });
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    if (hasSessionStart(normalizedText)) {
      if (hasSessionEnd(normalizedText) || hasItemLine(normalizedText)) {
        // Complete single-message: has SESSION_END or item lines → parse directly
        console.log("single complete message detected — parsing directly");
        log.info("single complete message detected (has SESSION_END or items), parsing directly");
        return this.runParser(msgEvent, rawMessageId, eventId, event.type, log, sessionKey, bangkokToday());
      }

      const gate = await this.canCollectProduceHeader(firstLine, sessionKey, log);
      if (!gate.ok) {
        log.info("produce header blocked before pending session", { sessionKey, firstLine });
        if (replyToken) await this.replyMessage(replyToken, gate.reply);
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      // Header-only → start accumulating (store raw text so parser sees TIME_PREFIX sender)
      console.log("session header detected — starting pending session", sessionKey);
      log.info("session header detected — starting pending session", { sessionKey });
      try {
        await pendingService.create(sessionKey, text, replyToken, lineUserId);
        console.log("pending session create succeeded", sessionKey);
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            await this.buildProduceHeaderOpenedReply(firstLine, sessionKey),
          );
        }
      } catch (createErr) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr);
        console.log("pending session create FAILED:", msg);
        log.error("pending session create failed", { sessionKey, error: msg });
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    if (hasSessionEnd(normalizedText)) {
      console.log("SESSION_END received but no pending session found — ignoring", sessionKey);
      log.warn("SESSION_END received without active pending session", { sessionKey });
    } else {
      log.debug("no parser matched text message — left unprocessed");
    }
    return { eventId, eventType: event.type, status: "saved", parsed: false };
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

    // ── V2: resolve which Work Round this manual-slip evidence belongs to ─────
    const wrs      = new WorkRoundService(this.supabase);
    const decision = await wrs.resolveForEvidence(sourceId, businessDate);

    if (decision.mode === "error") {
      log.warn("manual slip open blocked: Work Round lookup failed", { sourceId, businessDate, error: decision.error });
      if (replyToken) await this.replyMessage(replyToken, "ยังเปิดสลิปมือไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้ง");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    if (decision.mode === "no_round" || decision.mode === "blocked") {
      log.info("manual slip open blocked: rounds exist but none eligible", { sourceId, businessDate });
      if (replyToken) await this.replyMessage(replyToken, "ไม่พบงวดที่เปิดอยู่สำหรับวันนี้ กรุณาเปิดงวดก่อน");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    if (decision.mode === "select") {
      const candidates = await wrs.buildCandidates(decision.candidates);
      await new WorkRoundSelectionService(this.supabase).create({
        sourceId, lineUserId, businessDate, intent: "manual_slip", candidates,
        payload: { dateStr, marketLabel, marketKey, lineMessageId },
      });
      log.info("manual slip open: multiple eligible rounds — pending selection", { count: decision.candidates.length });
      if (replyToken) await this.replyMessage(replyToken, buildSelectionMessage("manual_slip", candidates));
      return { eventId, eventType, status: "saved", parsed: false };
    }

    const workRoundId = decision.mode === "linked" ? decision.workRound.id : null; // deliberate legacy only

    try {
      const svc    = new ManualSlipSessionService(this.supabase);
      const result = await svc.openSession({ sourceId, businessDate, marketKey, marketLabel, lineUserId, lineMessageId, workRoundId });

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
          sourceId, businessDate, session.work_round_id ?? null,
          lineMessageId, lineUserId, replyToken, false, log,
        );
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // New session successfully opened.
      const { amounts, hasClose } = this.extractBatchLines(fullText);
      if (amounts.length > 0 || hasClose) {
        await this.processSessionBatch(
          svc, result.session!.id as string, dateStr, amounts, hasClose,
          sourceId, businessDate, result.session!.work_round_id ?? null,
          lineMessageId, lineUserId, replyToken, true, log,
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
    workRoundId:   string | null,
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
      if (workRoundId) {
        this.tryFinalizeWorkRoundSafe(workRoundId, log);
      } else {
        tryFinalizeSettlement(this.supabase, sourceId, businessDate).catch(
          (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
        );
      }
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
      if (session.work_round_id) {
        this.tryFinalizeWorkRoundSafe(session.work_round_id, log);
      } else {
        tryFinalizeSettlement(this.supabase, sourceId, session.business_date).catch(
          (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
        );
      }
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
            const shouldReplyNoSession = this.shouldReplyNoSessionImageGuidance(
              sourceId,
              senderId,
              event.timestamp || Date.now(),
            );
            if (event.replyToken && shouldReplyNoSession) {
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
            if (activeSession.workRoundId) {
              await this.supabase
                .from("slip_evidences")
                .update({ work_round_id: activeSession.workRoundId })
                .eq("id", evidenceId);
            }
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

  // Converts a slip header date ("9/6/2569") to an ISO business date.
  // Falls back to today's Bangkok business date when the header has no date.
  private slipHeaderBusinessDate(header: SlipSessionHeader): string {
    if (header.slipDate) {
      const m = header.slipDate.match(/^(\d{1,2})\/(\d{1,2})\/((?:25)?\d{2})$/);
      if (m) return parseBuddhistDate(m[1], m[2], m[3]);
    }
    return bangkokToday();
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

    this.resetNoSessionImageGuidance(sourceId, senderId);

    log.info("slip session open command received", {
      sourceId,
      sellerName: header.sellerName,
      marketName: header.marketName,
      slipDate:   header.slipDate,
    });

    try {
      // ── V2: resolve which Work Round this slip evidence belongs to ─────────
      const businessDate = this.slipHeaderBusinessDate(header);
      const wrs          = new WorkRoundService(this.supabase);
      const decision     = await wrs.resolveForEvidence(sourceId, businessDate, {
        sellerName: header.sellerName, marketName: header.marketName,
      });

      if (decision.mode === "error") {
        log.warn("slip open blocked: Work Round lookup failed", { sourceId, businessDate, error: decision.error });
        if (replyToken) await this.replyMessage(replyToken, "ยังเปิดชุดสลิปไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้ง");
        return { eventId, eventType, status: "saved", parsed: false };
      }

      if (decision.mode === "no_round") {
        log.info("slip open blocked: no matching Work Round", {
          sourceId,
          businessDate,
          sellerName: header.sellerName,
          marketName: header.marketName,
        });
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            [
              `ไม่พบรอบงานของ ${header.sellerName} — ${header.marketName}`,
              `วันที่ ${header.slipDate ?? businessDate}`,
              "กรุณาเปิดเบิกและปิดรอบให้เรียบร้อยก่อนส่งสลิป",
            ].join("\n"),
          );
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      if (decision.mode === "blocked") {
        log.info("slip open blocked: matching Work Round not evidence-eligible", {
          sourceId,
          businessDate,
          statuses: decision.candidates.map((r) => r.status),
        });
        const statusList = [...new Set(decision.candidates.map((r) => r.status))].join(", ");
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            [
              `พบรอบงานของ ${header.sellerName} — ${header.marketName}`,
              `วันที่ ${header.slipDate ?? businessDate}`,
              `แต่ยังไม่พร้อมรับสลิป (สถานะ: ${statusList})`,
              "กรุณาปิดรอบและยืนยันส่งเงินก่อนส่งสลิป",
            ].join("\n"),
          );
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      if (decision.mode === "select") {
        const candidates = await wrs.buildCandidates(decision.candidates);
        await new WorkRoundSelectionService(this.supabase).create({
          sourceId, lineUserId: senderId, businessDate, intent: "slip", candidates,
          payload: { header, sourceType: event.source.type, senderId },
        });
        log.info("slip open: multiple eligible rounds — pending selection", { count: decision.candidates.length });
        if (replyToken) await this.replyMessage(replyToken, buildSelectionMessage("slip", candidates));
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const workRoundId = decision.mode === "linked" ? decision.workRound.id : null; // legacy → null

      const result = await this.slipSessionService.openSession(
        sourceId, event.source.type, senderId, header, workRoundId,
      );

      if (!result.opened) {
        log.info("slip open: session already open", { existingBatchId: result.existingBatchId });
        if (replyToken) await this.replyMessage(replyToken, SESSION_ALREADY_OPEN_REPLY);
        return { eventId, eventType, status: "saved", parsed: false };
      }

      log.info("slip session opened", { batchId: result.batchId, workRoundId, mode: decision.mode });

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

  // ── Produce pending-session helpers ───────────────────────────────────────

  private async buildProduceHeaderOpenedReply(
    firstLine:  string,
    sessionKey: string,
  ): Promise<string> {
    const hdr = classifyHeader(firstLine);
    if (!hdr) return buildBorrowOpenedReply(firstLine);

    const isReturnIntent =
      hdr.txIntent === "คืน" || hdr.txIntent === "คืนเสีย" || hdr.txIntent === "ชั่งคืนเพิ่ม";

    if (hdr.type === "explicit" && hdr.txIntent === "เบิก") {
      return buildBorrowOpenedReply(firstLine);
    }

    if (isReturnIntent) {
      const wrs = new WorkRoundService(this.supabase);
      const decision = await wrs.resolveForIntent({
        sourceId:        sessionKey,
        businessDate:    businessDateFromText(firstLine, bangkokToday()),
        sellerName:      hdr.type === "explicit" || hdr.type === "seller_only" ? hdr.sellerName : undefined,
        marketName:      hdr.type === "explicit" ? hdr.marketName : undefined,
        allowedStatuses: allowedProduceStatusesForIntent(hdr.txIntent),
      });
      if (decision.mode === "linked") {
        return buildReturnHeaderOpenedReply(
          decision.workRound.seller_name,
          decision.workRound.market_name,
          hdr.txIntent,
        );
      }
      if (hdr.type === "explicit") {
        return buildReturnHeaderOpenedReply(hdr.sellerName, hdr.marketName, hdr.txIntent);
      }
      return [
        hdr.txIntent === "คืนเสีย" ? "รับหัวคืนเสียแล้ว ✅" : "รับหัวชั่งคืนแล้ว ✅",
        "— —",
        "ส่งรายการสินค้าได้เลย",
        "ปิดรายการด้วย: จบรายการ",
      ].join("\n");
    }

    return buildBorrowOpenedReply(firstLine);
  }

  private async canCollectProduceHeader(
    firstLine:  string,
    sessionKey: string,
    log:        ChildLogger,
  ): Promise<{ ok: true } | { ok: false; reply: string }> {
    const hdr = classifyHeader(firstLine);
    const wrs = new WorkRoundService(this.supabase);
    if (!hdr) {
      return { ok: false, reply: wrs.buildNoRoundPrompt() };
    }

    const businessDate = businessDateFromText(firstLine, bangkokToday());

    if (hdr.type === "explicit" && hdr.txIntent === "เบิก") {
      if (!RE.DATE_IN_TEXT.test(firstLine)) {
        return { ok: false, reply: buildMissingDateReply(firstLine) };
      }
      return { ok: true };
    }

    if (hdr.type === "explicit" && hdr.txIntent === "เบิกเพิ่ม") {
      return this.canCollectExplicitProduceAppend(firstLine, sessionKey, log);
    }

    if (hdr.type === "seller_only" && (hdr.txIntent === "เบิก" || hdr.txIntent === "เบิกเพิ่ม")) {
      log.info("seller-only borrow header blocked before pending session", {
        sessionKey,
        sellerName: hdr.sellerName,
        txIntent: hdr.txIntent,
      });
      return { ok: false, reply: wrs.buildNoRoundPrompt() };
    }

    try {
      const decision = await wrs.resolveForIntent({
        sourceId: sessionKey,
        businessDate,
        sellerName: hdr.type === "explicit" || hdr.type === "seller_only" ? hdr.sellerName : undefined,
        marketName: hdr.type === "explicit" ? hdr.marketName : undefined,
        allowedStatuses: allowedProduceStatusesForIntent(hdr.txIntent),
      });
      if (decision.mode === "error") {
        log.warn("Work Round header gate lookup failed", { sessionKey, businessDate, error: decision.error });
        return { ok: false, reply: wrs.buildNoRoundPrompt() };
      }
      if (decision.mode === "no_round") {
        log.info("generic header: no open Work Round — blocking pending session", { sessionKey });
        return { ok: false, reply: wrs.buildNoRoundPrompt() };
      }
      if (decision.mode === "blocked") {
        log.info("generic header: ambiguous Work Rounds — blocking pending session", {
          sessionKey, count: decision.candidates.length,
        });
        return {
          ok: false,
          reply: "พบรอบงานแล้ว แต่สถานะยังไม่พร้อมรับรายการนี้ กรุณาตรวจสอบในหน้า Work Rounds",
        };
      }
      log.info("generic header: resolved to one open Work Round", {
        sessionKey, mode: decision.mode,
      });
      return { ok: true };
    } catch (wrErr) {
      log.warn("Work Round disambiguation failed (may need migration)", {
        error: wrErr instanceof Error ? wrErr.message : String(wrErr),
      });
      return { ok: false, reply: wrs.buildNoRoundPrompt() };
    }
  }

  private async canCollectExplicitProduceAppend(
    firstLine:  string,
    sessionKey: string,
    log:        ChildLogger,
  ): Promise<{ ok: true } | { ok: false; reply: string }> {
    const hdr = classifyHeader(firstLine);
    const wrs = new WorkRoundService(this.supabase);
    if (hdr?.type !== "explicit" || hdr.txIntent !== "เบิกเพิ่ม") {
      return { ok: false, reply: wrs.buildNoAppendRoundPrompt() };
    }

    if (!RE.DATE_IN_TEXT.test(firstLine)) {
      return { ok: false, reply: buildMissingDateReply(firstLine) };
    }

    const businessDate = businessDateFromText(firstLine, bangkokToday());

    try {
      const result = await wrs.resolveExplicitProduceAppend({
        sourceId: sessionKey,
        businessDate,
        sellerName: hdr.sellerName,
        marketName: hdr.marketName,
      });
      if (result.status === "resolved") {
        log.info("explicit produce append: resolved to Work Round", {
          sessionKey, workRoundId: result.workRound.id,
        });
        return { ok: true };
      }
      if (result.status === "ambiguous") {
        log.info("explicit produce append: ambiguous Work Rounds", {
          sessionKey, count: result.candidates.length,
        });
        return { ok: false, reply: wrs.buildDisambiguationPrompt(result.candidates) };
      }

      const all = await wrs.findAllRounds(sessionKey, businessDate);
      const sameIdentity = all.filter(
        (r) => r.seller_name === hdr.sellerName && r.market_name === hdr.marketName,
      );
      if (sameIdentity.some((r) => !PRODUCE_APPEND_ELIGIBLE_STATUSES.includes(r.status))) {
        log.info("explicit produce append: round exists but not append-eligible", { sessionKey });
        return {
          ok:    false,
          reply: "รอบนี้อนุมัติแล้วหรือไม่พร้อมรับรายการเพิ่ม กรุณาตรวจสอบสถานะรอบในหน้า Work Rounds",
        };
      }

      log.info("explicit produce append: no matching open Work Round", { sessionKey });
      return {
        ok:    false,
        reply: wrs.buildNoExplicitAppendRoundPrompt(hdr.sellerName, hdr.marketName, businessDate),
      };
    } catch (wrErr) {
      log.warn("explicit produce append Work Round lookup failed", {
        error: wrErr instanceof Error ? wrErr.message : String(wrErr),
      });
      return { ok: false, reply: wrs.buildNoAppendRoundPrompt() };
    }
  }

  private async canCollectProduceAppend(
    sessionKey: string,
    log:        ChildLogger,
  ): Promise<{ ok: true } | { ok: false; reply: string }> {
    try {
      const wrs    = new WorkRoundService(this.supabase);
      const result = await wrs.resolveProduceAppendTarget(sessionKey);
      if (result.status === "none") {
        log.info("produce append: no identifiable open Work Round", { sessionKey });
        return { ok: false, reply: wrs.buildNoAppendRoundPrompt() };
      }
      if (result.status === "ambiguous") {
        log.info("produce append: ambiguous Work Rounds", {
          sessionKey, count: result.candidates.length,
        });
        return { ok: false, reply: wrs.buildDisambiguationPrompt(result.candidates) };
      }
      log.info("produce append: resolved to Work Round", {
        sessionKey, workRoundId: result.workRound.id,
      });
      return { ok: true };
    } catch (wrErr) {
      log.warn("produce append Work Round lookup failed", {
        error: wrErr instanceof Error ? wrErr.message : String(wrErr),
      });
      return {
        ok:    false,
        reply: new WorkRoundService(this.supabase).buildNoAppendRoundPrompt(),
      };
    }
  }

  private async finalizePendingSession(
    pendingService:   PendingSessionService,
    updated:          import("@/lib/line/pending-session-service").PendingSession,
    sessionKey:       string,
    _text:            string,
    replyToken:       string | null,
    lineUserId:       string | null,
    rawMessageId:     string,
    eventId:          string,
    eventType:        string,
    endEventTimestamp: number,
    log:              ChildLogger,
  ): Promise<WebhookProcessResult> {
    log.info("pending session end command received", {
      sessionKey,
      endCommandReceived: true,
      settleMs: this.produceEndSettleMs,
    });
    if (this.produceEndSettleMs > 0) {
      await this.sleep(this.produceEndSettleMs);
    }

    let finalText = updated.accumulated_text;
    const fallbackTime = bangkokTimeFromTimestamp(new Date(updated.created_at).getTime());
    const accumulatedItemCount = parseWeighSession(
      updated.accumulated_text,
      bangkokToday(),
      fallbackTime,
    ).items.length;

    try {
      const rebuilt = await pendingService.rebuildForFinalization(
        sessionKey,
        updated,
        endEventTimestamp,
      );
      const rebuiltItemCount = parseWeighSession(
        rebuilt,
        bangkokToday(),
        fallbackTime,
      ).items.length;
      if (rebuiltItemCount >= accumulatedItemCount) {
        finalText = rebuilt;
      } else {
        log.warn("pending session rebuild dropped items — keeping accumulated buffer", {
          sessionKey,
          accumulatedItemCount,
          rebuiltItemCount,
        });
      }
    } catch (rebuildError) {
      log.error("pending session raw-message rebuild failed", {
        sessionKey,
        error: rebuildError instanceof Error ? rebuildError.message : String(rebuildError),
      });
    }

    const result = await this.finalizeAccumulated(
      finalText,
      updated.latest_reply_token ?? replyToken,
      updated.line_user_id ?? lineUserId,
      rawMessageId,
      eventId,
      eventType,
      log,
      fallbackTime,
      sessionKey,
      bangkokToday(),
    );

    await pendingService.delete(sessionKey);
    if (result.pendingSessionClosed) {
      log.info("pending session closed", { sessionKey, sessionStatus: "closed" });
    } else {
      log.warn("pending session aborted after unsuccessful finalization", {
        sessionKey,
        sessionStatus: "aborted",
      });
    }
    return result;
  }

  // ── Finalize accumulated multi-message session ────────────────────────────
  private async finalizeAccumulated(
    accumulatedText:  string,
    replyToken:       string | null,
    lineUserId:       string | null,
    rawMessageId:     string,
    eventId:          string,
    eventType:        string,
    log:              ChildLogger,
    fallbackTime:     string | null = null,
    sourceId:         string        = "",
    businessDate:     string        = "",
  ): Promise<WebhookProcessResult> {
    try {
      console.log("[TRACE][finalizeAccumulated] accumulated_text_before_parse:\n" + accumulatedText);
      const parsed = parseWeighSession(accumulatedText, bangkokToday(), fallbackTime);
      console.log("[TRACE][finalizeAccumulated] parser_output:", JSON.stringify({ date: parsed.date, staff_name: parsed.staff_name, items_count: parsed.items.length, items: parsed.items, parse_errors: parsed.parse_errors }, null, 2));

      if (parsed.parse_errors.length > 0) {
        log.warn("finalized with parse errors", { errors: parsed.parse_errors });
        for (const parseError of parsed.parse_errors) {
          log.warn("produce session parse error", { rawLine: parseError });
        }
      }

      // Fix 2: guard empty parse
      if (parsed.items.length === 0) {
        log.warn("parsed session has no items — aborting");
        if (replyToken) {
          try {
            await this.replyMessage(replyToken, "อ่านรายการไม่สำเร็จ กรุณาตรวจสอบรูปแบบข้อความ");
          } catch (e) {
            log.error("reply failed", { error: String(e) });
          }
        }
        return {
          eventId,
          eventType,
          status: "saved",
          parsed: false,
          pendingSessionClosed: true,
        };
      }

      if (hasParseReviewBlockers(parsed)) {
        log.warn("parsed session has review blockers — aborting", { issues: parsed.review_issues });
        if (replyToken) {
          try {
            await this.replyMessage(replyToken, buildParseReviewReply(parsed));
          } catch (e) {
            log.error("reply failed", { error: String(e) });
          }
        }
        return {
          eventId,
          eventType,
          status: "saved",
          parsed: false,
          pendingSessionClosed: true,
        };
      }

      // V2: gate on Work Round resolution, then dedup + persist.
      return await this.persistProduceGated({
        parsed, accumulatedText, rawMessageId, lineUserId, replyToken,
        sourceId, businessDate, eventId, eventType, log,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("finalize accumulated session failed", { error: errorMessage });

      if (replyToken) {
        try {
          await replyLineMessage(replyToken, "ยังอ่านรายการนี้ไม่ได้ครับ กรุณาตรวจรูปแบบข้อความอีกครั้ง");
        } catch (e) {
          log.error("reply failed", { error: String(e) });
        }
      }

      return {
        eventId,
        eventType,
        status: "saved",
        parsed: false,
        error: errorMessage,
        pendingSessionClosed: true,
      };
    }
  }

  // ── Single-message parser flow (backward compat) ──────────────────────────
  private async runParser(
    msgEvent:     LineMessageEvent,
    rawMessageId: string,
    eventId:      string,
    eventType:    string,
    log:          ChildLogger,
    sourceId:     string = "",
    businessDate: string = "",
  ): Promise<WebhookProcessResult> {
    const parser     = parserRegistry.findParser(msgEvent);
    const replyToken = msgEvent.replyToken;

    if (!parser) {
      log.debug("no parser matched");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    log.info("running parser", { parser: parser.name, version: parser.version });

    try {
      console.log("[TRACE][runParser] text_before_parse:", (msgEvent.message as import("@/lib/line/types").LineTextMessage).text);
      const result = await parser.parse(msgEvent);

      // V2: weigh-session is persisted through the Work-Round-gated path so a
      // complete single-message generic session can NEVER persist unresolved.
      if (parser.name === "weigh-session" && result.data) {
        const ws = result.data as unknown as WeighSession;
        console.log("[TRACE][runParser] parser_output:", JSON.stringify({ date: ws.date, staff_name: ws.staff_name, items_count: ws.items.length, items: ws.items, parse_errors: ws.parse_errors }, null, 2));

        if (ws.items.length === 0) {
          log.warn("parsed session has no items — aborting");
          if (replyToken) {
            try {
              await this.replyMessage(replyToken, "อ่านรายการไม่สำเร็จ กรุณาตรวจสอบรูปแบบข้อความ");
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        if (hasParseReviewBlockers(ws)) {
          log.warn("parsed session has review blockers — aborting", { issues: ws.review_issues });
          if (replyToken) {
            try {
              await this.replyMessage(replyToken, buildParseReviewReply(ws));
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        const rawText = (msgEvent.message as LineTextMessage).text;
        return await this.persistProduceGated({
          parsed:          ws,
          accumulatedText: rawText,
          rawMessageId,
          lineUserId:      getUserId(msgEvent.source),
          replyToken:      replyToken ?? null,
          sourceId,
          businessDate,
          eventId,
          eventType,
          log,
        });
      }

      // Non-weigh parsers keep the legacy persist path.
      await result.persist(this.supabase, rawMessageId);

      await this.supabase
        .from("raw_messages")
        .update({ is_processed: true })
        .eq("id", rawMessageId);

      log.info("parse succeeded", { parser: parser.name });

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

  // ── V2: LINE-first settlement command ─────────────────────────────────────
  // Handles "ส่งเงิน 24/06/2569" or "ปิดยอด 24/06/2569".
  // Opens/finds a settlement draft tied to a Work Round.
  // Declared amounts may appear in the same message on lines after the command.
  private async processSettlementCommand(
    event:        LineMessageEvent,
    fullText:     string,
    dateStr:      string,
    eventId:      string,
    eventType:    string,
    log:          ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;

    const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/((?:25)?\d{2})$/);
    if (!parts) {
      if (replyToken) await replyLineMessage(replyToken, "รูปแบบวันที่ไม่ถูกต้อง เช่น ส่งเงิน 24/06/2569");
      return { eventId, eventType, status: "saved", parsed: false };
    }
    const businessDate = parseBuddhistDate(parts[1], parts[2], parts[3]);

    log.info("settlement command received", { sourceId, businessDate, dateStr });

    if (!lineUserId) {
      if (replyToken) await replyLineMessage(replyToken, "ยังระบุตัวผู้ส่งไม่ได้ กรุณาส่งคำสั่งจากบัญชี LINE ผู้ใช้ในกลุ่ม");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    try {
      const svc    = new SettlementIntakeService(this.supabase);
      const rounds = await svc.findEligibleRounds(sourceId, businessDate);

      // P0: NEVER auto-select among multiple Work Rounds.
      if (rounds.length === 0) {
        if (replyToken) await replyLineMessage(replyToken, svc.buildSelectionPrompt([], dateStr));
        return { eventId, eventType, status: "saved", parsed: false };
      }

      if (rounds.length > 1) {
        // Record a durable pending selection and reply with numbered options.
        const wrs        = new WorkRoundService(this.supabase);
        const candidates = await wrs.buildCandidates(rounds);
        await new WorkRoundSelectionService(this.supabase).create({
          sourceId, lineUserId, businessDate, intent: "settlement", candidates,
          payload: { fullText },
        });
        log.info("multiple eligible rounds — pending settlement selection created", { count: rounds.length });
        if (replyToken) await replyLineMessage(replyToken, buildSelectionMessage("settlement", candidates));
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // Exactly one eligible round — proceed.
      return await this.openSettlementForRound(
        rounds[0], fullText, lineUserId, replyToken, eventId, eventType, log,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("settlement command failed", { error: errorMessage });
      if (replyToken) {
        try { await replyLineMessage(replyToken, "เปิดรายการส่งเงินไม่สำเร็จ กรุณาลองอีกครั้ง"); } catch { /* ignore */ }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // Opens/reuses a settlement draft for a specific Work Round, records any
  // same-message amounts, advances round status, and replies.
  private async openSettlementForRound(
    round:      import("@/lib/work-round/types").WorkRound,
    fullText:   string,
    lineUserId: string | null,
    replyToken: string | undefined,
    eventId:    string,
    eventType:  string,
    log:        ChildLogger,
  ): Promise<WebhookProcessResult> {
    const svc    = new SettlementIntakeService(this.supabase);
    const status = new WorkRoundStatusService(this.supabase);
    const wr     = round;

    await status.applyEvent(round.id, "settlement_opened");

    const { draft } = await svc.openDraft(round.id, lineUserId);

    if (hasAnyAmount(fullText)) {
      const amounts = parseSettlementAmounts(fullText);
      const updated = await svc.recordDeclared(draft.id, amounts, lineUserId);
      if (replyToken) await replyLineMessage(replyToken, svc.buildReviewSummary(updated, wr));
      log.info("settlement draft declared (same message)", { draftId: draft.id });
    } else {
      if (replyToken) await replyLineMessage(replyToken, svc.buildAmountsPrompt(wr));
      log.info("settlement draft opened — awaiting amounts", { draftId: draft.id });
    }
    return { eventId, eventType, status: "saved", parsed: false };
  }

  // ── V2: settlement follow-up (amounts or ยืนยันส่งเงิน in a later message) ──
  // Returns null if no open draft for this sender, so the caller falls through.
  private async trySettlementFollowup(
    event:     LineMessageEvent,
    text:      string,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult | null> {
    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;

    let found: Awaited<ReturnType<SettlementIntakeService["findOpenDraftForSender"]>>;
    try {
      const svc = new SettlementIntakeService(this.supabase);
      const foundList = await svc.findOpenDraftsForSender(sourceId, lineUserId);
      if (foundList.length > 1) {
        const wrs = new WorkRoundService(this.supabase);
        const candidates = await wrs.buildCandidates(foundList.map((f) => f.round));
        await new WorkRoundSelectionService(this.supabase).create({
          sourceId, lineUserId, businessDate: foundList[0].round.business_date,
          intent: "settlement", candidates, payload: { followupText: text },
        });
        if (replyToken) await replyLineMessage(replyToken, buildSelectionMessage("settlement", candidates));
        return { eventId, eventType, status: "saved", parsed: false };
      }
      found = foundList[0] ?? null;
    } catch (err) {
      // work_rounds/settlement_drafts not migrated — let other handlers run.
      log.warn("settlement followup lookup skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (!found) return null; // wrong sender / no open draft / stale — fall through

    const { draft, round } = found;

    return this.applySettlementFollowupForRound(
      draft, round, text, lineUserId, replyToken, eventId, eventType, log,
    );
  }

  private async processCloseRoundCommand(
    event:     LineMessageEvent,
    dateStr:   string,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;
    const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/((?:25)?\d{2})$/);
    if (!parts) {
      if (replyToken) await this.replyMessage(replyToken, "รูปแบบวันที่ไม่ถูกต้อง เช่น ปิดรอบ 24/06/2569");
      return { eventId, eventType, status: "saved", parsed: false };
    }
    if (!lineUserId) {
      if (replyToken) await this.replyMessage(replyToken, "ยังระบุตัวผู้ส่งไม่ได้ กรุณาส่งคำสั่งจากบัญชี LINE ผู้ใช้ในกลุ่ม");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    const businessDate = parseBuddhistDate(parts[1], parts[2], parts[3]);
    const wrs = new WorkRoundService(this.supabase);
    try {
      const decision = await wrs.resolveForIntent({
        sourceId,
        businessDate,
        allowedStatuses: ["open"],
      });
      if (decision.mode === "error") throw new Error(decision.error);
      if (decision.mode === "no_round") {
        if (replyToken) await this.replyMessage(replyToken, `ไม่พบรอบที่เปิดอยู่สำหรับวันที่ ${dateStr}`);
        return { eventId, eventType, status: "saved", parsed: false };
      }
      if (decision.mode === "blocked") {
        if (replyToken) await this.replyMessage(replyToken, `พบรอบสำหรับวันที่ ${dateStr} แต่สถานะยังไม่พร้อมปิดรอบ`);
        return { eventId, eventType, status: "saved", parsed: false };
      }
      if (decision.mode === "select") {
        const candidates = await wrs.buildCandidates(decision.candidates);
        await new WorkRoundSelectionService(this.supabase).create({
          sourceId, lineUserId, businessDate, intent: "close_round", candidates,
          payload: { dateStr },
        });
        if (replyToken) await this.replyMessage(replyToken, buildSelectionMessage("close_round", candidates));
        return { eventId, eventType, status: "saved", parsed: false };
      }
      if (decision.mode !== "linked") {
        if (replyToken) await this.replyMessage(replyToken, "ปิดรอบไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้ง");
        return { eventId, eventType, status: "saved", parsed: false };
      }
      const candidates = await wrs.buildCandidates([decision.workRound]);
      await this.createCloseRoundConfirmation(sourceId, lineUserId, businessDate, candidates[0], dateStr);
      if (replyToken) await this.replyMessage(replyToken, await this.buildCloseRoundConfirmPrompt(decision.workRound));
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      log.warn("close round command failed", { error: err instanceof Error ? err.message : String(err) });
      if (replyToken) await this.replyMessage(replyToken, "ปิดรอบไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้ง");
      return { eventId, eventType, status: "saved", parsed: false };
    }
  }

  private async processCloseRoundConfirmation(
    event:     LineMessageEvent,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;
    const selSvc = new WorkRoundSelectionService(this.supabase);
    const wrs = new WorkRoundService(this.supabase);
    try {
      const selection = await selSvc.findActive(sourceId, lineUserId);
      if (!selection || selection.intent !== "close_round_confirm") {
        if (replyToken) await this.replyMessage(replyToken, "ไม่พบรายการปิดรอบที่รอยืนยัน กรุณาพิมพ์ \"ปิดรอบ วันที่\" อีกครั้ง");
        return { eventId, eventType, status: "saved", parsed: false };
      }
      const claimed = await selSvc.claim({
        selectionId: selection.id,
        sourceId,
        lineUserId,
        choice: 1,
        allowedStatuses: ["open"],
      });
      const workRoundId = claimed?.resolved_work_round_id;
      if (!workRoundId) {
        if (replyToken) await this.replyMessage(replyToken, "รอบมีการเปลี่ยนแปลงหลังสรุป กรุณาสั่งปิดรอบใหม่เพื่อตรวจยอดอีกครั้ง");
        return { eventId, eventType, status: "saved", parsed: false };
      }
      const round = await wrs.validateChoice(workRoundId, sourceId, selection.business_date, ["open"]);
      if (!round) {
        if (replyToken) await this.replyMessage(replyToken, "รอบมีการเปลี่ยนแปลงหลังสรุป กรุณาสั่งปิดรอบใหม่เพื่อตรวจยอดอีกครั้ง");
        return { eventId, eventType, status: "saved", parsed: false };
      }
      const next = await new WorkRoundStatusService(this.supabase).applyEvent(workRoundId, "produce_closed");
      if (!next) {
        if (replyToken) await this.replyMessage(replyToken, "ปิดรอบไม่ได้แล้ว กรุณาตรวจสอบในหน้า Work Rounds");
        return { eventId, eventType, status: "saved", parsed: false };
      }
      if (replyToken) await this.replyMessage(replyToken, await this.buildCloseRoundSuccessReply(round));
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      log.error("close round confirmation failed", { error: err instanceof Error ? err.message : String(err) });
      if (replyToken) await this.replyMessage(replyToken, "ยืนยันปิดรอบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
      return { eventId, eventType, status: "saved", parsed: false };
    }
  }

  private async createCloseRoundConfirmation(
    sourceId: string,
    lineUserId: string,
    businessDate: string,
    candidate: SelectionCandidate,
    dateStr: string,
  ): Promise<void> {
    await new WorkRoundSelectionService(this.supabase).create({
      sourceId,
      lineUserId,
      businessDate,
      intent: "close_round_confirm",
      candidates: [candidate],
      payload: { dateStr },
    });
  }

  private async buildCloseRoundConfirmPrompt(round: WorkRound): Promise<string> {
    const totals = await computeRoundTotals(this.supabase, round.id);
    return [
      `${round.seller_name} — ${round.market_name}`,
      this.formatBusinessDateThai(round.business_date),
      "",
      `ยอดเบิก: ${this.formatBaht(totals.borrow)}`,
      `ยอดชั่งคืน: ${this.formatBaht(totals.ret)}`,
      `ยอดคืนเสีย: ${this.formatBaht(totals.badReturn)}`,
      `ยอดที่ต้องขายได้: ${this.formatBaht(totals.expected)}`,
      "",
      "พิมพ์ “ยืนยันปิดรอบ” เพื่อดำเนินการต่อ",
    ].join("\n");
  }

  private async buildCloseRoundSuccessReply(round: WorkRound): Promise<string> {
    const totals = await computeRoundTotals(this.supabase, round.id);
    const [year, month, day] = round.business_date.split("-").map(Number);
    const shortDate = `${day}/${month}/${year + 543}`;
    const amountInt = totals.expected.toLocaleString("th-TH", { maximumFractionDigits: 0 });
    return [
      "ปิดรอบเรียบร้อย ✅",
      `${round.seller_name} — ${round.market_name}`,
      `ยอดที่ต้องส่ง: ${this.formatBaht(totals.expected)}`,
      "",
      "แจ้งยอดโอนด้วย:",
      `ส่งเงิน ${shortDate} ${amountInt} บาท`,
    ].join("\n");
  }

  private formatBaht(amount: number): string {
    return `${amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
  }

  private formatBusinessDateThai(businessDate: string): string {
    const [year, month, day] = businessDate.split("-").map((v) => Number(v));
    const monthNames = [
      "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
      "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
    ];
    if (!year || !month || !day || month < 1 || month > 12) return businessDate;
    return `${day} ${monthNames[month - 1]} ${year + 543}`;
  }

  private async applySettlementFollowupForRound(
    draft:      import("@/lib/work-round/types").SettlementDraft,
    round:      import("@/lib/work-round/types").WorkRound,
    text:       string,
    lineUserId: string | null,
    replyToken: string | undefined,
    eventId:    string,
    eventType:  string,
    log:        ChildLogger,
  ): Promise<WebhookProcessResult> {
    const svc    = new SettlementIntakeService(this.supabase);
    const status = new WorkRoundStatusService(this.supabase);

    if (isConfirmCommand(text)) {
      const submitted = await svc.confirmDraft(draft.id, lineUserId);
      await status.applyEvent(round.id, "settlement_confirmed");
      if (replyToken) await replyLineMessage(replyToken, svc.buildSubmittedReply(submitted, round));
      log.info("settlement draft confirmed/submitted", { draftId: draft.id, workRoundId: round.id });
      this.tryFinalizeWorkRoundSafe(round.id, log);
      return { eventId, eventType, status: "saved", parsed: false };
    }

    // Amounts present — record a new immutable history version and ask to confirm.
    const amounts = parseSettlementAmounts(text);
    const updated = await svc.recordDeclared(draft.id, amounts, lineUserId);
    if (replyToken) await replyLineMessage(replyToken, svc.buildReviewSummary(updated, round));
    log.info("settlement draft declared (follow-up)", { draftId: draft.id, workRoundId: round.id });
    return { eventId, eventType, status: "saved", parsed: false };
  }

  // ── V2: resolve a pending numbered selection ──────────────────────────────
  // Returns null if there is no active selection for this sender (caller falls through).
  private async tryResolveSelection(
    event:     LineMessageEvent,
    choice:    number,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult | null> {
    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;

    let selection;
    try {
      selection = await new WorkRoundSelectionService(this.supabase).findActive(sourceId, lineUserId);
    } catch (err) {
      log.warn("selection lookup skipped", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    if (!selection) return null;

    const selSvc  = new WorkRoundSelectionService(this.supabase);
    const wrs     = new WorkRoundService(this.supabase);
    const candidates = selection.candidates as SelectionCandidate[];
    const idx     = choice - 1;

    if (idx < 0 || idx >= candidates.length) {
      if (replyToken) await replyLineMessage(replyToken, `กรุณาเลือกหมายเลข 1-${candidates.length}`);
      return { eventId, eventType, status: "saved", parsed: false };
    }

    const candidate = candidates[idx];
    if (selection.intent === "close_round_confirm") {
      if (replyToken) await replyLineMessage(replyToken, "พิมพ์ ยืนยันปิดรอบ เพื่อปิดรอบ");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    const eligible: WorkRoundStatus[] = selection.intent === "settlement"
      ? SETTLEMENT_ELIGIBLE_STATUSES
      : selection.intent === "close_round"
        ? ["open"]
        : selection.intent === "produce_attach"
          ? ["open", "awaiting_settlement", "awaiting_slips", "variance_found", "ready_for_review", "needs_correction"]
          : EVIDENCE_ELIGIBLE_STATUSES;

    // Re-validate: round must still exist, belong to this source/date, be eligible.
    const round = await wrs.validateChoice(
      candidate.work_round_id, sourceId, selection.business_date, eligible,
    );
    if (!round) {
      await selSvc.expire(selection.id);
      if (replyToken) await replyLineMessage(replyToken, "ตัวเลือกหมดอายุหรือใช้ไม่ได้แล้ว กรุณาเริ่มใหม่");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    const claimed = await selSvc.claim({
      selectionId: selection.id,
      sourceId,
      lineUserId,
      choice,
      allowedStatuses: eligible,
    });
    if (!claimed) {
      if (replyToken) await replyLineMessage(replyToken, "ตัวเลือกนี้ถูกใช้ไปแล้วหรือหมดอายุ กรุณาเริ่มใหม่");
      return { eventId, eventType, status: "saved", parsed: false };
    }
    log.info("selection resolved", { intent: selection.intent, workRoundId: round.id, choice });

    const payload = (selection.payload ?? {}) as Record<string, unknown>;
    switch (selection.intent as SelectionIntent) {
      case "settlement":
        if (typeof payload.followupText === "string") {
          const foundList = await new SettlementIntakeService(this.supabase).findOpenDraftsForSender(sourceId, lineUserId);
          const found = foundList.find((f) => f.round.id === round.id);
          if (!found) {
            if (replyToken) await replyLineMessage(replyToken, "ไม่พบรายการส่งเงินที่เลือก กรุณาเริ่มใหม่");
            return { eventId, eventType, status: "saved", parsed: false };
          }
          return this.applySettlementFollowupForRound(
            found.draft, found.round, payload.followupText, lineUserId, replyToken, eventId, eventType, log,
          );
        }
        return this.openSettlementForRound(
          round, (payload.fullText as string) ?? "", lineUserId, replyToken, eventId, eventType, log,
        );
      case "close_round": {
        const selected = await wrs.buildCandidates([round]);
        await this.createCloseRoundConfirmation(
          sourceId, lineUserId!, round.business_date, selected[0], String(payload.dateStr ?? round.business_date),
        );
        if (replyToken) await this.replyMessage(replyToken, await this.buildCloseRoundConfirmPrompt(round));
        return { eventId, eventType, status: "saved", parsed: false };
      }
      case "produce_attach":
        return this.resumeProduceAttach(event, round, payload, eventId, eventType, log);
      case "slip":
        return this.resumeSlipOpen(event, round, payload, eventId, eventType, log);
      case "manual_slip":
        return this.resumeManualSlipOpen(event, round, payload, eventId, eventType, log);
      default:
        return { eventId, eventType, status: "saved", parsed: false };
    }
  }

  // ── V2: Work-Round-gated produce persist ──────────────────────────────────
  //
  // Resolves the target Work Round for a parsed produce session, then persists.
  // A NEW V2 session is NEVER stored with a null work_round_id, blank seller, or
  // generic market — unless the work_rounds table is absent (unmigrated legacy),
  // in which case it falls back to the legacy null-link persist.
  private async enrichParsedFromWorkRound(
    parsed:       WeighSession,
    workRoundId:  string,
  ): Promise<WeighSession> {
    const { data } = await this.supabase
      .from("work_rounds")
      .select("seller_name, market_name")
      .eq("id", workRoundId)
      .maybeSingle();

    if (!data) return parsed;

    return {
      ...parsed,
      staff_name:    String(data.seller_name),
      session_title: String(data.market_name),
    };
  }

  private async persistProduceGated(params: {
    parsed:          WeighSession;
    accumulatedText: string;
    rawMessageId:    string;
    lineUserId:      string | null;
    replyToken:      string | null;
    sourceId:        string;
    businessDate:    string;
    eventId:         string;
    eventType:       string;
    log:             ChildLogger;
    forced?:         { workRoundId: string; isAppend: boolean };
  }): Promise<WebhookProcessResult> {
    const {
      parsed, accumulatedText, rawMessageId, lineUserId, replyToken,
      sourceId, businessDate, eventId, eventType, log, forced,
    } = params;

    const effectiveBusinessDate = parsed.date ?? businessDate;

    // 1. Decide the target Work Round (unless a selection already forced one).
    let target: { workRoundId: string | null; isAppend: boolean };
    if (forced) {
      target = { workRoundId: forced.workRoundId, isAppend: forced.isAppend };
    } else {
      const decision = await this.resolveProduceTarget(
        parsed, accumulatedText, rawMessageId, lineUserId, replyToken,
        sourceId, effectiveBusinessDate, eventId, eventType, log,
      );
      if (decision.kind === "halt") return decision.result;
      target = { workRoundId: decision.workRoundId, isAppend: decision.isAppend };
    }

    if (!target.workRoundId) {
      log.warn("V2 produce blocked: unresolved work_round_id");
      if (replyToken) {
        try {
          await replyLineMessage(replyToken, new WorkRoundService(this.supabase).buildNoRoundPrompt());
        } catch (e) { log.error("reply failed", { error: String(e) }); }
      }
      return { eventId, eventType, status: "saved", parsed: false, pendingSessionClosed: true };
    }

    if (hasParseReviewBlockers(parsed)) {
      log.warn("produce persist blocked: parse review issues", { issues: parsed.review_issues });
      if (replyToken) {
        try { await this.replyMessage(replyToken, buildParseReviewReply(parsed)); }
        catch (e) { log.error("reply failed", { error: String(e) }); }
      }
      return { eventId, eventType, status: "saved", parsed: false, pendingSessionClosed: true };
    }

    const persisted = await this.enrichParsedFromWorkRound(parsed, target.workRoundId);
    // 2. Dedup. Release ghost reservations from old failed inserts.
    const dedup     = new SessionDedupService(this.supabase);
    let isDuplicate = await dedup.isDuplicate(persisted);
    if (isDuplicate && !(await dedup.hasPersistedItems(persisted))) {
      await dedup.release(persisted);
      isDuplicate = false;
    }
    if (isDuplicate) {
      log.info("duplicate session — skipping insert");
      if (replyToken) {
        try { await replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว"); }
        catch (e) { log.error("duplicate reply failed", { error: String(e) }); }
      }
      return { eventId, eventType, status: "saved", parsed: false, pendingSessionClosed: true };
    }

    // 3. Insert the session WITH its Work Round link + append flag.
    const { data: session, error: sessionErr } = await this.supabase
      .from("produce_sessions")
      .insert({
        raw_message_id:    rawMessageId,
        line_user_id:      lineUserId ?? undefined,
        staff_name:        persisted.staff_name,
        sender_name:       persisted.sender_name      ?? undefined,
        transaction_time:  persisted.transaction_time ?? undefined,
        session_date:      persisted.date             ?? undefined,
        session_title:     persisted.session_title    ?? undefined,
        total_items:       persisted.items.length,
        parser_errors:     persisted.parse_errors.length > 0 ? persisted.parse_errors : null,
        work_round_id:     target.workRoundId,
        is_append_session: target.isAppend,
      })
      .select("id")
      .single();

    if (sessionErr) throw new Error(`produce_session insert failed: ${sessionErr.message}`);

    try {
      for (const item of persisted.items) {
        const { error: itemErr } = await this.supabase.from("produce_items").insert({
          session_id:       session.id,
          item_number:      item.item_number,
          product_name:     item.product_name,
          price_per_unit:   item.price_per_unit,
          quantity:         item.quantity ?? undefined,
          unit:             item.unit     ?? undefined,
          section:          item.section,
          transaction_type: item.transaction_type,
          item_hash:        computeItemHash(persisted, item),
        });
        if (itemErr) throw new Error(`produce_item insert failed for ${item.product_name}: ${itemErr.message}`);
      }
    } catch (err) {
      await this.supabase.from("produce_sessions").delete().eq("id", session.id);
      throw err;
    }

    const duplicateAfterPersist = await dedup.record(persisted, accumulatedText);
    if (duplicateAfterPersist) {
      await this.supabase.from("produce_sessions").delete().eq("id", session.id);
      log.info("duplicate session recorded concurrently — removed current insert");
      if (replyToken) await replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว");
      return { eventId, eventType, status: "saved", parsed: false, pendingSessionClosed: true };
    }

    await this.supabase.from("raw_messages").update({ is_processed: true }).eq("id", rawMessageId);

    // 4. Advance Work Round status (produce_attached keeps it open).
    if (target.workRoundId) {
      await new WorkRoundStatusService(this.supabase).applyEvent(
        target.workRoundId,
        target.isAppend ? "produce_reopened" : "produce_attached",
      );
    }

    await new DailySummaryService(this.supabase).recalculate(
      persisted.date ?? bangkokToday(),
      persisted.staff_name,
      persisted.session_title ?? null,
    );

    log.info("produce session persisted", {
      items: persisted.items.length, workRoundId: target.workRoundId, isAppend: target.isAppend,
    });

    if (replyToken) {
      const summary = buildWeighSessionSummary(persisted);
      try { await replyLineMessage(replyToken, summary); }
      catch (e) { log.error("reply failed", { error: String(e) }); }
    }

    return { eventId, eventType, status: "saved", parsed: true, pendingSessionClosed: true };
  }

  // Decides which Work Round a parsed produce session attaches to.
  // Returns a target work_round_id (possibly null = legacy/unmigrated) to persist,
  // OR halts with an already-sent reply (no produce data is persisted).
  private async resolveProduceTarget(
    parsed:          WeighSession,
    accumulatedText: string,
    rawMessageId:    string,
    lineUserId:      string | null,
    replyToken:      string | null,
    sourceId:        string,
    businessDate:    string,
    eventId:         string,
    eventType:       string,
    log:             ChildLogger,
  ): Promise<
    | { kind: "persist"; workRoundId: string | null; isAppend: boolean }
    | { kind: "halt"; result: WebhookProcessResult }
  > {
    const halt = (): WebhookProcessResult => ({
      eventId, eventType, status: "saved", parsed: false, pendingSessionClosed: true,
    });

    if (!sourceId || !businessDate) {
      log.warn("missing V2 routing context — not persisting produce session");
      if (replyToken) await replyLineMessage(replyToken, "ยังระบุกลุ่มหรือวันที่ของรายการไม่ได้ กรุณาลองส่งใหม่อีกครั้ง");
      return { kind: "halt", result: halt() };
    }

    const firstLine = normalizeText(accumulatedText).split("\n")[0] ?? "";
    const hdr       = classifyHeader(firstLine);
    const isReturnAppend = hdr?.txIntent === "ชั่งคืนเพิ่ม";
    const isProduceAppend = hdr?.txIntent === "เบิกเพิ่ม";
    const isAppend  = isReturnAppend || isProduceAppend;
    const wrs       = new WorkRoundService(this.supabase);

    // Produce append (เบิกเพิ่ม) may only attach while the round is still in the
    // produce stage. A return append (ชั่งคืนเพิ่ม) is the intended late-correction
    // path and may attach on post-close / review statuses (→ needs_correction).
    const appendEligibleStatuses = isReturnAppend
      ? RETURN_APPEND_ELIGIBLE_STATUSES
      : PRODUCE_APPEND_ELIGIBLE_STATUSES;

    const resolveAppendRound = async (
      candidates: import("@/lib/work-round/types").WorkRound[],
    ): Promise<
      | { kind: "persist"; workRoundId: string; isAppend: boolean }
      | { kind: "halt"; result: WebhookProcessResult }
    > => {
      const eligible = candidates.filter((r) => appendEligibleStatuses.includes(r.status));
      if (eligible.length === 0) {
        log.warn("append produce blocked: no append-eligible target round", { sourceId, businessDate });
        if (replyToken) await replyLineMessage(replyToken, "รอบนี้อนุมัติแล้วหรือไม่พบรอบเดิม กรุณาให้ผู้ตรวจสอบเปิดเส้นทางแก้ไขก่อน");
        return { kind: "halt", result: halt() };
      }
      if (eligible.length === 1) {
        return { kind: "persist", workRoundId: eligible[0].id, isAppend: true };
      }
      const selectionCandidates = await wrs.buildCandidates(eligible);
      await new WorkRoundSelectionService(this.supabase).create({
        sourceId, lineUserId, businessDate, intent: "produce_attach", candidates: selectionCandidates,
        payload: { rawMessageId, accumulatedText, isAppend: true, lineUserId },
      });
      if (replyToken) await replyLineMessage(replyToken, buildSelectionMessage("produce_attach", selectionCandidates));
      return { kind: "halt", result: halt() };
    };

    try {
      if (hdr?.type === "explicit") {
        if (isProduceAppend) {
          const appendTarget = await wrs.resolveExplicitProduceAppend({
            sourceId,
            businessDate,
            sellerName: hdr.sellerName,
            marketName: hdr.marketName,
          });
          if (appendTarget.status === "resolved") {
            return { kind: "persist", workRoundId: appendTarget.workRound.id, isAppend: true };
          }
          if (appendTarget.status === "ambiguous") {
            log.warn("explicit produce append: ambiguous target rounds", { sourceId, businessDate });
            if (replyToken) {
              await replyLineMessage(replyToken, wrs.buildDisambiguationPrompt(appendTarget.candidates));
            }
            return { kind: "halt", result: halt() };
          }

          const all = await wrs.findAllRounds(sourceId, businessDate);
          const sameIdentity = all.filter(
            (r) => r.seller_name === hdr.sellerName && r.market_name === hdr.marketName,
          );
          if (sameIdentity.some((r) => !appendEligibleStatuses.includes(r.status))) {
            log.warn("explicit produce append blocked: round not append-eligible", { sourceId, businessDate });
            if (replyToken) {
              await replyLineMessage(
                replyToken,
                "รอบนี้อนุมัติแล้วหรือไม่พร้อมรับรายการเพิ่ม กรุณาตรวจสอบสถานะรอบในหน้า Work Rounds",
              );
            }
            return { kind: "halt", result: halt() };
          }

          log.warn("explicit produce append: no matching open Work Round", { sourceId, businessDate });
          if (replyToken) {
            await replyLineMessage(
              replyToken,
              wrs.buildNoExplicitAppendRoundPrompt(hdr.sellerName, hdr.marketName, businessDate),
            );
          }
          return { kind: "halt", result: halt() };
        }

        if (isReturnAppend) {
          const all = await wrs.findAllRounds(sourceId, businessDate);
          const matched = all.filter(
            (r) => r.seller_name === hdr.sellerName && r.market_name === hdr.marketName,
          );
          return resolveAppendRound(matched);
        }

        if (hdr.txIntent === "เบิก") {
          const { workRound } = await wrs.resolve({
            sourceId, businessDate,
            sellerName: hdr.sellerName, marketName: hdr.marketName,
            sourceMeta: { rawFirstLine: firstLine },
          });
          return { kind: "persist", workRoundId: workRound.id, isAppend: false };
        }

        const decision = await wrs.resolveForIntent({
          sourceId,
          businessDate,
          sellerName: hdr.sellerName,
          marketName: hdr.marketName,
          allowedStatuses: allowedProduceStatusesForIntent(hdr.txIntent),
        });

        if (decision.mode === "error") throw new Error(decision.error);
        if (decision.mode === "linked") {
          return { kind: "persist", workRoundId: decision.workRound.id, isAppend: false };
        }
        if (decision.mode === "select") {
          const candidates = await wrs.buildCandidates(decision.candidates);
          await new WorkRoundSelectionService(this.supabase).create({
            sourceId, lineUserId, businessDate, intent: "produce_attach", candidates,
            payload: { rawMessageId, accumulatedText, isAppend: false, lineUserId },
          });
          if (replyToken) await replyLineMessage(replyToken, buildSelectionMessage("produce_attach", candidates));
          return { kind: "halt", result: halt() };
        }

        log.warn("explicit non-borrow produce header blocked", {
          sourceId,
          businessDate,
          sellerName: hdr.sellerName,
          marketName: hdr.marketName,
          txIntent: hdr.txIntent,
          reason: decision.mode,
        });
        if (replyToken) await replyLineMessage(replyToken, wrs.buildNoRoundPrompt());
        return { kind: "halt", result: halt() };
      }

      if (hdr?.type === "seller_only") {
        if (hdr.txIntent === "เบิก" || hdr.txIntent === "เบิกเพิ่ม") {
          log.warn("seller-only borrow header blocked: market required", {
            sourceId,
            businessDate,
            sellerName: hdr.sellerName,
          });
          if (replyToken) await replyLineMessage(replyToken, wrs.buildNoRoundPrompt());
          return { kind: "halt", result: halt() };
        }

        const decision = await wrs.resolveForIntent({
          sourceId,
          businessDate,
          sellerName: hdr.sellerName,
          allowedStatuses: isReturnAppend ? RETURN_APPEND_ELIGIBLE_STATUSES : PRODUCE_APPEND_ELIGIBLE_STATUSES,
        });

        if (decision.mode === "error") throw new Error(decision.error);
        if (decision.mode === "linked") {
          return { kind: "persist", workRoundId: decision.workRound.id, isAppend };
        }
        if (decision.mode === "select") {
          const candidates = await wrs.buildCandidates(decision.candidates);
          await new WorkRoundSelectionService(this.supabase).create({
            sourceId, lineUserId, businessDate, intent: "produce_attach", candidates,
            payload: { rawMessageId, accumulatedText, isAppend, lineUserId },
          });
          if (replyToken) await replyLineMessage(replyToken, buildSelectionMessage("produce_attach", candidates));
          return { kind: "halt", result: halt() };
        }

        const reason = decision.mode === "blocked"
          ? "matching seller round is not eligible for this produce event"
          : "no matching seller round";
        log.warn("seller-only produce header blocked", {
          sourceId,
          businessDate,
          sellerName: hdr.sellerName,
          txIntent: hdr.txIntent,
          reason,
        });
        if (replyToken) {
          const reply = decision.mode === "blocked"
            ? `พบรอบของ ${hdr.sellerName} แต่สถานะยังไม่พร้อมรับรายการนี้ กรุณาตรวจสอบในหน้า Work Rounds`
            : `ไม่พบรอบของ ${hdr.sellerName} สำหรับวันที่นี้ กรุณาเปิดเบิกพร้อมชื่อตลาดก่อน`;
          await replyLineMessage(replyToken, reply);
        }
        return { kind: "halt", result: halt() };
      }

      if (isProduceAppend) {
        const appendTarget = await wrs.resolveProduceAppendTarget(sourceId);
        if (appendTarget.status === "resolved") {
          return { kind: "persist", workRoundId: appendTarget.workRound.id, isAppend: true };
        }
        if (appendTarget.status === "none") {
          log.warn("produce append finalize: no identifiable open Work Round", { sourceId });
          if (replyToken) await replyLineMessage(replyToken, wrs.buildNoAppendRoundPrompt());
          return { kind: "halt", result: halt() };
        }
        log.warn("produce append finalize: ambiguous Work Rounds", {
          sourceId, count: appendTarget.candidates.length,
        });
        if (replyToken) {
          await replyLineMessage(replyToken, wrs.buildDisambiguationPrompt(appendTarget.candidates));
        }
        return { kind: "halt", result: halt() };
      }

      // Generic (or unrecognised) header → require a unique open Work Round.
      const dis = await wrs.disambiguateGeneric(sourceId, businessDate);
      if (dis.status === "resolved") {
        return { kind: "persist", workRoundId: dis.workRound.id, isAppend };
      }
      if (dis.status === "none") {
        log.warn("generic complete session: no open Work Round — not persisting", { sourceId });
        if (replyToken) await replyLineMessage(replyToken, wrs.buildNoRoundPrompt());
        return { kind: "halt", result: halt() };
      }
      // Ambiguous → open a durable produce_attach selection; persist nothing.
      const candidates = await wrs.buildCandidates(dis.candidates);
      await new WorkRoundSelectionService(this.supabase).create({
        sourceId, lineUserId, businessDate, intent: "produce_attach", candidates,
        payload: { rawMessageId, accumulatedText, isAppend, lineUserId },
      });
      log.warn("generic complete session: ambiguous Work Round — pending selection", {
        count: dis.candidates.length,
      });
      if (replyToken) await replyLineMessage(replyToken, buildSelectionMessage("produce_attach", candidates));
      return { kind: "halt", result: halt() };
    } catch (err) {
      // Fail closed: V2 produce must not persist without a resolved work_round_id.
      log.warn("Work Round resolution unavailable — produce not persisted", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (replyToken) await replyLineMessage(replyToken, "ยังบันทึกรายการไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้ง");
      return { kind: "halt", result: halt() };
    }
  }

  // ── V2: selection resume — produce attach ─────────────────────────────────
  private async resumeProduceAttach(
    event:     LineMessageEvent,
    round:     import("@/lib/work-round/types").WorkRound,
    payload:   Record<string, unknown>,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken      = event.replyToken ?? null;
    const rawMessageId    = payload.rawMessageId    as string;
    const accumulatedText = payload.accumulatedText as string;
    const isAppend        = Boolean(payload.isAppend);
    const lineUserId      = (payload.lineUserId as string | null) ?? getUserId(event.source);

    const parsed = parseWeighSession(accumulatedText, round.business_date);
    if (parsed.items.length === 0) {
      if (replyToken) await replyLineMessage(replyToken, "อ่านรายการไม่สำเร็จ กรุณาส่งใหม่");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    return this.persistProduceGated({
      parsed, accumulatedText, rawMessageId, lineUserId, replyToken,
      sourceId: round.source_id, businessDate: round.business_date,
      eventId, eventType, log,
      forced: { workRoundId: round.id, isAppend },
    });
  }

  // ── V2: selection resume — slip session open ──────────────────────────────
  private async resumeSlipOpen(
    event:     LineMessageEvent,
    round:     import("@/lib/work-round/types").WorkRound,
    payload:   Record<string, unknown>,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    const header     = payload.header     as SlipSessionHeader;
    const sourceType = payload.sourceType as string;
    const senderId   = (payload.senderId as string | null) ?? null;
    const sourceId   = getSourceId(event.source);

    const result = await this.slipSessionService.openSession(
      sourceId, sourceType, senderId, header, round.id,
    );
    if (!result.opened) {
      if (replyToken) await replyLineMessage(replyToken, SESSION_ALREADY_OPEN_REPLY);
      return { eventId, eventType, status: "saved", parsed: false };
    }
    if (replyToken) {
      await replyLineMessage(replyToken, [
        "เปิดชุดสลิปเงินโอนแล้ว",
        `${round.seller_name} — ${round.market_name}`,
        "ส่งรูปสลิปต่อได้เลย",
        `พิมพ์ "จบสลิป" เมื่อส่งครบ`,
      ].join("\n"));
    }
    log.info("slip session opened via selection", { batchId: result.batchId, workRoundId: round.id });
    return { eventId, eventType, status: "saved", parsed: false };
  }

  // ── V2: selection resume — manual slip session open ───────────────────────
  private async resumeManualSlipOpen(
    event:     LineMessageEvent,
    round:     import("@/lib/work-round/types").WorkRound,
    payload:   Record<string, unknown>,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken    = event.replyToken;
    const lineUserId    = getUserId(event.source);
    const sourceId      = getSourceId(event.source);
    const marketLabel   = (payload.marketLabel as string | null) ?? null;
    const marketKey     = (payload.marketKey   as string) ?? "default";
    const businessDate  = round.business_date;
    const dateStr       = (payload.dateStr as string) ?? businessDate;
    const lineMessageId = (payload.lineMessageId as string) ?? `sel-${eventId}`;

    const svc    = new ManualSlipSessionService(this.supabase);
    const result = await svc.openSession({
      sourceId, businessDate, marketKey, marketLabel, lineUserId, lineMessageId,
      workRoundId: round.id,
    });
    if (!result.opened) {
      if (replyToken) await replyLineMessage(replyToken, "เปิดสลิปมือไม่สำเร็จ มีงวดอื่นเปิดอยู่");
      return { eventId, eventType, status: "saved", parsed: false };
    }
    if (replyToken) {
      await replyLineMessage(replyToken, [
        `เปิดสลิปมือ ${dateStr} แล้ว (${round.seller_name} — ${round.market_name})`,
        "ส่งจำนวนเงินได้เลย แล้วพิมพ์ จบสลิปมือ เมื่อส่งครบ",
      ].join("\n"));
    }
    log.info("manual slip session opened via selection", { sessionId: result.session?.id, workRoundId: round.id });
    return { eventId, eventType, status: "saved", parsed: false };
  }

  // ── DB helpers ────────────────────────────────────────────────────────────
  private tryFinalizeWorkRoundSafe(workRoundId: string | null | undefined, log: ChildLogger): void {
    if (!workRoundId) return;
    tryFinalizeWorkRound(this.supabase, workRoundId).catch(
      (err) => log.warn("tryFinalizeWorkRound failed", { reason: err instanceof Error ? err.message : String(err) }),
    );
  }

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
