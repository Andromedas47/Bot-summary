export interface DailyRow {
  id:             string;
  item_number:    number | null;
  product_name:   string;
  price_per_unit: number | null;
  quantity:       number | null;
  unit:           string | null;
  section:        string;
  created_at:     string;
  produce_sessions: {
    session_date:  string | null;
    session_title: string | null;
    staff_name:    string;
  } | null;
}

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return "—";
  return n.toLocaleString("th-TH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("th-TH", {
    day:   "numeric",
    month: "short",
    year:  "2-digit",
  }).format(new Date(d + "T00:00:00"));
}

const TH = "px-3 py-2.5 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap";
const TD = "px-3 py-2 text-sm";

export function DailyTable({ rows }: { rows: DailyRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <svg className="size-12 mb-3" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125" />
        </svg>
        <p className="text-sm font-medium">ไม่มีข้อมูลในช่วงที่เลือก</p>
        <p className="text-xs mt-1">ลองเปลี่ยนตัวกรองหรือช่วงวันที่</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-325 border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-100 shadow-sm">
          <tr className="border-b-2 border-slate-300">
            <th className={`${TH} w-10 text-right`}>#</th>
            <th className={`${TH} w-28`}>วันที่</th>
            <th className={`${TH} w-36`}>ตลาด</th>
            <th className={`${TH} w-32`}>คนขาย</th>
            <th className={`${TH} min-w-40`}>รายการ</th>
            <th className={`${TH} w-20 text-right`}>จำนวน</th>
            <th className={`${TH} w-16`}>หน่วย</th>
            <th className={`${TH} w-24 text-right`}>ราคา/หน่วย</th>
            <th className={`${TH} w-28 text-right`}>ยอดรวม</th>
            <th className={`${TH} w-24 text-right text-slate-400`}>เงินโอน</th>
            <th className={`${TH} w-24 text-right text-slate-400`}>เงินสด</th>
            <th className={`${TH} w-28 text-right text-slate-400`}>ค่าใช้จ่าย</th>
            <th className={`${TH} w-24 text-right text-slate-400`}>คงเหลือ</th>
            <th className={`${TH} min-w-30 text-slate-400`}>หมายเหตุ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const s     = row.produce_sessions;
            const total = row.quantity != null && row.price_per_unit != null
              ? row.quantity * row.price_per_unit
              : null;

            return (
              <tr
                key={row.id}
                className={`border-b border-slate-100 hover:bg-emerald-50/50 transition-colors ${
                  i % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                }`}
              >
                <td className={`${TD} text-right tabular-nums text-slate-400`}>
                  {row.item_number ?? ""}
                </td>
                <td className={`${TD} whitespace-nowrap text-slate-700`}>
                  {fmtDate(s?.session_date)}
                </td>
                <td className={`${TD} text-slate-700`}>
                  {s?.session_title ?? "—"}
                </td>
                <td className={`${TD} whitespace-nowrap text-slate-700`}>
                  {s?.staff_name ?? "—"}
                </td>
                <td className={`${TD} font-medium text-slate-900`}>
                  {row.product_name}
                </td>
                <td className={`${TD} text-right tabular-nums text-slate-700`}>
                  {fmt(row.quantity, 3)}
                </td>
                <td className={`${TD} text-slate-600`}>
                  {row.unit ?? "—"}
                </td>
                <td className={`${TD} text-right tabular-nums text-slate-700`}>
                  {fmt(row.price_per_unit, 2)}
                </td>
                <td className={`${TD} text-right tabular-nums font-semibold text-slate-900`}>
                  {fmt(total, 2)}
                </td>
                <td className={`${TD} text-right text-slate-300`}>—</td>
                <td className={`${TD} text-right text-slate-300`}>—</td>
                <td className={`${TD} text-right text-slate-300`}>—</td>
                <td className={`${TD} text-right text-slate-300`}>—</td>
                <td className={`${TD} text-slate-300`}>—</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
