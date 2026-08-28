import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { fetchAuthoritativeHouseStockReport } from "@/lib/physical-inventory/house-stock-report";
import { loadSalesReport } from "@/lib/sales/load";
import { loadPurchasePlanningReport } from "@/lib/summary/purchase-planning-service";
import {
  summarizePurchasePlanning,
  summarizeSales,
  type MorningBriefHouseStock,
  type MorningBriefReport,
} from "@/lib/summary/morning-brief";

type Supabase = SupabaseClient<Database>;

async function loadHouseStock(
  supabase: Supabase,
  businessDate: string,
): Promise<MorningBriefHouseStock> {
  try {
    const report = await fetchAuthoritativeHouseStockReport(supabase, businessDate);
    if (!report) return { status: "missing" };
    return {
      status: "available",
      groupCount: report.groupCount,
      totalValueSatang: report.totalValueSatang,
    };
  } catch (error) {
    logger.warn("morning brief house stock unavailable", {
      businessDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "unavailable" };
  }
}

export async function loadMorningBriefReport(
  supabase: Supabase,
  businessDate: string,
): Promise<MorningBriefReport> {
  const [purchasePlanning, sales, houseStock] = await Promise.all([
    loadPurchasePlanningReport(supabase, businessDate),
    loadSalesReport(supabase, businessDate),
    loadHouseStock(supabase, businessDate),
  ]);

  return {
    businessDate,
    purchasePlanning: summarizePurchasePlanning(purchasePlanning),
    sales: summarizeSales(sales),
    houseStock,
  };
}
