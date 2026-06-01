import { logger } from "@/lib/logger";
import { formatThaiDate } from "@/lib/date";
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
  let borrowCount    = 0;
  let returnCount    = 0;
  let badReturnCount = 0;
  let borrowTotal    = 0;
  let returnTotal    = 0;
  let badReturnTotal = 0;

  for (const item of session.items) {
    const amount = (item.price_per_unit ?? 0) * (item.quantity ?? 0);
    if (item.transaction_type === "เบิก" || item.transaction_type === "เบิกเพิ่ม") {
      borrowTotal += amount;
      borrowCount++;
    } else if (item.transaction_type === "คืน") {
      returnTotal += amount;
      returnCount++;
    } else if (item.transaction_type === "คืนเสีย") {
      badReturnTotal += amount;
      badReturnCount++;
    }
  }

  const hasBorrow    = borrowCount > 0;
  const hasReturn    = returnCount > 0;
  const hasBadReturn = badReturnCount > 0;
  const hasMixed     = hasBorrow && (hasReturn || hasBadReturn);

  const dateLabel = session.date ? formatThaiDate(session.date) : "";
  const header = [
    "บันทึกแล้ว ✅",
    "",
    `${session.staff_name}${dateLabel ? ` — ${dateLabel}` : ""}`,
  ];

  const body: string[] = [];

  if (hasBorrow) {
    body.push(`เบิก: ${borrowCount} รายการ รวม ${fmt(borrowTotal)} บาท`);
  }
  if (hasReturn) {
    body.push(`ชั่งคืน: ${returnCount} รายการ รวม ${fmt(returnTotal)} บาท`);
  }
  if (hasBadReturn) {
    body.push(`คืนเสีย: ${badReturnCount} รายการ รวม ${fmt(badReturnTotal)} บาท`);
  }
  if (hasMixed) {
    const netSendTotal = borrowTotal - returnTotal - badReturnTotal;
    body.push("", `ยอดส่งสุทธิ: ${fmt(netSendTotal)} บาท`);
  }

  return [...header, "", ...body].join("\n");
}
