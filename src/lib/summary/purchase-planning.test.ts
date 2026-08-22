import { describe, expect, test } from "bun:test";
import type { RoundReturnState } from "@/lib/produce/round-return-status";
import {
  buildPurchasePlanningReport,
  canonicalIdentity,
  HIGH_SELL_THROUGH_MIN_PERCENT,
  LOW_NEXT_DAY_STOCK_TO_SOLD_RATIO_MAX,
  MEDIUM_SELL_THROUGH_MIN_PERCENT,
  type HouseStockEntry,
  type HouseStockSignal,
  type PurchasePlanningInput,
  type PurchasePlanningItem,
  type PurchasePlanningReport,
  type PurchaseProduceRow,
} from "./purchase-planning";

const DATE = "2026-08-21";
const ROUND_A = "11111111-1111-4111-8111-111111111111";
const ROUND_B = "22222222-2222-4222-8222-222222222222";

const WITHDRAW = "เบิก";
const RETURN = "คืน";
const DAMAGED = "คืนเสีย";

function row(overrides: Partial<PurchaseProduceRow> = {}): PurchaseProduceRow {
  return {
    market_name: "ตลาด72",
    product_name: "แอปเปิ้ล",
    quantity: 1,
    unit: "ลูก",
    transaction_type: WITHDRAW,
    price_per_unit: 20,
    accountability_round_id: ROUND_A,
    ...overrides,
  };
}

/** Every round a row mentions is "persisted" unless the test says otherwise. */
function defaultRoundStates(rows: readonly PurchaseProduceRow[]): Map<string, RoundReturnState> {
  const states = new Map<string, RoundReturnState>();
  for (const r of rows) {
    if (r.accountability_round_id) states.set(r.accountability_round_id, "persisted");
  }
  return states;
}

function build(
  rows: readonly PurchaseProduceRow[],
  options: Partial<Omit<PurchasePlanningInput, "businessDate" | "rows">> = {},
): PurchasePlanningReport {
  return buildPurchasePlanningReport({
    businessDate: DATE,
    rows,
    roundReturnStates: options.roundReturnStates ?? defaultRoundStates(rows),
    incompleteReturnRounds: options.incompleteReturnRounds,
    unreliableSessionIds: options.unreliableSessionIds,
    hasUnattributedIncompleteReturns: options.hasUnattributedIncompleteReturns,
    unresolvedSessionCount: options.unresolvedSessionCount,
    houseStock: options.houseStock,
  });
}

function only(report: PurchasePlanningReport): PurchasePlanningItem {
  expect(report.items).toHaveLength(1);
  return report.items[0]!;
}

function stock(...entries: HouseStockEntry[]): HouseStockSignal {
  return { status: "available", entries };
}

/** withdraw / good / damaged for one product+unit, all inside one round. */
function cell(
  withdrawn: number,
  good: number,
  damaged: number,
  overrides: Partial<PurchaseProduceRow> = {},
): PurchaseProduceRow[] {
  const rows = [row({ ...overrides, transaction_type: WITHDRAW, quantity: withdrawn })];
  rows.push(row({ ...overrides, transaction_type: RETURN, quantity: good }));
  if (damaged > 0) {
    rows.push(row({ ...overrides, transaction_type: DAMAGED, quantity: damaged }));
  }
  return rows;
}

describe("purchase planning — sell-through bands", () => {
  test("case 1 — low sell-through is 🔴 ควรลดการซื้อ", () => {
    const item = only(build(cell(100, 75, 5)));
    expect(item.estimatedSoldQuantity).toBe(20);
    expect(item.sellThroughRate).toBe(20);
    expect(item.band).toBe("low");
    expect(item.status).toBe("reduce");
  });

  test("case 2 — exactly 40% is 🟠, not 🔴", () => {
    const item = only(build(cell(100, 55, 5)));
    expect(item.estimatedSoldQuantity).toBe(40);
    expect(item.sellThroughRate).toBe(MEDIUM_SELL_THROUGH_MIN_PERCENT);
    expect(item.band).toBe("medium");
    expect(item.status).toBe("surplus");
  });

  test("case 3 — exactly 70% with little next-day good stock is 🟢", () => {
    // sold 70, house 3 + good return 30 = 33 ready → 0.471 ratio.
    const item = only(build(cell(100, 30, 0), {
      houseStock: stock({ productName: "แอปเปิ้ล", unit: "ลูก", quantity: 3 }),
    }));
    expect(item.sellThroughRate).toBe(HIGH_SELL_THROUGH_MIN_PERCENT);
    expect(item.band).toBe("high");
    expect(item.status).toBe("strong");
  });

  test("case 12 — damaged return reduces the estimated sold quantity", () => {
    const withDamage = only(build(cell(100, 20, 30)));
    const withoutDamage = only(build(cell(100, 20, 0)));
    expect(withDamage.damagedQuantity).toBe(30);
    expect(withDamage.estimatedSoldQuantity).toBe(50);
    expect(withoutDamage.estimatedSoldQuantity).toBe(80);
  });
});

describe("purchase planning — house-stock modifier", () => {
  test("case 4 — high sell-through at exactly the low-stock ratio is 🟢", () => {
    // sold 80; house 20 + good return 20 = 40 ready → ratio 0.5, the inclusive
    // boundary.
    const item = only(build(cell(100, 20, 0), {
      houseStock: stock({ productName: "แอปเปิ้ล", unit: "ลูก", quantity: 20 }),
    }));
    expect(item.nextDayGoodStockQuantity).toBe(40);
    expect(item.nextStockToSoldRatio).toBe(LOW_NEXT_DAY_STOCK_TO_SOLD_RATIO_MAX);
    expect(item.status).toBe("strong");
  });

  test("case 5 + 24 — high sell-through with a large house stock is never 🟢", () => {
    const item = only(build(cell(100, 20, 0), {
      houseStock: stock({ productName: "แอปเปิ้ล", unit: "ลูก", quantity: 400 }),
    }));
    expect(item.band).toBe("high");
    expect(item.nextDayGoodStockQuantity).toBe(420);
    expect(item.nextStockToSoldRatio).toBe(5.25);
    expect(item.status).toBe("surplus");
  });

  test("case 6 — high sell-through with no usable house stock stays conservative", () => {
    const item = only(build(cell(100, 20, 0), { houseStock: { status: "none" } }));
    expect(item.band).toBe("high");
    expect(item.nextStockToSoldRatio).toBeNull();
    expect(item.status).toBe("surplus");
    expect(item.stockAbsence).toBe("no_snapshot");
  });

  test("case 7 — medium sell-through stays 🟠 however small the house stock is", () => {
    const item = only(build(cell(100, 50, 0), {
      houseStock: stock({ productName: "แอปเปิ้ล", unit: "ลูก", quantity: 0 }),
    }));
    expect(item.band).toBe("medium");
    expect(item.houseStockQuantity).toBe(0);
    expect(item.nextDayGoodStockQuantity).toBe(50);
    expect(item.status).toBe("surplus");
  });

  test("case 8 — low sell-through is 🔴 even with no stock evidence", () => {
    const item = only(build(cell(100, 80, 0), { houseStock: { status: "none" } }));
    expect(item.band).toBe("low");
    expect(item.status).toBe("reduce");
  });

  test("case 18 — house stock matches only through the same canonical identity", () => {
    // หมอน is an explicit PRODUCT_ALIASES entry for หมอนทอง, and กก. normalizes
    // onto the stored โล — both sides go through one canonicalization.
    const item = only(build(cell(100, 20, 0, { product_name: "หมอนทอง", unit: "โล" }), {
      houseStock: stock({ productName: "หมอน", unit: "กก.", quantity: 5 }),
    }));
    expect(item.productName).toBe("หมอนทอง");
    expect(item.unit).toBe("โล");
    expect(item.houseStockQuantity).toBe(5);
    expect(item.nextDayGoodStockQuantity).toBe(25);
    expect(item.status).toBe("strong");
  });

  test("case 19 — a house unit that is not the market unit is never combined", () => {
    const item = only(build(cell(100, 20, 0, { unit: "ลูก" }), {
      houseStock: stock({ productName: "แอปเปิ้ล", unit: "ถุง", quantity: 40 }),
    }));
    expect(item.houseStockQuantity).toBeNull();
    expect(item.nextDayGoodStockQuantity).toBeNull();
    expect(item.stockAbsence).toBe("no_match");
    expect(item.status).toBe("surplus");
  });

  test("case 20 — the house count and the good return ADD UP to next-day stock", () => {
    // The house was counted after dispatch and before any return arrived, so
    // these are disjoint quantities of one product.
    const rows = [
      row({ transaction_type: WITHDRAW, quantity: 89, price_per_unit: 5 }),
      row({ transaction_type: WITHDRAW, quantity: 145, price_per_unit: 5 }),
      row({ transaction_type: RETURN, quantity: 134 }),
      row({ transaction_type: DAMAGED, quantity: 5 }),
    ];
    const item = only(build(rows, {
      houseStock: stock({ productName: "แอปเปิ้ล", unit: "ลูก", quantity: 80 }),
    }));

    expect(item.houseStockQuantity).toBe(80);
    expect(item.goodReturnQuantity).toBe(134);
    expect(item.nextDayGoodStockQuantity).toBe(214);
    // Damaged return is NOT sellable stock: neither added nor subtracted.
    expect(item.damagedQuantity).toBe(5);
    expect(item.nextDayGoodStockQuantity).not.toBe(219);
    expect(item.nextDayGoodStockQuantity).not.toBe(209);
    // The sold quantity is still purely market arithmetic.
    expect(item.estimatedSoldQuantity).toBe(95);
    expect(item.status).toBe("surplus");
  });

  test("adding a house count never changes the estimated sold quantity", () => {
    const houseStock = stock({ productName: "แอปเปิ้ล", unit: "ลูก", quantity: 60 });
    const withStock = only(build(cell(100, 20, 0), { houseStock }));
    const withoutStock = only(build(cell(100, 20, 0), { houseStock: { status: "none" } }));

    expect(withStock.estimatedSoldQuantity).toBe(80);
    expect(withStock.estimatedSoldQuantity).toBe(withoutStock.estimatedSoldQuantity);
    expect(withStock.goodReturnQuantity).toBe(withoutStock.goodReturnQuantity);
    expect(withStock.sellThroughRate).toBe(withoutStock.sellThroughRate);
    // Only the forward-looking stock figure differs.
    expect(withStock.nextDayGoodStockQuantity).toBe(80);
    expect(withoutStock.nextDayGoodStockQuantity).toBeNull();
  });

  test("the mango case: 45.9 out, 35.4 back, 20 at home", () => {
    const rows = [
      row({ product_name: "มะม่วงจิ้ว", unit: "โล", transaction_type: WITHDRAW, quantity: 45.9 }),
      row({ product_name: "มะม่วงจิ้ว", unit: "โล", transaction_type: RETURN, quantity: 35.4 }),
    ];
    const item = only(build(rows, {
      houseStock: stock({ productName: "มะม่วงจิ้ว", unit: "กก.", quantity: 20 }),
    }));

    expect(item.estimatedSoldQuantity).toBe(10.5);
    expect(item.sellThroughRate).toBeCloseTo(22.876, 3);
    expect(item.nextDayGoodStockQuantity).toBe(55.4);
    expect(item.status).toBe("reduce");
  });

  test("no safe house match yields no next-day stock figure at all", () => {
    const item = only(build(cell(100, 20, 0), { houseStock: { status: "none" } }));
    // The good return alone is not the whole of what is left, so it must not be
    // presented as the next-day stock.
    expect(item.goodReturnQuantity).toBe(20);
    expect(item.nextDayGoodStockQuantity).toBeNull();
    expect(item.nextStockToSoldRatio).toBeNull();
    expect(item.status).toBe("surplus");
  });

  test("case 21 — zero snapshots still produces a market report", () => {
    const report = build(cell(100, 80, 0), { houseStock: { status: "none" } });
    expect(report.stockAbsence).toBe("no_snapshot");
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.status).toBe("reduce");
  });

  test("case 22 — duplicate authoritative snapshots invent no stock", () => {
    const report = build(cell(100, 20, 0), { houseStock: { status: "conflict" } });
    const item = only(report);
    expect(report.stockAbsence).toBe("snapshot_conflict");
    expect(item.houseStockQuantity).toBeNull();
    expect(item.nextStockToSoldRatio).toBeNull();
    expect(item.status).toBe("surplus");
  });

  test("an unreadable snapshot degrades the signal, not the report", () => {
    const report = build(cell(100, 20, 0), { houseStock: { status: "unavailable" } });
    expect(report.stockAbsence).toBe("unavailable");
    expect(only(report).status).toBe("surplus");
  });

  test("a complete snapshot with the product wholly absent is house stock zero", () => {
    const item = only(build(cell(34, 10, 0, { product_name: "สับปะรด", unit: "ถุง" }), {
      houseStock: stock({ productName: "ลูกพลับ", unit: "ลูก", quantity: 230 }),
    }));
    expect(item.houseStockQuantity).toBe(0);
    expect(item.nextDayGoodStockQuantity).toBe(10);
    expect(item.stockAbsence).toBeNull();
  });

  test("pineapple: complete-snapshot absence at 70.6% is 🟢", () => {
    const item = only(build(cell(34, 10, 0, { product_name: "สับปะรด", unit: "ถุง" }), {
      houseStock: stock(
        { productName: "ลูกพลับ", unit: "ลูก", quantity: 230 },
        { productName: "สาลี่", unit: "ลูก", quantity: 216 },
        { productName: "ลูกไหนดำ", unit: "โล", quantity: 25 },
        { productName: "มังคุด", unit: "โล", quantity: 45 },
      ),
    }));
    expect(item.estimatedSoldQuantity).toBe(24);
    expect(item.sellThroughRate).toBeCloseTo(70.588, 3);
    expect(item.band).toBe("high");
    expect(item.houseStockQuantity).toBe(0);
    expect(item.nextDayGoodStockQuantity).toBe(10);
    expect(item.nextStockToSoldRatio).toBeCloseTo(10 / 24, 6);
    expect(item.status).toBe("strong");
  });

  test("the same product in an incompatible house unit is never zero", () => {
    const item = only(build(cell(100, 20, 0, { product_name: "สินค้า X", unit: "โล" }), {
      houseStock: stock({ productName: "สินค้า X", unit: "ลูก", quantity: 40 }),
    }));
    expect(item.houseStockQuantity).toBeNull();
    expect(item.nextDayGoodStockQuantity).toBeNull();
    expect(item.stockAbsence).toBe("no_match");
    expect(item.status).toBe("surplus");
  });

  test("a valid empty complete snapshot is zero for every market product", () => {
    const item = only(build(cell(34, 10, 0, { product_name: "สับปะรด", unit: "ถุง" }), {
      houseStock: { status: "empty" },
    }));
    expect(item.houseStockQuantity).toBe(0);
    expect(item.nextDayGoodStockQuantity).toBe(10);
    expect(item.status).toBe("strong");
  });

  test("MEDIUM stays 🟠 when the complete snapshot simply has none of it", () => {
    const rows = [
      row({ transaction_type: WITHDRAW, quantity: 89 }),
      row({ transaction_type: WITHDRAW, quantity: 145 }),
      row({ transaction_type: RETURN, quantity: 134 }),
      row({ transaction_type: DAMAGED, quantity: 5 }),
    ];
    const item = only(build(rows, {
      houseStock: stock({ productName: "ลูกพลับ", unit: "ลูก", quantity: 230 }),
    }));
    expect(item.sellThroughRate).toBeCloseTo(40.598, 3);
    expect(item.houseStockQuantity).toBe(0);
    expect(item.nextDayGoodStockQuantity).toBe(134);
    expect(item.status).toBe("surplus");
  });

  test("house-zero on a complete snapshot cannot rescue incomplete market evidence", () => {
    const item = only(build(
      cell(34, 10, 0, { product_name: "สับปะรด", unit: "ถุง", session_id: "broken" }),
      {
        houseStock: stock({ productName: "ลูกพลับ", unit: "ลูก", quantity: 230 }),
        unreliableSessionIds: new Set(["broken"]),
      },
    ));
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("session_integrity");
    expect(item.houseStockQuantity).toBe(0);
    expect(item.estimatedSoldQuantity).toBeNull();
  });
});

describe("purchase planning — price never touches the quantity signal", () => {
  test("case 9 + 23 — conflicting withdrawal prices still rank on quantity", () => {
    const rows: PurchaseProduceRow[] = [
      row({ transaction_type: WITHDRAW, quantity: 89, price_per_unit: 5 }),
      row({ transaction_type: WITHDRAW, quantity: 145, price_per_unit: 35 }),
      row({ transaction_type: RETURN, quantity: 134, price_per_unit: 10 }),
      row({ transaction_type: DAMAGED, quantity: 5, price_per_unit: 30 }),
    ];
    const item = only(build(rows, {
      houseStock: stock({ productName: "แอปเปิ้ล", unit: "ลูก", quantity: 80 }),
    }));

    expect(item.withdrawnQuantity).toBe(234);
    expect(item.estimatedSoldQuantity).toBe(95);
    expect(item.sellThroughRate).toBeCloseTo(40.598, 3);
    expect(item.band).toBe("medium");
    expect(item.status).toBe("surplus");
    expect(item.priceConflict).toBe(true);
    expect(item.houseStockQuantity).toBe(80);
  });

  test("one withdrawal price is not a conflict", () => {
    expect(only(build(cell(100, 20, 0))).priceConflict).toBe(false);
  });
});

describe("purchase planning — aggregation identity", () => {
  test("case 10 — the same product and unit aggregates across markets and rounds", () => {
    const marketRows = (
      market: string,
      round: string,
      withdrawn: number,
      good: number,
      damaged: number,
    ): PurchaseProduceRow[] => cell(withdrawn, good, damaged, {
      market_name: market,
      accountability_round_id: round,
    });

    const rows = [
      ...marketRows("ตลาด72", ROUND_A, 89, 47, 1),
      ...marketRows("ราชพฤก", ROUND_B, 145, 87, 4),
    ];
    const item = only(build(rows));

    expect(item.withdrawnQuantity).toBe(234);
    expect(item.goodReturnQuantity).toBe(134);
    expect(item.damagedQuantity).toBe(5);
    expect(item.estimatedSoldQuantity).toBe(95);
    expect(item.sellThroughRate).toBeCloseTo(40.598, 3);
  });

  test("case 11 — the same product in different units stays on separate rows", () => {
    const rows = [
      ...cell(100, 20, 0, { unit: "ลูก" }),
      ...cell(50, 40, 0, { unit: "โล", accountability_round_id: ROUND_B }),
    ];
    const report = build(rows);
    expect(report.items).toHaveLength(2);
    expect(report.items.map((i) => [i.unit, i.withdrawnQuantity])).toEqual([
      ["โล", 50],
      ["ลูก", 100],
    ]);
  });

  test("QA market scopes never reach the ranking", () => {
    const report = build(cell(100, 20, 0, { market_name: "ทดสอบ" }));
    expect(report.items).toHaveLength(0);
  });

  test("a row with no usable identity is counted, not silently dropped", () => {
    const report = build([row({ unit: null }), row({ product_name: "  " })]);
    expect(report.items).toHaveLength(0);
    expect(report.unidentifiedRowCount).toBe(2);
  });

  test("canonicalIdentity refuses an empty product or unit", () => {
    expect(canonicalIdentity("", "ลูก")).toBeNull();
    expect(canonicalIdentity("แอปเปิ้ล", null)).toBeNull();
    expect(canonicalIdentity("แอปเปิ้ล", "กก.")).toEqual({
      productName: "แอปเปิ้ล",
      unit: "โล",
    });
  });
});

describe("purchase planning — quantity integrity never guesses", () => {
  test("case 13 — returns exceeding the withdrawal are not clamped", () => {
    const item = only(build(cell(100, 96, 10)));
    expect(item.estimatedSoldQuantity).toBeNull();
    expect(item.sellThroughRate).toBeNull();
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("returns_exceed_withdrawal");
  });

  test("case 14 — a return with no withdrawal never divides by zero", () => {
    const item = only(build([row({ transaction_type: RETURN, quantity: 12 })]));
    expect(item.withdrawnQuantity).toBe(0);
    expect(item.estimatedSoldQuantity).toBeNull();
    expect(item.sellThroughRate).toBeNull();
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("no_withdrawal");
  });

  test("a null quantity blocks the product instead of counting as zero", () => {
    const rows = [...cell(100, 20, 0), row({ transaction_type: WITHDRAW, quantity: null })];
    const item = only(build(rows));
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("invalid_quantity");
  });

  test("an unknown transaction type blocks the product instead of vanishing", () => {
    const rows = [...cell(100, 20, 0), row({ transaction_type: "โอนเงิน", quantity: 5 })];
    const item = only(build(rows));
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("unknown_transaction_type");
  });

  test("the legacy เสีย spelling and the ...เพิ่ม marker rows are counted", () => {
    const rows = [
      row({ transaction_type: WITHDRAW, quantity: 100 }),
      row({ transaction_type: "ชั่งคืนเพิ่ม", quantity: 20 }),
      row({ transaction_type: "เสีย", quantity: 5 }),
    ];
    const item = only(build(rows));
    expect(item.goodReturnQuantity).toBe(20);
    expect(item.damagedQuantity).toBe(5);
    expect(item.estimatedSoldQuantity).toBe(75);
  });
});

describe("purchase planning — missing and incomplete return evidence", () => {
  test("case 15 — a withdrawal with no return for that product is never 100% sold", () => {
    // The round's return document landed (state "persisted") but covers a
    // different product. P4A never proves coverage, so this is no evidence.
    const rows = [
      row({ transaction_type: WITHDRAW, quantity: 100 }),
      row({ product_name: "ส้มไต้หวัน", unit: "โล", transaction_type: WITHDRAW, quantity: 10 }),
      row({ product_name: "ส้มไต้หวัน", unit: "โล", transaction_type: RETURN, quantity: 2 }),
    ];
    const report = build(rows);
    const apple = report.items.find((i) => i.productName === "แอปเปิ้ล")!;

    expect(apple.sellThroughRate).toBeNull();
    expect(apple.estimatedSoldQuantity).toBeNull();
    expect(apple.status).toBe("unknown");
    expect(apple.uncertaintyReasons).toContain("product_return_absent");
  });

  test("a round with no return evidence at all is not a confident sell-out", () => {
    const rows = cell(100, 20, 0);
    const item = only(build(rows, {
      roundReturnStates: new Map<string, RoundReturnState>([[ROUND_A, "none"]]),
    }));
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("return_missing");
  });

  test("case 16 — a blocked or pending return makes its own product uncertain", () => {
    for (const state of ["blocked", "pending"] as const) {
      const item = only(build(cell(100, 20, 0), {
        roundReturnStates: new Map<string, RoundReturnState>([[ROUND_A, state]]),
      }));
      expect(item.status).toBe("unknown");
      expect(item.uncertaintyReasons).toContain("return_incomplete");
    }
  });

  test("a still-failing return attempt on the round makes its product uncertain", () => {
    const item = only(build(cell(100, 20, 0), {
      incompleteReturnRounds: new Set([ROUND_A]),
    }));
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("return_incomplete");
  });

  test("a withdrawal with no accountability round cannot be proven complete", () => {
    const item = only(build(cell(100, 20, 0, { accountability_round_id: null })));
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("unattributed_round");
  });

  test("case 17 — an unrelated unresolved session keeps valid products ranked", () => {
    const rows = [
      ...cell(100, 80, 0),
      ...cell(50, 5, 0, { product_name: "ส้มไต้หวัน", unit: "โล", accountability_round_id: ROUND_B }),
    ];
    const report = build(rows, {
      unresolvedSessionCount: 15,
      houseStock: stock({ productName: "ส้มไต้หวัน", unit: "โล", quantity: 2 }),
    });

    expect(report.unresolvedSessionCount).toBe(15);
    expect(report.items.map((i) => [i.productName, i.status])).toEqual([
      ["แอปเปิ้ล", "reduce"],
      ["ส้มไต้หวัน", "strong"],
    ]);
  });
});

describe("purchase planning — threshold exactness on real decimals", () => {
  test("a day that is exactly 70% is 🟢, not one band worse", () => {
    // 35.44 + 43.73 out, 23.751 back → 55.419 sold → exactly 70.000000%,
    // but 69.99999999999999 in IEEE-754.
    const rows = [
      row({ transaction_type: WITHDRAW, quantity: 35.44, unit: "โล" }),
      row({ transaction_type: WITHDRAW, quantity: 43.73, unit: "โล" }),
      row({ transaction_type: RETURN, quantity: 23.751, unit: "โล" }),
    ];
    const item = only(build(rows, {
      houseStock: stock({ productName: "แอปเปิ้ล", unit: "โล", quantity: 1 }),
    }));

    expect(item.withdrawnQuantity).toBe(79.17);
    expect(item.estimatedSoldQuantity).toBe(55.419);
    expect(item.band).toBe("high");
    expect(item.status).toBe("strong");
  });

  test("a day that is exactly 40% is 🟠, not 🔴", () => {
    // 13.065 + 96.46 out, 65.715 back → 43.81 sold → exactly 40%.
    const rows = [
      row({ transaction_type: WITHDRAW, quantity: 13.065, unit: "โล" }),
      row({ transaction_type: WITHDRAW, quantity: 96.46, unit: "โล" }),
      row({ transaction_type: RETURN, quantity: 65.715, unit: "โล" }),
    ];
    const item = only(build(rows));

    expect(item.estimatedSoldQuantity).toBe(43.81);
    expect(item.band).toBe("medium");
    expect(item.status).toBe("surplus");
  });

  test("quantities are carried at the column's own 3-decimal resolution", () => {
    const item = only(build([
      row({ transaction_type: WITHDRAW, quantity: 45.9, unit: "โล" }),
      row({ transaction_type: RETURN, quantity: 35.4, unit: "โล" }),
    ]));
    // 45.9 - 35.4 is 10.499999999999996 in raw float.
    expect(item.estimatedSoldQuantity).toBe(10.5);
  });

  test("case 8 boundary — a fully returned product is 0%, never a negative", () => {
    const item = only(build(cell(100, 100, 0)));
    expect(item.estimatedSoldQuantity).toBe(0);
    expect(item.sellThroughRate).toBe(0);
    expect(item.status).toBe("reduce");
    // No ratio when nothing sold: dividing by zero sold would be meaningless.
    expect(item.nextStockToSoldRatio).toBeNull();
  });
});

describe("purchase planning — evidence that only inflates the sold quantity", () => {
  test("an untagged return is not reported as a missing return", () => {
    const rows = [
      row({ transaction_type: WITHDRAW, quantity: 100 }),
      row({ transaction_type: RETURN, quantity: 20, accountability_round_id: null }),
    ];
    const item = only(build(rows, {
      roundReturnStates: new Map<string, RoundReturnState>([[ROUND_A, "persisted"]]),
    }));

    expect(item.goodReturnQuantity).toBe(20);
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("return_not_round_tagged");
    expect(item.uncertaintyReasons).not.toContain("product_return_absent");
  });

  test("a session that read incompletely blocks its own products", () => {
    const rows = cell(100, 20, 0, { session_id: "session-broken" });
    const item = only(build(rows, {
      unreliableSessionIds: new Set(["session-broken"]),
    }));
    expect(item.status).toBe("unknown");
    expect(item.uncertaintyReasons).toContain("session_integrity");
  });

  test("an unattributable failed return document forbids a confident 🟢", () => {
    const houseStock = stock({ productName: "แอปเปิ้ล", unit: "ลูก", quantity: 1 });
    const clean = only(build(cell(100, 20, 0), { houseStock }));
    const contaminated = only(build(cell(100, 20, 0), {
      houseStock,
      hasUnattributedIncompleteReturns: true,
    }));

    expect(clean.status).toBe("strong");
    // Same numbers, but a return that never landed can only mean MORE came back.
    expect(contaminated.band).toBe("high");
    expect(contaminated.status).toBe("surplus");
  });

  test("an unattributable failed return does not rescue a weak seller", () => {
    const item = only(build(cell(100, 80, 0), {
      hasUnattributedIncompleteReturns: true,
    }));
    // An inflated sold quantity can only make a weak seller look better, so a
    // "buy less" reading stays the safe one.
    expect(item.status).toBe("reduce");
  });
});

describe("purchase planning — report ordering", () => {
  test("groups run 🔴 then 🟠 then 🟢 then ⚠️, deterministically within each", () => {
    const rows = [
      // 🔴 20%
      ...cell(100, 80, 0, { product_name: "มะม่วงจิ้ว", unit: "โล" }),
      // 🔴 10% — the weaker seller must lead
      ...cell(100, 90, 0, {
        product_name: "ลูกพลับ",
        unit: "ลูก",
        accountability_round_id: ROUND_B,
      }),
      // 🟢 90% with almost nothing left at home
      ...cell(100, 10, 0, {
        product_name: "ส้มไต้หวัน",
        unit: "โล",
        accountability_round_id: ROUND_B,
      }),
      // ⚠️ no withdrawal
      row({ product_name: "ทุเรียน", unit: "ลูก", transaction_type: RETURN, quantity: 3 }),
    ];
    const report = build(rows, {
      houseStock: stock({ productName: "ส้มไต้หวัน", unit: "โล", quantity: 1 }),
    });

    expect(report.items.map((i) => [i.productName, i.status])).toEqual([
      ["ลูกพลับ", "reduce"],
      ["มะม่วงจิ้ว", "reduce"],
      ["ส้มไต้หวัน", "strong"],
      ["ทุเรียน", "unknown"],
    ]);
  });

  test("within 🟠 the weakest seller leads, then the biggest pile at home", () => {
    const rows = [
      ...cell(100, 50, 0, { product_name: "ก", unit: "ลูก" }),
      ...cell(100, 50, 0, { product_name: "ข", unit: "ลูก", accountability_round_id: ROUND_B }),
      ...cell(100, 40, 0, { product_name: "ค", unit: "ลูก", accountability_round_id: ROUND_B }),
    ];
    const report = build(rows, {
      houseStock: stock(
        { productName: "ก", unit: "ลูก", quantity: 10 },
        { productName: "ข", unit: "ลูก", quantity: 90 },
        { productName: "ค", unit: "ลูก", quantity: 5 },
      ),
    });

    expect(report.items.map((i) => i.productName)).toEqual(["ข", "ก", "ค"]);
  });
});
