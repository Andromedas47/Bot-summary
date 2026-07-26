import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { loadSalesReport } from "@/lib/sales/load";
import { buildSalesAutoMessages } from "@/lib/sales/message";
import {
  DEFAULT_SALES_REVISION,
  isStrictBusinessDate,
  isValidSalesRevision,
  parseSalesSummaryTargets,
  resolveSalesSummaryDate,
  salesSummaryRetryKey,
  SALES_SUMMARY_TARGETS_ENV,
} from "@/lib/sales/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled daily Sales report (P1).
 *
 * What goes out is how much product was sold on the previous business date and
 * what it is worth at the central selling price — per product, per market, and
 * across all markets — plus every result that could not be verified. It is not
 * cash, transfers, slips, reconciliation, cost or profit.
 *
 * NOT ACTIVATED. The workflow that would call this route
 * (.github/workflows/daily-sales-summary.yml) ships with no schedule, and
 * delivery is additionally inert until SALES_SUMMARY_LINE_TARGETS is
 * configured. Production activation requires explicit approval after UAT.
 *
 * Contract (the proven P0 scheduler pattern):
 *   - Auth: Bearer CRON_SECRET, same convention as every other cron route.
 *   - Report date: with no ?date=, the PREVIOUS Bangkok business date. An
 *     explicit ?date=YYYY-MM-DD is used verbatim and never shifted; a malformed
 *     one is a 400, never a silent fallback to another day.
 *   - Idempotent: a deterministic X-Line-Retry-Key per (revision, date, target,
 *     part) means a repeated scheduler call cannot produce duplicate LINE
 *     messages. A deliberate corrected resend passes ?revision=, which is the
 *     only way to obtain new keys for a day already delivered.
 *   - Per-target isolation: one failing target never blocks the others.
 *   - Any failure returns 500 so the scheduler retries; already-delivered
 *     targets are protected by their retry keys.
 *   - ?debug=1 previews the exact messages without sending anything.
 *   - Shares the SalesReport model with the manual command — no second business
 *     calculation lives here.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("daily sales summary cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    logger.warn("daily sales summary cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const debugMode = req.nextUrl.searchParams.get("debug") === "1";

  // A malformed ?date= is a caller mistake, not a request for yesterday. Falling
  // back would silently report a different day than the operator asked for — and
  // could push it to LINE — so it fails before anything is read or sent.
  if (dateParam !== null && !isStrictBusinessDate(dateParam)) {
    logger.warn("daily sales summary cron rejected - invalid date parameter", { dateParam });
    return NextResponse.json(
      { error: "date must be a real ISO business date (YYYY-MM-DD)", date: dateParam },
      { status: 400 },
    );
  }

  const revisionParam = req.nextUrl.searchParams.get("revision");
  if (revisionParam !== null && !isValidSalesRevision(revisionParam)) {
    logger.warn("daily sales summary cron rejected - invalid revision", { revisionParam });
    return NextResponse.json(
      { error: "revision must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}", revision: revisionParam },
      { status: 400 },
    );
  }

  const revision = revisionParam ?? DEFAULT_SALES_REVISION;
  const businessDate = resolveSalesSummaryDate(dateParam);
  const targets = parseSalesSummaryTargets(process.env[SALES_SUMMARY_TARGETS_ENV]);

  logger.info("daily sales summary cron started", {
    businessDate,
    hasDateParam: Boolean(dateParam),
    revision,
    debugMode,
    targetCount: targets.length,
  });

  let report;
  try {
    report = await loadSalesReport(createServiceClient(), businessDate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("daily sales summary cron failed - report build error", {
      businessDate,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const messages = buildSalesAutoMessages(report);
  const stats = {
    businessDate,
    marketCount: report.markets.length,
    productCount: report.products.length,
    blockedCount: report.blocked.length,
    scopeBlockerCount: report.scopeBlockers.length,
    expectedSalesSatang: report.allMarkets.expectedSalesSatang,
    quantityAuthoritative: report.allMarkets.quantityAuthoritative,
    valueAuthoritative: report.allMarkets.valueAuthoritative,
  };

  if (debugMode) {
    logger.info("daily sales summary cron debug completed", {
      ...stats,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
    });

    return NextResponse.json({
      ok: true,
      debug: true,
      ...stats,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
      messages,
    });
  }

  if (targets.length === 0) {
    // Expected until Production activation — logged loudly enough to notice,
    // but a successful no-op rather than a failure the scheduler should retry.
    logger.warn("daily sales summary cron skipped - no LINE targets configured", {
      businessDate,
      envVar: SALES_SUMMARY_TARGETS_ENV,
    });
    return NextResponse.json({
      ok: true,
      ...stats,
      sent: false,
      reason: "no_targets_configured",
      targetCount: 0,
    });
  }

  let sentCount = 0;
  const failedTargets: string[] = [];

  for (const target of targets) {
    try {
      for (const [index, message] of messages.entries()) {
        await pushLineMessage(target, message, salesSummaryRetryKey(businessDate, target, index, revision));
      }
      sentCount += 1;
    } catch (error) {
      failedTargets.push(target);
      logger.error("daily sales summary cron push failed", {
        businessDate,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedTargets.length > 0) {
    logger.error("daily sales summary cron completed with failures", {
      businessDate,
      sentCount,
      failedCount: failedTargets.length,
    });
    return NextResponse.json(
      {
        ok: false,
        ...stats,
        sent: sentCount > 0,
        sentCount,
        failedCount: failedTargets.length,
        targetCount: targets.length,
      },
      { status: 500 },
    );
  }

  logger.info("daily sales summary cron sent", { ...stats, sentCount });

  return NextResponse.json({
    ok: true,
    ...stats,
    sent: true,
    sentCount,
    targetCount: targets.length,
  });
}
