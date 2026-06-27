import { describe, it, expect } from "bun:test";
import { resolveAcceptedCloseMarker, compareProduceRoundParity } from "./parity";
import type { ProduceRoundEvent } from "./types";

function makeEvent(
  overrides: Partial<ProduceRoundEvent> &
    Pick<ProduceRoundEvent, "seqInMessage" | "eventKind" | "normalizedLine">,
): ProduceRoundEvent {
  return {
    id:              overrides.id ?? "e1",
    rawMessageId:    "msg-1",
    lineEventId:     "ev-1",
    lineTimestampMs: 1_000,
    eventStatus:     "parsed",
    rawLine:         overrides.normalizedLine,
    category:        null,
    parsedPayload:   {},
    workRoundId:     null,
    createdAt:       "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("resolveAcceptedCloseMarker", () => {
  it("returns borrow close marker", () => {
    expect(resolveAcceptedCloseMarker("borrow", "a\nจบรายการเบิก")).toBe("จบรายการเบิก");
  });

  it("returns append close marker", () => {
    expect(resolveAcceptedCloseMarker("append", "จบรายการเบิกเพิ่ม")).toBe("จบรายการเบิกเพิ่ม");
  });
});

describe("compareProduceRoundParity", () => {
  it("reports match when projection equals normalized legacy text", () => {
    const events = [
      makeEvent({ id: "e1", seqInMessage: 0, eventKind: "header",       normalizedLine: "โอม-ตลาด เบิก", lineTimestampMs: 1000 }),
      makeEvent({ id: "e2", seqInMessage: 0, eventKind: "item",         normalizedLine: "1มังคุด35บาท",  lineTimestampMs: 2000, lineEventId: "ev-2" }),
      makeEvent({ id: "e3", seqInMessage: 0, eventKind: "close_marker", normalizedLine: "จบรายการเบิก",  lineTimestampMs: 3000, lineEventId: "ev-3" }),
    ];
    const legacy = "โอม-ตลาด เบิก\n1มังคุด35บาท\nจบรายการเบิก";
    const result = compareProduceRoundParity(events, legacy, "borrow");
    expect(result.match).toBe(true);
    expect(result.lateEventCount).toBe(0);
  });

  it("reports late events after accepted close", () => {
    const events = [
      makeEvent({ id: "e1", seqInMessage: 0, eventKind: "header",       normalizedLine: "โอม-ตลาด เบิก", lineTimestampMs: 1000 }),
      makeEvent({ id: "e2", seqInMessage: 0, eventKind: "close_marker", normalizedLine: "จบรายการเบิก",  lineTimestampMs: 2000, lineEventId: "ev-2" }),
      makeEvent({ id: "e3", seqInMessage: 0, eventKind: "item",         normalizedLine: "2ทุเรียน35บาท", lineTimestampMs: 3000, lineEventId: "ev-3" }),
    ];
    const legacy = "โอม-ตลาด เบิก\nจบรายการเบิก";
    const result = compareProduceRoundParity(events, legacy, "borrow");
    expect(result.match).toBe(true);
    expect(result.lateEventCount).toBe(1);
  });
});
