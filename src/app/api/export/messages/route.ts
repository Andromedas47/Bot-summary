import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { LineEventType } from "@/types/database";

const VALID_EVENT_TYPES = new Set<LineEventType>([
  "message", "follow", "unfollow", "join", "leave",
  "memberJoined", "memberLeft", "postback", "beacon",
  "accountLink", "unsend", "videoPlayComplete",
]);

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape  = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q         = searchParams.get("q")         ?? undefined;
  const type      = searchParams.get("type")      ?? undefined;
  const processed = searchParams.get("processed") ?? undefined;

  const eventType = type && VALID_EVENT_TYPES.has(type as LineEventType)
    ? (type as LineEventType) : undefined;

  const supabase = await createServiceClient();

  let query = supabase
    .from("raw_messages")
    .select("id,line_event_id,destination,event_type,source_type,source_id,user_id,message_id,message_type,raw_text,is_processed,processed_at,created_at")
    .order("created_at", { ascending: false })
    .limit(10000);

  if (q)                   query = query.ilike("raw_text", `%${q}%`);
  if (eventType)           query = query.eq("event_type", eventType);
  if (processed === "yes") query = query.eq("is_processed", true);
  if (processed === "no")  query = query.eq("is_processed", false);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const csv = toCsv((data ?? []) as Record<string, unknown>[]);

  return new NextResponse(csv, {
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="messages.csv"',
    },
  });
}
