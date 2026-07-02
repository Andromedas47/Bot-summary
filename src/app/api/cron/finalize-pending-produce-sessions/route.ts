import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/app/api/cron/finalize-slip-batches/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { finalizeDuePendingGenerations } from "@/lib/line/pending-session-finalizer";
import { logger } from "@/lib/logger";
import {
  processDueProduceNotifications,
  resendProduceNotification,
} from "@/lib/line/produce-notification-delivery";

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
    const supabase = createServiceClient();
    const result = await finalizeDuePendingGenerations(supabase);
    const notifications = await processDueProduceNotifications(supabase);
    logger.info("pending produce finalizer completed", {
      ...result,
      notifications,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      notifications,
      triggeredAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("pending produce finalizer sweep failed", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const produceSessionId = body && typeof body === "object"
    && "produceSessionId" in body
    ? (body as { produceSessionId?: unknown }).produceSessionId
    : null;
  if (
    typeof produceSessionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(produceSessionId)
  ) {
    return NextResponse.json(
      { error: "produceSessionId must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const result = await resendProduceNotification(
      createServiceClient(),
      produceSessionId,
    );
    if (result === "not_requeued") {
      return NextResponse.json(
        { error: "Notification was not found or is currently sending" },
        { status: 409 },
      );
    }

    logger.info("operator produce notification resend completed", {
      produceSessionId,
      result,
    });
    const status = result === "sent"
      ? 200
      : result === "retry_scheduled"
        ? 202
        : result === "failed"
          ? 502
          : 409;
    return NextResponse.json({ ok: result === "sent", result }, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("operator produce notification resend failed", {
      produceSessionId,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
