export const runtime = "nodejs";

import React from "react";
import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createServiceClient } from "@/lib/supabase/server";
import { DailyTableDoc } from "@/lib/pdf/DailyTableDoc";
import { registerFonts } from "@/lib/pdf/fonts";
import type { DailyRow } from "@/components/daily-table/DailyTable";

async function getRows(req: NextRequest): Promise<DailyRow[]> {
  const { searchParams } = req.nextUrl;
  const date    = searchParams.get("date")    ?? undefined;
  const market  = searchParams.get("market")  ?? undefined;
  const seller  = searchParams.get("seller")  ?? undefined;
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
  if (seller)  query = query.ilike("staff_name",    `%${seller}%`);
  if (product) query = query.ilike("product_name",  `%${product}%`);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? []) as DailyRow[];
}

export async function GET(req: NextRequest) {
  let rows: DailyRow[];
  try {
    rows = await getRows(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const filterLabel = req.nextUrl.searchParams.toString() || "all";

  let buffer: Buffer;
  try {
    registerFonts();
    buffer = await renderToBuffer(
      <DailyTableDoc rows={rows} filterLabel={filterLabel} />,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown pdf render error";
    console.error("daily table pdf render failed", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":        "application/pdf",
      "Content-Disposition": `attachment; filename="daily-table-${Date.now()}.pdf"`,
      "Cache-Control":       "no-store",
    },
  });
}
