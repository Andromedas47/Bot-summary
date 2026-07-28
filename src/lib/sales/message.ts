import { formatThaiDate } from "@/lib/date";
import { formatQuantity, displayRemainingUnit } from "@/lib/summary/remaining-fruit";
import {
  capAtMaxMessages,
  chunkBlocks,
  LINE_MESSAGE_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";
import { latestDataHintBlock, type LatestDataHint } from "@/lib/summary/latest-data-hint";
import {
  satangToBahtText,
  type SalesBlockReason,
  type SalesIdentityRow,
  type SalesMarketSummary,
  type SalesProductSummary,
  type SalesReport,
  type SalesScopeBlocker,
  type SalesTotal,
} from "./calculate";

/**
 * P1 Daily Sales — LINE presentation.
 *
 * Presentation only: every number here comes from the SalesReport the
 * calculator produced. No arithmetic, no re-derivation, and above all no
 * relabelling — a subtotal that is not authoritative is never printed under a
 * "total sales" heading.
 */

export const SALES_MANUAL_TITLE = "💰 สรุปยอดขาย";
export const SALES_AUTO_TITLE = "💰 สรุปยอดขายประจำวัน";

/** The only wording allowed for a subtotal that is not fully verified. */
export const SALES_PARTIAL_HEADING = "⚠️ ยอดที่ยืนยันได้บางส่วน";
export const SALES_TOTAL_HEADING = "ยอดขายรวมทุกตลาด";
export const SALES_MARKET_TOTAL_HEADING = "ยอดขายรวม";

export const SALES_PRODUCT_SECTION_HEADING = "📦 ยอดขายรายสินค้า (ทุกตลาด)";
export const SALES_BLOCKED_HEADING =
  "⛔ สาเหตุที่ยังยืนยันไม่ได้\n(1 รายการอาจพบมากกว่า 1 สาเหตุ)";
export const SALES_SCOPE_BLOCKER_HEADING = "⚠️ ข้อมูลวันนี้ยังไม่ครบ";
export const SALES_EMPTY_NOTICE = "ไม่พบรายการขายสำหรับวันนี้";
/**
 * The scheduled report's empty state.
 *
 * "ไม่พบรายการขายสำหรับวันนี้" was ambiguous at 08:10: it did not say WHICH day
 * had nothing, and gave no way to tell "nobody sold anything" from "yesterday's
 * entries have not been made yet". This names the requested date explicitly, and
 * the latest-data block that follows names its own — so a prior date can never
 * be read as an answer for the requested one.
 */
export const SALES_NO_DATA_PREFIX = "ยังไม่พบรายการขายประจำวันที่";
/** Nothing anywhere in history, so there is no earlier date to point at. */
export const SALES_NO_HISTORY_NOTICE = "ยังไม่พบรายการขายในระบบ";
/**
 * No persisted sales rows AND something is known to be missing. Saying
 * "ไม่พบรายการขาย" here would report a broken day as a quiet day, so this
 * wording states the opposite: nothing can be concluded yet.
 */
export const SALES_NO_ROWS_BLOCKED_NOTICE =
  "⛔ ยังสรุปยอดขายไม่ได้ — ไม่พบรายการที่บันทึกไว้ และข้อมูลของวันนี้ยังไม่ครบ";
/** Used wherever a money figure would otherwise print a misleading 0.00. */
export const SALES_VALUE_UNAVAILABLE = "ยอดเงินยังคำนวณไม่ได้";
export const SALES_MARKET_SECTION_HEADING = "🏪 สถานะยอดขายรายตลาด";
/** Quantity is complete, only the money is not. */
export const SALES_QUANTITY_ONLY_NOTICE = "จำนวนที่ขายครบถ้วน • ยอดเงินยังไม่ครบ (รอราคากลาง)";

/**
 * P1 has no Sales web page, so the shared overflow notice — which points at one
 * — must not be used here. This states only what is true, and names no
 * destination that does not exist.
 */
export const SALES_OVERFLOW_NOTICE =
  "\n\nแสดงได้ไม่ครบ — ข้อความยาวเกินที่ LINE ตอบได้ในครั้งเดียว";

const REASON_LABELS: Record<SalesBlockReason, string> = {
  invalid_identity: "ข้อมูลสินค้า/หน่วยไม่ครบ",
  invalid_quantity: "จำนวนไม่ถูกต้อง",
  unknown_transaction_type: "ประเภทรายการไม่รู้จัก",
  market_unresolved: "ระบุตลาดไม่ได้",
  missing_return_evidence: "ยังไม่มีข้อมูลชั่งคืน",
  return_without_withdrawal: "มีคืนแต่ไม่มีเบิก",
  returns_exceed_withdrawal: "คืน+เสีย มากกว่าเบิก",
  duplicate_main_session: "มีชุดหลักซ้ำในวันเดียวกัน",
  session_parser_errors: "อ่านข้อความไม่ครบ",
  session_item_count_mismatch: "จำนวนรายการที่บันทึกไม่ตรง",
  session_rows_missing: "ชุดนี้ไม่มีรายการที่บันทึกไว้เลย",
  session_date_missing: "ชุดนี้ไม่มีวันที่กำกับ",
  produce_message_never_landed: "มีข้อความชั่งที่ไม่ได้ถูกบันทึก",
  missing_central_price: "ไม่มีราคากลาง",
  central_price_conflict: "ราคากลางขัดแย้ง รอผู้ดูแลยืนยัน",
};

const UNRESOLVED_MARKET_LABEL = "ไม่ระบุตลาด";

export function salesReasonLabel(reason: SalesBlockReason): string {
  return REASON_LABELS[reason];
}

function scopeBlockerLabel(blocker: SalesScopeBlocker): string {
  if (blocker.kind === "unresolved_pending_session") {
    return `มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ ${blocker.count} ชุด`;
  }
  if (blocker.kind === "unattributable_session") {
    return `มีชุดรายการที่บันทึกไม่ครบและระบุตลาดไม่ได้ ${blocker.count} ชุด`;
  }
  return `มีข้อความที่อ่านไม่สำเร็จ ${blocker.count} ข้อความ`;
}

function marketLabel(row: { marketLabel: string }): string {
  return row.marketLabel || UNRESOLVED_MARKET_LABEL;
}

function unitLabel(unit: string): string {
  return displayRemainingUnit(unit);
}

/**
 * A total plus its heading. The heading is the safety mechanism: an
 * authoritative figure is a total, anything else is explicitly partial.
 */
function totalBlock(heading: string, total: SalesTotal, withCounts = true): string {
  const lines = [
    total.valueAuthoritative ? heading : SALES_PARTIAL_HEADING,
    // Nothing is priced yet: "0.00 บาท" would read as zero revenue, which is a
    // different (and false) claim from "the value is not calculable".
    total.trustedRowCount === 0 && !total.valueAuthoritative
      ? SALES_VALUE_UNAVAILABLE
      : `${satangToBahtText(total.expectedSalesSatang)} บาท`,
  ];
  if (!total.valueAuthoritative) {
    const blocked = total.valueBlockedRowCount + total.quantityBlockedRowCount;
    // The Auto report states these counts on their own lines and passes
    // withCounts=false, so the figure is never printed twice.
    if (withCounts) {
      lines.push(`ยืนยันได้ ${total.trustedRowCount} รายการ • ยืนยันไม่ได้ ${blocked} รายการ`);
    }
    // Quantity trust survives a pricing problem, and saying so is the point of
    // separating the two: "we know what was sold, not what it is worth".
    if (total.quantityAuthoritative) lines.push(SALES_QUANTITY_ONLY_NOTICE);
  }
  return lines.join("\n");
}

/** W / R / D / sold / central price / expected sales / status for one identity. */
function identityLines(row: SalesIdentityRow): string[] {
  const lines = [
    `${row.productName} (${unitLabel(row.unit)})`,
    `เบิก ${formatQuantity(row.withdrawnQuantity)} • คืน ${formatQuantity(row.goodReturnQuantity)}`
      + ` • เสีย ${formatQuantity(row.damagedReturnQuantity)}`,
  ];

  if (row.soldQuantity === null) {
    lines.push(`ขาย — (${row.reasons.map(salesReasonLabel).join(", ")})`);
    return lines;
  }

  lines.push(`ขาย ${formatQuantity(row.soldQuantity)} ${unitLabel(row.unit)}`);
  if (row.centralPriceSatang === null || row.expectedSalesSatang === null) {
    lines.push(`ยอดขาย — (${row.reasons.map(salesReasonLabel).join(", ")})`);
    return lines;
  }
  lines.push(
    `ราคากลาง ${satangToBahtText(row.centralPriceSatang)} → ${satangToBahtText(row.expectedSalesSatang)} บาท`,
  );
  return lines;
}

function marketBlock(market: SalesMarketSummary): string {
  return [
    `🏪 ${marketLabel(market)}`,
    totalBlock(SALES_MARKET_TOTAL_HEADING, market.total),
    ...market.rows.flatMap(identityLines),
  ].join("\n");
}

/**
 * Quantity and value carry their own "บางส่วน" marker, because they are trusted
 * independently: a product can have a complete sold quantity and a partial value
 * when one market is still missing its central price.
 */
function productLine(product: SalesProductSummary): string {
  const quantitySuffix = product.total.quantityAuthoritative ? "" : " (บางส่วน)";
  return (
    `${product.productName} (${unitLabel(product.unit)})`
    + ` — ขาย ${formatQuantity(product.soldQuantity)}${quantitySuffix}`
    + ` • ${valueText(product.total)}`
  );
}

/** Money for a subtotal: a figure, a partial figure, or an honest "not yet". */
function valueText(total: SalesTotal): string {
  if (total.trustedRowCount === 0 && !total.valueAuthoritative) return SALES_VALUE_UNAVAILABLE;
  const suffix = total.valueAuthoritative ? "" : " (บางส่วน)";
  return `${satangToBahtText(total.expectedSalesSatang)} บาท${suffix}`;
}

/**
 * Blocked entries as reason counts, for the Auto report.
 *
 * The morning push answers "how much did we sell, and how much of it can I
 * trust". Two hundred individual blocked lines answer neither and bury the
 * number. Every blocked row is still listed in full by the manual
 * สรุปยอดขาย command and by the cron route's debug preview — this groups,
 * it never drops.
 */
function blockedReasonBlocks(report: SalesReport): string[] {
  if (report.blocked.length === 0) return [];

  const counts = new Map<SalesBlockReason, number>();
  for (const row of report.blocked) {
    // A row blocked for two reasons counts under both: these are reason totals,
    // not a partition of the rows.
    for (const reason of row.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || salesReasonLabel(a[0]).localeCompare(salesReasonLabel(b[0]), "th"))
    .map(([reason, count]) => `• ${salesReasonLabel(reason)} — ${count} รายการ`);

  return [[SALES_BLOCKED_HEADING, ...lines].join("\n")];
}

/** One line per blocked identity. Every blocked entry is listed — never a sample. */
function blockedLine(row: SalesIdentityRow): string {
  const reasons = row.reasons.map(salesReasonLabel).join(", ");
  return (
    `${marketLabel(row)} • ${row.productName} (${unitLabel(row.unit)})`
    + ` — ${reasons} [เบิก ${formatQuantity(row.withdrawnQuantity)}`
    + ` • คืน ${formatQuantity(row.goodReturnQuantity)}`
    + ` • เสีย ${formatQuantity(row.damagedReturnQuantity)}]`
  );
}

function headerBlock(title: string, report: SalesReport): string {
  return [title, `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`].join("\n");
}

function scopeBlockerBlocks(report: SalesReport): string[] {
  if (report.scopeBlockers.length === 0) return [];
  return [
    [SALES_SCOPE_BLOCKER_HEADING, ...report.scopeBlockers.map(scopeBlockerLabel)].join("\n"),
  ];
}

function blockedBlocks(report: SalesReport): string[] {
  if (report.blocked.length === 0) return [];
  return [[SALES_BLOCKED_HEADING, ...report.blocked.map(blockedLine)].join("\n")];
}

function productBlocks(report: SalesReport): string[] {
  if (report.products.length === 0) return [];
  return [[SALES_PRODUCT_SECTION_HEADING, ...report.products.map(productLine)].join("\n")];
}

function hasNoRows(report: SalesReport): boolean {
  return report.markets.length === 0 && report.blocked.length === 0;
}

/**
 * The opening blocks when the day produced no sales rows at all.
 *
 * With nothing missing, that is a real answer: no sales. With a scope blocker
 * present it is NOT — the rows may simply never have landed — so the report
 * says so and lists every blocker. Returns [] when there are rows to report.
 */
function noRowsBlocks(report: SalesReport, header: string): string[] {
  if (!hasNoRows(report)) return [];
  if (report.scopeBlockers.length === 0) return [`${header}\n\n${SALES_EMPTY_NOTICE}`];
  return [`${header}\n\n${SALES_NO_ROWS_BLOCKED_NOTICE}`, ...scopeBlockerBlocks(report)];
}

/**
 * Manual `สรุปยอดขาย` blocks.
 *
 * Order is deliberate: the answer first, then what is not trustworthy about it,
 * then the per-market working, then the per-product roll-up. A LINE reply is
 * capped at five messages, so what a human most needs has to arrive first.
 */
export function buildSalesSummaryBlocks(report: SalesReport): string[] {
  const header = headerBlock(SALES_MANUAL_TITLE, report);
  if (hasNoRows(report)) return noRowsBlocks(report, header);

  return [
    `${header}\n\n${totalBlock(SALES_TOTAL_HEADING, report.allMarkets)}`,
    ...scopeBlockerBlocks(report),
    ...blockedBlocks(report),
    ...report.markets.map(marketBlock),
    ...productBlocks(report),
  ];
}

export function buildSalesSummaryMessages(
  report: SalesReport,
  options: { maxCodePoints?: number; maxMessages?: number } = {},
): string[] {
  const messages = chunkBlocks(
    buildSalesSummaryBlocks(report),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
  return capAtMaxMessages(messages, options.maxMessages, SALES_OVERFLOW_NOTICE);
}

/**
 * True when the scheduled report has nothing to show AND nothing is known to be
 * missing — the only case where pointing at the latest date we do have is
 * honest. With a scope blocker present the day is not empty, it is unproven, and
 * that keeps its own wording.
 */
export function salesAutoNeedsLatestDataHint(report: SalesReport): boolean {
  return hasNoRows(report) && report.scopeBlockers.length === 0;
}

/**
 * The scheduled 08:10 report.
 *
 * Same numbers, different shape: the per-identity working is dropped in favour
 * of product and market roll-ups, but every blocked entry is still listed in
 * full. Nothing is ever dropped to fit a message budget — this is a push, so
 * the day gets as many parts as it needs.
 *
 * `latest` is the empty state's context block and is used ONLY there — a day
 * with sales renders exactly as before, whatever is passed.
 */
export function buildSalesAutoBlocks(
  report: SalesReport,
  latest: LatestDataHint | null = null,
): string[] {
  const header = headerBlock(SALES_AUTO_TITLE, report);
  if (salesAutoNeedsLatestDataHint(report)) {
    return [
      [
        header,
        `${SALES_NO_DATA_PREFIX} ${formatThaiDate(report.businessDate)}`,
        latest ? latestDataHintBlock(latest) : SALES_NO_HISTORY_NOTICE,
      ].join("\n\n"),
    ];
  }
  if (hasNoRows(report)) return noRowsBlocks(report, header);

  const counts = [
    `✅ ยืนยันได้ ${report.allMarkets.trustedRowCount} รายการ`,
    `⚠️ ยืนยันไม่ได้ ${report.allMarkets.valueBlockedRowCount + report.allMarkets.quantityBlockedRowCount} รายการ`,
  ].join("\n");

  const marketTotals = report.markets.map(
    (market) => `${marketLabel(market)} — ${valueText(market.total)}`,
  );

  return [
    `${header}\n\n${totalBlock(SALES_TOTAL_HEADING, report.allMarkets, false)}\n\n${counts}`,
    ...scopeBlockerBlocks(report),
    ...(marketTotals.length > 0
      ? [[SALES_MARKET_SECTION_HEADING, ...marketTotals].join("\n")]
      : []),
    ...blockedReasonBlocks(report),
  ];
}

export function buildSalesAutoMessages(
  report: SalesReport,
  options: { maxCodePoints?: number; latest?: LatestDataHint | null } = {},
): string[] {
  return chunkBlocks(
    buildSalesAutoBlocks(report, options.latest ?? null),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
}
