import { describe, expect, test } from "bun:test";
import { parseSalesSummaryCommand, parseSalesSummaryCommandFromMessage } from "./command";

describe("สรุปยอดขาย command", () => {
  test("with no date defers the business date to the caller", () => {
    expect(parseSalesSummaryCommand("สรุปยอดขาย")).toEqual({ businessDate: null });
    expect(parseSalesSummaryCommand("  สรุปยอดขาย  ")).toEqual({ businessDate: null });
  });

  test("accepts DD/MM/YYYY in Gregorian years", () => {
    expect(parseSalesSummaryCommand("สรุปยอดขาย 25/07/2026")).toEqual({
      businessDate: "2026-07-25",
    });
  });

  test("accepts a 4-digit Buddhist year", () => {
    expect(parseSalesSummaryCommand("สรุปยอดขาย 25/07/2569")).toEqual({
      businessDate: "2026-07-25",
    });
  });

  test("accepts the 2-digit Buddhist year the existing commands use", () => {
    // Same rule as สรุปคงเหลือ: 69 → 2569 BE → 2026 CE.
    expect(parseSalesSummaryCommand("สรุปยอดขาย 25/07/69")).toEqual({
      businessDate: "2026-07-25",
    });
  });

  test("pads single-digit days and months", () => {
    expect(parseSalesSummaryCommand("สรุปยอดขาย 5/7/2569")).toEqual({
      businessDate: "2026-07-05",
    });
  });

  test("rejects an impossible date instead of answering for another day", () => {
    expect(parseSalesSummaryCommand("สรุปยอดขาย 31/02/2569")).toBeNull();
    expect(parseSalesSummaryCommand("สรุปยอดขาย 32/07/2569")).toBeNull();
    expect(parseSalesSummaryCommand("สรุปยอดขาย 25/13/2569")).toBeNull();
    expect(parseSalesSummaryCommand("สรุปยอดขาย 25-07-2569")).toBeNull();
  });

  test("does not match other commands or arbitrary text", () => {
    expect(parseSalesSummaryCommand("สรุปคงเหลือ")).toBeNull();
    expect(parseSalesSummaryCommand("ตลาดกี้ สรุปคงเหลือ")).toBeNull();
    expect(parseSalesSummaryCommand("สรุปยอดขายรวม")).toBeNull();
    expect(parseSalesSummaryCommand("อยากได้สรุปยอดขาย")).toBeNull();
    expect(parseSalesSummaryCommand("")).toBeNull();
  });

  test("reads the command out of an exported LINE line", () => {
    expect(parseSalesSummaryCommandFromMessage("09:12 พี่ไก่ สรุปยอดขาย 25/07/69")).toEqual({
      businessDate: "2026-07-25",
    });
  });

  test("finds the command on its own line inside a multi-line message", () => {
    expect(parseSalesSummaryCommandFromMessage("สวัสดีครับ\nสรุปยอดขาย\nขอบคุณ")).toEqual({
      businessDate: null,
    });
  });
});
