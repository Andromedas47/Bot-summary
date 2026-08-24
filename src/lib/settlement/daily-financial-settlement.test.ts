import { describe, expect, test } from "bun:test";
import {
  computeDailyFinancialSettlement,
  type DailyFinancialSettlementInputs,
} from "./daily-financial-settlement";

const IDENTITY = { businessDate: "2026-08-22", marketLabelNormalized: "ตลาดกลาง" };

function inputs(overrides: Partial<DailyFinancialSettlementInputs> = {}): DailyFinancialSettlementInputs {
  return {
    whiteSheetSales: 0,
    transferTotal: 0,
    ownerCash: 0,
    expensesTotal: 0,
    wagesTotal: 0,
    actualCash: 0,
    ...overrides,
  };
}

describe("computeDailyFinancialSettlement — historical fixtures", () => {
  test("22 Aug: exact close, difference 0", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9553,
    }));
    expect(result.status).toBe("CLOSED_MATCHED");
    expect(result.expectedCash).toBe(9553);
    expect(result.difference).toBe(0);
    expect(result.missingInputs).toEqual([]);
  });

  test("21 Aug: exact close, difference 0, owner cash 0", () => {
    const result = computeDailyFinancialSettlement(
      { businessDate: "2026-08-21", marketLabelNormalized: "ตลาดกลาง" },
      inputs({
        whiteSheetSales: 24740,
        transferTotal: 7708,
        ownerCash: 0,
        expensesTotal: 2475,
        wagesTotal: 5540,
        actualCash: 9017,
      }),
    );
    expect(result.status).toBe("CLOSED_MATCHED");
    expect(result.expectedCash).toBe(9017);
    expect(result.difference).toBe(0);
  });
});

describe("computeDailyFinancialSettlement — status model", () => {
  test("shortage: actual cash below expected reports negative difference", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9000, // 553 short of 9553
    }));
    expect(result.status).toBe("CLOSED_DIFFERENCE");
    expect(result.expectedCash).toBe(9553);
    expect(result.difference).toBe(-553);
  });

  test("excess: actual cash above expected reports positive difference", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9600, // 47 over 9553
    }));
    expect(result.status).toBe("CLOSED_DIFFERENCE");
    expect(result.difference).toBe(47);
  });

  test("missing actual cash: never reports CLOSED_MATCHED", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: null,
    }));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.expectedCash).toBeNull();
    expect(result.difference).toBeNull();
    expect(result.missingInputs).toEqual(["actual_cash"]);
  });

  test("missing white-sheet sales: never reports CLOSED_MATCHED", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: null,
      actualCash: 9553,
    }));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingInputs).toEqual(["white_sheet_sales"]);
  });

  test("missing expense input: INCOMPLETE, not silently treated as zero", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      actualCash: 9553,
      expensesTotal: null,
    }));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingInputs).toEqual(["expenses"]);
  });

  test("missing owner cash: INCOMPLETE, not silently treated as zero", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      actualCash: 9553,
      ownerCash: null,
    }));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingInputs).toEqual(["owner_cash"]);
  });

  test("missing wages: INCOMPLETE, not silently treated as zero", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      actualCash: 9553,
      wagesTotal: null,
    }));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingInputs).toEqual(["wages"]);
  });

  test("multiple missing inputs are all reported, not just the first", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: null,
      ownerCash: null,
      expensesTotal: null,
      wagesTotal: null,
      actualCash: null,
    }));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingInputs).toEqual([
      "white_sheet_sales",
      "owner_cash",
      "expenses",
      "wages",
      "actual_cash",
    ]);
  });

  test("transferTotal is never a missing input — it always carries a best-known value", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      actualCash: 9553,
      transferTotal: 0,
      transferUncertainty: ["ยังไม่ได้ทำการกระทบยอดเงินโอน"],
    }));
    expect(result.missingInputs).not.toContain("transfer_total");
    expect(result.uncertainty).toEqual(["ยังไม่ได้ทำการกระทบยอดเงินโอน"]);
  });
});

describe("computeDailyFinancialSettlement — money exactness", () => {
  test("fractional satang amounts never drift under float arithmetic", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 100.1,
      transferTotal: 0,
      ownerCash: 0,
      expensesTotal: 0,
      wagesTotal: 0,
      actualCash: 100.1,
    }));
    expect(result.status).toBe("CLOSED_MATCHED");
    expect(result.difference).toBe(0);
  });

  test("0.1 + 0.2 style drift does not produce a false shortage/overage", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 0.3,
      transferTotal: 0.1,
      ownerCash: 0.1,
      expensesTotal: 0.1,
      wagesTotal: 0,
      actualCash: 0,
    }));
    expect(result.status).toBe("CLOSED_MATCHED");
    expect(result.expectedCash).toBe(0);
    expect(result.difference).toBe(0);
  });
});

describe("computeDailyFinancialSettlement — produce cross-check separation", () => {
  test("produce cross-check is attached as informational only, never overwrites sales", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      actualCash: 9553,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      produceCrossCheck: { expectedSales: 27000, warnings: ["ตัวอย่างคำเตือน"] },
    }));
    expect(result.whiteSheetSales).toBe(28632);
    expect(result.status).toBe("CLOSED_MATCHED");
    expect(result.produceCrossCheck).toEqual({ expectedSales: 27000, warnings: ["ตัวอย่างคำเตือน"] });
  });

  test("dirty produce cross-check data does not block a complete financial close", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, inputs({
      whiteSheetSales: 28632,
      actualCash: 9553,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      produceCrossCheck: { expectedSales: 0, warnings: ["session ยังไม่สมบูรณ์", "ราคากลางขาดหาย"] },
    }));
    expect(result.status).toBe("CLOSED_MATCHED");
  });
});
