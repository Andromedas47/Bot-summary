import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { SlipSessionIngestor, ActiveSlipSession } from "@/lib/slips/slip-session-service";
import type { Database } from "@/types/database";

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

function createRawMessageSupabase(rawId = "raw-img") {
  const client = {
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert() {
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: rawId }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
  return client;
}

function createSlipHeaderSupabase(rawId = "raw-img") {
  const workRounds = [{
    id: "wr-1",
    source_id: "group-1",
    business_date: "2026-06-09",
    seller_name: "กี้",
    market_name: "วัดทุ่งลานนา",
    round_seq: 1,
    status: "awaiting_slips",
    source_meta: null,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
  }];

  const queryRows = (rows: Array<Record<string, unknown>>) => {
    const chain = (filtered: Array<Record<string, unknown>>) => ({
      eq(col: string, val: unknown) { return chain(filtered.filter((r) => r[col] === val)); },
      in(col: string, vals: unknown[]) { return chain(filtered.filter((r) => vals.includes(r[col]))); },
      order() { return chain(filtered); },
      then(resolve: (v: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: filtered, error: null }));
      },
    });
    return chain(rows);
  };

  const client = {
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert() {
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: rawId }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "work_rounds") {
        return { select() { return queryRows(workRounds); } };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
  return client;
}

function textEvent(text: string, timestamp = Date.UTC(2026, 5, 9, 5, 0, 0)): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `event-text-${timestamp}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: `reply-text-${timestamp}`,
    message: { id: `msg-text-${timestamp}`, type: "text", quoteToken: "q", text },
  };
}

function imageEvent(id: string, timestamp = Date.UTC(2026, 5, 1, 5, 0, 0)): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `event-${id}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: `reply-${id}`,
    message: {
      id,
      type: "image",
      quoteToken: `quote-${id}`,
      contentProvider: { type: "line" },
    },
  };
}

function stubIngestor(status: "RECEIVED" | "STORAGE_FAILED" = "RECEIVED", evidenceId = "ev-1") {
  return {
    async ingest() {
      return {
        evidenceId: status === "RECEIVED" ? evidenceId : null,
        status,
        storagePath: "slips/path.jpg",
        sha256: "a".repeat(64),
      };
    },
  };
}

const stubCheckProcessor = { async processEvidence() {} };

function activeSession(imageCount: number): ActiveSlipSession {
  return {
    batchId:    "batch-1",
    imageCount,
    headerText: null,
    sellerName: null,
    marketName: null,
    slipDate:   null,
  };
}

// ── Batch behavior ─────────────────────────────────────────────────────────────

describe("WebhookService batch slip flow", () => {
  it("first image in open session (imageCount=0) triggers a reply and schedules OCR", async () => {
    const replies: string[] = [];
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(0); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const bgTasks: Array<() => Promise<void>> = [];
    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-1"),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence(batchId, evidenceId) { attachCalls.push({ batchId, evidenceId }); },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-1")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(
      `รับรูปหลักฐานแล้วครับ\nถ้ามีหลายใบ ส่งต่อได้เลย\nพิมพ์ "จบสลิป" เมื่อส่งครบ`,
    );
    expect(attachCalls).toEqual([{ batchId: "batch-1", evidenceId: "ev-1" }]);
    expect(bgTasks).toHaveLength(1);
  });

  it("subsequent image (imageCount>0) does not reply but still schedules OCR", async () => {
    const replies: string[] = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(3); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-2"),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: { async attachEvidence() {} },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-2")], "dest");

    expect(replies).toHaveLength(0);
    expect(bgTasks).toHaveLength(1);
  });

  it("two images in sequence: first replies, second is silent", async () => {
    const replies: string[] = [];
    let callCount = 0;

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() {
        callCount += 1;
        return activeSession(callCount === 1 ? 0 : 1);
      },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor(),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: { async attachEvidence() {} },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask() {},
    });

    await service.processEvents([imageEvent("msg-a"), imageEvent("msg-b")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("รับรูปหลักฐานแล้วครับ");
  });

  it("valid header opens a slip batch and multiple images attach to the same batch", async () => {
    const replies: string[] = [];
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];
    const bgTasks: Array<() => Promise<void>> = [];
    let opened = false;
    let imageCount = 0;

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() {
        return opened ? activeSession(imageCount) : null;
      },
      async openSession() {
        opened = true;
        imageCount = 0;
        return { opened: true, batchId: "batch-1" };
      },
    };

    const service = new WebhookService(createSlipHeaderSupabase(), {
      evidenceIngestor: {
        async ingest(input) {
          return {
            evidenceId: `ev-${input.lineMessageId}`,
            status: "RECEIVED",
            storagePath: "slips/path.jpg",
            sha256: "a".repeat(64),
          };
        },
      },
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence(batchId, evidenceId) {
          attachCalls.push({ batchId, evidenceId });
          imageCount += 1;
        },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([
      textEvent("กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569", Date.UTC(2026, 5, 9, 5, 0, 0)),
      imageEvent("msg-header-img-1", Date.UTC(2026, 5, 9, 5, 0, 1)),
      imageEvent("msg-header-img-2", Date.UTC(2026, 5, 9, 5, 0, 2)),
    ], "dest");

    expect(replies).toHaveLength(2);
    expect(replies[0]).toContain("เปิดชุดสลิปเงินโอนแล้ว");
    expect(replies[1]).toContain("รับรูปหลักฐานแล้วครับ");
    expect(attachCalls).toEqual([
      { batchId: "batch-1", evidenceId: "ev-msg-header-img-1" },
      { batchId: "batch-1", evidenceId: "ev-msg-header-img-2" },
    ]);
    expect(bgTasks).toHaveLength(2);
  });

  it("first image without a header replies with the exact open-session guidance and skips OCR", async () => {
    const replies: string[] = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return null; },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor(),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: { async attachEvidence() {} },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-nosession")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(NO_SESSION_IMAGE_REPLY);
    expect(bgTasks).toHaveLength(0);
  });

  it("multiple images without a header reply with guidance only once in the quiet window", async () => {
    const replies: string[] = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return null; },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor(),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: { async attachEvidence() {} },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([
      imageEvent("msg-nosession-a", Date.UTC(2026, 5, 1, 5, 0, 0)),
      imageEvent("msg-nosession-b", Date.UTC(2026, 5, 1, 5, 0, 5)),
      imageEvent("msg-nosession-c", Date.UTC(2026, 5, 1, 5, 0, 10)),
    ], "dest");

    expect(replies).toEqual([NO_SESSION_IMAGE_REPLY]);
    expect(bgTasks).toHaveLength(0);
  });

  it("session lookup failure falls back to plain ack so sender is not left silent", async () => {
    const replies: string[] = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { throw new Error("db unavailable"); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor(),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: { async attachEvidence() {} },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask() {},
    });

    await service.processEvents([imageEvent("msg-fallback")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("รับรูปหลักฐานแล้วครับ");
  });

  it("attach failure does NOT schedule OCR (evidence would be orphaned with no batch_id)", async () => {
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(0); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-attach-fail"),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence() { throw new Error("attach to batch failed"); },
      },
      async replyMessage() {},
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-attach-fail")], "dest");

    // OCR must not be scheduled — evidence is not attached to any batch
    expect(bgTasks).toHaveLength(0);
  });

  it("storage failure still replies with retry message regardless of session", async () => {
    const replies: string[] = [];

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("STORAGE_FAILED"),
      checkProcessor: stubCheckProcessor,
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask() {},
    });

    await service.processEvents([imageEvent("msg-fail")], "dest");

    expect(replies).toEqual(["รับรูปไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง"]);
  });

  // ── Fix 2: Late-image rejection when finalizer has already claimed the batch ──

  it("attachment loses to finalizer: replies with rejection message, no OCR scheduled", async () => {
    const replies: string[] = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      // findActiveSession returns the batch (it's closing or processing from finder's perspective)
      async findActiveSession() { return activeSession(2); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase("raw-late"), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-late"),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence() {
          // Simulates the RPC exception from migration 0024 when batch is processing
          throw new Error(
            "Failed to attach evidence to batch: slip_batch batch-1 not found or not in collecting/closing status",
          );
        },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-late")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(
      "รูปนี้ไม่ถูกรวมในชุดสลิป เนื่องจากระบบเริ่มสรุปแล้ว กรุณาเปิดชุดใหม่ก่อนส่งรูป",
    );
    // No OCR — evidence is not part of the finalized batch
    expect(bgTasks).toHaveLength(0);
  });

  it("image with no open session still replies with open-session instruction (not rejection)", async () => {
    const replies: string[] = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return null; },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase("raw-nosession"), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-nosession"),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: { async attachEvidence() {} },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-nosession2")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(NO_SESSION_IMAGE_REPLY);
    // Must NOT show the finalizer-rejection message
    expect(replies[0]).not.toContain("เนื่องจากระบบเริ่มสรุปแล้ว");
    expect(bgTasks).toHaveLength(0);
  });
});
