import { describe, it, expect } from "bun:test";
import { projectEvents } from "./projector";
import type { ProduceRoundEvent } from "./types";

function makeEvent(
  overrides: Partial<ProduceRoundEvent> &
    Pick<ProduceRoundEvent, "id" | "seqInMessage" | "eventKind" | "normalizedLine">,
): ProduceRoundEvent {
  return {
    rawMessageId:    "msg-1",
    lineEventId:     "ev-1",
    lineTimestampMs: 1_000_000,
    eventStatus:     "parsed",
    rawLine:         overrides.normalizedLine,
    category:        null,
    parsedPayload:   {},
    workRoundId:     null,
    createdAt:       "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("projectEvents", () => {
  it("sorts events deterministically: lineTimestampMs → seqInMessage → lineEventId", () => {
    const events: ProduceRoundEvent[] = [
      makeEvent({ id: "e3", lineTimestampMs: 1000, seqInMessage: 2, eventKind: "item",   normalizedLine: "C" }),
      makeEvent({ id: "e1", lineTimestampMs: 1000, seqInMessage: 0, eventKind: "header", normalizedLine: "A" }),
      makeEvent({ id: "e2", lineTimestampMs: 1000, seqInMessage: 1, eventKind: "item",   normalizedLine: "B" }),
    ];

    const { orderedLines } = projectEvents(events);
    expect(orderedLines.map((l) => l.event.normalizedLine)).toEqual(["A", "B", "C"]);
  });

  it("breaks equal-timestamp ties using seqInMessage", () => {
    const ts = 2_000_000;
    const events: ProduceRoundEvent[] = [
      makeEvent({ id: "e2", lineTimestampMs: ts, seqInMessage: 5, eventKind: "item", normalizedLine: "later"   }),
      makeEvent({ id: "e1", lineTimestampMs: ts, seqInMessage: 2, eventKind: "item", normalizedLine: "earlier" }),
    ];

    const { orderedLines } = projectEvents(events);
    expect(orderedLines[0].event.normalizedLine).toBe("earlier");
    expect(orderedLines[1].event.normalizedLine).toBe("later");
  });

  it("breaks equal timestamp and seq ties using lineEventId", () => {
    const ts = 2_000_000;
    const events: ProduceRoundEvent[] = [
      makeEvent({ id: "e2", lineEventId: "ev-z", lineTimestampMs: ts, seqInMessage: 0, eventKind: "item", normalizedLine: "later"   }),
      makeEvent({ id: "e1", lineEventId: "ev-a", lineTimestampMs: ts, seqInMessage: 0, eventKind: "item", normalizedLine: "earlier" }),
    ];

    const { orderedLines } = projectEvents(events);
    expect(orderedLines[0].event.lineEventId).toBe("ev-a");
    expect(orderedLines[1].event.lineEventId).toBe("ev-z");
  });

  it("flags needs_review unattached events as orphaned when attached events exist", () => {
    const events: ProduceRoundEvent[] = [
      makeEvent({ id: "e1", seqInMessage: 0, eventKind: "header",       normalizedLine: "กี้-วัดทุ่ง เบิก", workRoundId: "wr-1" }),
      makeEvent({ id: "e2", seqInMessage: 1, eventKind: "unparsed",     normalizedLine: "??",              eventStatus: "needs_review", workRoundId: null }),
      makeEvent({ id: "e3", seqInMessage: 2, eventKind: "item",         normalizedLine: "1.หมอนทอง119บาท", workRoundId: "wr-1" }),
    ];

    const { orphanedEvents } = projectEvents(events);
    expect(orphanedEvents).toHaveLength(1);
    expect(orphanedEvents[0].id).toBe("e2");
  });

  it("close boundary: reconstructedText includes all lines up to and including close marker", () => {
    const events: ProduceRoundEvent[] = [
      makeEvent({ id: "e1", seqInMessage: 0, eventKind: "header",       normalizedLine: "กี้-วัดทุ่ง เบิก"  }),
      makeEvent({ id: "e2", seqInMessage: 1, eventKind: "item",         normalizedLine: "1.หมอนทอง119บาท" }),
      makeEvent({ id: "e3", seqInMessage: 2, eventKind: "close_marker", normalizedLine: "จบรายการเบิก"    }),
    ];

    const { reconstructedText, closeBoundaryIdx } = projectEvents(events, "จบรายการเบิก");
    expect(closeBoundaryIdx).toBe(2);
    expect(reconstructedText).toBe("กี้-วัดทุ่ง เบิก\n1.หมอนทอง119บาท\nจบรายการเบิก");
  });

  it("item after the accepted close is flagged isAfterClose and appears in lateEvents", () => {
    const events: ProduceRoundEvent[] = [
      makeEvent({ id: "e1", seqInMessage: 0, eventKind: "header",       normalizedLine: "กี้-วัดทุ่ง เบิก" }),
      makeEvent({ id: "e2", seqInMessage: 1, eventKind: "close_marker", normalizedLine: "จบรายการเบิก"    }),
      makeEvent({ id: "e3", seqInMessage: 2, eventKind: "item",         normalizedLine: "2.มังคุด50บาท"   }),
    ];

    const { lateEvents, orderedLines } = projectEvents(events, "จบรายการเบิก");
    expect(lateEvents).toHaveLength(1);
    expect(lateEvents[0].normalizedLine).toBe("2.มังคุด50บาท");
    expect(orderedLines.find((l) => l.event.id === "e3")?.isAfterClose).toBe(true);
  });
});
