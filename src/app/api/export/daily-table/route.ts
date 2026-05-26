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
  const date   = searchParams.get("date")   ?? undefined;
  const market = searchParams.get("market") ?? undefined;
  const staff  = searchParams.get("staff")  ?? undefined;

  const supabase = await createServiceClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from("produce_items")
    .select(
      "item_number,product_name,price_per_unit,quantity,unit,section,created_at," +
      "produce_sessions!inner(session_date,session_title,staff_name)",
    )
    .order("created_at", { ascending: false })
    .order("item_number", { ascending: true, nullsFirst: false })
    .limit(10000);

  if (date)   query = query.eq("produce_sessions.session_date", date);
  if (market) query = query.ilike("produce_sessions.session_title", `%${market}%`);
  if (staff)  query = query.ilike("produce_sessions.staff_name", `%${staff}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []).map((r: {
    item_number: number | null;
    product_name: string;
    price_per_unit: number | null;
    quantity: number | null;
    unit: string | null;
    section: string;
    created_at: string;
    produce_sessions: { session_date: string | null; session_title: string | null; staff_name: string } | null;
  }) => {
    const s     = r.produce_sessions;
    const total = r.quantity != null && r.price_per_unit != null
      ? r.quantity * r.price_per_unit
      : null;
    return {
      วันที่:       s?.session_date  ?? "",
      ตลาด:        s?.session_title ?? "",
      คนขาย:      s?.staff_name    ?? "",
      ลำดับ:       r.item_number    ?? "",
      รายการ:      r.product_name,
      จำนวน:      r.quantity       ?? "",
      หน่วย:      r.unit           ?? "",
      "ราคา/หน่วย": r.price_per_unit ?? "",
      ยอดรวม:     total            ?? "",
      หมวด:        r.section,
    };
  });

  const csv = "﻿" + toCsv(rows as Record<string, unknown>[]);

  return new NextResponse(csv, {
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="daily-table.csv"',
    },
  });
}
