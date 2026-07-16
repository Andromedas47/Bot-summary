"use client";

import Link from "next/link";
import { toPng } from "html-to-image";
import type { CompareProductRow, CompareReport } from "@/lib/compare-report";

function money(value: number): string {
  return value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qty(values: Record<string, number>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== 0)
    .map(([unit, value]) => `${value.toLocaleString("th-TH", { maximumFractionDigits: 3 })} ${unit}`)
    .join(" / ") || "0";
}

function Bucket({ values }: { values: { quantities: Record<string, number>; amount: number } }) {
  return <><div className="font-medium text-slate-800">{qty(values.quantities)}</div><div className="text-xs tabular-nums text-slate-500">{money(values.amount)} บาท</div></>;
}

function ReportTable({ rows }: { rows: CompareProductRow[] }) {
  return (
    <table className="w-full min-w-240 border-collapse text-sm">
      <thead className="bg-slate-800 text-white print:table-header-group">
        <tr>
          {['รายการ', 'ราคาต่อหน่วย', 'เบิก', 'ชั่งคืน', 'คืนเสีย', 'คงเหลือ'].map((label) => (
            <th key={label} className="px-3 py-2.5 text-left text-xs font-semibold">{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.canonicalName} className="break-inside-avoid border-b border-slate-200 even:bg-slate-50/60">
            <td className="px-3 py-3 align-top">
              <div className="font-semibold text-slate-900">{row.canonicalName}</div>
              {row.sourceNames.some((name) => name !== row.canonicalName) && <div className="mt-1 text-xs text-slate-400">ชื่อเดิม: {row.sourceNames.join(', ')}</div>}
              {row.transactions.some((item) => item.is_corrected) && <span className="mt-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">แก้ไขแล้ว</span>}
              <div className="mt-2 flex flex-wrap gap-2 print:hidden">
                {row.transactions.map((item) => <span key={item.id} className="inline-flex gap-2">
                  <Link href={`/corrections/new?transactionId=${item.id}`} className="text-xs font-medium text-emerald-700 hover:underline">แจ้งแก้ไข</Link>
                  <Link href={`/corrections/new?transactionId=${item.id}&view=original`} className="text-xs text-slate-500 hover:underline">ดูรายการต้นฉบับ</Link>
                </span>)}
              </div>
            </td>
            <td className="px-3 py-3 align-top tabular-nums">{row.prices.map((price) => money(price)).join(' / ') || '—'} บาท</td>
            <td className="px-3 py-3 align-top"><Bucket values={row.issued} /></td>
            <td className="px-3 py-3 align-top"><Bucket values={row.returned} /></td>
            <td className="px-3 py-3 align-top"><Bucket values={row.damaged} /></td>
            <td className="px-3 py-3 align-top"><Bucket values={row.remaining} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Summary({ report }: { report: CompareReport }) {
  const s = report.summary;
  const items = [
    ['ยอดเบิก', money(s.issuedAmount)],
    ['ยอดชั่งคืน', money(s.returnedAmount)],
    ['ยอดคืนเสีย', money(s.damagedAmount)],
    ['ยอดที่ควรรับ', money(s.expectedAmount)],
    ['ยอดตามรายการส่งเงิน', s.settlementAmount == null ? 'รอข้อมูล' : money(s.settlementAmount)],
    ['เงินขาด/เกิน', s.difference == null ? 'ยังไม่สามารถคำนวณได้' : money(s.difference)],
  ];
  return <div className="grid gap-2 border-t border-slate-200 p-4 sm:grid-cols-3 lg:grid-cols-6">
    {items.map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 font-semibold tabular-nums text-slate-900">{value}</div></div>)}
    <div className={`sm:col-span-3 lg:col-span-6 rounded-lg p-3 text-sm ${s.settlementStatus === 'recorded' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}>
      สถานะข้อมูลปิดยอด: {s.settlementStatus === 'recorded' ? 'บันทึกรายการส่งเงินแล้ว' : 'ยังไม่ได้บันทึกรายการส่งเงิน/ใบขาว'}
    </div>
  </div>;
}

export function CompareReportView({ report, worker, date, market }: { report: CompareReport; worker: string; date: string; market?: string }) {
  const pageSize = 14;
  const pages = Array.from({ length: Math.max(1, Math.ceil(report.rows.length / pageSize)) }, (_, index) => report.rows.slice(index * pageSize, (index + 1) * pageSize));

  async function downloadPng() {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-compare-page]'));
    for (let index = 0; index < elements.length; index += 1) {
      const url = await toPng(elements[index], { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true });
      const anchor = document.createElement('a');
      anchor.download = `compare-${worker}-${date}-page-${index + 1}.png`;
      anchor.href = url;
      anchor.click();
    }
  }

  return <>
    <div className="mb-3 flex flex-wrap justify-end gap-2 print:hidden">
      <a href={`/api/pdf/compare-report?date=${encodeURIComponent(date)}&worker=${encodeURIComponent(worker)}${market ? `&market=${encodeURIComponent(market)}` : ''}`} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100">ดาวน์โหลด PDF</a>
      <button type="button" onClick={downloadPng} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">ดาวน์โหลด PNG</button>
      <button type="button" onClick={() => window.print()} className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">พิมพ์ A4</button>
    </div>
    <div className="space-y-4 print:space-y-0">
      {pages.map((rows, index) => <section key={index} data-compare-page className="compare-a4-page overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm print:rounded-none print:border-0 print:shadow-none">
        <header className="flex items-start justify-between border-b border-slate-200 p-4">
          <div><h2 className="text-lg font-bold text-slate-900">รายงานเปรียบเทียบสินค้า</h2><p className="mt-1 text-sm text-slate-500">วันที่ {date} · พนักงาน {worker}{market ? ` · ตลาด ${market}` : ''}</p></div>
          <div className="text-xs text-slate-400">หน้า {index + 1}/{pages.length}</div>
        </header>
        <div className="overflow-x-auto"><ReportTable rows={rows} /></div>
        {index === pages.length - 1 && <><Summary report={report} />{report.corrections.length > 0 && <div className="border-t border-slate-200 p-4"><h3 className="font-semibold text-slate-900">รายการปรับแก้</h3>{report.corrections.map((item) => <p key={item.correctionId} className="mt-2 text-sm text-slate-600">{item.productName} — {item.transactionType}: {money(item.originalAmount ?? 0)} → {money(item.amount)} บาท · {item.reason}</p>)}</div>}</>}
      </section>)}
    </div>
  </>;
}
