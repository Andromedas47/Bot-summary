"use client";

import type { Database } from "@/types/database";
import { displayMarketName } from "@/lib/market";

export type DailyRow = Database["public"]["Views"]["produce_transactions"]["Row"];

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

function fmtTime(d: string | null | undefined): string {
  if (!d) return "—";
  if (/^\d{1,2}[:.]\d{2}$/.test(d)) return d.replace(".", ":");
  return new Intl.DateTimeFormat("th-TH", {
    hour:     "2-digit",
    minute:   "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date(d));
}

function TxBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    เบิก:      "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60",
    เบิกเพิ่ม: "bg-green-50 text-green-700 ring-1 ring-green-200/60",
    คืน:       "bg-blue-50 text-blue-700 ring-1 ring-blue-200/60",
    คืนเสีย:   "bg-red-50 text-red-700 ring-1 ring-red-200/60",
  };
  const cls = styles[type] ?? "bg-slate-50 text-slate-600 ring-1 ring-slate-200/60";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {type}
    </span>
  );
}

const TH = "px-3 py-2.5 text-left text-[0.6875rem] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap";
const TD = "px-3 py-2.5 text-sm";

export function DailyTable({ rows }: { rows: DailyRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <div className="flex size-14 items-center justify-center rounded-full bg-slate-100 mb-4">
          <svg className="size-7" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-slate-600">ไม่มีข้อมูลในช่วงที่เลือก</p>
        <p className="text-xs mt-1 text-slate-400">ลองเปลี่ยนตัวกรองหรือช่วงวันที่</p>
      </div>
    );
  }

  return (
    <div>
      {/* Mobile card list — compact view for small screens */}
      <ul className="divide-y divide-slate-100 sm:hidden">
        {rows.map((row) => (
          <li
            key={row.id}
            className="px-4 py-3 transition-colors hover:bg-[#06C755]/5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <TxBadge type={row.transaction_type} />
                <span className="truncate text-sm font-medium text-slate-900">
                  {row.product_name}
                </span>
              </div>
              <span className="shrink-0 text-sm font-semibold text-slate-900 tabular-nums">
                {fmt(row.total_amount, 2)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-slate-500">
              <span>
                {fmtDate(row.transaction_date)}{" "}
                {fmtTime(row.transaction_time ?? row.session_created_at)}
              </span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span>{row.staff_name}</span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span>{displayMarketName(row.market_name)}</span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span className="tabular-nums">
                {fmt(row.quantity, 3)} {row.unit ?? ""} · {fmt(row.price_per_unit, 2)}/หน่วย
              </span>
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop table — full column view */}
      <div className="hidden sm:block overflow-x-auto [-webkit-overflow-scrolling:touch]">
        <table className="w-full min-w-225 border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 border-y border-slate-200">
              <th className={`${TH} w-28`}>วันที่รายการ</th>
              <th className={`${TH} w-20`}>เวลา</th>
              <th className={`${TH} w-28`}>ชื่อใน prefix</th>
              <th className={`${TH} w-28`}>คนขาย</th>
              <th className={`${TH} w-32`}>ตลาด</th>
              <th className={`${TH} w-28`}>ประเภท</th>
              <th className={`${TH} w-10 text-right`}>ลำดับ</th>
              <th className={`${TH} min-w-36`}>สินค้า</th>
              <th className={`${TH} w-20 text-right`}>จำนวน</th>
              <th className={`${TH} w-14`}>หน่วย</th>
              <th className={`${TH} w-24 text-right`}>ราคา/หน่วย</th>
              <th className={`${TH} w-28 text-right`}>รวม</th>
              <th className={`${TH} min-w-28 text-slate-400`}>หมายเหตุ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.id}
                className={`border-b border-slate-100 transition-colors hover:bg-[#06C755]/5 ${
                  i % 2 === 0 ? "bg-white" : "bg-slate-50/40"
                }`}
              >
                <td className={`${TD} whitespace-nowrap text-slate-700`}>
                  {fmtDate(row.transaction_date)}
                </td>
                <td className={`${TD} whitespace-nowrap tabular-nums text-slate-500`}>
                  {fmtTime(row.transaction_time ?? row.session_created_at)}
                </td>
                <td className={`${TD} whitespace-nowrap text-slate-500`}>
                  {row.sender_name ?? row.staff_name}
                </td>
                <td className={`${TD} whitespace-nowrap font-medium text-slate-700`}>
                  {row.staff_name}
                </td>
                <td className={`${TD} text-slate-600`}>
                  {displayMarketName(row.market_name)}
                </td>
                <td className={TD}>
                  <TxBadge type={row.transaction_type} />
                </td>
                <td className={`${TD} text-right tabular-nums text-slate-400`}>
                  {row.item_number ?? ""}
                </td>
                <td className={`${TD} font-medium text-slate-900`}>
                  {row.product_name}
                </td>
                <td className={`${TD} text-right tabular-nums text-slate-700`}>
                  {fmt(row.quantity, 3)}
                </td>
                <td className={`${TD} text-slate-500`}>
                  {row.unit ?? "—"}
                </td>
                <td className={`${TD} text-right tabular-nums text-slate-700`}>
                  {fmt(row.price_per_unit, 2)}
                </td>
                <td className={`${TD} text-right tabular-nums font-semibold text-slate-900`}>
                  {fmt(row.total_amount, 2)}
                </td>
                <td className={`${TD} text-slate-300`}>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
