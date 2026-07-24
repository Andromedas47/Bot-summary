import { describe, expect, test } from "bun:test";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { resolveUnitQuantity } from "@/lib/parsers/weigh-session/units";
import {
  calculateDigitalWhiteSheet,
  calculateWhiteSheetItems,
  WhiteSheetValidationError,
} from "./calculate";
import { centralPriceMapKey } from "./pricing";
import type {
  DigitalWhiteSheetInput,
  WhiteSheetExpenses,
  WhiteSheetTransactionRow,
} from "./types";

const MARKET_KEY = "market-72";
const BUSINESS_DATE = "2026-07-23";

function transaction(
  overrides: Partial<WhiteSheetTransactionRow> = {},
): WhiteSheetTransactionRow {
  return {
    marketKey: MARKET_KEY,
    businessDate: BUSINESS_DATE,
    productName: "ผักกาดขาว",
    unit: "โล",
    quantity: 10,
    transactionType: "เบิก",
    unitPrice: 25,
    ...overrides,
  };
}

function expenses(overrides: Partial<WhiteSheetExpenses> = {}): WhiteSheetExpenses {
  return {
    labor: 0,
    locationFee: 0,
    bag: 0,
    snack: 0,
    other: 0,
    ...overrides,
  };
}

/**
 * BR-01: central daily selling price, keyed the same way calculate.ts groups
 * items (normalizeProductName + resolveUnitQuantity(...).unit) — never a
 * second, independent normalization.
 */
function priceMap(
  entries: Array<{ product: string; unit: string; priceBaht: number }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const productKey = normalizeProductName(entry.product);
    const unitKey = resolveUnitQuantity(1, entry.unit).unit;
    map.set(centralPriceMapKey(productKey, unitKey), Math.round(entry.priceBaht * 100));
  }
  return map;
}

function input(
  overrides: Partial<DigitalWhiteSheetInput> = {},
): DigitalWhiteSheetInput {
  return {
    marketKey: MARKET_KEY,
    marketLabel: "ตลาด 72",
    businessDate: BUSINESS_DATE,
    transactions: [transaction()],
    centralPrices: priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 25 }]),
    verifiedTransfers: 0,
    expenses: expenses(),
    actualCashSubmitted: 0,
    ...overrides,
  };
}

describe("calculateWhiteSheetItems", () => {
  test("subtracts good and damaged returns from withdrawals, priced at the central daily price (not the withdrawal price)", () => {
    const items = calculateWhiteSheetItems(
      [
        transaction({ quantity: 10, unitPrice: 999 }),
        transaction({ quantity: 2, transactionType: "คืน", unitPrice: null }),
        transaction({ quantity: 1, transactionType: "คืนเสีย", unitPrice: null }),
      ],
      priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 25 }]),
    );

    expect(items).toEqual([
      expect.objectContaining({
        withdrawnQuantity: 10,
        goodReturnQuantity: 2,
        damagedReturnQuantity: 1,
        soldQuantity: 7,
        expectedSales: 175,
      }),
    ]);
  });

  test("treats missing and explicit zero returns as zero", () => {
    const prices = priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 12.5 }]);
    const missing = calculateWhiteSheetItems([transaction({ quantity: 4 })], prices);
    const explicitZero = calculateWhiteSheetItems(
      [
        transaction({ quantity: 4 }),
        transaction({ quantity: 0, transactionType: "คืน", unitPrice: null }),
        transaction({ quantity: 0, transactionType: "คืนเสีย", unitPrice: null }),
      ],
      prices,
    );

    expect(missing[0]).toMatchObject({
      goodReturnQuantity: 0,
      damagedReturnQuantity: 0,
      soldQuantity: 4,
      expectedSales: 50,
    });
    expect(explicitZero).toEqual(missing);
  });

  test("sums duplicate product rows", () => {
    const [item] = calculateWhiteSheetItems(
      [
        transaction({ quantity: 2, unitPrice: 10 }),
        transaction({ quantity: 3, unitPrice: 10 }),
        transaction({ quantity: 1, transactionType: "คืน", unitPrice: null }),
      ],
      priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 10 }]),
    );

    expect(item).toMatchObject({
      withdrawnQuantity: 5,
      goodReturnQuantity: 1,
      soldQuantity: 4,
      expectedSales: 40,
    });
  });

  test("preserves decimal kilogram precision", () => {
    const [item] = calculateWhiteSheetItems(
      [
        transaction({ quantity: 1.25, unitPrice: 100 }),
        transaction({ quantity: 0.15, transactionType: "คืน", unitPrice: null }),
        transaction({ quantity: 0.1, transactionType: "คืนเสีย", unitPrice: null }),
      ],
      priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 100 }]),
    );

    expect(item).toMatchObject({
      withdrawnQuantity: 1.25,
      goodReturnQuantity: 0.15,
      damagedReturnQuantity: 0.1,
      soldQuantity: 1,
      expectedSales: 100,
    });
  });

  test("central price is used even when a persisted basis price exists on the row (BR-01)", () => {
    const items = calculateWhiteSheetItems(
      [
        transaction({
          productName: "ข้าวโพด",
          unit: "หัว",
          quantity: 7,
          unitPrice: 33.33,
          basisQuantity: 3,
          basisPrice: 100,
        }),
        transaction({
          productName: "ข้าวโพด",
          unit: "หัว",
          quantity: 1,
          transactionType: "คืน",
          unitPrice: null,
        }),
      ],
      priceMap([{ product: "ข้าวโพด", unit: "หัว", priceBaht: 40 }]),
    );

    // Basis price implies ~33.33/หัว; central price (40) wins instead.
    expect(items[0]).toMatchObject({
      soldQuantity: 6,
      expectedSales: 240,
    });
  });

  test("fails closed when only half of a persisted basis price is supplied", () => {
    expect(() =>
      calculateWhiteSheetItems([
        transaction({ basisQuantity: 3, basisPrice: null }),
      ]),
    ).toThrow(WhiteSheetValidationError);
  });

  test("keeps incompatible units on separate rows", () => {
    const items = calculateWhiteSheetItems(
      [
        transaction({ quantity: 2, unit: "โล", unitPrice: 100 }),
        transaction({ quantity: 3, unit: "ลูก", unitPrice: 10 }),
      ],
      priceMap([
        { product: "ผักกาดขาว", unit: "โล", priceBaht: 100 },
        { product: "ผักกาดขาว", unit: "ลูก", priceBaht: 10 },
      ]),
    );

    expect(items).toHaveLength(2);
    expect(items.find((item) => item.normalizedUnit === "โล")).toMatchObject({
      soldQuantity: 2,
      expectedSales: 200,
    });
    expect(items.find((item) => item.normalizedUnit === "ลูก")).toMatchObject({
      soldQuantity: 3,
      expectedSales: 30,
    });
  });

  test("converts compatible weight units to a common canonical basis (withdrawal in โล, return in ขีด)", () => {
    const items = calculateWhiteSheetItems(
      [
        transaction({ quantity: 1, unit: "โล", unitPrice: 100 }),
        transaction({ quantity: 2, unit: "ขีด", transactionType: "คืน", unitPrice: null }),
      ],
      priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 100 }]),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      normalizedUnit: "โล",
      withdrawnQuantity: 1,
      goodReturnQuantity: 0.2,
      soldQuantity: 0.8,
      expectedSales: 80,
    });
  });

  test("supports decimal kilogram withdrawal reconciled against a gram return", () => {
    const items = calculateWhiteSheetItems(
      [
        transaction({ quantity: 1.5, unit: "โล", unitPrice: 40 }),
        transaction({ quantity: 250, unit: "กรัม", transactionType: "คืน", unitPrice: null }),
      ],
      priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 40 }]),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      normalizedUnit: "โล",
      withdrawnQuantity: 1.5,
      goodReturnQuantity: 0.25,
      soldQuantity: 1.25,
      expectedSales: 50,
    });
  });

  test("rescales the informational legacy unitPrice by the same factor as the converted quantity (display only — central price still prices the sale)", () => {
    // 2 ขีด withdrawn at 10 baht/ขีด converts to 0.2 โล; the display price
    // rescales to 100 baht/โล (10 / 0.1) so unitPrice × quantity stays
    // unchanged after conversion — but the central price (50/โล) is what
    // actually prices expectedSales.
    const items = calculateWhiteSheetItems(
      [transaction({ quantity: 2, unit: "ขีด", unitPrice: 10 })],
      priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 50 }]),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      normalizedUnit: "โล",
      withdrawnQuantity: 0.2,
      soldQuantity: 0.2,
      withdrawalUnitPrices: [100],
      expectedSales: 10,
    });
  });

  test("rescales a persisted basis price under a converted unit for display only — central price still prices the sale", () => {
    const items = calculateWhiteSheetItems(
      [
        transaction({
          unit: "ขีด",
          quantity: 6,
          unitPrice: 30,
          basisQuantity: 3,
          basisPrice: 90,
        }),
        transaction({ unit: "ขีด", quantity: 2, transactionType: "คืน", unitPrice: null }),
      ],
      priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 50 }]),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      normalizedUnit: "โล",
      withdrawnQuantity: 0.6,
      goodReturnQuantity: 0.2,
      soldQuantity: 0.4,
      expectedSales: 20,
    });
  });

  test("kg and pieces remain incompatible even though both are recognized units", () => {
    const items = calculateWhiteSheetItems([
      transaction({ quantity: 1, unit: "โล", unitPrice: 100 }),
      transaction({ quantity: 1, unit: "ชิ้น", unitPrice: 50 }),
    ]);

    expect(items).toHaveLength(2);
  });

  test("does not weaken negative sold-quantity validation across compatible units", () => {
    const source = [
      transaction({ quantity: 1, unit: "โล", unitPrice: 100 }),
      // 20 ขีด = 2 โล — more than the 1 โล withdrawn, so this must still
      // fail closed instead of being silently absorbed by conversion.
      transaction({ quantity: 20, unit: "ขีด", transactionType: "คืน", unitPrice: null }),
    ];

    expect(() => calculateWhiteSheetItems(source)).toThrow(WhiteSheetValidationError);
  });

  test("fails closed when returns make sold quantity negative", () => {
    const source = [
      transaction({ quantity: 1, unitPrice: 10 }),
      transaction({ quantity: 1.001, transactionType: "คืน", unitPrice: null }),
    ];

    expect(() => calculateWhiteSheetItems(source)).toThrow(WhiteSheetValidationError);
    try {
      calculateWhiteSheetItems(source);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WhiteSheetValidationError);
      expect((error as WhiteSheetValidationError).issues[0]?.code).toBe("negative_sold_quantity");
    }
  });

  test("BR-01: conflicting withdrawal-lot prices no longer affect expected sales — the central price is the sole deterministic source", () => {
    const result = calculateDigitalWhiteSheet(input({
      transactions: [
        transaction({ quantity: 2, unitPrice: 10 }),
        transaction({ quantity: 3, unitPrice: 20 }),
        transaction({ quantity: 1, transactionType: "คืน", unitPrice: null }),
      ],
      centralPrices: priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 15 }]),
      actualCashSubmitted: 60,
    }));

    expect(result.items[0]).toMatchObject({
      soldQuantity: 4,
      withdrawalUnitPrices: [10, 20],
      expectedSales: 60,
    });
    expect(result.expectedSales).toBe(60);
    expect(result.warnings).toContain(
      "Withdrawal lot prices varied for ผักกาดขาว (โล): 10.00, 20.00 — central price used for expected sales instead.",
    );
  });

  test("BR-01: missing central price fails closed with a precise product/unit/date warning, never a guessed price", () => {
    const items = calculateWhiteSheetItems([transaction({ quantity: 10 })], new Map());

    expect(items[0]?.expectedSales).toBe(0);
  });
});

describe("calculateDigitalWhiteSheet", () => {
  test("missing central price produces a precise HARD-STOP-classified warning at the summary level", () => {
    const result = calculateDigitalWhiteSheet(input({ centralPrices: new Map() }));

    expect(result.expectedSales).toBe(0);
    expect(result.warnings).toContain("ไม่พบราคากลางสำหรับ ผักกาดขาว (โล) วันที่ 2026-07-23");
  });

  test("warns about uncategorized products without excluding them", () => {
    const result = calculateDigitalWhiteSheet(input({
      transactions: [transaction({ productName: "ปลาทูเค็ม", quantity: 2, unitPrice: 30 })],
      centralPrices: priceMap([{ product: "ปลาทูเค็ม", unit: "โล", priceBaht: 30 }]),
      actualCashSubmitted: 60,
    }));

    expect(result.expectedSales).toBe(60);
    expect(result.items[0]?.category).toBe("uncategorized");
    expect(result.warnings).toEqual(["Uncategorized product: ปลาทูเค็ม (โล)"]);
  });

  test("calculates expense total and expected cash", () => {
    const result = calculateDigitalWhiteSheet(input({
      transactions: [transaction({ quantity: 10, unitPrice: 10 })],
      centralPrices: priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 10 }]),
      verifiedTransfers: 20,
      expenses: expenses({ labor: 2, locationFee: 3, bag: 1, snack: 1, other: 3 }),
      actualCashSubmitted: 70,
    }));

    expect(result.expenseTotal).toBe(10);
    expect(result.expectedCash).toBe(70);
  });

  for (const scenario of [
    { name: "shortage", actualCashSubmitted: 60, difference: -10 },
    { name: "matched", actualCashSubmitted: 70, difference: 0 },
    { name: "overage", actualCashSubmitted: 75, difference: 5 },
  ] as const) {
    test(`reports ${scenario.name}`, () => {
      const result = calculateDigitalWhiteSheet(input({
        transactions: [transaction({ quantity: 10, unitPrice: 10 })],
        centralPrices: priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 10 }]),
        verifiedTransfers: 20,
        expenses: expenses({ labor: 10 }),
        actualCashSubmitted: scenario.actualCashSubmitted,
      }));

      expect(result.expectedCash).toBe(70);
      expect(result.difference).toBe(scenario.difference);
      expect(result.status).toBe(scenario.name);
    });
  }

  test("rounds monetary boundaries in integer satang without float drift", () => {
    const result = calculateDigitalWhiteSheet(input({
      transactions: [
        transaction({ quantity: 0.1, unitPrice: 0.1 }),
        transaction({ quantity: 0.2, unitPrice: 0.1 }),
      ],
      centralPrices: priceMap([{ product: "ผักกาดขาว", unit: "โล", priceBaht: 0.1 }]),
      verifiedTransfers: 0,
      expenses: expenses({ other: 0.1 + 0.2 }),
      actualCashSubmitted: 0,
    }));

    expect(result.expectedSales).toBe(0.03);
    expect(result.expenses.other).toBe(0.3);
    expect(result.expenseTotal).toBe(0.3);
    expect(result.expectedCash).toBe(-0.27);
    expect(result.difference).toBe(0.27);
    expect(result.status).toBe("overage");
  });

  test("does not mutate input arrays or source records", () => {
    const transactions = [
      Object.freeze(transaction({ quantity: 3, unitPrice: 10 })),
      Object.freeze(transaction({ quantity: 1, transactionType: "คืน", unitPrice: null })),
    ] as const;
    const expenseInput = Object.freeze(expenses({ other: 5, otherNote: "parking" }));
    const source = Object.freeze(input({
      transactions: Object.freeze(transactions),
      expenses: expenseInput,
      actualCashSubmitted: 15,
    }));
    const before = JSON.parse(JSON.stringify({ ...source, centralPrices: undefined }));

    calculateDigitalWhiteSheet(source);

    expect({ ...source, centralPrices: undefined }).toEqual(before);
  });
});
