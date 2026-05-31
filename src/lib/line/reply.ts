import { logger } from "@/lib/logger";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";

export async function replyLineMessage(replyToken: string, text: string): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    logger.error("LINE reply failed", { status: res.status, body: errorText });
    throw new Error(`LINE reply HTTP ${res.status}: ${errorText}`);
  }
}

function fmt(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function buildWeighSessionSummary(session: WeighSession): string {
  let borrowTotal    = 0;
  let returnTotal    = 0;
  let badReturnTotal = 0;

  for (const item of session.items) {
    const amount = (item.price_per_unit ?? 0) * (item.quantity ?? 0);
    if (item.transaction_type === "เบิก" || item.transaction_type === "เบิกเพิ่ม") {
      borrowTotal += amount;
    } else if (item.transaction_type === "คืน") {
      returnTotal += amount;
    } else if (item.transaction_type === "คืนเสีย") {
      badReturnTotal += amount;
    }
  }

  const netSendTotal = borrowTotal - returnTotal - badReturnTotal;
  const itemCount    = session.items.length;

  const lines = [
    "บันทึกข้อมูลเรียบร้อย ✅",
    "",
    `สรุป: ${session.staff_name}`,
    `รายการทั้งหมด: ${itemCount} รายการ`,
    "",
    `เบิกรวม: ${fmt(borrowTotal)} บาท`,
    `คืนรวม: ${fmt(returnTotal)} บาท`,
    `คืนเสียรวม: ${fmt(badReturnTotal)} บาท`,
    "",
    `ยอดส่งสุทธิ: ${fmt(netSendTotal)} บาท`,
  ];

  return lines.join("\n");
}
