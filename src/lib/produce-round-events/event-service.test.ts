import { describe, it, expect } from "bun:test";
import { memSupabase } from "@/lib/test-utils/mem-supabase";
import { ProduceRoundEventService } from "./event-service";
import type { ProduceRoundEventDraft } from "./types";

function makeDraft(seq: number, overrides: Partial<ProduceRoundEventDraft> = {}): ProduceRoundEventDraft {
  return {
    rawMessageId:    "msg-1",
    lineEventId:     "ev-1",
    seqInMessage:    seq,
    lineTimestampMs: 1_000_000,
    eventKind:       "item",
    eventStatus:     "parsed",
    rawLine:         `raw-${seq}`,
    normalizedLine:  `norm-${seq}`,
    category:        null,
    parsedPayload:   {},
    workRoundId:     null,
    ...overrides,
  };
}

describe("ProduceRoundEventService", () => {
  it("bulkInsert persists drafts and returns inserted events", async () => {
    const db  = memSupabase();
    const svc = new ProduceRoundEventService(db as never);

    const inserted = await svc.bulkInsert([makeDraft(0), makeDraft(1), makeDraft(2)]);

    expect(inserted).toHaveLength(3);
    expect(db._rows("produce_round_events")).toHaveLength(3);
  });

  it("raw_message_id + seq_in_message duplicate is silently skipped", async () => {
    const db  = memSupabase();
    const svc = new ProduceRoundEventService(db as never);
    const drafts = [makeDraft(0), makeDraft(1)];

    await svc.bulkInsert(drafts);
    const second = await svc.bulkInsert(drafts); // same rawMessageId + seqs

    expect(second).toHaveLength(0);
    expect(db._rows("produce_round_events")).toHaveLength(2);
  });

  it("line_event_id + seq_in_message duplicate is silently skipped", async () => {
    const db  = memSupabase();
    const svc = new ProduceRoundEventService(db as never);

    // First message: lineEventId=ev-1, seq=0
    await svc.bulkInsert([makeDraft(0, { rawMessageId: "msg-1", lineEventId: "ev-1" })]);
    // Re-delivery: different raw_message row but same LINE event id + same seq
    const second = await svc.bulkInsert([makeDraft(0, { rawMessageId: "msg-2", lineEventId: "ev-1" })]);

    expect(second).toHaveLength(0);
    expect(db._rows("produce_round_events")).toHaveLength(1);
  });

  it("duplicate insert does not mutate the existing immutable row", async () => {
    const db  = memSupabase();
    const svc = new ProduceRoundEventService(db as never);
    const original = makeDraft(0, { rawLine: "original", normalizedLine: "original" });

    const first = await svc.bulkInsert([original]);
    expect(first).toHaveLength(1);

    const second = await svc.bulkInsert([
      makeDraft(0, { rawLine: "mutated", normalizedLine: "mutated" }),
    ]);
    expect(second).toHaveLength(0);

    const stored = db._rows("produce_round_events")[0];
    expect(stored.raw_line).toBe("original");
    expect(stored.normalized_line).toBe("original");
  });

  it("listByMessage returns events ordered by seqInMessage regardless of insertion order", async () => {
    const db  = memSupabase();
    const svc = new ProduceRoundEventService(db as never);

    await svc.bulkInsert([makeDraft(2), makeDraft(0), makeDraft(1)]);
    const events = await svc.listByMessage("msg-1");

    expect(events.map((e) => e.seqInMessage)).toEqual([0, 1, 2]);
  });

  it("listBySource returns only events for the given source across multiple messages", async () => {
    const db = memSupabase({
      raw_messages: [
        { id: "msg-A", source_id: "src-1", line_event_id: "ev-A", event_type: "message", source_type: "group", destination: "d", payload: {}, is_processed: false, created_at: "2026-01-01T00:00:00Z" },
        { id: "msg-B", source_id: "src-1", line_event_id: "ev-B", event_type: "message", source_type: "group", destination: "d", payload: {}, is_processed: false, created_at: "2026-01-01T00:01:00Z" },
        { id: "msg-C", source_id: "src-2", line_event_id: "ev-C", event_type: "message", source_type: "group", destination: "d", payload: {}, is_processed: false, created_at: "2026-01-01T00:02:00Z" },
      ],
    });
    const svc = new ProduceRoundEventService(db as never);

    await svc.bulkInsert([
      makeDraft(0, { rawMessageId: "msg-A", lineEventId: "ev-A", lineTimestampMs: 1000 }),
      makeDraft(1, { rawMessageId: "msg-A", lineEventId: "ev-A", lineTimestampMs: 1000 }),
    ]);
    await svc.bulkInsert([
      makeDraft(0, { rawMessageId: "msg-B", lineEventId: "ev-B", lineTimestampMs: 2000 }),
    ]);
    await svc.bulkInsert([
      makeDraft(0, { rawMessageId: "msg-C", lineEventId: "ev-C", lineTimestampMs: 3000 }),
    ]);

    const events = await svc.listBySource("src-1");
    expect(events).toHaveLength(3);             // msg-A (×2) + msg-B (×1); msg-C excluded
    expect(events[0].lineTimestampMs).toBe(1000);
    expect(events[2].lineTimestampMs).toBe(2000);
  });
});
