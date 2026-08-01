import { describe, expect, it } from "bun:test";
import {
  formatWhiteSheetSessionFieldsSummary,
  isWhiteSheetSessionCancelCommand,
  isWhiteSheetSessionCloseCommand,
  parseWhiteSheetSessionFieldLines,
  parseWhiteSheetSessionOpener,
} from "./white-sheet-session-command";

describe("parseWhiteSheetSessionOpener", () => {
  it("parses the exact opener line", () => {
    const result = parseWhiteSheetSessionOpener("พาชิโอ้ผลไม้ ส่งใบขาวมือ 31/07/2569");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.opener.marketLabel).toBe("พาชิโอ้ผลไม้");
    expect(result.opener.businessDate).toBe("2026-07-31");
    expect(result.opener.businessDateDisplay).toBe("31/07/2569");
  });

  it("rejects an invalid date with an exact reason", () => {
    const result = parseWhiteSheetSessionOpener("พาชิโอ้ผลไม้ ส่งใบขาวมือ 99/99/2569");
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid");
    expect(result.message).toContain("วันที่ไม่ถูกต้อง");
  });

  it("returns not_command for unrelated text", () => {
    expect(parseWhiteSheetSessionOpener("สวัสดีตอนเช้า").kind).toBe("not_command");
  });

  it("returns not_command for the manual-slip opener (different keyword)", () => {
    expect(parseWhiteSheetSessionOpener("ตลาดกี้ ส่งสลิปมือ 31/07/2569").kind).toBe("not_command");
  });

  it("returns not_command for a multi-line message", () => {
    expect(
      parseWhiteSheetSessionOpener("พาชิโอ้ผลไม้ ส่งใบขาวมือ 31/07/2569\nค่าแรง 500").kind,
    ).toBe("not_command");
  });
});

describe("close/cancel exact triggers", () => {
  it("matches the exact closer", () => {
    expect(isWhiteSheetSessionCloseCommand("จบใบขาวมือ")).toBe(true);
    expect(isWhiteSheetSessionCloseCommand("จบใบขาวมือ ")).toBe(true);
    expect(isWhiteSheetSessionCloseCommand("จบปิดยอด")).toBe(false);
  });

  it("matches the exact cancel command", () => {
    expect(isWhiteSheetSessionCancelCommand("ยกเลิกใบขาวมือ")).toBe(true);
    expect(isWhiteSheetSessionCancelCommand("ยกเลิก")).toBe(false);
  });
});

describe("parseWhiteSheetSessionFieldLines", () => {
  it("returns none for a message with no recognized field lines", () => {
    expect(parseWhiteSheetSessionFieldLines("สวัสดีครับ").kind).toBe("none");
  });

  it("parses a single field line", () => {
    const result = parseWhiteSheetSessionFieldLines("ค่าแรง 500");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.fields.labor).toBe(500);
    expect(result.fields.locationFee).toBeUndefined();
  });

  it("parses multiple field lines in one message", () => {
    const result = parseWhiteSheetSessionFieldLines(
      "ค่าแรง 500\nค่าที่ 200\nค่าถุง 100\nค่าขนม 50\nเงินสด 4850",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.fields).toMatchObject({
      labor: 500,
      locationFee: 200,
      bag: 100,
      snack: 50,
      actualCashSubmitted: 4850,
    });
  });

  it("later line for the same field wins within one message", () => {
    const result = parseWhiteSheetSessionFieldLines("ค่าแรง 500\nค่าแรง 600");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.fields.labor).toBe(600);
  });

  it("accepts explicit zero", () => {
    const result = parseWhiteSheetSessionFieldLines("ค่าแรง 0");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.fields.labor).toBe(0);
  });

  it("ค่าอื่น captures amount and note", () => {
    const result = parseWhiteSheetSessionFieldLines("ค่าอื่น 30 ค่าน้ำ");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.fields.other).toEqual({ amount: 30, note: "ค่าน้ำ" });
  });

  it("ค่าอื่น 0 with no note is a present-but-empty-note clear signal", () => {
    const result = parseWhiteSheetSessionFieldLines("ค่าอื่น 0");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.fields.other).toEqual({ amount: 0, note: null });
  });

  it("rejects malformed money with the exact bad line and makes zero mutation available", () => {
    const result = parseWhiteSheetSessionFieldLines("ค่าแรง abc");
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid");
    expect(result.message).toContain("ค่าแรง abc");
  });

  it("rejects a bare label with no amount", () => {
    const result = parseWhiteSheetSessionFieldLines("ค่าแรง");
    expect(result.kind).toBe("invalid");
  });

  it("rejects negative amounts", () => {
    expect(parseWhiteSheetSessionFieldLines("เงินสด -5").kind).toBe("invalid");
  });

  it("rejects malformed commas and >2 decimals", () => {
    expect(parseWhiteSheetSessionFieldLines("เงินสด 1,25").kind).toBe("invalid");
    expect(parseWhiteSheetSessionFieldLines("เงินสด 1.999").kind).toBe("invalid");
  });

  it("accepts commas and two-decimal amounts", () => {
    const result = parseWhiteSheetSessionFieldLines("เงินสด 1,250.50");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.fields.actualCashSubmitted).toBe(1250.5);
  });

  it("a mixed valid+invalid message is entirely invalid (zero mutation)", () => {
    const result = parseWhiteSheetSessionFieldLines("ค่าแรง 500\nค่าที่ abc");
    expect(result.kind).toBe("invalid");
  });

  it("ignores unrelated lines mixed with a valid field line", () => {
    const result = parseWhiteSheetSessionFieldLines("อรุณสวัสดิ์\nค่าแรง 500");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.fields.labor).toBe(500);
  });
});

describe("formatWhiteSheetSessionFieldsSummary", () => {
  it("shows ยังไม่ระบุ for unset fields and formatted amounts for set ones", () => {
    const text = formatWhiteSheetSessionFieldsSummary({
      labor: 500,
      location_fee: null,
      bag: null,
      snack: null,
      other_amount: null,
      other_note: null,
      actual_cash_submitted: null,
    });
    expect(text).toContain("ค่าแรง: 500.00");
    expect(text).toContain("ค่าที่: ยังไม่ระบุ");
    expect(text).toContain("เงินสด: ยังไม่ระบุ");
  });

  it("includes the ค่าอื่น note when present", () => {
    const text = formatWhiteSheetSessionFieldsSummary({
      labor: null,
      location_fee: null,
      bag: null,
      snack: null,
      other_amount: 30,
      other_note: "ค่าน้ำ",
      actual_cash_submitted: null,
    });
    expect(text).toContain("ค่าอื่น: 30.00 (ค่าน้ำ)");
  });
});
