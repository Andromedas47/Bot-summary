import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";
import type { SettlementTotals, TransactionTotals } from "@/lib/summary/transactions";

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
