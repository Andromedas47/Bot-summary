import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

const KNOWN_TYPES = ["เบิก", "เบิกเพิ่ม", "คืน", "คืนเสีย"] as const;

export async function GET(req: NextRequest) {
  const date   = req.nextUrl.searchParams.get("date");
  const market = req.nextUrl.searchParams.get("market");
  const seller = req.nextUrl.searchParams.get("seller");

  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const supabase = await createServiceClient();

  let query = supabase
    .from("produce_transactions")
    .select("transaction_type, total_amount")
    .eq("transaction_date", date)
    .in("transaction_type", KNOWN_TYPES as unknown as string[]);

  if (market) query = query.eq("market_name", market);
  if (seller) query = query.eq("staff_name", seller);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let เบิก = 0, คืน = 0, คืนเสีย = 0;
  for (const r of data ?? []) {
    const amt = (r.total_amount as number) ?? 0;
    if (r.transaction_type === "เบิก" || r.transaction_type === "เบิกเพิ่ม") เบิก += amt;
    else if (r.transaction_type === "คืน") คืน += amt;
    else if (r.transaction_type === "คืนเสีย") คืนเสีย += amt;
  }

  return NextResponse.json({ เบิก, คืน, คืนเสีย, ยอดส่ง: เบิก - คืน - คืนเสีย });
}
