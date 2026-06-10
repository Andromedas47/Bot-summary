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
import { parseWeighSession, bangkokTimeFromTimestamp } from "@/lib/parsers/weigh-session/parser";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import { DailySummaryService } from "@/lib/line/daily-summary-service";
import { SessionDedupService, computeItemHash } from "@/lib/line/session-dedup-service";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import type { SlipEvidenceIngestor } from "@/lib/slips/types";
import {
  SlipCheckService,
  type SlipCheckProcessor,
} from "@/lib/slips/check-service";
import { SlipBatchService, type SlipBatchIngestor } from "@/lib/slips/batch-service";

type Supabase      = SupabaseClient<Database>;
type ChildLogger   = ReturnType<typeof logger.child>;
type ReplyLineMessage = (replyToken: string, text: string) => Promise<void>;
type ScheduleBackgroundTask = (task: () => Promise<void>) => void;

const BATCH_FIRST_IMAGE_REPLY = [
  "รับรูปหลักฐานแล้วครับ",
  "ถ้ามีหลายใบ ส่งต่อได้เลย",
  "ระบบจะสรุปหลังจากหยุดส่งประมาณ 20 วินาที",
].join("\n");

const EVIDENCE_FAILED_REPLY = "รับรูปไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง";

interface WebhookServiceDependencies {
  evidenceIngestor?: SlipEvidenceIngestor;
  checkProcessor?: SlipCheckProcessor;
  batchService?: SlipBatchIngestor;
  replyMessage?: ReplyLineMessage;
  scheduleBackgroundTask?: ScheduleBackgroundTask;
}

export interface WebhookProcessResult {
  eventId:   string;
  eventType: string;
  status:    "saved" | "duplicate" | "error";
  parsed?:   boolean;
  error?:    string;
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
export function hasSessionStart(text: string): boolean {
  return text.split("\n").some((l) => {
    const line = l.trim();
    return !RE.SESSION_END.test(line) && RE.SESSION_START.test(line);
  });
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
  private readonly replyMessage: ReplyLineMessage;
  private readonly scheduleBackgroundTask: ScheduleBackgroundTask;

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
  }

  async processEvents(events: LineEvent[], destination: string): Promise<WebhookProcessResult[]> {
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const results: WebhookProcessResult[] = [];

    for (const event of sorted) {
      results.push(await this.processOne(event, destination));
    }

    return results;
  }

  private async processOne(event: LineEvent, destination: string): Promise<WebhookProcessResult> {
    const eventId = event.webhookEventId;
    const log     = logger.child({ eventId, eventType: event.type });

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

    // ── 4. Pending session flow ───────────────────────────────────────────────
    const pendingService = new PendingSessionService(this.supabase);
    console.log("pending session lookup started", sessionKey);
    let pending = await pendingService.get(sessionKey);
    console.log("pending session found:", !!pending, pending ? `key=${pending.session_key}` : "");

    if (pending && pendingService.isExpired(pending)) {
      log.info("pending session expired — resetting", { sessionKey });
      await pendingService.delete(sessionKey);
      pending = null;
    }

    if (pending) {
      // Append raw text so the parser can extract senderName from TIME_PREFIX
      const updated = await pendingService.append(sessionKey, text, replyToken);

      if (hasSessionEnd(normalizedText)) {
        console.log("session end detected — finalizing accumulated session", sessionKey);
        log.info("session end detected — finalizing accumulated session", { sessionKey });
        // Fallback time for sessions sent without LINE export format (no TIME_PREFIX).
        // LINE export messages carry their own prefix so parser extracts time directly.
        const fallbackTime = bangkokTimeFromTimestamp(new Date(updated.created_at).getTime());
        const result = await this.finalizeAccumulated(
          updated.accumulated_text,
          updated.latest_reply_token,
          updated.line_user_id,
          rawMessageId,
          eventId,
          event.type,
          log,
          fallbackTime,
        );
        await pendingService.delete(sessionKey);
        return result;
      }

      log.debug("message appended to pending session — waiting for session end", { sessionKey });
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 5. No active pending session ──────────────────────────────────────────
    if (hasSessionStart(normalizedText)) {
      if (hasSessionEnd(normalizedText) || hasItemLine(normalizedText)) {
        // Complete single-message: has SESSION_END or item lines → parse directly
        console.log("single complete message detected — parsing directly");
        log.info("single complete message detected (has SESSION_END or items), parsing directly");
        return this.runParser(msgEvent, rawMessageId, eventId, event.type, log);
      }

      // Header-only → start accumulating (store raw text so parser sees TIME_PREFIX sender)
      console.log("session header detected — starting pending session", sessionKey);
      log.info("session header detected — starting pending session", { sessionKey });
      try {
        await pendingService.create(sessionKey, text, replyToken, lineUserId);
        console.log("pending session create succeeded", sessionKey);
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

        // Batch logic: attach evidence to an active batch and only reply for
        // the first image in a new batch. Falls back to a plain ack if the
        // batch service fails so the webhook never goes silent.
        let shouldReply = false;
        try {
          const { batchId, isNewBatch } = await this.batchService.getOrCreateBatch(
            sourceId,
            event.source.type,
            senderId,
          );
          await this.batchService.attachEvidence(batchId, evidenceId);
          shouldReply = isNewBatch;
          log.debug("slip evidence attached to batch", { batchId, isNewBatch });
        } catch (batchError) {
          log.error("batch attachment failed — sending plain ack", {
            error: batchError instanceof Error ? batchError.message : String(batchError),
          });
          shouldReply = true; // fallback: always reply so sender is not left silent
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

        // Schedule per-image OCR regardless of batch — results are aggregated
        // by the finalizer. check-service suppresses per-image LINE pushes when
        // the evidence belongs to a batch.
        this.scheduleBackgroundTask(
          () => this.checkProcessor.processEvidence(evidenceId),
        );
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
  ): Promise<WebhookProcessResult> {
    try {
      console.log("[TRACE][finalizeAccumulated] accumulated_text_before_parse:\n" + accumulatedText);
      const parsed = parseWeighSession(accumulatedText, bangkokToday(), fallbackTime);
      console.log("[TRACE][finalizeAccumulated] parser_output:", JSON.stringify({ date: parsed.date, staff_name: parsed.staff_name, items_count: parsed.items.length, items: parsed.items, parse_errors: parsed.parse_errors }, null, 2));

      if (parsed.parse_errors.length > 0) {
        log.warn("finalized with parse errors", { errors: parsed.parse_errors });
      }

      // Fix 2: guard empty parse
      if (parsed.items.length === 0) {
        log.warn("parsed session has no items — aborting");
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
      const dedup       = new SessionDedupService(this.supabase);
      let isDuplicate   = await dedup.isDuplicate(parsed);
      if (isDuplicate && !(await dedup.hasPersistedItems(parsed))) {
        await dedup.release(parsed);
        isDuplicate = false;
      }
      if (isDuplicate) {
        log.info("duplicate session — skipping insert");
        if (replyToken) {
          console.log("duplicate reply triggered");
          try {
            await replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว");
            console.log("duplicate reply success");
          } catch (replyErr) {
            const replyMsg = replyErr instanceof Error ? replyErr.message : String(replyErr);
            console.log("duplicate reply error:", replyMsg);
            log.error("duplicate reply failed", { error: replyMsg });
          }
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // Persist session
      const { data: session, error: sessionErr } = await this.supabase
        .from("produce_sessions")
        .insert({
          raw_message_id:   rawMessageId,
          line_user_id:     lineUserId ?? undefined,
          staff_name:       parsed.staff_name,
          sender_name:      parsed.sender_name      ?? undefined,
          transaction_time: parsed.transaction_time ?? undefined,
          session_date:     parsed.date             ?? undefined,
          session_title:    parsed.session_title    ?? undefined,
          total_items:      parsed.items.length,
          parser_errors:    parsed.parse_errors.length > 0 ? parsed.parse_errors : null,
        })
        .select("id")
        .single();

      if (sessionErr) throw new Error(`produce_session insert failed: ${sessionErr.message}`);

      try {
        for (const item of parsed.items) {
          const { error: itemErr } = await this.supabase.from("produce_items").insert({
            session_id:       session.id,
            item_number:      item.item_number,
            product_name:     item.product_name,
            price_per_unit:   item.price_per_unit,
            quantity:         item.quantity    ?? undefined,
            unit:             item.unit        ?? undefined,
            section:          item.section,
            transaction_type: item.transaction_type,
            item_hash:        computeItemHash(parsed, item),
          });
          if (itemErr) {
            throw new Error(`produce_item insert failed for ${item.product_name}: ${itemErr.message}`);
          }
        }
      } catch (err) {
        await this.supabase.from("produce_sessions").delete().eq("id", session.id);
        throw err;
      }

      const duplicateAfterPersist = await dedup.record(parsed, accumulatedText);
      if (duplicateAfterPersist) {
        await this.supabase.from("produce_sessions").delete().eq("id", session.id);
        log.info("duplicate session recorded concurrently — removed current insert");
        if (replyToken) await replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว");
        return { eventId, eventType, status: "saved", parsed: false };
      }

      await this.supabase
        .from("raw_messages")
        .update({ is_processed: true })
        .eq("id", rawMessageId);

      log.info("accumulated session finalized", { items: parsed.items.length, staff: parsed.staff_name });

      await new DailySummaryService(this.supabase).recalculate(
        parsed.date ?? bangkokToday(),
        parsed.staff_name,
        parsed.session_title ?? null,
      );

      log.info("pending session finalized", { items: parsed.items.length, staff: parsed.staff_name });

      if (replyToken) {
        console.log("reply triggered for finalized session");
        console.log("[TRACE][finalizeAccumulated] items_before_summary:", JSON.stringify(parsed.items.map(i => ({ item_number: i.item_number, product_name: i.product_name, price_per_unit: i.price_per_unit, quantity: i.quantity, unit: i.unit, transaction_type: i.transaction_type }))));
        const summary = buildWeighSessionSummary(parsed);
        console.log("[TRACE][finalizeAccumulated] summary_reply_payload:", summary);
        try {
          await replyLineMessage(replyToken, summary);
        } catch (e) {
          log.error("reply failed", { error: String(e) });
        }
      }

      return { eventId, eventType, status: "saved", parsed: true };
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
      console.log("[TRACE][runParser] text_before_parse:", (msgEvent.message as import("@/lib/line/types").LineTextMessage).text);
      const result = await parser.parse(msgEvent);

      // Fix 2 + 3: weigh-session specific guards before any DB writes
      if (parser.name === "weigh-session" && result.data) {
        const ws = result.data as unknown as WeighSession;
        console.log("[TRACE][runParser] parser_output:", JSON.stringify({ date: ws.date, staff_name: ws.staff_name, items_count: ws.items.length, items: ws.items, parse_errors: ws.parse_errors }, null, 2));

        // Fix 2: empty items guard
        if (ws.items.length === 0) {
          log.warn("parsed session has no items — aborting");
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
          console.log("[TRACE][runParser] items_before_summary:", JSON.stringify((result.data as unknown as WeighSession).items.map(i => ({ item_number: i.item_number, product_name: i.product_name, price_per_unit: i.price_per_unit, quantity: i.quantity, unit: i.unit, transaction_type: i.transaction_type }))));
          console.log("[TRACE][runParser] summary_reply_payload:", summaryText);
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
