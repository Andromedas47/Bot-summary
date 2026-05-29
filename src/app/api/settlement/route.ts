import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

function monthRange(month: string): { from: string; toExclusive: string } {
  const [y, m] = month.split("-").map(Number);
  const next = new Date(y, m, 1);
  return {
    from:        `${month}-01`,
    toExclusive: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`,
  };
}

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month");
  if (!month) return NextResponse.json({ error: "month required" }, { status: 400 });

  const { from, toExclusive } = monthRange(month);
  const supabase = await createServiceClient();

  const { data, error } = await supabase
    .from("settlement_entries")
    .select("*")
    .gte("settlement_date", from)
    .lt("settlement_date", toExclusive);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    settlement_date: string;
    settlement_time?: string;
    staff_name?:      string;
    market_name?:     string;
    money_transfer?:  number;
    money_cash?:      number;
    notes?:           string;
  };

  const { settlement_date, settlement_time = "", staff_name = "", market_name = "",
          money_transfer = 0, money_cash = 0, notes = "" } = body;

  if (!settlement_date) return NextResponse.json({ error: "settlement_date required" }, { status: 400 });

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("settlement_entries")
    .upsert(
      { settlement_date, settlement_time, staff_name, market_name,
        money_transfer, money_cash, notes, updated_at: new Date().toISOString() },
      { onConflict: "settlement_date,settlement_time,staff_name,market_name" },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
