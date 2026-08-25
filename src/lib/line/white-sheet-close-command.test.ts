import { describe, expect, it } from "bun:test";
import {
  parseCloseMoneyAmount,
  parseWhiteSheetCloseCommand,
} from "./white-sheet-close-command";

const VALID_FULL = [
  "ตลาดกี้ ปิดยอด 24/07/2569",
  "ยอดขาย 5,560.50",
  "เงินให้เจ้า 320",
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
  it("A. complete valid message keeps explicit expense values", () => {
    const result = parseWhiteSheetCloseCommand(VALID_FULL);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command).toEqual({
      marketLabel: "ตลาดกี้",
      marketLabelNormalized: "ตลาดกี้",
      businessDate: "2026-07-24",
      whiteSheetSales: 5560.5,
      ownerCash: 320,
      labor: 300,
      locationFee: 200,
      bag: 50,
      snack: 40,
      other: { amount: 100, note: "ค่าน้ำแข็ง" },
      actualCashSubmitted: 4850,
    });
  });

  it("B. accepts Buddhist-year dates", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nยอดขาย 100\nเงินให้เจ้า 0\nเงินสด 100\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.businessDate).toBe("2026-07-24");
  });

  it("C. accepts comma amounts", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nยอดขาย 1,250\nเงินให้เจ้า 0\nเงินสด 1,250\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.actualCashSubmitted).toBe(1250);
  });

  it("D. accepts decimal amounts", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nยอดขาย 1250.50\nเงินให้เจ้า 0\nเงินสด 1250.50\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.actualCashSubmitted).toBe(1250.5);
  });

  it("E. captures ค่าอื่น note as explicit other payload", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nยอดขาย 100\nเงินให้เจ้า 0\nค่าอื่น 100 ค่าน้ำแข็ง\nเงินสด 10\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.other).toEqual({ amount: 100, note: "ค่าน้ำแข็ง" });
  });

  it("F. omitted optional expenses stay undefined (not silently zeroed)", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nยอดขาย 100\nเงินให้เจ้า 0\nเงินสด 16\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.labor).toBeUndefined();
    expect(result.command.locationFee).toBeUndefined();
    expect(result.command.bag).toBeUndefined();
    expect(result.command.snack).toBeUndefined();
    expect(result.command.other).toBeUndefined();
    expect(result.command.actualCashSubmitted).toBe(16);
  });

  it("distinguishes explicit zero from omitted expense fields", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nยอดขาย 0\nเงินให้เจ้า 0\nค่าแรง 0\nค่าอื่น 0\nเงินสด 16\nจบปิดยอด",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.labor).toBe(0);
    expect(result.command.whiteSheetSales).toBe(0);
    expect(result.command.ownerCash).toBe(0);
    expect(result.command.locationFee).toBeUndefined();
    expect(result.command.other).toEqual({ amount: 0, note: null });
  });

  it("G. rejects missing เงินสด", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nยอดขาย 100\nเงินให้เจ้า 0\nค่าแรง 10\nจบปิดยอด",
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.message).toContain("เงินสด");
  });

  it("rejects a legacy retransmission missing both new required fields", () => {
    const result = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด 100\nจบปิดยอด",
    );
    expect(result).toEqual({
      kind: "invalid",
      message: "ยังปิดยอดไม่ได้\nกรุณากรอก:\n• ยอดขาย\n• เงินให้เจ้า",
    });
  });

  it("lists only the missing required financial field", () => {
    const missingOwner = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nยอดขาย 100\nเงินสด 100\nจบปิดยอด",
    );
    expect(missingOwner).toEqual({
      kind: "invalid",
      message: "ยังปิดยอดไม่ได้\nกรุณากรอก:\n• เงินให้เจ้า",
    });

    const missingSales = parseWhiteSheetCloseCommand(
      "ตลาดกี้ ปิดยอด 24/07/2569\nเงินให้เจ้า 0\nเงินสด 100\nจบปิดยอด",
    );
    expect(missingSales).toEqual({
      kind: "invalid",
      message: "ยังปิดยอดไม่ได้\nกรุณากรอก:\n• ยอดขาย",
    });
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
      "10:15 ผู้ขาย ยอดขาย 1,250.50",
      "10:15 ผู้ขาย เงินให้เจ้า 0",
      "10:15 ผู้ขาย เงินสด 1,250.50",
      "10:15 ผู้ขาย จบปิดยอด",
    ].join("\n");
    const result = parseWhiteSheetCloseCommand(text);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.command.actualCashSubmitted).toBe(1250.5);
  });
});
