import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature } from "@/lib/line/verify";
import { WebhookService } from "@/lib/line/webhook-service";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import type { LineWebhookBody } from "@/lib/line/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // ── Signature verification ──────────────────────────────────────────────────
  const signature = req.headers.get("x-line-signature");
  if (!signature) {
    logger.warn("webhook rejected — missing x-line-signature");
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret) {
    logger.error("LINE_CHANNEL_SECRET is not configured");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const rawBody = await req.text();

  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    logger.warn("webhook rejected — invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch {
    logger.warn("webhook rejected — invalid JSON");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  logger.info("webhook received", {
    destination: body.destination,
    eventCount:  body.events.length,
  });

  // ── Process events ──────────────────────────────────────────────────────────
  const supabase = await createServiceClient();
  const service  = new WebhookService(supabase);

  const results = await service.processEvents(body.events, body.destination);

  const saved     = results.filter((r) => r.status === "saved").length;
  const duplicate = results.filter((r) => r.status === "duplicate").length;
  const errors    = results.filter((r) => r.status === "error").length;

  logger.info("webhook processed", { saved, duplicate, errors });

  // LINE requires 200 OK regardless of processing outcome
  return NextResponse.json({ received: body.events.length, saved, duplicate, errors }, { status: 200 });
}
