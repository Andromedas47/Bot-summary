import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";
import type { SettlementTotals, TransactionTotals } from "@/lib/summary/transactions";
import type { ReconciliationResult } from "@/lib/reconciliation";

function fmt(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface SettlementLineMessageInput {
  date: string;
  staffName: string;
  marketName: string;
  transactions: TransactionTotals;
  settlement: SettlementTotals;
  notes?: string;
}

export function buildSettlementLineMessage(input: SettlementLineMessageInput): string {
  const market = displayMarketName(input.marketName, "");
  const title = market ? `${input.staffName} — ${market}` : input.staffName;
  const diff = input.settlement.ขาดเกิน;
  const diffLine =
    diff === 0
      ? "ผลตรวจ: ยอดตรงกัน"
      : diff > 0
        ? `ผลตรวจ: เกิน ${fmt(diff)} บาท`
        : `ผลตรวจ: ขาด ${fmt(Math.abs(diff))} บาท`;

  const lines = [
    "รายการส่งเงิน ✅",
    "",
    `${title} — ${formatThaiDate(input.date)}`,
    "",
    `ยอดขายสุทธิที่คำนวณได้: ${fmt(input.transactions.ยอดส่ง)} บาท`,
    `เงินโอน: ${fmt(input.settlement.ยอดโอน)} บาท`,
    `เงินสด: ${fmt(input.settlement.เงินสด)} บาท`,
    `ค่าใช้จ่าย: ${fmt(input.settlement.ค่าใช้จ่าย)} บาท`,
    `ค่าแรง: ${fmt(input.settlement.ค่าแรง)} บาท`,
    `ยอดขายจากรายการส่งเงิน: ${fmt(input.settlement.ยอดขาย)} บาท`,
    diffLine,
    `เงินสดที่ควรเหลือส่งเจ๊: ${fmt(input.settlement.เงินสดต้องส่งเจ๊)} บาท`,
  ];

  if (input.notes?.trim()) {
    lines.push("", `หมายเหตุ: ${input.notes.trim()}`);
  }

  return lines.join("\n");
}

export interface FinalSettlementMessageInput {
  date:           string;
  staffName:      string;
  marketName:     string;
  transactions:   TransactionTotals;
  settlement:     SettlementTotals;
  reconciliation: ReconciliationResult;
  notes?:         string;
}

export function buildFinalSettlementMessage(input: FinalSettlementMessageInput): string {
  const market = displayMarketName(input.marketName, "");
  const title  = market ? `${input.staffName} — ${market}` : input.staffName;
  const s      = input.settlement;
  const r      = input.reconciliation;

  const salesDiffLine =
    s.ขาดเกิน === 0
      ? "ผลตรวจ: ยอดตรงกัน"
      : s.ขาดเกิน > 0
        ? `ผลตรวจ: เกิน ${fmt(s.ขาดเกิน)} บาท`
        : `ผลตรวจ: ขาด ${fmt(Math.abs(s.ขาดเกิน))} บาท`;

  const slipDiffLine =
    r.difference === 0
      ? "ผลตรวจสลิป: ตรงกัน"
      : r.difference > 0
        ? `ผลตรวจสลิป: เกิน ${fmt(r.difference)} บาท`
        : `ผลตรวจสลิป: ขาด ${fmt(Math.abs(r.difference))} บาท`;

  const lines = [
    "รายการส่งเงิน ✅ (ยืนยันแล้ว)",
    "",
    `${title} — ${formatThaiDate(input.date)}`,
    "",
    `ยอดขายสุทธิที่คำนวณได้: ${fmt(input.transactions.ยอดส่ง)} บาท`,
    `เงินโอน: ${fmt(s.ยอดโอน)} บาท`,
    `เงินสด: ${fmt(s.เงินสด)} บาท`,
    `ค่าใช้จ่าย: ${fmt(s.ค่าใช้จ่าย)} บาท`,
    `ค่าแรง: ${fmt(s.ค่าแรง)} บาท`,
    `ยอดขายจากรายการส่งเงิน: ${fmt(s.ยอดขาย)} บาท`,
    salesDiffLine,
    `เงินสดที่ควรเหลือส่งเจ๊: ${fmt(s.เงินสดต้องส่งเจ๊)} บาท`,
    "",
    "— ตรวจสลิปโอน —",
    `ยอดสลิป AI: ${fmt(r.ai_verified_total)} บาท`,
    `ยอดสลิปมือ: ${fmt(r.manual_slip_total)} บาท`,
    `ยอดสลิปรวม: ${fmt(r.checked_slip_total)} บาท`,
    `ยอดโอนที่แจ้ง: ${fmt(r.submitted_transfer_total)} บาท`,
    slipDiffLine,
  ];

  if (input.notes?.trim()) {
    lines.push("", `หมายเหตุ: ${input.notes.trim()}`);
  }

  return lines.join("\n");
}
