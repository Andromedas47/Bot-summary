import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { isStrictBusinessDate } from "@/lib/sales/cron";
import {
  parseStockSummaryTargets,
  purchasePlanningRetryKey,
  resolveStockSummaryDate,
  STOCK_SUMMARY_TARGETS_ENV,
} from "@/lib/summary/daily-stock-cron";
import { buildPurchasePlanningMessages } from "@/lib/summary/purchase-planning-message";
import { loadPurchasePlanningReport } from "@/lib/summary/purchase-planning-service";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Scheduled 08:15 Asia/Bangkok purchase-planning delivery. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("daily purchase planning cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    logger.warn("daily purchase planning cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  if (dateParam !== null && !isStrictBusinessDate(dateParam)) {
    return NextResponse.json(
      { error: "date must be a real ISO business date (YYYY-MM-DD)", date: dateParam },
      { status: 400 },
    );
  }

  const debugMode = req.nextUrl.searchParams.get("debug") === "1";
  const businessDate = resolveStockSummaryDate(dateParam);
  const targets = parseStockSummaryTargets(process.env[STOCK_SUMMARY_TARGETS_ENV]);
  const supabase = createServiceClient();

  logger.info("daily purchase planning cron started", {
    businessDate,
    hasDateParam: Boolean(dateParam),
    debugMode,
    targetCount: targets.length,
  });

  let messages: string[];
  try {
    const report = await loadPurchasePlanningReport(supabase, businessDate);
    messages = buildPurchasePlanningMessages(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("daily purchase planning cron failed - report build error", {
      businessDate,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (debugMode) {
    logger.info("daily purchase planning cron debug completed", {
      businessDate,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
    });
    return NextResponse.json({
      ok: true,
      debug: true,
      businessDate,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
      messages,
    });
  }

  if (targets.length === 0) {
    logger.warn("daily purchase planning cron skipped - no LINE targets configured", {
      businessDate,
      envVar: STOCK_SUMMARY_TARGETS_ENV,
    });
    return NextResponse.json({
      ok: true,
      businessDate,
      sent: false,
      reason: "no_targets_configured",
      messageCount: messages.length,
      targetCount: 0,
    });
  }

  let sentCount = 0;
  const failedTargets: string[] = [];
  for (const target of targets) {
    try {
      for (const [index, message] of messages.entries()) {
        await pushLineMessage(
          target,
          message,
          purchasePlanningRetryKey(businessDate, target, index),
        );
      }
      sentCount += 1;
    } catch (error) {
      failedTargets.push(target);
      logger.error("daily purchase planning cron push failed", {
        businessDate,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedTargets.length > 0) {
    logger.error("daily purchase planning cron completed with failures", {
      businessDate,
      sentCount,
      failedCount: failedTargets.length,
    });
    // pg_net records this response but does not automatically retry it. Keep
    // the failure observable; a manual same-date rerun is safe via retry keys.
    return NextResponse.json(
      {
        ok: false,
        businessDate,
        sent: sentCount > 0,
        sentCount,
        failedCount: failedTargets.length,
        messageCount: messages.length,
        targetCount: targets.length,
      },
      { status: 500 },
    );
  }

  logger.info("daily purchase planning cron sent", { businessDate, sentCount });
  return NextResponse.json({
    ok: true,
    businessDate,
    sent: true,
    sentCount,
    messageCount: messages.length,
    targetCount: targets.length,
  });
}
