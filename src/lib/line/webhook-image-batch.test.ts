import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { SlipBatchIngestor, BatchResult } from "@/lib/slips/batch-service";
import type { Database } from "@/types/database";

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

// ── Batch behavior ─────────────────────────────────────────────────────────────

describe("WebhookService batch slip flow", () => {
  it("first image in new batch triggers a reply and schedules OCR", async () => {
    const replies: string[] = [];
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];

    const batchService: SlipBatchIngestor = {
      async getOrCreateBatch() { return { batchId: "batch-new", isNewBatch: true }; },
      async attachEvidence(batchId, evidenceId) { attachCalls.push({ batchId, evidenceId }); },
    };

    const bgTasks: Array<() => Promise<void>> = [];
    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-1"),
      checkProcessor: stubCheckProcessor,
      batchService,
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-1")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(
      "รับรูปหลักฐานแล้วครับ\nถ้ามีหลายใบ ส่งต่อได้เลย\nระบบจะสรุปหลังจากหยุดส่งประมาณ 20 วินาที",
    );
    expect(attachCalls).toEqual([{ batchId: "batch-new", evidenceId: "ev-1" }]);
    expect(bgTasks).toHaveLength(1);
  });

  it("subsequent image in existing batch does not reply but still schedules OCR", async () => {
    const replies: string[] = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const batchService: SlipBatchIngestor = {
      async getOrCreateBatch() { return { batchId: "batch-existing", isNewBatch: false }; },
      async attachEvidence() {},
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-2"),
      checkProcessor: stubCheckProcessor,
      batchService,
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

    const batchService: SlipBatchIngestor = {
      async getOrCreateBatch(): Promise<BatchResult> {
        callCount += 1;
        return callCount === 1
          ? { batchId: "batch-1", isNewBatch: true }
          : { batchId: "batch-1", isNewBatch: false };
      },
      async attachEvidence() {},
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor(),
      checkProcessor: stubCheckProcessor,
      batchService,
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask() {},
    });

    await service.processEvents([imageEvent("msg-a"), imageEvent("msg-b")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("รับรูปหลักฐานแล้วครับ");
  });

  it("batch failure falls back to plain ack so sender is not left silent", async () => {
    const replies: string[] = [];

    const batchService: SlipBatchIngestor = {
      async getOrCreateBatch() { throw new Error("db unavailable"); },
      async attachEvidence() {},
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor(),
      checkProcessor: stubCheckProcessor,
      batchService,
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask() {},
    });

    await service.processEvents([imageEvent("msg-fallback")], "dest");

    // Fallback: still sends the batch first-image reply (shouldReply = true)
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("รับรูปหลักฐานแล้วครับ");
  });

  it("storage failure still replies with retry message regardless of batch", async () => {
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
});
