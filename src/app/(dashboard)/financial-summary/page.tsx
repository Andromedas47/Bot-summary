import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import Link from "next/link";

interface Summary {
  key: string;
  count: number;
  qty: number;
  amount: number;
}

interface PageProps {
  searchParams: Promise<{ month?: string }>;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthDateRange(month: string): { from: string; toExclusive: string } {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const next = new Date(y, m, 1);
  const toExclusive = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
  return { from, toExclusive };
}

function thaiMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("th-TH", {
    month: "long",
    year:  "numeric",
  }).format(new Date(y, m - 1, 1));
}

function fmtDate(d: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    day:   "numeric",
    month: "short",
    year:  "2-digit",
  }).format(new Date(d + "T00:00:00"));
}

function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString("th-TH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: dec,
  });
}

type TxRow = {
  transaction_date: string | null;
  market_name:      string | null;
  staff_name:       string;
  section:          string;
  quantity:         number | null;
  total_amount:     number | null;
};

function buildAggregations(rows: TxRow[]) {
  const dayMap    = new Map<string, Summary>();
  const sellerMap = new Map<string, Summary>();
  const marketMap = new Map<string, Summary>();
  const catMap    = new Map<string, Summary>();

  const acc = (map: Map<string, Summary>, key: string, qty: number, amt: number) => {
    const p = map.get(key) ?? { key, count: 0, qty: 0, amount: 0 };
    map.set(key, { key, count: p.count + 1, qty: p.qty + qty, amount: p.amount + amt });
  };

  let totalQty = 0;
  let totalAmt = 0;

  for (const r of rows) {
    const date   = r.transaction_date ?? "ไม่ระบุวันที่";
    const seller = r.staff_name       || "ไม่ระบุ";
    const market = r.market_name      || "ไม่ระบุ";
    const cat    = r.section          || "ไม่ระบุ";
    const qty    = r.quantity         ?? 0;
    const amt    = r.total_amount     ?? 0;

    acc(dayMap,    date,   qty, amt);
    acc(sellerMap, seller, qty, amt);
    acc(marketMap, market, qty, amt);
    acc(catMap,    cat,    qty, amt);

    totalQty += qty;
    totalAmt += amt;
  }

  const sortDesc = (m: Map<string, Summary>) =>
    Array.from(m.values()).sort((a, b) => b.amount - a.amount);
  const sortByKey = (m: Map<string, Summary>) =>
    Array.from(m.values()).sort((a, b) => a.key.localeCompare(b.key));

  return {
    days:       sortByKey(dayMap),
    sellers:    sortDesc(sellerMap),
    markets:    sortDesc(marketMap),
    categories: sortDesc(catMap),
    total: { count: rows.length, qty: totalQty, amount: totalAmt },
  };
}

async function getSummary(month: string) {
  const supabase = await createServiceClient();
  const { from, toExclusive } = monthDateRange(month);

  const { data, error } = await supabase
    .from("produce_transactions")
    .select("transaction_date, market_name, staff_name, section, quantity, total_amount")
    .gte("transaction_date", from)
    .lt("transaction_date", toExclusive)
    .limit(10000);

  if (error) throw new Error(error.message);
  return buildAggregations((data ?? []) as TxRow[]);
}

const TH = "px-3 py-2 text-left text-xs font-semibold text-slate-600 whitespace-nowrap";
const TD = "px-3 py-2 text-sm";
const TR_EVEN = "bg-white";
const TR_ODD  = "bg-slate-50/60";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</span>
      <div className="flex-1 h-px bg-slate-200" />
    </div>
  );
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-sm text-slate-400">
        ไม่มีข้อมูล
      </td>
    </tr>
  );
}

export default async function FinancialSummaryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const now    = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const month  = params.month ?? defaultMonth;

  const { days, sellers, markets, categories, total } = await timed("financial-summary", () =>
    getSummary(month),
  );

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
            className={`flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors ${isLatestMonth ? "invisible pointer-events-none" : ""}`}
          >
            เดือนถัดไป
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </Link>
        </div>

        {/* Grand totals bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
          <div className="text-center">
            <div className="text-xs text-slate-500">รายการ</div>
            <div className="text-lg font-bold text-slate-800 tabular-nums">
              {total.count.toLocaleString("th-TH")}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-500">ปริมาณรวม</div>
            <div className="text-lg font-bold text-slate-800 tabular-nums">
              {fmtNum(total.qty, 3)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-500">ยอดรวม</div>
            <div className="text-lg font-bold text-emerald-700 tabular-nums">
              {fmtNum(total.amount, 2)} ฿
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-500">เงินโอน + เงินสด</div>
            <div className="text-lg font-bold text-slate-300 tabular-nums">—</div>
          </div>
        </div>

        {/* ─── สรุปรายวัน ─── */}
        <section>
          <SectionTitle>สรุปรายวัน</SectionTitle>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-slate-100 border-b border-slate-300">
                <tr>
                  <th className={TH}>วันที่</th>
                  <th className={`${TH} text-right`}>รายการ</th>
                  <th className={`${TH} text-right`}>ปริมาณรวม</th>
                  <th className={`${TH} text-right`}>ยอดรวม (฿)</th>
                  <th className={`${TH} text-right text-slate-400`}>เงินโอน</th>
                  <th className={`${TH} text-right text-slate-400`}>เงินสด</th>
                  <th className={`${TH} text-right text-slate-400`}>ผลต่าง</th>
                </tr>
              </thead>
              <tbody>
                {days.length === 0 ? (
                  <EmptyRow cols={7} />
                ) : (
                  days.map((d, i) => (
                    <tr key={d.key} className={`border-b border-slate-100 ${i % 2 === 0 ? TR_EVEN : TR_ODD}`}>
                      <td className={`${TD} whitespace-nowrap font-medium text-slate-700`}>
                        {fmtDate(d.key)}
                      </td>
                      <td className={`${TD} text-right tabular-nums text-slate-600`}>{d.count.toLocaleString("th-TH")}</td>
                      <td className={`${TD} text-right tabular-nums text-slate-600`}>{fmtNum(d.qty, 3)}</td>
                      <td className={`${TD} text-right tabular-nums font-semibold text-slate-800`}>{fmtNum(d.amount)}</td>
                      <td className={`${TD} text-right text-slate-300`}>—</td>
                      <td className={`${TD} text-right text-slate-300`}>—</td>
                      <td className={`${TD} text-right text-slate-300`}>—</td>
                    </tr>
                  ))
                )}
              </tbody>
              {days.length > 0 && (
                <tfoot className="border-t-2 border-slate-300 bg-amber-50">
                  <tr>
                    <td className={`${TD} font-bold text-slate-700`}>รวม {days.length} วัน</td>
                    <td className={`${TD} text-right tabular-nums font-bold text-slate-700`}>{total.count.toLocaleString("th-TH")}</td>
                    <td className={`${TD} text-right tabular-nums font-bold text-slate-700`}>{fmtNum(total.qty, 3)}</td>
                    <td className={`${TD} text-right tabular-nums font-bold text-emerald-700`}>{fmtNum(total.amount)}</td>
                    <td className={`${TD} text-right text-slate-300`}>—</td>
                    <td className={`${TD} text-right text-slate-300`}>—</td>
                    <td className={`${TD} text-right text-slate-300`}>—</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>

        {/* ─── คนขาย + ตลาด ─── */}
        <div className="grid gap-5 lg:grid-cols-2">

          {/* Seller */}
          <section>
            <SectionTitle>สรุปรายคนขาย</SectionTitle>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm border-collapse">
                <thead className="bg-slate-100 border-b border-slate-300">
                  <tr>
                    <th className={TH}>คนขาย</th>
                    <th className={`${TH} text-right`}>รายการ</th>
                    <th className={`${TH} text-right`}>ปริมาณ</th>
                    <th className={`${TH} text-right`}>ยอดรวม (฿)</th>
                    <th className={`${TH} text-right text-slate-400`}>เงินโอน</th>
                    <th className={`${TH} text-right text-slate-400`}>เงินสด</th>
                  </tr>
                </thead>
                <tbody>
                  {sellers.length === 0 ? (
                    <EmptyRow cols={6} />
                  ) : (
                    sellers.map((s, i) => (
                      <tr key={s.key} className={`border-b border-slate-100 ${i % 2 === 0 ? TR_EVEN : TR_ODD}`}>
                        <td className={`${TD} font-medium text-slate-700 whitespace-nowrap`}>{s.key}</td>
                        <td className={`${TD} text-right tabular-nums text-slate-600`}>{s.count.toLocaleString("th-TH")}</td>
                        <td className={`${TD} text-right tabular-nums text-slate-600`}>{fmtNum(s.qty, 3)}</td>
                        <td className={`${TD} text-right tabular-nums font-semibold text-slate-800`}>{fmtNum(s.amount)}</td>
                        <td className={`${TD} text-right text-slate-300`}>—</td>
                        <td className={`${TD} text-right text-slate-300`}>—</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {sellers.length > 0 && (
                  <tfoot className="border-t-2 border-slate-300 bg-amber-50">
                    <tr>
                      <td className={`${TD} font-bold text-slate-700`}>รวม {sellers.length} คน</td>
                      <td className={`${TD} text-right tabular-nums font-bold text-slate-700`}>{total.count.toLocaleString("th-TH")}</td>
                      <td className={`${TD} text-right tabular-nums font-bold text-slate-700`}>{fmtNum(total.qty, 3)}</td>
                      <td className={`${TD} text-right tabular-nums font-bold text-emerald-700`}>{fmtNum(total.amount)}</td>
                      <td className={`${TD} text-right text-slate-300`}>—</td>
                      <td className={`${TD} text-right text-slate-300`}>—</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>

          {/* Market */}
          <section>
            <SectionTitle>สรุปรายตลาด</SectionTitle>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm border-collapse">
                <thead className="bg-slate-100 border-b border-slate-300">
                  <tr>
                    <th className={TH}>ตลาด</th>
                    <th className={`${TH} text-right`}>รายการ</th>
                    <th className={`${TH} text-right`}>ปริมาณ</th>
                    <th className={`${TH} text-right`}>ยอดรวม (฿)</th>
                    <th className={`${TH} text-right text-slate-400`}>เงินโอน</th>
                    <th className={`${TH} text-right text-slate-400`}>เงินสด</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.length === 0 ? (
                    <EmptyRow cols={6} />
                  ) : (
                    markets.map((m, i) => (
                      <tr key={m.key} className={`border-b border-slate-100 ${i % 2 === 0 ? TR_EVEN : TR_ODD}`}>
                        <td className={`${TD} font-medium text-slate-700`}>{m.key}</td>
                        <td className={`${TD} text-right tabular-nums text-slate-600`}>{m.count.toLocaleString("th-TH")}</td>
                        <td className={`${TD} text-right tabular-nums text-slate-600`}>{fmtNum(m.qty, 3)}</td>
                        <td className={`${TD} text-right tabular-nums font-semibold text-slate-800`}>{fmtNum(m.amount)}</td>
                        <td className={`${TD} text-right text-slate-300`}>—</td>
                        <td className={`${TD} text-right text-slate-300`}>—</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {markets.length > 0 && (
                  <tfoot className="border-t-2 border-slate-300 bg-amber-50">
                    <tr>
                      <td className={`${TD} font-bold text-slate-700`}>รวม {markets.length} ตลาด</td>
                      <td className={`${TD} text-right tabular-nums font-bold text-slate-700`}>{total.count.toLocaleString("th-TH")}</td>
                      <td className={`${TD} text-right tabular-nums font-bold text-slate-700`}>{fmtNum(total.qty, 3)}</td>
                      <td className={`${TD} text-right tabular-nums font-bold text-emerald-700`}>{fmtNum(total.amount)}</td>
                      <td className={`${TD} text-right text-slate-300`}>—</td>
                      <td className={`${TD} text-right text-slate-300`}>—</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>

        </div>

        {/* ─── หมวดสินค้า ─── */}
        <section>
          <SectionTitle>สรุปรายหมวดสินค้า</SectionTitle>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-slate-100 border-b border-slate-300">
                <tr>
                  <th className={TH}>หมวดสินค้า</th>
                  <th className={`${TH} text-right`}>รายการ</th>
                  <th className={`${TH} text-right`}>ปริมาณรวม</th>
                  <th className={`${TH} text-right`}>ยอดรวม (฿)</th>
                  <th className={`${TH} text-right`}>สัดส่วน %</th>
                </tr>
              </thead>
              <tbody>
                {categories.length === 0 ? (
                  <EmptyRow cols={5} />
                ) : (
                  categories.map((c, i) => (
                    <tr key={c.key} className={`border-b border-slate-100 ${i % 2 === 0 ? TR_EVEN : TR_ODD}`}>
                      <td className={`${TD} font-medium text-slate-700`}>{c.key}</td>
                      <td className={`${TD} text-right tabular-nums text-slate-600`}>{c.count.toLocaleString("th-TH")}</td>
                      <td className={`${TD} text-right tabular-nums text-slate-600`}>{fmtNum(c.qty, 3)}</td>
                      <td className={`${TD} text-right tabular-nums font-semibold text-slate-800`}>{fmtNum(c.amount)}</td>
                      <td className={`${TD} text-right tabular-nums text-slate-500`}>
                        {total.amount > 0 ? `${((c.amount / total.amount) * 100).toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {categories.length > 0 && (
                <tfoot className="border-t-2 border-slate-300 bg-amber-50">
                  <tr>
                    <td className={`${TD} font-bold text-slate-700`}>รวม {categories.length} หมวด</td>
                    <td className={`${TD} text-right tabular-nums font-bold text-slate-700`}>{total.count.toLocaleString("th-TH")}</td>
                    <td className={`${TD} text-right tabular-nums font-bold text-slate-700`}>{fmtNum(total.qty, 3)}</td>
                    <td className={`${TD} text-right tabular-nums font-bold text-emerald-700`}>{fmtNum(total.amount)}</td>
                    <td className={`${TD} text-right tabular-nums font-bold text-slate-500`}>100%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>

      </div>
    </>
  );
}
