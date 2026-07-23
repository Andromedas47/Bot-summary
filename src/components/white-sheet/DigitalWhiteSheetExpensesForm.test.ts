import { describe, expect, it } from "bun:test";
import { validateWhiteSheetExpensesInput } from "./white-sheet-presentation";
import type { WhiteSheetExpenseInput } from "./types";

describe("DigitalWhiteSheetExpensesForm validation boundary", () => {
  it("produces typed submit payload shape", () => {
    const payload: WhiteSheetExpenseInput = {
      labor: 900,
      locationFee: 400,
      bag: 60,
      snack: 30,
      other: 150,
      otherNote: "ค่าน้ำแข็ง",
      actualCashSubmitted: 1850,
    };

    const validation = validateWhiteSheetExpensesInput(payload);
    expect(validation.valid).toBe(true);
    expect(payload).toMatchObject({
      labor: 900,
      locationFee: 400,
      bag: 60,
      snack: 30,
      other: 150,
      otherNote: "ค่าน้ำแข็ง",
      actualCashSubmitted: 1850,
    });
  });

  it("rejects invalid actual cash submitted values", () => {
    const result = validateWhiteSheetExpensesInput({
      labor: 0,
      locationFee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      actualCashSubmitted: -50,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.actualCashSubmitted).toBe("เงินสดส่งจริงต้องเป็นตัวเลข 0 ขึ้นไป");
    }
  });
});
