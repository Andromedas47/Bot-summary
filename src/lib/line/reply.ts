import { logger } from "@/lib/logger";
import { formatThaiDate } from "@/lib/date";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { ADDITIONAL_TYPE_LABEL } from "@/lib/parsers/weigh-session/parser";
import { produceCategoryTotals, resolveProduceCategory } from "@/lib/summary/produce-category-totals";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";
import type { TransactionBucket } from "@/lib/summary/transactions";
import { roundHalfUp, toMilliQuantity } from "@/lib/sales/calculate";

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

/** Outbound LINE Messaging API message objects (text / flex / template / …). */
export type LineApiMessage = Record<string, unknown> & { type: string };

async function postLineReply(
  replyToken: string,
  messages: LineApiMessage[],
  textMetrics?: string[],
): Promise<void> {
  logger.info("LINE reply sending", {
    operation: "reply",
    messageCount: messages.length,
    messageTypes: messages.map((m) => m.type),
    ...(textMetrics
      ? { messages: logLineTextMetrics("reply", textMetrics) }
      : {}),
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
      ...(textMetrics
        ? { messages: logLineTextMetrics("reply", textMetrics) }
        : {}),
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
      ...(textMetrics
        ? { messages: logLineTextMetrics("reply", textMetrics) }
        : {}),
    });
    throw new Error(`LINE reply HTTP ${res.status}`);
  }
}

export async function replyLineMessages(replyToken: string, texts: string[]): Promise<void> {
  const messages = texts.map((text) => ({ type: "text" as const, text }));
  await postLineReply(replyToken, messages, texts);
}

export async function replyLineMessage(replyToken: string, text: string): Promise<void> {
  await replyLineMessages(replyToken, [text]);
}

/**
 * Reply with typed LINE API message objects (Flex / template / text).
 * Webhook Guided Menu uses this exclusively — never push.
 */
export async function replyLineApiMessages(
  replyToken: string,
  messages: LineApiMessage[],
): Promise<void> {
  if (messages.length < 1 || messages.length > 5) {
    throw new Error(`LINE reply allows 1–5 messages, got ${messages.length}`);
  }
  await postLineReply(replyToken, messages);
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

/**
 * price_per_unit and basis_price are numeric(*, 2) DB columns — exactly 2
 * decimal places at the source. Math.round tolerates the ordinary float
 * representation noise such a value picks up crossing JSON/JS (unlike
 * Number.isSafeInteger, which rejects it outright — see the P2A physical
 * inventory parser fix for that failure mode), so this recovers the exact
 * satang count the DB actually stored.
 */
function baht2ToSatang(baht: number): number {
  return Math.round(baht * 100);
}

/**
 * The finest unit that holds quantity (numeric(10,3)) x price_per_unit
 * (numeric(*,2)) exactly: 1/1000 of a satang, i.e. 10^-5 baht. Matches the
 * EXACT_SCALE = 5 convention src/lib/summary/produce-category-totals.ts
 * already documents for this identical reason — total_amount is
 * numeric(10,3) x numeric(10,2), so five decimal places hold it exactly.
 */
const MILLI_SATANG_PER_SATANG = BigInt(1000);

/**
 * Exact per-item total in milli-satang — the SAME value the
 * `produce_transactions` DB view computes (supabase/migrations/
 * 0033_produce_basis_pricing.sql), to the last digit, with NO floating-point
 * arithmetic anywhere in the computation:
 *
 *   basis rows (e.g. "3โล100บาท"): ROUND(qty * basis_price / basis_quantity, 2)
 *     — the view itself rounds this term, so it is rounded to the satang
 *     here too (never derived from price_per_unit, which is only a rounded
 *     display approximation for basis rows), then scaled up to milli-satang
 *     exactly. One rounding, matching the view's one rounding.
 *
 *   unit rows: qty * price_per_unit — plain NUMERIC multiplication in
 *     Postgres, which is exact and is NEVER rounded by the view. This must
 *     not round it either: quantityMilli (scale 3) x priceSatang (scale 2)
 *     is one BigInt multiplication landing exactly on scale 5 (milli-satang),
 *     with no division and therefore no rounding at all — matching the
 *     view's unrounded term exactly, not just to the satang.
 *
 * Fails closed rather than returning a silent 0 for a precondition this
 * receipt should never see in practice (negative/non-finite quantity or
 * basis_quantity, a non-positive basis_quantity, or a negative price) — a
 * plausible-looking "0.00" line on an operator-facing receipt is money
 * silently vanishing, which is worse than a loud failure for something the
 * current parser never actually produces. Mirrors the same
 * throw-on-invalid-item precedent house-stock-report.ts already uses.
 */
export function weighItemTotalMilliSatang(item: WeighSessionItem): bigint {
  const quantity = item.quantity ?? 0;
  const quantityMilli = toMilliQuantity(quantity);
  if (quantityMilli === null) {
    throw new Error(`invalid_weigh_item_quantity:${item.item_number}`);
  }

  if (item.basis_quantity && item.basis_price != null) {
    const basisQuantityMilli = toMilliQuantity(item.basis_quantity);
    if (basisQuantityMilli === null || basisQuantityMilli <= BigInt(0)) {
      throw new Error(`invalid_weigh_item_basis_quantity:${item.item_number}`);
    }
    const basisPriceSatang = baht2ToSatang(item.basis_price);
    if (basisPriceSatang < 0) {
      throw new Error(`invalid_weigh_item_basis_price:${item.item_number}`);
    }
    const basisSatang = roundHalfUp(quantityMilli * BigInt(basisPriceSatang), basisQuantityMilli);
    return basisSatang * MILLI_SATANG_PER_SATANG;
  }

  const priceSatang = baht2ToSatang(item.price_per_unit ?? 0);
  if (priceSatang < 0) {
    throw new Error(`invalid_weigh_item_price:${item.item_number}`);
  }
  // Exact: quantityMilli (scale 3) x priceSatang (scale 2) = scale 5 = milli-satang.
  return quantityMilli * BigInt(priceSatang);
}

/**
 * Per-item DISPLAY total in satang — the one place a unit row's otherwise
 * exact, unrounded value gets rounded, exactly once, for printing on one
 * receipt line. Aggregates must NOT be built by summing this per-item
 * rounded value (see sumWeighItemsSatang) — that reintroduces the
 * pre-rounded-sum drift this codebase has already hit once (see the
 * buildSection comment below).
 */
export function weighItemTotalSatang(item: WeighSessionItem): number {
  return Number(roundHalfUp(weighItemTotalMilliSatang(item), MILLI_SATANG_PER_SATANG));
}

export function weighItemTotal(item: WeighSessionItem): number {
  return weighItemTotalSatang(item) / 100;
}

/**
 * Sum many items' EXACT milli-satang totals and round to the satang ONCE,
 * at the end — never per item first. Summing per-item rounded satang (or
 * worse, per-item floats) before rounding again is how a receipt's own
 * grouped subtotal can disagree with the sum of its own printed lines.
 */
export function sumWeighItemsSatang(items: readonly WeighSessionItem[]): number {
  const totalMilliSatang = items.reduce(
    (sum, item) => sum + weighItemTotalMilliSatang(item),
    BigInt(0),
  );
  return Number(roundHalfUp(totalMilliSatang, MILLI_SATANG_PER_SATANG));
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

  // Exact milli-satang sum, rounded once at the end — never the sum of
  // per-item rounded (or floating-point) totals. See sumWeighItemsSatang.
  const sumItems = (items: Item[]) => sumWeighItemsSatang(items) / 100;

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

  // Category is presentation only, derived at output time from the approved
  // Product Code Dictionary (see product-code/category.ts) — it never changes
  // what the operator typed, never changes an item's own line text or the
  // section subtotal, and never reorders items across a shared category
  // (Array.prototype.sort is stable, so same-category items keep their
  // original relative order and therefore their original numbering).
  /**
   * Category is presentation only, derived at output time from the approved
   * Product Code Dictionary (product-code/category.ts). It never changes what
   * the operator typed and never enters any business identity.
   *
   * Two deliberate properties:
   *
   * Every printed number in a section — each item line, each category subtotal
   * and the section subtotal — comes from ONE integer-satang sum of the same
   * per-item totals. Leaving the section subtotal on the older float reduce
   * let a section print item lines of 0.13 + 0.13 + 0.13, a category subtotal
   * of 0.39, and a section subtotal of 0.38 in the same receipt.
   *
   * An item's category depends only on that item's own name. `knownNames` is
   * deliberately NOT passed: it authorizes normalizeProductName's `เพิ่ม`
   * prefix strip, which would make a literal `เพิ่มหมอนทอง` classify as
   * ทุเรียน or ไม่จัดหมวด depending on whether some OTHER line in the same
   * message happens to be `หมอนทอง`. The day-wide 08:00 report has genuine
   * day-wide context and may resolve such a name further; an instant reply
   * has only this message, so it stays pure rather than guessing from
   * whatever else was typed alongside.
   */
  const buildSection = (
    label: string,
    subtotalLabel: string,
    items: Item[],
    bucket: TransactionBucket,
  ): string[] => {
    if (items.length === 0) return [];

    const breakdown = produceCategoryTotals(items.map((it) => ({
      product_name: it.product_name,
      transaction_type: it.transaction_type,
      total_amount: weighItemTotal(it),
    })));

    const body: string[] = [];
    // Numbering follows PRINT order, so the receipt always reads 1, 2, 3 top to
    // bottom. Numbering by the item's original position instead would print
    // "2." above "1." whenever a section spans categories, and "แก้ item 2"
    // would point at a line above item 1. Within one category the items keep
    // their typed order, so the sequence still tracks what the operator sent.
    let printed = 0;
    for (const entry of breakdown[bucket].categories) {
      body.push(entry.heading);
      for (const item of items) {
        // Same pure, single-argument call the totals used — see the coupling
        // note on produceCategoryTotals. Diverging here once made an item
        // count toward a subtotal while printing under no category at all.
        if (resolveProduceCategory(item.product_name) !== entry.id) continue;
        body.push(itemLine(item, printed));
        printed += 1;
      }
      body.push(`รวม${entry.label} ${fmt(entry.totalSatang / 100)} บาท`);
    }

    return [
      label,
      ...body,
      `${subtotalLabel}: ${fmt(breakdown[bucket].totalSatang / 100)} บาท`,
    ];
  };

  /** The pre-category rendering, kept as the fallback for an oversized message. */
  const buildFlatSection = (
    label: string,
    subtotalLabel: string,
    items: Item[],
    total: number,
  ): string[] =>
    items.length === 0 ? [] : [label, ...items.map(itemLine), `${subtotalLabel}: ${fmt(total)} บาท`];

  const dateLabel = session.date ? formatThaiDate(session.date) : "";
  const lines: string[] = [
    "บันทึกแล้ว ✅",
    "",
    `${session.staff_name}${dateLabel ? ` — ${dateLabel}` : ""}`,
  ];

  const assemble = (sections: string[][]): string => {
    const out = [...lines];
    for (const section of sections.filter((s) => s.length > 0)) out.push("", ...section);
    return out.join("\n");
  };

  const grouped = assemble([
    buildSection("เบิก",    "รวมเบิก", borrowItems,    "เบิก"),
    buildSection("ชั่งคืน", "รวมคืน",  returnItems,    "คืน"),
    buildSection("คืนเสีย", "รวมเสีย", badReturnItems, "คืนเสีย"),
  ]);
  // Grouping adds a heading and a subtotal line per category, and this reply is
  // delivered as ONE unsplit LINE message, so grouping must never be the reason
  // a receipt stops fitting. Past the cap it drops back to the exact pre-feature
  // rendering — readability is the optional part, the receipt is not.
  //
  // This buys back only what grouping costs. A document large enough to overflow
  // the FLAT rendering too (~90+ items) still fails delivery, exactly as it did
  // before this feature; nothing here splits the message. That ceiling is
  // pre-existing and deliberately left alone.
  if (countCodePoints(grouped) <= LINE_MESSAGE_MAX_CODE_POINTS) return grouped;

  return assemble([
    buildFlatSection("เบิก",    "รวมเบิก", borrowItems,    borrowTotal),
    buildFlatSection("ชั่งคืน", "รวมคืน",  returnItems,    returnTotal),
    buildFlatSection("คืนเสีย", "รวมเสีย", badReturnItems, badReturnTotal),
  ]);
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
  // Exact milli-satang sum, rounded once at the end — see sumWeighItemsSatang.
  const batchTotal = sumWeighItemsSatang(session.items) / 100;

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
