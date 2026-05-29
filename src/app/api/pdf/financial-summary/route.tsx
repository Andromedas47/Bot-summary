export const runtime = "nodejs";

import React from "react";
import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createServiceClient } from "@/lib/supabase/server";
import { registerFonts } from "@/lib/pdf/fonts";
import { FinancialSummaryDoc } from "@/lib/pdf/FinancialSummaryDoc";
import type { GroupRow, SettlementEntry } from "@/components/financial-summary/FinancialTable";

// ── Date helpers ──────────────────────────────────────────────────────────────

function monthDateRange(month: string): { from: string; toExclusive: string } {
  const [y, m] = month.split("-").map(Number);
  const next   = new Date(y, m, 1);
  return {
    from:        `${month}-01`,
    toExclusive: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`,
  };
}

// ── Business logic (mirrors financial-summary page) ───────────────────────────

type TxRow = {
  transaction_date: string | null;
  transaction_time: string | null;
  market_name:      string | null;
  staff_name:       string;
  transaction_type: string;
  total_amount:     number | null;
};

const KNOWN_TX_TYPES = ["เบิก", "เบิกเพิ่ม", "คืน", "คืนเสีย"] as const;

function buildGroups(rows: TxRow[]): GroupRow[] {
  const map = new Map<string, Omit<GroupRow, "ยอดส่ง">>();

  for (const r of rows) {
    if (!(KNOWN_TX_TYPES as readonly string[]).includes(r.transaction_type)) continue;
    const date   = r.transaction_date ?? "ไม่ระบุวันที่";
    const time   = r.transaction_time ?? null;
    const seller = r.staff_name        || "ไม่ระบุ";
    const market = r.market_name       || "ไม่ระบุ";
    const key    = `${date}||${time ?? ""}||${seller}||${market}`;
    const amt    = r.total_amount ?? 0;

    if (!map.has(key)) map.set(key, { date, time, seller, market, เบิก: 0, คืน: 0, คืนเสีย: 0 });
    const g = map.get(key)!;

    switch (r.transaction_type) {
      case "เบิก":
      case "เบิกเพิ่ม": g.เบิก    += amt; break;
      case "คืน":       g.คืน     += amt; break;
      case "คืนเสีย":   g.คืนเสีย += amt; break;
    }
  }

  return Array.from(map.values())
    .map((g) => ({ ...g, ยอดส่ง: g.เบิก - g.คืน - g.คืนเสีย }))
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time ?? "").localeCompare(b.time ?? "") ||
      a.seller.localeCompare(b.seller),
    );
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month required (YYYY-MM)" }, { status: 400 });
  }

  const supabase             = await createServiceClient();
  const { from, toExclusive } = monthDateRange(month);

  // Fetch transactions
  const PAGE = 1000;
  const allTx: TxRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("produce_transactions")
      .select("transaction_date, transaction_time, market_name, staff_name, transaction_type, total_amount")
      .gte("transaction_date", from)
      .lt("transaction_date",  toExclusive)
      .in("transaction_type",  KNOWN_TX_TYPES as unknown as string[])
      .range(offset, offset + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    allTx.push(...((data ?? []) as TxRow[]));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }

  // Fetch settlements
  const { data: settlData, error: settlErr } = await supabase
    .from("settlement_entries")
    .select("settlement_date, settlement_time, staff_name, market_name, money_transfer, money_cash")
    .gte("settlement_date", from)
    .lt("settlement_date",  toExclusive);
  if (settlErr) return NextResponse.json({ error: settlErr.message }, { status: 500 });

  const groups      = buildGroups(allTx);
  const settlements = (settlData ?? []) as SettlementEntry[];

  // Generate PDF
  registerFonts();
  const buffer = await renderToBuffer(
    <FinancialSummaryDoc month={month} groups={groups} settlements={settlements} />,
  );

  const [y, m] = month.split("-");
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":        "application/pdf",
      "Content-Disposition": `attachment; filename="สรุปการเงิน-${y}-${m}.pdf"`,
      "Cache-Control":       "no-store",
    },
  });
}
