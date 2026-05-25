import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, getSourceId, getUserId } from "@/lib/line/verify";
import type { LineWebhookBody, LineMessageEvent } from "@/lib/line/types";
import { parserRegistry } from "@/lib/parsers/registry";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-line-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret) {
    console.error("LINE_CHANNEL_SECRET is not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const rawBody = await req.text();

  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = await createServiceClient();

  const results = await Promise.allSettled(
    body.events.map((event) => processEvent(event, body.destination, supabase))
  );

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);

  if (errors.length > 0) {
    console.error("Webhook processing errors:", errors);
  }

  // LINE expects 200 OK regardless of processing outcome
  return NextResponse.json({ processed: body.events.length }, { status: 200 });
}

async function processEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
  destination: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
): Promise<void> {
  const source = event.source ?? {};
  const message = event.message;

  const { data: rawEvent, error: insertError } = await supabase
    .from("line_raw_events")
    .insert({
      event_id: event.webhookEventId,
      destination,
      event_type: event.type,
      message_type: message?.type ?? null,
      source_type: source.type ?? "user",
      source_id: getSourceId(source),
      user_id: getUserId(source),
      payload: event,
    })
    .select("id")
    .single();

  if (insertError) {
    // Duplicate event_id = already processed (idempotent)
    if (insertError.code === "23505") return;
    throw new Error(`DB insert failed: ${insertError.message}`);
  }

  // Only attempt parsing for message events
  if (event.type !== "message" || !message) return;

  const parser = parserRegistry.findParser(event as LineMessageEvent);
  if (!parser) return;

  try {
    const result = await parser.parse(event as LineMessageEvent);

    await supabase.from("parsed_messages").insert({
      raw_event_id: rawEvent.id,
      parser_name: result.parserName,
      parser_version: result.parserVersion,
      parsed_data: result.data,
      status: "parsed",
    });
  } catch (err) {
    await supabase.from("parsed_messages").insert({
      raw_event_id: rawEvent.id,
      parser_name: parser.name,
      parser_version: parser.version,
      parsed_data: {},
      status: "error",
      error_message: err instanceof Error ? err.message : String(err),
    });
  }
}
