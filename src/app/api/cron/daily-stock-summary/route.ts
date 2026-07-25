import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/app/api/cron/finalize-slip-batches/auth";
import { logger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase/server";
import {
  deliverDailyStockMessages,
  parseDailyStockTargetIds,
  prepareAutomaticStockReport,
  resolveDailyStockDate,
} from "@/lib/line/daily-stock-delivery";
import { getDailyStockSummary } from "@/lib/summary/daily-stock-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = checkCronAuth(
    process.env.CRON_SECRET,
    req.headers.get("authorization"),
    req.headers.get("x-cron-secret"),
  );
  if (!auth.secretConfigured) {
    logger.error("daily stock cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (!auth.authorized) {
    logger.warn("daily stock cron rejected - invalid authorization", {
      headerTypeUsed: auth.headerTypeUsed,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const businessDate = resolveDailyStockDate(req.nextUrl.searchParams.get("date"));
  const debugMode = req.nextUrl.searchParams.get("debug") === "1";
  const targetIds = parseDailyStockTargetIds(process.env.DAILY_STOCK_LINE_TARGET_IDS);

  logger.info("daily stock cron started", {
    businessDate,
    debugMode,
    targetCount: targetIds.length,
  });

  if (!debugMode && targetIds.length === 0) {
    logger.error("daily stock cron failed - DAILY_STOCK_LINE_TARGET_IDS is missing");
    return NextResponse.json(
      { error: "DAILY_STOCK_LINE_TARGET_IDS is not configured", businessDate },
      { status: 500 },
    );
  }

  try {
    const summary = await getDailyStockSummary(createServiceClient(), businessDate);
    const prepared = prepareAutomaticStockReport(businessDate, summary);

    if (debugMode) {
      logger.info("daily stock cron debug completed", {
        businessDate,
        targetCount: targetIds.length,
        messageCount: prepared.messages.length,
        incompleteCount: summary.incomplete.length,
      });
      return NextResponse.json({
        ok: true,
        debug: true,
        businessDate,
        targetCount: targetIds.length,
        messageCount: prepared.messages.length,
        productCount: summary.overall.length,
        incompleteCount: summary.incomplete.length,
      });
    }

    const delivery = await deliverDailyStockMessages(
      businessDate,
      targetIds,
      prepared.messages,
    );

    if (delivery.failures.length > 0) {
      logger.error("daily stock cron completed with failures", {
        businessDate,
        attemptedCount: delivery.attemptedCount,
        acceptedCount: delivery.acceptedCount,
        failures: delivery.failures,
      });
      return NextResponse.json(
        {
          ok: false,
          businessDate,
          attemptedCount: delivery.attemptedCount,
          acceptedCount: delivery.acceptedCount,
          failedCount: delivery.failures.length,
        },
        { status: 500 },
      );
    }

    logger.info("daily stock cron sent", {
      businessDate,
      targetCount: targetIds.length,
      messageCount: prepared.messages.length,
      incompleteCount: summary.incomplete.length,
    });
    return NextResponse.json({
      ok: true,
      businessDate,
      targetCount: targetIds.length,
      messageCount: prepared.messages.length,
      productCount: summary.overall.length,
      incompleteCount: summary.incomplete.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("daily stock cron failed", { businessDate, error: message });
    return NextResponse.json({ error: message, businessDate }, { status: 500 });
  }
}
