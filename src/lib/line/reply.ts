import { logger } from "@/lib/logger";
import { formatThaiDate } from "@/lib/date";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { ADDITIONAL_TYPE_LABEL } from "@/lib/parsers/weigh-session/parser";

export function measureLineText(text: string): { codePoints: number; utf8Bytes: number } {
  return {
    codePoints: [...text].length,
    utf8Bytes: new TextEncoder().encode(text).length,
  };
}

function logLineTextMetrics(
  operation: "reply" | "push",
  texts: string[],
): Array<{ index: number; codePoints: number; utf8Bytes: number }> {
  return texts.map((text, index) => ({ index, ...measureLineText(text) }));
}

export async function replyLineMessages(replyToken: string, texts: string[]): Promise<void> {
  const messages = texts.map((text) => ({ type: "text" as const, text }));
  logger.info("LINE reply sending", {
    operation: "reply",
    messageCount: messages.length,
    messages: logLineTextMetrics("reply", texts),
  });

  let res: Response;
  try {
    res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken, messages }),
    });
  } catch {
    logger.error("LINE API request failed", {
      operation: "reply",
      category: "network_error",
      messageCount: messages.length,
      messages: logLineTextMetrics("reply", texts),
    });
    throw new Error("LINE reply network error");
  }

  if (!res.ok) {
    const responseBody = await res.text();
    logger.error("LINE API request failed", {
      operation: "reply",
      status: res.status,
      category: lineHttpErrorCategory(res.status),
      responseBody,
      messageCount: messages.length,
      messages: logLineTextMetrics("reply", texts),
    });
    throw new Error(`LINE reply HTTP ${res.status}`);
  }
}

export async function replyLineMessage(replyToken: string, text: string): Promise<void> {
  await replyLineMessages(replyToken, [text]);
}

export type PushResult = { status: "delivered" | "already_accepted" };

export class LinePushError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "LinePushError";
  }
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - nowMs);
}

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
    throw new LinePushError("LINE push network error", null, true);
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

  const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
  const retryable = res.status === 429 || res.status >= 500;
  logger.error("LINE API request failed", {
    operation: "push",
    status: res.status,
    category: lineHttpErrorCategory(res.status),
    retryAfterMs,
  });
  throw new LinePushError(
    `LINE push HTTP ${res.status}`,
    res.status,
    retryable,
    retryAfterMs,
  );
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Basis rows (e.g. "3โล100บาท") total round(qty * basis_price / basis_quantity, 2),
// never (qty * price_per_unit) — price_per_unit is only a rounded display
// approximation for those rows and multiplying it back out reintroduces
// the rounding error.
export function weighItemTotal(item: WeighSessionItem): number {
  if (item.basis_quantity && item.basis_price != null) {
    return round2((item.quantity ?? 0) * item.basis_price / item.basis_quantity);
  }
  return (item.price_per_unit ?? 0) * (item.quantity ?? 0);
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

  const lineTotal = weighItemTotal;

  const sumItems = (items: Item[]) =>
    items.reduce((acc, it) => acc + lineTotal(it), 0);

  const borrowTotal    = sumItems(borrowItems);
  const returnTotal    = sumItems(returnItems);
  const badReturnTotal = sumItems(badReturnItems);

  const itemLine = (item: Item, i: number): string => {
    const qty   = item.quantity ?? 0;
    const unit  = item.unit ? ` ${item.unit}` : "";
    const total = lineTotal(item);

    // Basis rows show the real basis instead of a "qty × price_per_unit"
    // equation that wouldn't multiply out correctly:
    //   32 หัว × 20 บาท / 3 หัว = 213.33
    if (item.basis_quantity && item.basis_price != null) {
      const basisUnit = item.basis_unit ? ` ${item.basis_unit}` : "";
      return `${i + 1}. ${item.product_name} ${fmt(qty)}${unit} × ${fmt(item.basis_price)} บาท / ${fmt(item.basis_quantity)}${basisUnit} = ${fmt(total)}`;
    }

    const price = item.price_per_unit ?? 0;
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

export interface AdditionalSessionDayContext {
  /** Day total for the same date + staff + market + base transaction type,
   *  INCLUDING this addition. */
  cumulativeTotal:  number;
  /** Whether any main-kind session already exists for the same grouping key. */
  hasMatchingMain:  boolean;
}

// Reply for an append-only additional batch. Deliberately never claims the
// original session was modified — the addition is its own session.
export function buildAdditionalSessionSummary(
  session: WeighSession,
  day: AdditionalSessionDayContext,
): string {
  const label = session.declared_transaction_type
    ? ADDITIONAL_TYPE_LABEL[session.declared_transaction_type]
    : "เพิ่ม";
  const batchTotal = session.items.reduce((sum, item) => sum + weighItemTotal(item), 0);

  // Previous day total before this addition; clamp floating-point residue.
  let previousTotal = round2(day.cumulativeTotal - batchTotal);
  if (Math.abs(previousTotal) < 0.005) previousTotal = 0;

  const lines = [
    `บันทึกรายการ${label}แล้ว ✅`,
    "",
    `เพิ่ม ${session.items.length} รายการ`,
    `ยอดเดิมก่อนเพิ่ม: ${fmt(previousTotal)} บาท`,
    `ยอดเพิ่ม: ${fmt(batchTotal)} บาท`,
    `ยอดสะสมของวัน: ${fmt(day.cumulativeTotal)} บาท`,
  ];

  if (!day.hasMatchingMain) {
    lines.push(
      "ยังไม่พบชุดหลักของวันนี้ รายการนี้ถูกบันทึกแยกไว้ และจะรวมยอดตามวันที่ คนขาย และตลาดเดียวกัน",
    );
  }

  return lines.join("\n");
}
