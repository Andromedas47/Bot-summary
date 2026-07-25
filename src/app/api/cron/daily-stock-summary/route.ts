import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { loadStockSummary } from "@/lib/summary/stock-summary-service";
import { buildStockSnapshotMessages } from "@/lib/summary/stock-snapshot-message";
import {
  parseStockSummaryTargets,
  resolveStockSummaryDate,
  stockSummaryRetryKey,
  STOCK_SUMMARY_TARGETS_ENV,
} from "@/lib/summary/daily-stock-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled daily Stock snapshot delivery.
 *
 * What goes out is the sellable remaining stock of the previous business date
 * across all markets, grouped by category then by unit — a factual snapshot the
 * humans use to decide what to buy. It contains no recommendation, no reorder
 * rule and no purchase wording. The FULL per-market inventory stays on the
 * manual `สรุปคงเหลือ` command.
 *
 * Scheduled by .github/workflows/daily-stock-summary.yml at 08:00 Asia/Bangkok
 * (01:00 UTC) — GitHub Actions, matching how finalize-slip-batches is driven,
 * because vercel.json crons are UTC-only and this project is on a Hobby plan
 * where cron firing time is approximate.
 *
 * Delivery is still INERT until STOCK_SUMMARY_LINE_TARGETS is configured: with
 * no targets the route logs and returns without sending anything.
 *
 * Contract:
 *   - Auth: Bearer CRON_SECRET, the same convention as the other cron routes.
 *   - Report date: with no ?date=, the PREVIOUS Bangkok business date (the day
 *     that just closed) — see previousBangkokBusinessDate. An explicit
 *     ?date=YYYY-MM-DD is used verbatim and never shifted.
 *   - Idempotent: a deterministic X-Line-Retry-Key per (date, target, part)
 *     means a repeated scheduler call cannot produce duplicate LINE messages.
 *   - Per-target isolation: one failing target never blocks the others.
 *   - Any failure returns 500 so the scheduler retries; already-delivered
 *     targets are protected by their retry keys.
 *   - Shares the StockSummary model with the manual command — no second
 *     business calculation lives here.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("daily stock summary cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    logger.warn("daily stock summary cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const debugMode = req.nextUrl.searchParams.get("debug") === "1";
  const businessDate = resolveStockSummaryDate(dateParam);
  const targets = parseStockSummaryTargets(process.env[STOCK_SUMMARY_TARGETS_ENV]);

  logger.info("daily stock summary cron started", {
    businessDate,
    hasDateParam: Boolean(dateParam),
    debugMode,
    targetCount: targets.length,
  });

  let summary;
  try {
    summary = await loadStockSummary(createServiceClient(), businessDate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("daily stock summary cron failed - summary build error", {
      businessDate,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // The all-market stock snapshot, grouped by category then unit, with the
  // missing-ชั่งคืน section collapsed to counts. No per-market detail: the
  // morning report has to be readable before the markets run.
  const messages = buildStockSnapshotMessages(summary);
  const productCount = summary.categories.reduce((n, group) => n + group.products.length, 0);

  if (debugMode) {
    logger.info("daily stock summary cron debug completed", {
      businessDate,
      productCount,
      incompleteCount: summary.incomplete.length,
      isComplete: summary.isComplete,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
    });

    return NextResponse.json({
      ok: true,
      debug: true,
      businessDate,
      productCount,
      incompleteCount: summary.incomplete.length,
      isComplete: summary.isComplete,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
      messages,
    });
  }

  if (targets.length === 0) {
    // Expected until Production activation — log loudly enough to notice, but
    // this is a successful no-op, not a failure the scheduler should retry.
    logger.warn("daily stock summary cron skipped - no LINE targets configured", {
      businessDate,
      envVar: STOCK_SUMMARY_TARGETS_ENV,
    });
    return NextResponse.json({
      ok: true,
      businessDate,
      sent: false,
      reason: "no_targets_configured",
      productCount,
      incompleteCount: summary.incomplete.length,
      targetCount: 0,
    });
  }

  let sentCount = 0;
  const failedTargets: string[] = [];

  for (const target of targets) {
    try {
      for (const [index, message] of messages.entries()) {
        await pushLineMessage(target, message, stockSummaryRetryKey(businessDate, target, index));
      }
      sentCount += 1;
    } catch (error) {
      failedTargets.push(target);
      logger.error("daily stock summary cron push failed", {
        businessDate,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedTargets.length > 0) {
    logger.error("daily stock summary cron completed with failures", {
      businessDate,
      sentCount,
      failedCount: failedTargets.length,
    });
    return NextResponse.json(
      {
        ok: false,
        businessDate,
        sent: sentCount > 0,
        sentCount,
        failedCount: failedTargets.length,
        productCount,
        incompleteCount: summary.incomplete.length,
        targetCount: targets.length,
      },
      { status: 500 },
    );
  }

  logger.info("daily stock summary cron sent", {
    businessDate,
    sentCount,
    productCount,
    incompleteCount: summary.incomplete.length,
    isComplete: summary.isComplete,
  });

  return NextResponse.json({
    ok: true,
    businessDate,
    sent: true,
    sentCount,
    productCount,
    incompleteCount: summary.incomplete.length,
    isComplete: summary.isComplete,
    targetCount: targets.length,
  });
}
