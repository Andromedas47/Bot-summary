import { describe, expect, it } from "bun:test";
import {
  parseCloseMoneyAmount,
  parseWhiteSheetCloseCommand,
} from "./white-sheet-close-command";

const VALID_FULL = [
  "ตลาดกี้ ปิดยอด 24/07/2569",
  "ค่าแรง 300",
  "ค่าที่ 200",
  "ค่าถุง 50",
  "ค่าขนม 40",
  "ค่าอื่น 100 ค่าน้ำแข็ง",
  "เงินสด 4850",
  "จบปิดยอด",
].join("\n");

describe("parseCloseMoneyAmount", () => {
  it("accepts plain, decimal, and comma amounts", () => {
    expect(parseCloseMoneyAmount("300")).toBe(300);
    expect(parseCloseMoneyAmount("300.00")).toBe(300);
    expect(parseCloseMoneyAmount("1,250")).toBe(1250);
    expect(parseCloseMoneyAmount("1,250.50")).toBe(1250.5);
    expect(parseCloseMoneyAmount("1250.50")).toBe(1250.5);
  });

  it("rejects negatives, malformed commas, and excess decimals", () => {
    expect(parseCloseMoneyAmount("-500")).toBeNull();
    expect(parseCloseMoneyAmount("abc")).toBeNull();
    expect(parseCloseMoneyAmount("1,25")).toBeNull();
    expect(parseCloseMoneyAmount("1,,250")).toBeNull();
    expect(parseCloseMoneyAmount("1.234")).toBeNull();
    expect(parseCloseMoneyAmount("")).toBeNull();
  });
});

describe("parseWhiteSheetCloseCommand", () => {
  it("A. parses a complete valid message", () => {
    const result = parseWhiteSheetCloseCommand(VALID_FULL);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command).toEqual({
      marketLabel: "ตลาดกี้",
      marketLabelNormalized: "ตลาดกี้",
      businessDate: "2026-07-24",
      labor: 300,
      locationFee: 200,
      bag: 50,
      snack: 40,
      other: 100,
      otherNote: "ค่าน้ำแข็ง",
      actualCashSubmitted: 4850,
    });
  });

  it("B. accepts Buddhist-year dates", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด 100\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.businessDate).toBe("2026-07-24");
  });

  it("C. accepts comma amounts", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด 1,250\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.actualCashSubmitted).toBe(1250);
  });

  it("D. accepts decimal amounts", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด 1250.50\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.actualCashSubmitted).toBe(1250.5);
  });

  it("E. captures ค่าอื่น note", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nค่าอื่น 100 ค่าน้ำแข็ง\nเงินสด 10\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.other).toBe(100);
    expect(result.command.otherNote).toBe("ค่าน้ำแข็ง");
  });

  it("F. omitted optional expenses become 0", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด 16\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.labor).toBe(0);
    expect(result.command.locationFee).toBe(0);
    expect(result.command.bag).toBe(0);
    expect(result.command.snack).toBe(0);
    expect(result.command.other).toBe(0);
    expect(result.command.otherNote).toBeNull();
  });

  it("G. rejects missing เงินสด", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nค่าแรง 10\nจบปิดยอด",
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.message).toContain("เงินสด");
  });

  it("H. rejects missing จบปิดยอด", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด 100",
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.message).toContain("จบปิดยอด");
  });

  it("I. rejects negative amount", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด -500\nจบปิดยอด",
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.message).toContain("เงินสด -500");
  });

  it("J. rejects malformed amount", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nค่าแรง abc\nเงินสด 100\nจบปิดยอด",
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.message).toContain("ค่าแรง abc");
  });

  it("K. rejects duplicate financial field", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด 100\nเงินสด 200\nจบปิดยอด",
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.message).toContain("เงินสด");
    expect(result.message).toContain("ซ้ำ");
  });

  it("L. rejects invalid date", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 32/13/2569\nเงินสด 100\nจบปิดยอด",
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.message).toContain("วันที่");
  });

  it("does not treat unrelated text as a close command", () => {
    expect(parseWhiteSheetCloseCommand("แตงโม 10 โล 20").kind).toBe("not_command");
    expect(parseWhiteSheetCloseCommand("สรุปคงเหลือ").kind).toBe("not_command");
    expect(parseWhiteSheetCloseCommand("จบสลิป").kind).toBe("not_command");
  });

  it("strips LINE export transcript prefixes", () => {
    const text = [
      "10:15 ผู้ขาย ตลาดกี้ ปิดยอด 24/07/2569",
      "10:15 ผู้ขาย เงินสด 1,250.50",
      "10:15 ผู้ขาย จบปิดยอด",
    ].join("\n");
    const result = parseWhiteSheetCloseCommand(text);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.actualCashSubmitted).toBe(1250.5);
  });
});
