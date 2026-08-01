import { describe, expect, test } from "bun:test";
import {
  parseNoteMoneyAmount,
  parseNoteBusinessDate,
  parseWhiteSheetNoteCommand,
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
      field: { key: "labor", amount: 500, note: null },
    });
  });
  test("ค่าที่", () => {
    expect(parseWhiteSheetNoteCommand("ค่าที่ 200")).toEqual({
      kind: "field",
      field: { key: "locationFee", amount: 200, note: null },
    });
  });
  test("ค่าถุง", () => {
    expect(parseWhiteSheetNoteCommand("ค่าถุง 100")).toEqual({
      kind: "field",
      field: { key: "bag", amount: 100, note: null },
    });
  });
  test("ค่าขนม", () => {
    expect(parseWhiteSheetNoteCommand("ค่าขนม 50")).toEqual({
      kind: "field",
      field: { key: "snack", amount: 50, note: null },
    });
  });
  test("ค่าอื่น with note", () => {
    expect(parseWhiteSheetNoteCommand("ค่าอื่น 30 ค่าน้ำ")).toEqual({
      kind: "field",
      field: { key: "other", amount: 30, note: "ค่าน้ำ" },
    });
  });
  test("ค่าอื่น without note", () => {
    expect(parseWhiteSheetNoteCommand("ค่าอื่น 30")).toEqual({
      kind: "field",
      field: { key: "other", amount: 30, note: null },
    });
  });
  test("เงินสด", () => {
    expect(parseWhiteSheetNoteCommand("เงินสด 4850")).toEqual({
      kind: "field",
      field: { key: "actualCash", amount: 4850, note: null },
    });
  });
  test("explicit zero is accepted", () => {
    expect(parseWhiteSheetNoteCommand("ค่าแรง 0")).toEqual({
      kind: "field",
      field: { key: "labor", amount: 0, note: null },
    });
  });
  test("invalid amount returns field_invalid", () => {
    const result = parseWhiteSheetNoteCommand("ค่าแรง abc");
    expect(result.kind).toBe("field_invalid");
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
