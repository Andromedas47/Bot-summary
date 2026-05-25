import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { ParseErrorType } from "@/types/database";

const VALID_ERROR_TYPES = new Set<ParseErrorType>([
  "format_error", "validation_error", "unknown_format",
  "parser_crash", "timeout", "unsupported_type",
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
  const q      = searchParams.get("q")      ?? undefined;
  const type   = searchParams.get("type")   ?? undefined;
  const parser = searchParams.get("parser") ?? undefined;

  const errorType = type && VALID_ERROR_TYPES.has(type as ParseErrorType)
    ? (type as ParseErrorType) : undefined;

  const supabase = await createServiceClient();

  let query = supabase
    .from("parse_errors")
    .select("id,raw_message_id,parser_name,parser_version,error_type,error_message,created_at")
    .order("created_at", { ascending: false })
    .limit(10000);

  if (q)         query = query.ilike("error_message", `%${q}%`);
  if (errorType) query = query.eq("error_type", errorType);
  if (parser)    query = query.eq("parser_name", parser);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const csv = toCsv((data ?? []) as Record<string, unknown>[]);

  return new NextResponse(csv, {
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="parse-errors.csv"',
    },
  });
}
