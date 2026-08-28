import { isSoldOutByAbsentReturn, type SalesReport } from "@/lib/sales/calculate";
import type {
  PurchasePlanningReport,
  PurchaseStatus,
} from "@/lib/summary/purchase-planning";

export const MORNING_BRIEF_NAME_LIMIT = 10;

export interface MorningBriefPurchaseGroup {
  count: number;
  productNames: string[];
}

export type MorningBriefPurchasePlanning = Record<
  PurchaseStatus,
  MorningBriefPurchaseGroup
>;

/** Tally existing classifications and retain only bounded actionable names. */
export function summarizePurchasePlanning(
  report: Pick<PurchasePlanningReport, "items">,
): MorningBriefPurchasePlanning {
  const summary: MorningBriefPurchasePlanning = {
    strong: { count: 0, productNames: [] },
    surplus: { count: 0, productNames: [] },
    reduce: { count: 0, productNames: [] },
    unknown: { count: 0, productNames: [] },
  };

  for (const item of report.items) {
    const group = summary[item.status];
    group.count += 1;
    if (item.status !== "unknown" && group.productNames.length < MORNING_BRIEF_NAME_LIMIT) {
      group.productNames.push(item.productName);
    }
  }

  return summary;
}

export interface MorningBriefSales {
  confirmedSalesSatang: number;
  valueAuthoritative: boolean;
  trustedCount: number;
  unresolvedCount: number;
  soldOutCount: number;
  priceConflictCount: number;
  priceConflictMarketCount: number;
}

/** Read headline facts from SalesReport; never recalculate sales or sold-out rules. */
export function summarizeSales(report: SalesReport): MorningBriefSales {
  let soldOutCount = 0;
  let priceConflictCount = 0;
  const conflictMarkets = new Set<string>();

  for (const market of report.markets) {
    for (const row of market.rows) {
      if (isSoldOutByAbsentReturn(row)) soldOutCount += 1;
      if (row.reasons.includes("central_price_conflict")) {
        priceConflictCount += 1;
        conflictMarkets.add(row.marketKey);
      }
    }
  }

  return {
    confirmedSalesSatang: report.allMarkets.expectedSalesSatang,
    valueAuthoritative: report.allMarkets.valueAuthoritative,
    trustedCount: report.allMarkets.trustedRowCount,
    unresolvedCount:
      report.allMarkets.valueBlockedRowCount + report.allMarkets.quantityBlockedRowCount,
    soldOutCount,
    priceConflictCount,
    priceConflictMarketCount: conflictMarkets.size,
  };
}

export type MorningBriefHouseStock =
  | { status: "available"; groupCount: number; totalValueSatang: number }
  | { status: "missing" }
  | { status: "unavailable" };

export interface MorningBriefReport {
  businessDate: string;
  purchasePlanning: MorningBriefPurchasePlanning;
  sales: MorningBriefSales;
  houseStock: MorningBriefHouseStock;
}
