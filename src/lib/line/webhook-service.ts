import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineEvent, LineMessageEvent, LineMessage, LineTextMessage } from "@/lib/line/types";
import type { Database, LineMessageType } from "@/types/database";
import { getSourceId, getUserId } from "@/lib/line/verify";
import { parserRegistry } from "@/lib/parsers/registry";
import { logger } from "@/lib/logger";
import { replyLineMessage, buildWeighSessionSummary } from "@/lib/line/reply";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import { DailySummaryService } from "@/lib/line/daily-summary-service";
import { SessionDedupService, computeItemHash } from "@/lib/line/session-dedup-service";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";

type Supabase      = SupabaseClient<Database>;
type ChildLogger   = ReturnType<typeof logger.child>;

export interface WebhookProcessResult {
  eventId:   string;
  eventType: string;
  status:    "saved" | "duplicate" | "error";
  parsed?:   boolean;
  error?:    string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bangkokToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
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
  constructor(private readonly supabase: Supabase) {}

  async processEvents(events: LineEvent[], destination: string): Promise<WebhookProcessResult[]> {
    return Promise.all(events.map((e) => this.processOne(e, destination)));
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
      // Append normalized text so accumulated_text is clean for the parser
      const updated = await pendingService.append(sessionKey, normalizedText, replyToken);

      if (hasSessionEnd(normalizedText)) {
        console.log("session end detected — finalizing accumulated session", sessionKey);
        log.info("session end detected — finalizing accumulated session", { sessionKey });
        await pendingService.delete(sessionKey);
        return this.finalizeAccumulated(
          updated.accumulated_text,
          updated.latest_reply_token,
          updated.line_user_id,
          rawMessageId,
          eventId,
          event.type,
          log,
        );
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

      // Header-only → start accumulating (store normalized so parser gets clean text)
      console.log("session header detected — starting pending session", sessionKey);
      log.info("session header detected — starting pending session", { sessionKey });
      try {
        await pendingService.create(sessionKey, normalizedText, replyToken, lineUserId);
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

  // ── Finalize accumulated multi-message session ────────────────────────────
  private async finalizeAccumulated(
    accumulatedText:  string,
    replyToken:       string | null,
    lineUserId:       string | null,
    rawMessageId:     string,
    eventId:          string,
    eventType:        string,
    log:              ChildLogger,
  ): Promise<WebhookProcessResult> {
    try {
      const parsed = parseWeighSession(accumulatedText, bangkokToday());

      if (parsed.parse_errors.length > 0) {
        log.warn("finalized with parse errors", { errors: parsed.parse_errors });
      }

      // Fix 2: guard empty parse
      if (parsed.items.length === 0) {
        log.warn("parsed session has no items — aborting");
        if (replyToken) {
          replyLineMessage(replyToken, "อ่านรายการไม่สำเร็จ กรุณาตรวจสอบรูปแบบข้อความ").catch(() => {});
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // Fix 3: dedup check
      const dedup       = new SessionDedupService(this.supabase);
      const isDuplicate = await dedup.checkAndRecord(parsed, accumulatedText);
      if (isDuplicate) {
        log.info("duplicate session — skipping insert");
        if (replyToken) {
          replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว").catch(() => {});
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
          log.warn("failed to insert produce_item", { product: item.product_name, error: itemErr.message });
        }
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
        const summary = buildWeighSessionSummary(parsed);
        replyLineMessage(replyToken, summary).catch((e) =>
          log.error("reply failed", { error: String(e) })
        );
      }

      return { eventId, eventType, status: "saved", parsed: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("finalize accumulated session failed", { error: errorMessage });

      if (replyToken) {
        replyLineMessage(replyToken, "ยังอ่านรายการนี้ไม่ได้ครับ กรุณาตรวจรูปแบบข้อความอีกครั้ง").catch(() => {});
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

        // Fix 2: empty items guard
        if (ws.items.length === 0) {
          log.warn("parsed session has no items — aborting");
          if (replyToken) {
            replyLineMessage(replyToken, "อ่านรายการไม่สำเร็จ กรุณาตรวจสอบรูปแบบข้อความ").catch(() => {});
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // Fix 3: dedup check
        const rawText     = (msgEvent.message as import("@/lib/line/types").LineTextMessage).text;
        const dedup       = new SessionDedupService(this.supabase);
        const isDuplicate = await dedup.checkAndRecord(ws, rawText);
        if (isDuplicate) {
          log.info("duplicate session — skipping insert");
          if (replyToken) {
            replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว").catch(() => {});
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }
      }

      // Fix 4: persist first, then mark processed
      await result.persist(this.supabase, rawMessageId);

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
          replyLineMessage(replyToken, summaryText).catch((e) =>
            log.error("reply failed", { error: String(e) })
          );
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
        replyLineMessage(replyToken, "ยังอ่านรายการนี้ไม่ได้ครับ กรุณาตรวจรูปแบบข้อความอีกครั้ง").catch(() => {});
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
