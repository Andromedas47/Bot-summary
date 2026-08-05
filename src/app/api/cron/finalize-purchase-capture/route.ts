import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/app/api/cron/finalize-slip-batches/auth";
import { sweepPurchaseCaptureEligibility } from "@/lib/purchase-capture/eligibility-sweep";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Slice A scope only (plan §21): discovers `closing` purchase-capture
 * sessions past quiet/deadline and logs finalize-candidate eligibility.
 * Never parses, never creates a receipt, never transitions a session, never
 * sends a LINE message. Slice B/C extend this into the real finalize/posting
 * recovery sweep.
 */
export async function GET(req: NextRequest) {
  const auth = checkCronAuth(
    process.env.CRON_SECRET,
    req.headers.get("authorization"),
    req.headers.get("x-cron-secret"),
  );
  if (!auth.secretConfigured) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 },
    );
  }
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sweepPurchaseCaptureEligibility(createServiceClient());
    logger.info("Purchase capture eligibility sweep completed", { ...result });
    return NextResponse.json({
      ok: true,
      ...result,
      triggeredAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Purchase capture eligibility sweep failed", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
