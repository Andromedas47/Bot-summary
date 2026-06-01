import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { buildDailySummaryMessage } from "@/lib/line/daily-summary-message";
import type { DailySummaryMessageRow } from "@/lib/line/daily-summary-message";
import { bangkokBusinessDateNow } from "@/lib/business-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TransactionRow {
  raw_message_id: string;
  staff_name: string;
  market_name: string | null;
  transaction_type: string;
  total_amount: number | null;
}

interface RawMessageSourceRow {
  id: string;
  source_id: string;
  source_type: string;
}

interface GroupedSummaryRow extends DailySummaryMessageRow {
  source_id: string;
}

function bangkokToday(): string {
  return bangkokBusinessDateNow();
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function groupKey(sourceId: string, staffName: string, marketName: string): string {
  return `${sourceId}||${staffName}||${marketName}`;
}

function addAmount(row: GroupedSummaryRow, tx: TransactionRow): void {
  const amount = Number(tx.total_amount ?? 0);

  if (tx.transaction_type === "เบิก" || tx.transaction_type === "เบิกเพิ่ม") {
    row.borrow_total += amount;
  } else if (tx.transaction_type === "คืน") {
    row.return_total += amount;
  } else if (tx.transaction_type === "คืนเสีย") {
    row.bad_return_total += amount;
  }

  row.net_sales = row.borrow_total - row.return_total - row.bad_return_total;
  row.transaction_count += 1;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("daily summary cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    logger.warn("daily summary cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const summaryDate = dateParam && isIsoDate(dateParam) ? dateParam : bangkokToday();

  const supabase = createServiceClient();
  const { data: txData, error: txError } = await supabase
    .from("produce_transactions")
    .select("raw_message_id,staff_name,market_name,transaction_type,total_amount")
    .eq("transaction_date", summaryDate)
    .order("staff_name", { ascending: true })
    .order("market_name", { ascending: true });

  if (txError) {
    logger.error("daily summary cron failed - transaction fetch error", {
      summaryDate,
      error: txError.message,
    });
    return NextResponse.json({ error: txError.message }, { status: 500 });
  }

  const transactions = (txData ?? []) as TransactionRow[];
  if (transactions.length === 0) {
    logger.info("daily summary cron skipped - no rows", { summaryDate });
    return NextResponse.json({ ok: true, summaryDate, sent: false, rowCount: 0, targetCount: 0 });
  }

  const rawMessageIds = [...new Set(transactions.map((row) => row.raw_message_id))];
  const { data: sourceData, error: sourceError } = await supabase
    .from("raw_messages")
    .select("id,source_id,source_type")
    .in("id", rawMessageIds);

  if (sourceError) {
    logger.error("daily summary cron failed - source fetch error", {
      summaryDate,
      error: sourceError.message,
    });
    return NextResponse.json({ error: sourceError.message }, { status: 500 });
  }

  const sourceByMessageId = new Map(
    ((sourceData ?? []) as RawMessageSourceRow[])
      .filter((row) => row.source_id && row.source_id !== "unknown")
      .map((row) => [row.id, row]),
  );

  const grouped = new Map<string, GroupedSummaryRow>();
  for (const tx of transactions) {
    const source = sourceByMessageId.get(tx.raw_message_id);
    if (!source) continue;

    const marketName = tx.market_name ?? "";
    const key = groupKey(source.source_id, tx.staff_name, marketName);
    const row = grouped.get(key) ?? {
      source_id: source.source_id,
      summary_date: summaryDate,
      staff_name: tx.staff_name,
      market_name: marketName,
      borrow_total: 0,
      return_total: 0,
      bad_return_total: 0,
      net_sales: 0,
      transaction_count: 0,
    };

    addAmount(row, tx);
    grouped.set(key, row);
  }

  const summariesBySource = new Map<string, DailySummaryMessageRow[]>();
  for (const row of grouped.values()) {
    const { source_id, ...summaryRow } = row;
    const rows = summariesBySource.get(source_id) ?? [];
    rows.push(summaryRow);
    summariesBySource.set(source_id, rows);
  }

  if (summariesBySource.size === 0) {
    logger.warn("daily summary cron skipped - no valid LINE source ids", { summaryDate });
    return NextResponse.json({
      ok: true,
      summaryDate,
      sent: false,
      rowCount: transactions.length,
      targetCount: 0,
    });
  }

  for (const [sourceId, rows] of summariesBySource) {
    const message = buildDailySummaryMessage(summaryDate, rows);
    await pushLineMessage(sourceId, message);
  }

  logger.info("daily summary cron sent", {
    summaryDate,
    rowCount: transactions.length,
    targetCount: summariesBySource.size,
  });

  return NextResponse.json({
    ok: true,
    summaryDate,
    sent: true,
    rowCount: transactions.length,
    targetCount: summariesBySource.size,
  });
}
