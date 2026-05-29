"use client";

import { useState, useRef } from "react";

export interface GroupRow {
  date:    string;
  time:    string | null;
  seller:  string;
  market:  string;
  เบิก:    number;
  คืน:     number;
  คืนเสีย: number;
  ยอดส่ง:  number;
}

export interface SettlementEntry {
  settlement_date: string;
  settlement_time: string;
  staff_name:      string;
  market_name:     string;
  money_transfer:  number;
  money_cash:      number;
}

interface CellState {
  money_transfer: number;
  money_cash:     number;
}

function gk(date: string, time: string | null, seller: string, market: string) {
  return `${date}||${time ?? ""}||${seller}||${market}`;
}

function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: dec });
}

function fmtDate(d: string): string {
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "2-digit" })
    .format(new Date(d + "T00:00:00"));
}

const TH = "px-3 py-2 text-left text-xs font-semibold text-slate-600 whitespace-nowrap";
const TD = "px-3 py-2 text-sm tabular-nums";

function DiffCell({ value }: { value: number }) {
  if (value === 0) return <td className={`${TD} text-right text-slate-400`}>0</td>;
  if (value > 0)   return <td className={`${TD} text-right font-semibold text-green-700`}>+{fmtNum(value)}</td>;
  return <td className={`${TD} text-right font-semibold text-red-600`}>{fmtNum(value)}</td>;
}

const INPUT_CLS =
  "w-24 rounded border border-slate-200 bg-transparent px-2 py-0.5 text-right text-sm tabular-nums " +
  "outline-none focus:border-blue-400 focus:bg-white focus:ring-0 hover:border-slate-300";

export function FinancialTable({
  groups,
  initialSettlements,
  month,
}: {
  groups:              GroupRow[];
  initialSettlements:  SettlementEntry[];
  month:               string;
}) {
  const [cells, setCells] = useState<Map<string, CellState>>(() => {
    const m = new Map<string, CellState>();
    for (const s of initialSettlements) {
      m.set(gk(s.settlement_date, s.settlement_time || null, s.staff_name, s.market_name), {
        money_transfer: s.money_transfer,
        money_cash:     s.money_cash,
      });
    }
    return m;
  });

  const savingKeys = useRef<Set<string>>(new Set());

  function getCell(key: string): CellState {
    return cells.get(key) ?? { money_transfer: 0, money_cash: 0 };
  }

  function handleChange(key: string, field: keyof CellState, raw: string) {
    const value = parseFloat(raw) || 0;
    setCells(prev => {
      const cur = prev.get(key) ?? { money_transfer: 0, money_cash: 0 };
      return new Map(prev).set(key, { ...cur, [field]: value });
    });
  }

  async function handleBlur(group: GroupRow, key: string) {
    if (savingKeys.current.has(key)) return;
    savingKeys.current.add(key);
    const cur = cells.get(key) ?? { money_transfer: 0, money_cash: 0 };
    try {
      await fetch("/api/settlement", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settlement_date: group.date,
          settlement_time: group.time ?? "",
          staff_name:      group.seller,
          market_name:     group.market,
          money_transfer:  cur.money_transfer,
          money_cash:      cur.money_cash,
        }),
      });
    } catch (err) {
      console.error("settlement save failed", err);
    } finally {
      savingKeys.current.delete(key);
    }
  }

  // Grand totals (live — includes current cell state)
  let grandเบิก = 0, grandคืน = 0, grandคืนเสีย = 0, grandยอดส่ง = 0,
      grandโอน = 0, grandสด = 0;
  for (const g of groups) {
    const c = getCell(gk(g.date, g.time, g.seller, g.market));
    grandเบิก    += g.เบิก;
    grandคืน     += g.คืน;
    grandคืนเสีย += g.คืนเสีย;
    grandยอดส่ง  += g.ยอดส่ง;
    grandโอน     += c.money_transfer;
    grandสด      += c.money_cash;
  }
  const grandยอดขาย = grandโอน + grandสด;
  const grandขาดเกิน = grandยอดขาย - grandยอดส่ง;

  return (
    <div className="space-y-5">
      {/* Grand totals bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        {[
          { label: "เบิกรวม",   value: grandเบิก,    cls: "text-green-700" },
          { label: "คืนรวม",    value: grandคืน,     cls: "text-blue-700" },
          { label: "คืนเสียรวม", value: grandคืนเสีย, cls: "text-red-600" },
          { label: "ยอดส่งรวม", value: grandยอดส่ง,  cls: "text-slate-800" },
          { label: "ยอดขายรวม", value: grandยอดขาย,  cls: "text-slate-800" },
        ].map(({ label, value, cls }) => (
          <div key={label} className="text-center">
            <div className="text-xs text-slate-500">{label}</div>
            <div className={`text-lg font-bold tabular-nums ${cls}`}>{fmtNum(value)}</div>
          </div>
        ))}
      </div>

      {/* Main table */}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-slate-100 border-b-2 border-slate-300">
            <tr>
              <th className={TH}>วันที่</th>
              <th className={TH}>เวลา</th>
              <th className={TH}>คนขาย</th>
              <th className={TH}>ตลาด</th>
              <th className={`${TH} text-right text-green-700`}>เบิก</th>
              <th className={`${TH} text-right text-blue-700`}>คืน</th>
              <th className={`${TH} text-right text-red-600`}>คืนเสีย</th>
              <th className={`${TH} text-right`}>ยอดส่ง</th>
              <th className={`${TH} text-right text-indigo-600`}>เงินโอน</th>
              <th className={`${TH} text-right text-amber-600`}>เงินสด</th>
              <th className={`${TH} text-right`}>ยอดขาย</th>
              <th className={`${TH} text-right`}>ขาด/เกิน</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-3 py-8 text-center text-sm text-slate-400">
                  ไม่มีข้อมูลในเดือนนี้
                </td>
              </tr>
            ) : (
              groups.map((g, i) => {
                const k       = gk(g.date, g.time, g.seller, g.market);
                const c       = getCell(k);
                const ยอดขาย  = c.money_transfer + c.money_cash;
                const ขาดเกิน = ยอดขาย - g.ยอดส่ง;

                return (
                  <tr
                    key={k}
                    className={`border-b border-slate-100 hover:bg-slate-50 ${
                      i % 2 === 0 ? "bg-white" : "bg-slate-50/40"
                    }`}
                  >
                    <td className={`${TD} whitespace-nowrap font-medium text-slate-700`}>
                      {fmtDate(g.date)}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-slate-500`}>
                      {g.time ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-slate-700`}>{g.seller}</td>
                    <td className={`${TD} text-slate-600`}>{g.market}</td>
                    <td className={`${TD} text-right text-green-800`}>
                      {g.เบิก > 0 ? fmtNum(g.เบิก) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className={`${TD} text-right text-blue-800`}>
                      {fmtNum(g.คืน)}
                    </td>
                    <td className={`${TD} text-right text-red-700`}>
                      {fmtNum(g.คืนเสีย)}
                    </td>
                    <td className={`${TD} text-right font-semibold text-slate-800`}>
                      {fmtNum(g.ยอดส่ง)}
                    </td>
                    <td className={`px-3 py-1.5 text-right`}>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={c.money_transfer || ""}
                        placeholder="0"
                        className={INPUT_CLS}
                        onChange={e => handleChange(k, "money_transfer", e.target.value)}
                        onBlur={() => handleBlur(g, k)}
                      />
                    </td>
                    <td className={`px-3 py-1.5 text-right`}>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={c.money_cash || ""}
                        placeholder="0"
                        className={INPUT_CLS}
                        onChange={e => handleChange(k, "money_cash", e.target.value)}
                        onBlur={() => handleBlur(g, k)}
                      />
                    </td>
                    <td className={`${TD} text-right font-semibold text-slate-800`}>
                      {fmtNum(ยอดขาย)}
                    </td>
                    <DiffCell value={ขาดเกิน} />
                  </tr>
                );
              })
            )}
          </tbody>
          {groups.length > 0 && (
            <tfoot className="border-t-2 border-slate-300 bg-amber-50">
              <tr>
                <td colSpan={4} className={`${TD} font-bold text-slate-700`}>
                  รวม {groups.length} กลุ่ม
                </td>
                <td className={`${TD} text-right font-bold text-green-800`}>{fmtNum(grandเบิก)}</td>
                <td className={`${TD} text-right font-bold text-blue-800`}>{fmtNum(grandคืน)}</td>
                <td className={`${TD} text-right font-bold text-red-700`}>{fmtNum(grandคืนเสีย)}</td>
                <td className={`${TD} text-right font-bold text-slate-800`}>{fmtNum(grandยอดส่ง)}</td>
                <td className={`${TD} text-right font-bold text-indigo-800`}>{fmtNum(grandโอน)}</td>
                <td className={`${TD} text-right font-bold text-amber-700`}>{fmtNum(grandสด)}</td>
                <td className={`${TD} text-right font-bold text-slate-800`}>{fmtNum(grandยอดขาย)}</td>
                <DiffCell value={grandขาดเกิน} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-xs text-slate-400">
        * ยอดส่ง = เบิก − คืน − คืนเสีย &nbsp;·&nbsp; ยอดขาย = เงินโอน + เงินสด &nbsp;·&nbsp;
        ขาด/เกิน = ยอดขาย − ยอดส่ง &nbsp;·&nbsp; กรอกเงินโอน/เงินสด แล้วคลิกออกเพื่อบันทึก
      </p>
    </div>
  );
}
