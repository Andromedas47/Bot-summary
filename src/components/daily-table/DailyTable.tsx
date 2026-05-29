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
  // If already "HH:MM" or "HH.MM" string (from transaction_time), return as-is
  if (/^\d{1,2}[:.]\d{2}$/.test(d)) return d.replace(".", ":");
  // Otherwise parse as ISO timestamp
  return new Intl.DateTimeFormat("th-TH", {
    hour:     "2-digit",
    minute:   "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date(d));
}

function TxBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    เบิก:      "bg-green-100 text-green-800",
    เบิกเพิ่ม: "bg-emerald-100 text-emerald-800",
    คืน:       "bg-blue-100 text-blue-800",
    คืนเสีย:   "bg-red-100 text-red-700",
  };
  const cls = styles[type] ?? "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${cls}`}>
      {type}
    </span>
  );
}

const TH = "px-2.5 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap";
const TD = "px-2.5 py-2 text-sm";

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
      <table className="w-full min-w-225 border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-100 shadow-sm">
          <tr className="border-b-2 border-slate-300">
            <th className={`${TH} w-28`}>วันที่รายการ</th>
            <th className={`${TH} w-20`}>เวลา</th>
            <th className={`${TH} w-28`}>ผู้ส่ง LINE</th>
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
              className={`border-b border-slate-100 hover:bg-emerald-50/50 transition-colors ${
                i % 2 === 0 ? "bg-white" : "bg-slate-50/50"
              }`}
            >
              <td className={`${TD} whitespace-nowrap text-slate-700`}>
                {fmtDate(row.transaction_date)}
              </td>
              <td className={`${TD} whitespace-nowrap tabular-nums text-slate-500`}>
                {fmtTime(row.transaction_time ?? row.session_created_at)}
              </td>
              <td className={`${TD} whitespace-nowrap text-slate-600`}>
                {row.sender_name ?? row.staff_name}
              </td>
              <td className={`${TD} whitespace-nowrap font-medium text-slate-700`}>
                {row.staff_name}
              </td>
              <td className={`${TD} text-slate-700`}>
                {displayMarketName(row.market_name)}
              </td>
              <td className={`${TD}`}>
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
              <td className={`${TD} text-slate-600`}>
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
  );
}
