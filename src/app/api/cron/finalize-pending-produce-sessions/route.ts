import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/app/api/cron/finalize-slip-batches/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { finalizeDuePendingGenerations } from "@/lib/line/pending-session-finalizer";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const result = await finalizeDuePendingGenerations(createServiceClient());
    logger.info("pending produce finalizer completed", { ...result });
    return NextResponse.json({
      ok: true,
      ...result,
      triggeredAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("pending produce finalizer sweep failed", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
