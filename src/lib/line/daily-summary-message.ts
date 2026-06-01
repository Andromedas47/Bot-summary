import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";

export interface DailySummaryMessageRow {
  summary_date: string;
  staff_name: string;
  market_name: string;
  borrow_total: number;
  return_total: number;
  bad_return_total: number;
  net_sales: number;
  transaction_count: number;
}

function fmt(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function buildDailySummaryMessage(date: string, rows: DailySummaryMessageRow[]): string {
  const lines = [
    `สรุปยอดประจำวันที่ ${formatThaiDate(date)}`,
  ];

  for (const row of rows) {
    const market = displayMarketName(row.market_name, "");
    const title = market ? `${row.staff_name} — ${market}` : row.staff_name;

    lines.push(
      "",
      title,
      `เบิกรวม: ${fmt(Number(row.borrow_total))} บาท`,
      `คืนรวม: ${fmt(Number(row.return_total))} บาท`,
      `คืนเสียรวม: ${fmt(Number(row.bad_return_total))} บาท`,
      `ยอดส่ง: ${fmt(Number(row.net_sales))} บาท`,
    );
  }

  return lines.join("\n");
}
