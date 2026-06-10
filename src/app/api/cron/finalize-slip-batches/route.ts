import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { finalizeDueSlipBatches } from "@/lib/slips/batch-finalizer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("finalize-slip-batches cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    logger.warn("finalize-slip-batches cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const batchesFinalized = await finalizeDueSlipBatches(supabase);

  logger.info("finalize-slip-batches cron completed", { batchesFinalized });
  return NextResponse.json({ ok: true, batchesFinalized });
}
