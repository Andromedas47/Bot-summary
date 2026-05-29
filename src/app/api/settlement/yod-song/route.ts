import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { KNOWN_TX_TYPES, addTransactionAmount, emptyTransactionTotals } from "@/lib/summary/transactions";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  const market = req.nextUrl.searchParams.get("market");
  const seller = req.nextUrl.searchParams.get("seller");

  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const supabase = await createServiceClient();

  let query = supabase
    .from("produce_transactions")
    .select("transaction_type, total_amount")
    .eq("transaction_date", date)
    .in("transaction_type", KNOWN_TX_TYPES as unknown as string[]);

  if (market) query = query.eq("market_name", market);
  if (seller) query = query.eq("staff_name", seller);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const totals = emptyTransactionTotals();
  for (const r of data ?? []) {
    addTransactionAmount(totals, {
      transaction_type: r.transaction_type as string,
      total_amount: (r.total_amount as number) ?? 0,
    });
  }

  return NextResponse.json(totals);
}
