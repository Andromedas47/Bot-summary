"use client";

import {
  displayRemainingUnit,
  formatQuantity,
  type RemainingFruitItem,
  type RemainingFruitReport,
} from "@/lib/summary/remaining-fruit";

function formatCell(item: RemainingFruitItem, field: "remaining" | "withdrawn" | "damaged"): string {
  if (field === "remaining") {
    if (item.hasReturnGoodData) {
      return formatQuantity(item.remainingForResaleQuantity);
    }
    if (item.hasWithdrawnData || item.hasDamagedData) {
      return "ยังไม่มีข้อมูลชั่งคืน";
    }
    return "—";
  }
  if (field === "withdrawn") {
    return item.hasWithdrawnData ? formatQuantity(item.withdrawnQuantity) : "—";
  }
  return item.hasDamagedData ? formatQuantity(item.damagedQuantity) : "—";
}

function ItemTable({ items }: { items: RemainingFruitItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-500">ไม่มีรายการ</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-slate-600">
          <tr>
            <th className="px-3 py-2 font-semibold">ผลไม้</th>
            <th className="px-3 py-2 font-semibold">หน่วย</th>
            <th className="px-3 py-2 text-right font-semibold">เบิกทั้งหมด</th>
            <th className="px-3 py-2 text-right font-semibold">เหลือขายต่อ</th>
            <th className="px-3 py-2 text-right font-semibold">คืนเสีย</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.fruitName}||${item.unit}`} className="border-t border-slate-100">
              <td className="px-3 py-2">{item.fruitName}</td>
              <td className="px-3 py-2">{displayRemainingUnit(item.unit)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCell(item, "withdrawn")}</td>
              <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">
                {formatCell(item, "remaining")}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCell(item, "damaged")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RemainingFruitSection({ report }: { report: RemainingFruitReport }) {
  if (report.markets.length === 0 && report.overall.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        ไม่พบข้อมูลเบิก/ชั่งคืน/คืนเสียสำหรับวันที่เลือก
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-600">
        ตัวเลข <span className="font-medium">เหลือขายต่อ</span> มาจากผลไม้ที่ชั่งคืนและยังขายต่อได้
        — ไม่ใช่ยอดคลังสินค้าทั้งหมด
      </p>

      {report.markets.map((section) => (
        <div key={section.marketName} className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-800">{section.marketName}</h3>
          <ItemTable items={section.items} />
        </div>
      ))}

      {report.overall.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-800">สรุปคงเหลือรวมทุกตลาด</h3>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-semibold">ผลไม้</th>
                  <th className="px-3 py-2 font-semibold">หน่วย</th>
                  <th className="px-3 py-2 text-right font-semibold">เหลือขายต่อทั้งหมด</th>
                  <th className="px-3 py-2 font-semibold">แยกตามตลาด</th>
                </tr>
              </thead>
              <tbody>
                {report.overall.map((row) => (
                  <tr key={`${row.fruitName}||${row.unit}`} className="border-t border-slate-100">
                    <td className="px-3 py-2">{row.fruitName}</td>
                    <td className="px-3 py-2">{displayRemainingUnit(row.unit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">
                      {formatQuantity(row.totalRemainingForResale)}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {row.marketBreakdown
                        .map((entry) =>
                          `${entry.marketName}: ${formatQuantity(entry.quantity)} ${displayRemainingUnit(row.unit)}`,
                        )
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
