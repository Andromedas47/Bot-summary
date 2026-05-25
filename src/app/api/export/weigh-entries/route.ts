import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

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
  const q      = searchParams.get("q")      ?? undefined;
  const errors = searchParams.get("errors") ?? undefined;

  const supabase = await createServiceClient();

  let query = supabase
    .from("produce_sessions")
    .select("id,raw_message_id,line_user_id,staff_name,session_date,session_title,total_items,parser_errors,created_at")
    .order("created_at", { ascending: false })
    .limit(10000);

  if (q)             query = query.ilike("staff_name", `%${q}%`);
  if (errors === "yes") query = query.not("parser_errors", "is", null);
  if (errors === "no")  query = query.is("parser_errors", null);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []).map((r) => ({
    ...r,
    parser_errors: Array.isArray(r.parser_errors)
      ? (r.parser_errors as string[]).join(" | ")
      : "",
  }));

  const csv = toCsv(rows as Record<string, unknown>[]);

  return new NextResponse(csv, {
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="weigh-entries.csv"',
    },
  });
}
