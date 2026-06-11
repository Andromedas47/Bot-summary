import { logger } from "@/lib/logger";
import { formatThaiDate } from "@/lib/date";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";

export async function replyLineMessage(replyToken: string, text: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("https://api.line.me/v2/bot/message/reply", {
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
  } catch {
    logger.error("LINE API request failed", {
      operation: "reply",
      category: "network_error",
    });
    throw new Error("LINE reply network error");
  }

  if (!res.ok) {
    logger.error("LINE API request failed", {
      operation: "reply",
      status: res.status,
      category: lineHttpErrorCategory(res.status),
    });
    throw new Error(`LINE reply HTTP ${res.status}`);
  }
}

export type PushResult = { status: "delivered" | "already_accepted" };

// LINE Messaging API supports X-Line-Retry-Key for push idempotency.
// Passing the same UUID on a retry causes LINE to return 409 without
// re-delivering if the original request was already processed — safe for
// both definite rejections (message was never sent) and ambiguous failures
// (network error where delivery status is unknown).
//
// Returns:
//   { status: "delivered" }       — HTTP 2xx, message delivered now
//   { status: "already_accepted" } — HTTP 409 + retryKey, idempotent re-send
// Throws on any other non-2xx status or network error.
export async function pushLineMessage(to: string, text: string, retryKey?: string): Promise<PushResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
  if (retryKey) headers["X-Line-Retry-Key"] = retryKey;

  let res: Response;
  try {
    res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers,
      body: JSON.stringify({
        to,
        messages: [{ type: "text", text }],
      }),
    });
  } catch {
    logger.error("LINE API request failed", {
      operation: "push",
      category: "network_error",
    });
    throw new Error("LINE push network error");
  }

  if (res.ok) {
    return { status: "delivered" };
  }

  // 409 with a retry key: LINE already accepted a previous request with the
  // same key — idempotent delivery, treat as success.
  // 409 without a retry key is an unrelated conflict — fail normally.
  if (res.status === 409 && retryKey) {
    logger.warn("LINE push 409 — already accepted (retry key match)", {
      operation: "push",
      retryKey,
    });
    return { status: "already_accepted" };
  }

  logger.error("LINE API request failed", {
    operation: "push",
    status: res.status,
    category: lineHttpErrorCategory(res.status),
  });
  throw new Error(`LINE push HTTP ${res.status}`);
}

function lineHttpErrorCategory(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "http_error";
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
