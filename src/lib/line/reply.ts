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

export async function pushLineMessage(to: string, text: string): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    logger.error("LINE push failed", { status: res.status, body: errorText });
    throw new Error(`LINE push HTTP ${res.status}: ${errorText}`);
  }
}

function fmt(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildWeighSessionSummary(session: WeighSession): string {
  type Item = typeof session.items[number];

  const borrowItems: Item[]    = [];
  const returnItems: Item[]    = [];
  const badReturnItems: Item[] = [];

  for (const item of session.items) {
    if (item.transaction_type === "เบิก" || item.transaction_type === "เบิกเพิ่ม") {
      borrowItems.push(item);
    } else if (item.transaction_type === "คืน") {
      returnItems.push(item);
    } else if (item.transaction_type === "คืนเสีย") {
      badReturnItems.push(item);
    }
  }

  const sumItems = (items: Item[]) =>
    items.reduce((acc, it) => acc + (it.price_per_unit ?? 0) * (it.quantity ?? 0), 0);

  const borrowTotal    = sumItems(borrowItems);
  const returnTotal    = sumItems(returnItems);
  const badReturnTotal = sumItems(badReturnItems);

  const itemLine = (item: Item, i: number): string => {
    const qty   = item.quantity ?? 0;
    const unit  = item.unit ? ` ${item.unit}` : "";
    const price = item.price_per_unit ?? 0;
    const total = price * qty;
    return `${i + 1}. ${item.product_name} ${fmt(qty)}${unit} × ${fmt(price)} = ${fmt(total)}`;
  };

  const buildSection = (label: string, subtotalLabel: string, items: Item[], total: number): string[] => {
    if (items.length === 0) return [];
    return [label, ...items.map(itemLine), `${subtotalLabel}: ${fmt(total)} บาท`];
  };

  const dateLabel = session.date ? formatThaiDate(session.date) : "";
  const lines: string[] = [
    "บันทึกแล้ว ✅",
    "",
    `${session.staff_name}${dateLabel ? ` — ${dateLabel}` : ""}`,
  ];

  const sections = [
    buildSection("เบิก",    "รวมเบิก", borrowItems,    borrowTotal),
    buildSection("ชั่งคืน", "รวมคืน",  returnItems,    returnTotal),
    buildSection("คืนเสีย", "รวมเสีย", badReturnItems, badReturnTotal),
  ].filter(s => s.length > 0);

  for (const s of sections) {
    lines.push("", ...s);
  }

  return lines.join("\n");
}
