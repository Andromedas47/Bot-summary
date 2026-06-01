import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { buildDailySummaryMessage } from "@/lib/line/daily-summary-message";
import type { DailySummaryRow } from "@/types/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bangkokToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("daily summary cron rejected — CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    logger.warn("daily summary cron rejected — invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const summaryDate = dateParam && isIsoDate(dateParam) ? dateParam : bangkokToday();

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("daily_summaries")
    .select("summary_date,staff_name,market_name,borrow_total,return_total,bad_return_total,net_sales,transaction_count")
    .eq("summary_date", summaryDate)
    .order("staff_name", { ascending: true })
    .order("market_name", { ascending: true });

  if (error) {
    logger.error("daily summary cron failed — fetch error", { summaryDate, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as DailySummaryRow[];
  if (rows.length === 0) {
    logger.info("daily summary cron skipped — no rows", { summaryDate });
    return NextResponse.json({ ok: true, summaryDate, sent: false, rowCount: 0 });
  }

  const targetId = process.env.LINE_DAILY_SUMMARY_TARGET_ID;
  if (!targetId) {
    logger.error("daily summary cron failed — LINE_DAILY_SUMMARY_TARGET_ID is missing");
    return NextResponse.json({ error: "LINE_DAILY_SUMMARY_TARGET_ID is not configured" }, { status: 500 });
  }

  const message = buildDailySummaryMessage(summaryDate, rows);
  await pushLineMessage(targetId, message);

  logger.info("daily summary cron sent", { summaryDate, rowCount: rows.length });
  return NextResponse.json({ ok: true, summaryDate, sent: true, rowCount: rows.length });
}
