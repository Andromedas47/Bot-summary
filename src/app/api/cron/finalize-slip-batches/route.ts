import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { finalizeDueSlipBatches, parseAbandonedMinutes } from "@/lib/slips/batch-finalizer";
import { checkCronAuth } from "./auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const xCronSecretHeader = req.headers.get("x-cron-secret");
  const auth = checkCronAuth(secret, authHeader, xCronSecretHeader);

  logger.info("finalize-slip-batches cron auth check", {
    secretConfigured: auth.secretConfigured,
    authHeaderPresent: auth.authHeaderPresent,
    headerTypeUsed: auth.headerTypeUsed,
  });

  if (!auth.secretConfigured) {
    logger.error("finalize-slip-batches cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  if (!auth.authorized) {
    logger.warn("finalize-slip-batches cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const finalizedCount = await finalizeDueSlipBatches(supabase);

  const abandonedMinutes = parseAbandonedMinutes(process.env.SLIP_ABANDONED_SESSION_MINUTES);
  logger.info("finalize-slip-batches completed", { finalizedCount, abandonedMinutes });
  return NextResponse.json({
    ok: true,
    finalizedCount,
    abandonedSessionMinutes: abandonedMinutes,
    triggeredAt: new Date().toISOString(),
  });
}
