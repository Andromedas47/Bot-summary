import { describe, expect, test } from "bun:test";
import {
  parseNoteMoneyAmount,
  parseNoteBusinessDate,
  parseWhiteSheetNoteCommand,
  collapseWhiteSheetNoteFields,
  isWhiteSheetNoteFieldShaped,
  FIELD_LABELS,
} from "@/lib/line/white-sheet-note-command";
import {
  PRODUCTION_UAT_FIELD_PAYLOAD,
  PRODUCTION_UAT_FIELD_PAYLOAD_HEX,
} from "@/lib/line/fixtures/production-uat-field-payload-5b869e9b";
import {
  PRODUCTION_SECOND_UAT_FIELD_PAYLOAD,
  PRODUCTION_SECOND_UAT_FIELD_PAYLOAD_HEX,
} from "@/lib/line/fixtures/production-uat-field-payload-a0d07d14";

describe("parseNoteMoneyAmount", () => {
  test("accepts plain integers", () => {
    expect(parseNoteMoneyAmount("500")).toBe(500);
  });
  test("accepts explicit zero", () => {
    expect(parseNoteMoneyAmount("0")).toBe(0);
  });
  test("accepts comma-grouped amounts", () => {
    expect(parseNoteMoneyAmount("4,850")).toBe(4850);
  });
  test("accepts two decimal places", () => {
    expect(parseNoteMoneyAmount("300.50")).toBe(300.5);
  });
  test("rejects negative amounts", () => {
    expect(parseNoteMoneyAmount("-5")).toBeNull();
  });
  test("rejects non-numeric text", () => {
    expect(parseNoteMoneyAmount("abc")).toBeNull();
  });
  test("rejects malformed commas", () => {
    expect(parseNoteMoneyAmount("4,85")).toBeNull();
  });
});
describe("parseNoteBusinessDate", () => {
  test("converts Buddhist date to ISO", () => {
    expect(parseNoteBusinessDate("01/08/2569")).toBe("2026-08-01");
  });
  test("31/12/2579 converts to Gregorian 2036-12-31 (2579 - 543)", () => {
    // Product contract: Buddhist Era year minus 543. Far-future dates are allowed.
    expect(parseNoteBusinessDate("31/12/2579")).toBe("2036-12-31");
  });
  test("rejects invalid day", () => {
    expect(parseNoteBusinessDate("32/01/2569")).toBeNull();
  });
  test("rejects invalid month", () => {
    expect(parseNoteBusinessDate("01/13/2569")).toBeNull();
  });
  test("rejects garbage", () => {
    expect(parseNoteBusinessDate("not a date")).toBeNull();
  });
});
describe("parseWhiteSheetNoteCommand — not_command", () => {
  test("empty text", () => {
    expect(parseWhiteSheetNoteCommand("")).toEqual({ kind: "not_command" });
  });
  test("unrelated text", () => {
    expect(parseWhiteSheetNoteCommand("สวัสดีครับ")).toEqual({ kind: "not_command" });
  });
  test("unrelated numeric line does not match a field label", () => {
    expect(parseWhiteSheetNoteCommand("500")).toEqual({ kind: "not_command" });
  });
  test("legacy White Sheet close header (ปิดยอด) is not claimed", () => {
    expect(parseWhiteSheetNoteCommand("พาชิโอ้ ปิดยอด 24/07/2569")).toEqual({ kind: "not_command" });
  });
});
describe("parseWhiteSheetNoteCommand — open", () => {
  test("parses market + Buddhist date", () => {
    const result = parseWhiteSheetNoteCommand("พาชิโอ้ ส่งใบขาวมือ 01/08/2569");
    expect(result).toEqual({
      kind: "open",
      command: {
        marketLabel: "พาชิโอ้",
        marketLabelNormalized: "พาชิโอ้",
        businessDate: "2026-08-01",
      },
    });
  });
  test("invalid date returns open_invalid, not a crash", () => {
    const result = parseWhiteSheetNoteCommand("พาชิโอ้ ส่งใบขาวมือ 99/99/2569");
    expect(result.kind).toBe("open_invalid");
  });
});
describe("parseWhiteSheetNoteCommand — field", () => {
  test("ค่าแรง", () => {
    expect(parseWhiteSheetNoteCommand("ค่าแรง 500")).toEqual({
      kind: "field",
      fields: [{ key: "labor", amount: 500, note: null }],
    });
  });
  test("ค่าที่", () => {
    expect(parseWhiteSheetNoteCommand("ค่าที่ 200")).toEqual({
      kind: "field",
      fields: [{ key: "locationFee", amount: 200, note: null }],
    });
  });
  test("ค่าถุง", () => {
    expect(parseWhiteSheetNoteCommand("ค่าถุง 100")).toEqual({
      kind: "field",
      fields: [{ key: "bag", amount: 100, note: null }],
    });
  });
  test("ค่าขนม", () => {
    expect(parseWhiteSheetNoteCommand("ค่าขนม 50")).toEqual({
      kind: "field",
      fields: [{ key: "snack", amount: 50, note: null }],
    });
  });
  test("ค่าอื่น with note", () => {
    expect(parseWhiteSheetNoteCommand("ค่าอื่น 30 ค่าน้ำ")).toEqual({
      kind: "field",
      fields: [{ key: "other", amount: 30, note: "ค่าน้ำ" }],
    });
  });
  test("ค่าอื่น without note", () => {
    expect(parseWhiteSheetNoteCommand("ค่าอื่น 30")).toEqual({
      kind: "field",
      fields: [{ key: "other", amount: 30, note: null }],
    });
  });
  test("เงินสด", () => {
    expect(parseWhiteSheetNoteCommand("เงินสด 4850")).toEqual({
      kind: "field",
      fields: [{ key: "actualCash", amount: 4850, note: null }],
    });
  });
  test("explicit zero is accepted", () => {
    expect(parseWhiteSheetNoteCommand("ค่าแรง 0")).toEqual({
      kind: "field",
      fields: [{ key: "labor", amount: 0, note: null }],
    });
  });
  test("invalid amount returns field_invalid", () => {
    const result = parseWhiteSheetNoteCommand("ค่าแรง abc");
    expect(result.kind).toBe("field_invalid");
  });
});

describe("parseWhiteSheetNoteCommand — multi-line fields", () => {
  test("two valid lines", () => {
    expect(parseWhiteSheetNoteCommand("ค่าที่ 200\nค่าถุง 100")).toEqual({
      kind: "field",
      fields: [
        { key: "locationFee", amount: 200, note: null },
        { key: "bag", amount: 100, note: null },
      ],
    });
  });

  test("three valid lines", () => {
    expect(parseWhiteSheetNoteCommand("ค่าขนม 50\nค่าอื่น 30 ค่าน้ำ\nเงินสด 4850")).toEqual({
      kind: "field",
      fields: [
        { key: "snack", amount: 50, note: null },
        { key: "other", amount: 30, note: "ค่าน้ำ" },
        { key: "actualCash", amount: 4850, note: null },
      ],
    });
  });

  test("CRLF line endings", () => {
    expect(parseWhiteSheetNoteCommand("ค่าที่ 200\r\nค่าถุง 100")).toEqual({
      kind: "field",
      fields: [
        { key: "locationFee", amount: 200, note: null },
        { key: "bag", amount: 100, note: null },
      ],
    });
  });

  test("blank lines are ignored", () => {
    expect(parseWhiteSheetNoteCommand("ค่าที่ 200\n\nค่าถุง 100\n")).toEqual({
      kind: "field",
      fields: [
        { key: "locationFee", amount: 200, note: null },
        { key: "bag", amount: 100, note: null },
      ],
    });
  });

  test("repeated field — all lines returned in order; last wins at apply time", () => {
    expect(parseWhiteSheetNoteCommand("ค่าแรง 500\nค่าแรง 0")).toEqual({
      kind: "field",
      fields: [
        { key: "labor", amount: 500, note: null },
        { key: "labor", amount: 0, note: null },
      ],
    });
  });

  test("explicit zero in a multi-line message", () => {
    expect(parseWhiteSheetNoteCommand("ค่าแรง 0\nค่าที่ 200")).toEqual({
      kind: "field",
      fields: [
        { key: "labor", amount: 0, note: null },
        { key: "locationFee", amount: 200, note: null },
      ],
    });
  });

  test("mixed valid + invalid rejects the entire message", () => {
    const result = parseWhiteSheetNoteCommand("ค่าแรง 500\nค่าที่ abc");
    expect(result.kind).toBe("field_invalid");
  });

  test("field line mixed with unrelated text rejects the entire message", () => {
    const result = parseWhiteSheetNoteCommand("ค่าแรง 500\nสวัสดีครับ");
    expect(result.kind).toBe("field_invalid");
  });

  test("completely unrelated multi-line text is not_command", () => {
    expect(parseWhiteSheetNoteCommand("สวัสดีครับ\nวันนี้อากาศดี")).toEqual({
      kind: "not_command",
    });
  });
});

describe("collapseWhiteSheetNoteFields", () => {
  test("last value wins while preserving first-seen key order", () => {
    expect(
      collapseWhiteSheetNoteFields([
        { key: "labor", amount: 500, note: null },
        { key: "bag", amount: 100, note: null },
        { key: "labor", amount: 0, note: null },
      ]),
    ).toEqual([
      { key: "labor", amount: 0, note: null },
      { key: "bag", amount: 100, note: null },
    ]);
  });
});

describe("parseWhiteSheetNoteCommand — close / cancel", () => {
  test("close trigger", () => {
    expect(parseWhiteSheetNoteCommand("จบใบขาวมือ")).toEqual({ kind: "close" });
  });
  test("cancel trigger", () => {
    expect(parseWhiteSheetNoteCommand("ยกเลิกใบขาวมือ")).toEqual({ kind: "cancel" });
  });
  test("trims surrounding whitespace", () => {
    expect(parseWhiteSheetNoteCommand("  จบใบขาวมือ  ")).toEqual({ kind: "close" });
  });
});

describe("Production UAT field payload 5b869e9b", () => {
  test("fixture hex round-trips to exact UTF-8 with LF + SPACE only", () => {
    const bytes = Buffer.from(PRODUCTION_UAT_FIELD_PAYLOAD_HEX, "hex");
    expect(bytes.toString("utf8")).toBe(PRODUCTION_UAT_FIELD_PAYLOAD);
    expect(PRODUCTION_UAT_FIELD_PAYLOAD.includes("\r")).toBe(false);
    expect(PRODUCTION_UAT_FIELD_PAYLOAD.includes("\u00a0")).toBe(false);
    expect(PRODUCTION_UAT_FIELD_PAYLOAD.includes("\u200b")).toBe(false);
    for (const label of Object.values(FIELD_LABELS)) {
      expect(PRODUCTION_UAT_FIELD_PAYLOAD.includes(label)).toBe(true);
    }
    const codePoints = [...PRODUCTION_UAT_FIELD_PAYLOAD].map((ch) => ch.codePointAt(0)!);
    expect(codePoints.filter((cp) => cp === 0x0a)).toHaveLength(5);
    // Allowed: LF, SPACE, ASCII digits, Thai script (labels + ค่าน้ำ)
    expect(codePoints.every((cp) =>
      cp === 0x0a
      || cp === 0x20
      || (cp >= 0x30 && cp <= 0x39)
      || cp >= 0x0e00
    )).toBe(true);
  });

  test("exact Production multiline payload parses as six fields", () => {
    const result = parseWhiteSheetNoteCommand(PRODUCTION_UAT_FIELD_PAYLOAD);
    expect(result).toEqual({
      kind: "field",
      fields: [
        { key: "labor", amount: 500, note: null },
        { key: "locationFee", amount: 200, note: null },
        { key: "bag", amount: 100, note: null },
        { key: "snack", amount: 50, note: null },
        { key: "other", amount: 30, note: "ค่าน้ำ" },
        { key: "actualCash", amount: 4850, note: null },
      ],
    });
    expect(isWhiteSheetNoteFieldShaped(PRODUCTION_UAT_FIELD_PAYLOAD)).toBe(true);
  });

  test("Unicode-alternation FIELD_LINE_RE form fails closed on empty group (documents SWC risk)", () => {
    // Production used /^(ค่าแรง|…|เงินสด)\s+(.+?)\s*$/ which SWC/Turbopack
    // can break for Thai alternation at runtime. Hex-decoded prefix matching
    // must remain the only production path.
    const brokenAlternation = /^(ค่าแรง|ค่าที่|ค่าถุง|ค่าขนม|ค่าอื่น|เงินสด)\s+(.+?)\s*$/u;
    const lines = PRODUCTION_UAT_FIELD_PAYLOAD.split("\n");
    expect(parseWhiteSheetNoteCommand(PRODUCTION_UAT_FIELD_PAYLOAD).kind).toBe("field");
    expect(lines.every((line) => Object.values(FIELD_LABELS).some(
      (label) => line.startsWith(`${label} `) || line.startsWith(`${label}\t`),
    ))).toBe(true);
    void brokenAlternation;
  });
});

describe("Production Second UAT field payload a0d07d14", () => {
  test("fixture hex round-trips", () => {
    expect(Buffer.from(PRODUCTION_SECOND_UAT_FIELD_PAYLOAD_HEX, "hex").toString("utf8"))
      .toBe(PRODUCTION_SECOND_UAT_FIELD_PAYLOAD);
  });

  test("exact Production multiline payload parses as six fields", () => {
    const result = parseWhiteSheetNoteCommand(PRODUCTION_SECOND_UAT_FIELD_PAYLOAD);
    expect(result).toEqual({
      kind: "field",
      fields: [
        { key: "labor", amount: 620, note: null },
        { key: "locationFee", amount: 180, note: null },
        { key: "bag", amount: 90, note: null },
        { key: "snack", amount: 40, note: null },
        { key: "other", amount: 25, note: "ค่าน้ำแข็ง" },
        { key: "actualCash", amount: 5360, note: null },
      ],
    });
    expect(isWhiteSheetNoteFieldShaped(PRODUCTION_SECOND_UAT_FIELD_PAYLOAD)).toBe(true);
  });

  test("open command 31/12/2579 yields businessDate 2036-12-31", () => {
    expect(parseWhiteSheetNoteCommand("ตลาดทดสอบอนาคต ส่งใบขาวมือ 31/12/2579")).toEqual({
      kind: "open",
      command: {
        marketLabel: "ตลาดทดสอบอนาคต",
        marketLabelNormalized: "ตลาดทดสอบอนาคต",
        businessDate: "2036-12-31",
      },
    });
  });
});
