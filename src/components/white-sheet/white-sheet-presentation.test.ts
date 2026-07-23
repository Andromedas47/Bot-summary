import { describe, expect, it } from "bun:test";
import {
  formatWhiteSheetDifferenceLine,
  formatWhiteSheetMoney,
  validateWhiteSheetExpensesInput,
  WHITE_SHEET_STATUS_LABELS,
} from "./white-sheet-presentation";

describe("white-sheet presentation helpers", () => {
  it("formats currency with Thai locale and two decimals", () => {
    expect(formatWhiteSheetMoney(1234.5)).toBe("1,234.50");
  });

  it("labels shortage, matched, and overage explicitly in Thai", () => {
    expect(WHITE_SHEET_STATUS_LABELS.shortage).toBe("เงินขาด");
    expect(WHITE_SHEET_STATUS_LABELS.matched).toBe("ยอดตรง");
    expect(WHITE_SHEET_STATUS_LABELS.overage).toBe("เงินเกิน");
  });

  it("formats difference lines from supplied status and amount", () => {
    expect(formatWhiteSheetDifferenceLine("shortage", 310)).toBe("เงินขาด 310.00 บาท");
    expect(formatWhiteSheetDifferenceLine("matched", 0)).toBe("ยอดตรง 0.00 บาท");
    expect(formatWhiteSheetDifferenceLine("overage", 150)).toBe("เงินเกิน 150.00 บาท");
  });

  it("rejects negative expense values with Thai messages", () => {
    const result = validateWhiteSheetExpensesInput({
      labor: -1,
      locationFee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      actualCashSubmitted: 100,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.labor).toBe("ค่าแรงต้องเป็นตัวเลข 0 ขึ้นไป");
    }
  });

  it("accepts valid expense submit payload", () => {
    const input = {
      labor: 900,
      locationFee: 400,
      bag: 60,
      snack: 30,
      other: 150,
      otherNote: "ค่าน้ำแข็ง",
      actualCashSubmitted: 1850,
    };

    expect(validateWhiteSheetExpensesInput(input)).toEqual({ valid: true });
  });
});
