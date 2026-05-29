import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { FinancialTable, type GroupRow, type SettlementEntry } from "@/components/financial-summary/FinancialTable";
import Link from "next/link";

interface PageProps {
  searchParams: Promise<{ month?: string }>;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthDateRange(month: string): { from: string; toExclusive: string } {
  const [y, m] = month.split("-").map(Number);
  const next = new Date(y, m, 1);
  return {
    from:        `${month}-01`,
    toExclusive: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`,
  };
}

function thaiMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric" })
    .format(new Date(y, m - 1, 1));
}

// ── Business logic ────────────────────────────────────────────────────────────

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
    // Ignore any future/unknown transaction types — they have no place in financial accounting.
    if (!(KNOWN_TX_TYPES as readonly string[]).includes(r.transaction_type)) continue;

    const date   = r.transaction_date ?? "ไม่ระบุวันที่";
    const time   = r.transaction_time ?? null;
    const seller = r.staff_name        || "ไม่ระบุ";
    const market = r.market_name       || "ไม่ระบุ";
    const key    = `${date}||${time ?? ""}||${seller}||${market}`;
    const amt    = r.total_amount ?? 0;

    if (!map.has(key)) {
      map.set(key, { date, time, seller, market, เบิก: 0, คืน: 0, คืนเสีย: 0 });
    }
    const g = map.get(key)!;

    switch (r.transaction_type) {
      case "เบิก":
      case "เบิกเพิ่ม": g.เบิก    += amt; break;
      case "คืน":       g.คืน     += amt; break;
      case "คืนเสีย":   g.คืนเสีย += amt; break;
    }
  }

  return Array.from(map.values())
    .map(g => ({ ...g, ยอดส่ง: g.เบิก - g.คืน - g.คืนเสีย }))
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time ?? "").localeCompare(b.time ?? "") ||
      a.seller.localeCompare(b.seller)
    );
}

async function fetchAllTxRows(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  from: string,
  toExclusive: string,
): Promise<TxRow[]> {
  const PAGE = 1000;
  const all: TxRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("produce_transactions")
      .select("transaction_date, transaction_time, market_name, staff_name, transaction_type, total_amount")
      .gte("transaction_date", from)
      .lt("transaction_date",  toExclusive)
      .in("transaction_type",  KNOWN_TX_TYPES as unknown as string[])
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as TxRow[]));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

async function getPageData(month: string): Promise<{
  groups:      GroupRow[];
  settlements: SettlementEntry[];
}> {
  const supabase = await createServiceClient();
  const { from, toExclusive } = monthDateRange(month);

  const [txRows, settlResult] = await Promise.all([
    fetchAllTxRows(supabase, from, toExclusive),
    supabase
      .from("settlement_entries")
      .select("settlement_date, settlement_time, staff_name, market_name, money_transfer, money_cash")
      .gte("settlement_date", from)
      .lt("settlement_date",  toExclusive),
  ]);

  if (settlResult.error) throw new Error(settlResult.error.message);

  return {
    groups:      buildGroups(txRows),
    settlements: (settlResult.data ?? []) as SettlementEntry[],
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function FinancialSummaryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const now    = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const month  = params.month ?? defaultMonth;

  const { groups, settlements } = await timed("financial-summary", () => getPageData(month));

  const prev          = shiftMonth(month, -1);
  const next          = shiftMonth(month, +1);
  const isLatestMonth = month >= defaultMonth;

  return (
    <>
      <DashboardTopBar title="สรุปการเงิน" />

      <div className="p-4 sm:p-6 space-y-5">

        {/* Month navigation */}
        <div className="flex items-center justify-between">
          <Link
            href={`/financial-summary?month=${prev}`}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
            เดือนก่อน
          </Link>

          <h2 className="text-base font-semibold text-slate-800">{thaiMonth(month)}</h2>

          <Link
            href={`/financial-summary?month=${next}`}
            className={`flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors ${
              isLatestMonth ? "invisible pointer-events-none" : ""
            }`}
          >
            เดือนถัดไป
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </Link>
        </div>

        <FinancialTable
          groups={groups}
          initialSettlements={settlements}
        />

      </div>
    </>
  );
}
