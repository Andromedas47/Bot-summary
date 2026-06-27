import { describe, it, expect } from "bun:test";
import { classifyMessage } from "./classifier";

const BASE = { rawMessageId: "msg-1", lineEventId: "ev-1", lineTimestampMs: 1_000_000 };

describe("classifyMessage", () => {
  it("produces header/item/quantity/close_marker kinds for a complete message", () => {
    const drafts = classifyMessage({
      ...BASE,
      rawText: [
        "กี้-วัดทุ่งลานนา เบิก 25/6/2569",
        "1.หมอนทอง119บาท",
        "38.1.โล",
        "จบรายการเบิก",
      ].join("\n"),
    });

    expect(drafts).toHaveLength(4);
    expect(drafts[0]).toMatchObject({ seqInMessage: 0, eventKind: 'header',       category: 'เบิก' });
    expect(drafts[1]).toMatchObject({ seqInMessage: 1, eventKind: 'item',         category: null   });
    expect(drafts[2]).toMatchObject({ seqInMessage: 2, eventKind: 'quantity',     category: null   });
    expect(drafts[3]).toMatchObject({ seqInMessage: 3, eventKind: 'close_marker', category: null   });
  });

  it("seqInMessage is the physical line index; blank lines skip events but advance seq", () => {
    const drafts = classifyMessage({
      ...BASE,
      rawText: "กี้-วัดทุ่ง เบิก 25/6/2569\n\n1.หมอนทอง119บาท",
    });

    expect(drafts).toHaveLength(2);
    expect(drafts[0].seqInMessage).toBe(0);
    expect(drafts[1].seqInMessage).toBe(2); // blank at physical line 1 skipped but seq advanced
  });

  it("reserved financial summary lines are skipped without creating an event", () => {
    const drafts = classifyMessage({
      ...BASE,
      rawText: [
        "กี้-วัดทุ่ง เบิก 25/6/2569",
        "ยอดเบิก 500 บาท",
        "ยอดคืน 200 บาท",
        "1.หมอนทอง119บาท",
      ].join("\n"),
    });

    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.eventKind)).toEqual(['header', 'item']);
  });

  it("unparsed line in a message with produce context gets needs_review status", () => {
    const drafts = classifyMessage({
      ...BASE,
      rawText: [
        "กี้-วัดทุ่ง เบิก 25/6/2569",
        "?? ข้อความไม่รู้จัก ??",
      ].join("\n"),
    });

    const unparsed = drafts.find((d) => d.eventKind === 'unparsed');
    expect(unparsed).toBeDefined();
    expect(unparsed!.eventStatus).toBe('needs_review');
  });

  it("ordinary chat with no produce context returns no events", () => {
    const drafts = classifyMessage({ ...BASE, rawText: "ข้อความไม่รู้จัก" });
    expect(drafts).toHaveLength(0);
  });

  it("standalone recognized item line is captured without header context", () => {
    const drafts = classifyMessage({ ...BASE, rawText: "1.หมอนทอง119บาท" });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ seqInMessage: 0, eventKind: "item", eventStatus: "parsed" });
  });

  it("standalone close marker is captured without header context", () => {
    const drafts = classifyMessage({ ...BASE, rawText: "จบรายการเบิก" });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ seqInMessage: 0, eventKind: "close_marker", eventStatus: "parsed" });
  });

  it("stores ชั่งคืนเพิ่ม verbatim in category — no mapTransactionType canonicalization", () => {
    const drafts = classifyMessage({
      ...BASE,
      rawText: "กี้-วัดทุ่ง ชั่งคืนเพิ่ม 25/6/2569",
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0].eventKind).toBe('header');
    expect(drafts[0].category).toBe('ชั่งคืนเพิ่ม');
    expect(drafts[0].category).not.toBe('คืนเพิ่ม');
  });
});
