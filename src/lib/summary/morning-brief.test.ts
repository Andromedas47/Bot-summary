import { describe, expect, test } from "bun:test";
import type { PurchasePlanningItem } from "@/lib/summary/purchase-planning";
import { summarizePurchasePlanningCounts } from "./morning-brief";

function item(status: PurchasePlanningItem["status"]): PurchasePlanningItem {
  return {
    productName: `p-${Math.random()}`,
    unit: "กก.",
    withdrawnQuantity: 1,
    goodReturnQuantity: 0,
    damagedQuantity: 0,
    estimatedSoldQuantity: 1,
    sellThroughRate: 100,
    band: "high",
    status,
    uncertaintyReasons: [],
    houseStockQuantity: null,
    stockAbsence: null,
    nextDayGoodStockQuantity: null,
    nextStockToSoldRatio: null,
    priceConflict: false,
  };
}

describe("summarizePurchasePlanningCounts", () => {
  test("tallies each status from the report's own classification — no recomputation", () => {
    const counts = summarizePurchasePlanningCounts({
      items: [
        item("strong"),
        item("strong"),
        item("surplus"),
        item("reduce"),
        item("reduce"),
        item("reduce"),
        item("unknown"),
      ],
    });
    expect(counts).toEqual({ strong: 2, surplus: 1, reduce: 3, unknown: 1 });
  });

  test("an empty report tallies to all zero", () => {
    expect(summarizePurchasePlanningCounts({ items: [] })).toEqual({
      strong: 0,
      surplus: 0,
      reduce: 0,
      unknown: 0,
    });
  });
});
