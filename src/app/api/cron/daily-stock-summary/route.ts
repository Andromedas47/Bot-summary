import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { loadStockSummary } from "@/lib/summary/stock-summary-service";
import { buildStockSummaryMessages } from "@/lib/summary/stock-summary-message";
import {
  parseStockSummaryTargets,
  resolveStockSummaryDate,
  stockSummaryRetryKey,
  STOCK_SUMMARY_TARGETS_ENV,
} from "@/lib/summary/daily-stock-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled daily Stock ("สรุปคงเหลือ") delivery.
 *
 * NOT ACTIVATED. vercel.json declares no schedule for this route, and
 * STOCK_SUMMARY_LINE_TARGETS is unset in every environment, so the endpoint is
 * inert until the business supplies target IDs and an approved clock time.
 *
 * Contract:
 *   - Auth: Bearer CRON_SECRET, the same convention as the other cron routes.
 *   - Business date: Bangkok 04:00 cutoff, overridable with ?date=YYYY-MM-DD.
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

  const messages = buildStockSummaryMessages(summary);
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
