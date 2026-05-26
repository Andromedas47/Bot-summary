import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { DailyRow } from "@/components/daily-table/DailyTable";

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

function fmtTime(d: string | null | undefined): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("th-TH", {
    hour:     "2-digit",
    minute:   "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date(d));
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const date    = searchParams.get("date")    ?? undefined;
  const market  = searchParams.get("market")  ?? undefined;
  const staff   = searchParams.get("staff")   ?? undefined;
  const product = searchParams.get("product") ?? undefined;

  const supabase = await createServiceClient();

  let query = supabase
    .from("produce_transactions")
    .select("*")
    .order("session_created_at", { ascending: false })
    .order("item_number",        { ascending: true,  nullsFirst: false })
    .limit(10000);

  if (date)    query = query.eq("transaction_date", date);
  if (market)  query = query.ilike("market_name",   `%${market}%`);
  if (staff)   query = query.ilike("staff_name",    `%${staff}%`);
  if (product) query = query.ilike("product_name",  `%${product}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data as DailyRow[]).map((r) => ({
    วันที่:          r.transaction_date        ?? "",
    เวลา:            fmtTime(r.session_created_at),
    ตลาด:            r.market_name             ?? "",
    คนขาย:          r.staff_name,
    ลำดับ:           r.item_number             ?? "",
    สินค้า:          r.product_name,
    จำนวน:          r.quantity                ?? "",
    หน่วย:          r.unit                    ?? "",
    "ราคา/หน่วย":   r.price_per_unit          ?? "",
    ยอดรวม:         r.total_amount            ?? "",
    หมวด:            r.section,
    "Session ID":    r.session_id,
    "ข้อความ LINE":  r.source_message          ?? "",
  }));

  const csv = "﻿" + toCsv(rows as Record<string, unknown>[]);

  return new NextResponse(csv, {
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="daily-table.csv"',
    },
  });
}
