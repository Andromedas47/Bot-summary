import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { WebhookService } from "./webhook-service";
import type { LineEvent, LineMessageEvent } from "./types";

type QueueStatus = "pending" | "processing" | "processed" | "failed";

function event(id = "evt-ordered"): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: id,
    timestamp: Date.now(),
    replyToken: `reply-${id}`,
    source: { type: "user", userId: "source-1" },
    message: { type: "text", id: `message-${id}`, text: "ตลาด ส่งใบขาวมือ 99/99/2569" },
  } as unknown as LineMessageEvent;
}

function makeQueueDb(seed?: { event: LineMessageEvent; status: QueueStatus; stale?: boolean }) {
  const raws = new Map<string, { id: string; payload: LineEvent }>();
  let queue: {
    lineEventId: string;
    rawMessageId: string;
    sourceId: string;
    status: QueueStatus;
    stale: boolean;
    claimToken: string | null;
    attempts: number;
  } | null = null;
  let sequence = 0;
  let conflictNextCompletion = false;
  let receiveCalls = 0;
  let lastCompletedToken: string | null = null;

  function insertOrdered(item: LineMessageEvent, status: QueueStatus, stale = false) {
    const rawMessageId = `raw-${++sequence}`;
    raws.set(item.webhookEventId, { id: rawMessageId, payload: item });
    queue = {
      lineEventId: item.webhookEventId,
      rawMessageId,
      sourceId: "source-1",
      status,
      stale,
      claimToken: status === "processing" ? `token-${++sequence}` : null,
      attempts: status === "processing" ? 1 : 0,
    };
  }

  if (seed) insertOrdered(seed.event, seed.status, seed.stale);

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name === "receive_line_webhook_event") {
      receiveCalls += 1;
      const lineEventId = args.p_line_event_id as string;
      const existing = raws.get(lineEventId);
      if (existing) {
        return { data: { raw_message_id: existing.id, duplicate: true }, error: null };
      }
      const rawMessageId = `raw-${++sequence}`;
      raws.set(lineEventId, { id: rawMessageId, payload: args.p_payload as LineEvent });
      queue = {
        lineEventId,
        rawMessageId,
        sourceId: args.p_source_id as string,
        status: "pending",
        stale: false,
        claimToken: null,
        attempts: 0,
      };
      return { data: { raw_message_id: rawMessageId, duplicate: false }, error: null };
    }

    if (name === "claim_line_webhook_event") {
      if (!queue || queue.sourceId !== args.p_source_id) return { data: null, error: null };
      if (queue.status !== "pending" && !(queue.status === "processing" && queue.stale)) {
        return { data: null, error: null };
      }
      queue.status = "processing";
      queue.stale = false;
      queue.claimToken = `token-${++sequence}`;
      queue.attempts += 1;
      return {
        data: {
          queue_id: "queue-1",
          line_event_id: queue.lineEventId,
          source_id: queue.sourceId,
          raw_message_id: queue.rawMessageId,
          receive_order: 1,
          claim_token: queue.claimToken,
        },
        error: null,
      };
    }

    if (name === "complete_line_webhook_event") {
      if (conflictNextCompletion && queue) {
        conflictNextCompletion = false;
        queue.claimToken = `token-${++sequence}`;
        return { data: false, error: null };
      }
      const matches = queue?.status === "processing"
        && queue.rawMessageId === args.p_raw_message_id
        && queue.claimToken === args.p_claim_token;
      if (!matches || !queue) return { data: false, error: null };
      lastCompletedToken = queue.claimToken;
      queue.status = args.p_status as QueueStatus;
      queue.claimToken = null;
      return { data: true, error: null };
    }

    throw new Error(`unexpected rpc: ${name}`);
  }

  const db = {
    rpc,
    from(table: string) {
      if (table !== "raw_messages") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return {
            eq(_column: string, rawMessageId: unknown) {
              return {
                async maybeSingle() {
                  const raw = [...raws.values()].find((row) => row.id === rawMessageId);
                  return { data: raw ? { payload: raw.payload } : null, error: null };
                },
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          return {
            select() {
              return {
                async single() {
                  const lineEventId = payload.line_event_id as string;
                  if (raws.has(lineEventId)) {
                    return { data: null, error: { code: "23505", message: "duplicate" } };
                  }
                  const id = `raw-${++sequence}`;
                  raws.set(lineEventId, { id, payload: payload.payload as LineEvent });
                  return { data: { id }, error: null };
                },
              };
            },
          };
        },
      };
    },
    get queue() { return queue; },
    get rawCount() { return raws.size; },
    get queueCount() { return queue ? 1 : 0; },
    get receiveCalls() { return receiveCalls; },
    get lastCompletedToken() { return lastCompletedToken; },
    makeStale() { if (queue) queue.stale = true; },
    conflictOnNextCompletion() { conflictNextCompletion = true; },
    repeatCompletion() {
      return rpc("complete_line_webhook_event", {
        p_raw_message_id: queue?.rawMessageId,
        p_claim_token: lastCompletedToken,
        p_status: "processed",
      });
    },
  };
  return db;
}

function service(db: ReturnType<typeof makeQueueDb>, replies: string[]) {
  return new WebhookService(db as unknown as SupabaseClient<Database>, {
    replyMessage: async (_token, text) => { replies.push(text); },
    scheduleBackgroundTask: () => {},
  });
}

describe("ordered White Sheet duplicate recovery", () => {
  it("drains a pending duplicate without creating duplicate rows", async () => {
    const item = event();
    const db = makeQueueDb({ event: item, status: "pending" });
    const replies: string[] = [];

    await service(db, replies).processEvents([item], "destination");

    expect(db.queue?.status).toBe("processed");
    expect(replies).toHaveLength(1);
    expect(db.rawCount).toBe(1);
    expect(db.queueCount).toBe(1);
  });

  it("reclaims and drains a stale-processing duplicate", async () => {
    const item = event();
    const db = makeQueueDb({ event: item, status: "processing", stale: true });
    const oldToken = db.queue?.claimToken;
    const replies: string[] = [];

    await service(db, replies).processEvents([item], "destination");

    expect(db.queue?.status).toBe("processed");
    expect(db.lastCompletedToken).not.toBe(oldToken);
    expect(db.queue?.attempts).toBe(2);
    expect(replies).toHaveLength(1);
  });

  it("does not steal a fresh-processing duplicate", async () => {
    const item = event();
    const db = makeQueueDb({ event: item, status: "processing" });
    const token = db.queue?.claimToken;
    const replies: string[] = [];

    await service(db, replies).processEvents([item], "destination");

    expect(db.queue?.claimToken).toBe(token);
    expect(db.queue?.attempts).toBe(1);
    expect(replies).toHaveLength(0);
  });

  it("does not reply again for a processed duplicate", async () => {
    const item = event();
    const db = makeQueueDb({ event: item, status: "processed" });
    const replies: string[] = [];

    await service(db, replies).processEvents([item], "destination");

    expect(db.queue?.status).toBe("processed");
    expect(replies).toHaveLength(0);
  });

  it("leaves unrelated duplicate traffic on the direct path", async () => {
    const item = {
      type: "follow",
      webhookEventId: "evt-follow",
      timestamp: Date.now(),
      source: { type: "user", userId: "source-1" },
    } as unknown as LineEvent;
    const db = makeQueueDb();
    const svc = service(db, []);

    expect((await svc.processEvents([item], "destination"))[0].status).toBe("saved");
    expect((await svc.processEvents([item], "destination"))[0].status).toBe("duplicate");
    expect(db.receiveCalls).toBe(0);
    expect(db.rawCount).toBe(1);
    expect(db.queueCount).toBe(0);
  });
});

describe("ordered White Sheet completion conflicts", () => {
  it("discards stale-worker replies/results and keeps the later completion authoritative", async () => {
    const item = event("evt-conflict");
    const db = makeQueueDb();
    const replies: string[] = [];
    const svc = service(db, replies);
    db.conflictOnNextCompletion();

    const [staleResult] = await svc.processEvents([item], "destination");

    expect(staleResult).toMatchObject({ status: "duplicate", claimConflict: true });
    expect(replies).toHaveLength(0);
    expect(db.queue?.status).toBe("processing");

    db.makeStale();
    await svc.processEvents([item], "destination");
    expect(db.queue?.status).toBe("processed");
    expect(replies).toHaveLength(1);
    expect((await db.repeatCompletion()).data).toBe(false);
  });
});
