import { describe, expect, test } from "bun:test";
import {
  parseNoteMoneyAmount,
  parseNoteBusinessDate,
  parseWhiteSheetNoteCommand,
  collapseWhiteSheetNoteFields,
} from "@/lib/line/white-sheet-note-command";

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

describe("parseWhiteSheetNoteCommand — all-in-one", () => {
  const HAPPY = [
    "ตลาดกี้ ส่งใบขาวมือ 01/08/2569",
    "ค่าแรง 500",
    "ค่าที่ 200",
    "ค่าถุง 100",
    "ค่าขนม 50",
    "ค่าอื่น 30 ค่าน้ำ",
    "เงินสด 4850",
    "จบใบขาวมือ",
  ].join("\n");

  test("complete happy path", () => {
    const result = parseWhiteSheetNoteCommand(HAPPY);
    expect(result.kind).toBe("all_in_one");
    if (result.kind !== "all_in_one") throw new Error("unreachable");
    expect(result.command).toEqual({
      marketLabel: "ตลาดกี้",
      marketLabelNormalized: "ตลาดกี้",
      businessDate: "2026-08-01",
    });
    expect(result.fields).toEqual([
      { key: "labor", amount: 500, note: null },
      { key: "locationFee", amount: 200, note: null },
      { key: "bag", amount: 100, note: null },
      { key: "snack", amount: 50, note: null },
      { key: "other", amount: 30, note: "ค่าน้ำ" },
      { key: "actualCash", amount: 4850, note: null },
    ]);
  });

  test("CRLF and blank lines", () => {
    const text = [
      "ตลาดกี้ ส่งใบขาวมือ 01/08/2569",
      "",
      "ค่าแรง 500",
      "\r",
      "ค่าที่ 200",
      "จบใบขาวมือ",
    ].join("\r\n");
    const result = parseWhiteSheetNoteCommand(text);
    expect(result.kind).toBe("all_in_one");
    if (result.kind !== "all_in_one") throw new Error("unreachable");
    expect(result.fields).toEqual([
      { key: "labor", amount: 500, note: null },
      { key: "locationFee", amount: 200, note: null },
    ]);
  });

  test("repeated field — last wins at apply; parser returns both", () => {
    const result = parseWhiteSheetNoteCommand(
      "ตลาดกี้ ส่งใบขาวมือ 01/08/2569\nค่าแรง 500\nค่าแรง 0\nจบใบขาวมือ",
    );
    expect(result.kind).toBe("all_in_one");
    if (result.kind !== "all_in_one") throw new Error("unreachable");
    expect(result.fields).toEqual([
      { key: "labor", amount: 500, note: null },
      { key: "labor", amount: 0, note: null },
    ]);
    expect(collapseWhiteSheetNoteFields(result.fields)).toEqual([
      { key: "labor", amount: 0, note: null },
    ]);
  });

  test("explicit zero", () => {
    const result = parseWhiteSheetNoteCommand(
      "ตลาดกี้ ส่งใบขาวมือ 01/08/2569\nค่าแรง 0\nจบใบขาวมือ",
    );
    expect(result.kind).toBe("all_in_one");
    if (result.kind !== "all_in_one") throw new Error("unreachable");
    expect(result.fields[0]).toEqual({ key: "labor", amount: 0, note: null });
  });

  test("invalid middle line", () => {
    const result = parseWhiteSheetNoteCommand(
      "ตลาดกี้ ส่งใบขาวมือ 01/08/2569\nค่าแรง 500\nค่าที่ abc\nจบใบขาวมือ",
    );
    expect(result).toEqual({
      kind: "all_in_one_invalid",
      message: "จำนวนเงินไม่ถูกต้องที่บรรทัด:\nค่าที่ abc",
    });
  });

  test("missing close is not all-in-one and does not open", () => {
    const result = parseWhiteSheetNoteCommand(
      "ตลาดกี้ ส่งใบขาวมือ 01/08/2569\nค่าแรง 500",
    );
    expect(result.kind).toBe("all_in_one_invalid");
    expect(result.kind === "all_in_one_invalid" && result.message).toMatch(/จบใบขาวมือ/);
  });

  test("single-line opener still opens (unchanged)", () => {
    expect(parseWhiteSheetNoteCommand("ตลาดกี้ ส่งใบขาวมือ 01/08/2569").kind).toBe("open");
  });

  test("duplicate close in the middle is rejected", () => {
    const result = parseWhiteSheetNoteCommand(
      "ตลาดกี้ ส่งใบขาวมือ 01/08/2569\nค่าแรง 500\nจบใบขาวมือ\nเงินสด 1\nจบใบขาวมือ",
    );
    expect(result.kind).toBe("all_in_one_invalid");
  });
});
