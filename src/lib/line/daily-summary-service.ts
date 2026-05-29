import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export class DailySummaryService {
  constructor(private readonly supabase: AnyClient) {}

  async recalculate(
    summaryDate: string,
    staffName:   string,
    marketName:  string | null,
  ): Promise<void> {
    const market = marketName ?? "";
    const log = logger.child({ summaryDate, staffName, marketName: market });

    log.info("daily summary recalculation started");

    const { data: rows, error: fetchErr } = await this.supabase
      .from("produce_transactions")
      .select("transaction_type, total_amount")
      .eq("transaction_date", summaryDate)
      .eq("staff_name", staffName)
      .eq("market_name", market);

    if (fetchErr) {
      log.error("daily summary recalculation failed — fetch error", { error: fetchErr.message });
      return;
    }

    log.info("daily summary recalculation succeeded", { rowCount: rows?.length ?? 0 });

    let borrowTotal    = 0;
    let returnTotal    = 0;
    let badReturnTotal = 0;

    for (const row of rows ?? []) {
      const amount = Number(row.total_amount ?? 0);
      const type   = row.transaction_type as string;

      if (type === "เบิก" || type === "เบิกเพิ่ม") {
        borrowTotal += amount;
      } else if (type === "คืน") {
        returnTotal += amount;
      } else if (type === "คืนเสีย" || type === "เสีย") {
        badReturnTotal += amount;
      }
    }

    const netSales          = borrowTotal - returnTotal - badReturnTotal;
    const transactionCount  = rows?.length ?? 0;

    const { error: upsertErr } = await this.supabase
      .from("daily_summaries")
      .upsert(
        {
          summary_date:       summaryDate,
          staff_name:         staffName,
          market_name:        market,
          borrow_total:       borrowTotal,
          return_total:       returnTotal,
          bad_return_total:   badReturnTotal,
          net_sales:          netSales,
          transaction_count:  transactionCount,
          updated_at:         new Date().toISOString(),
        },
        { onConflict: "summary_date,staff_name,market_name" },
      );

    if (upsertErr) {
      log.error("daily summary upsert failed", { error: upsertErr.message });
    } else {
      log.info("daily summary upsert succeeded", {
        borrowTotal, returnTotal, badReturnTotal, netSales, transactionCount,
      });
    }
  }
}
