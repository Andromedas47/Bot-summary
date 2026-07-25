import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { loadStockSummary } from "@/lib/summary/stock-summary-service";
import { buildLowStockReport } from "@/lib/summary/low-stock";
import { buildLowStockMessages } from "@/lib/summary/low-stock-message";
import {
  parseStockSummaryTargets,
  resolveStockSummaryDate,
  stockSummaryRetryKey,
  STOCK_SUMMARY_TARGETS_ENV,
} from "@/lib/summary/daily-stock-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled daily LOW-STOCK ATTENTION delivery.
 *
 * Scheduled by .github/workflows/daily-stock-summary.yml at 08:00 Asia/Bangkok
 * (01:00 UTC) — GitHub Actions, matching how finalize-slip-batches is driven,
 * because vercel.json crons are UTC-only and this project is on a Hobby plan
 * where cron firing time is approximate.
 *
 * What goes out is the attention list for the previous business date — which
 * products are running low and deserve a look before buying. The FULL
 * inventory stays on the manual `สรุปคงเหลือ` command, which is unchanged.
 *
 * Delivery is INERT until BOTH are true, and fails closed on either:
 *   - at least one threshold is configured in stock-thresholds.ts, otherwise
 *     the alert list would be empty and misleading rather than informative;
 *   - STOCK_SUMMARY_LINE_TARGETS names at least one LINE target.
 * It never falls back to sending the whole stock report.
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

  // Attention list only — no full inventory, no per-market detail.
  const lowStock = buildLowStockReport(summary);
  const messages = buildLowStockMessages(lowStock);
  const productCount = summary.categories.reduce((n, group) => n + group.products.length, 0);
  const wouldSendLine = lowStock.hasThresholds && targets.length > 0;

  if (debugMode) {
    logger.info("daily stock summary cron debug completed", {
      businessDate,
      productCount,
      lowStockCount: lowStock.itemCount,
      thresholdCount: lowStock.thresholdCount,
      incompleteCount: summary.incomplete.length,
      isComplete: summary.isComplete,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine,
    });

    return NextResponse.json({
      ok: true,
      debug: true,
      businessDate,
      productCount,
      lowStockCount: lowStock.itemCount,
      thresholdCount: lowStock.thresholdCount,
      withoutThresholdCount: lowStock.withoutThresholdCount,
      suppressedIncompleteCount: lowStock.suppressedIncompleteCount,
      incompleteCount: summary.incomplete.length,
      isComplete: summary.isComplete,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine,
      messages,
    });
  }

  if (!lowStock.hasThresholds) {
    // Activation safety: with no approved thresholds every product is "not low"
    // by rule, so a delivered report would claim everything is fine. Sending
    // nothing is the honest answer, and sending the whole inventory instead is
    // explicitly not the fallback.
    logger.warn("daily stock summary cron skipped - no low-stock thresholds configured", {
      businessDate,
      productCount,
      withoutThresholdCount: lowStock.withoutThresholdCount,
    });
    return NextResponse.json({
      ok: true,
      businessDate,
      sent: false,
      reason: "no_low_stock_thresholds_configured",
      productCount,
      lowStockCount: 0,
      thresholdCount: 0,
      withoutThresholdCount: lowStock.withoutThresholdCount,
      incompleteCount: summary.incomplete.length,
      targetCount: targets.length,
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
      lowStockCount: lowStock.itemCount,
      thresholdCount: lowStock.thresholdCount,
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
        lowStockCount: lowStock.itemCount,
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
    lowStockCount: lowStock.itemCount,
    incompleteCount: summary.incomplete.length,
    isComplete: summary.isComplete,
  });

  return NextResponse.json({
    ok: true,
    businessDate,
    sent: true,
    sentCount,
    productCount,
    lowStockCount: lowStock.itemCount,
    thresholdCount: lowStock.thresholdCount,
    withoutThresholdCount: lowStock.withoutThresholdCount,
    suppressedIncompleteCount: lowStock.suppressedIncompleteCount,
    incompleteCount: summary.incomplete.length,
    isComplete: summary.isComplete,
    targetCount: targets.length,
  });
}
