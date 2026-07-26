import { formatThaiDate } from "@/lib/date";
import { formatQuantity, displayRemainingUnit } from "@/lib/summary/remaining-fruit";
import {
  capAtMaxMessages,
  chunkBlocks,
  LINE_MESSAGE_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";
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
export const SALES_MARKET_SECTION_HEADING = "🏪 ยอดขายรายตลาด";
export const SALES_BLOCKED_HEADING = "⛔ รายการที่ยืนยันไม่ได้";
export const SALES_SCOPE_BLOCKER_HEADING = "⚠️ ข้อมูลวันนี้ยังไม่ครบ";
export const SALES_EMPTY_NOTICE = "ไม่พบรายการขายสำหรับวันนี้";

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
  missing_central_price: "ไม่มีราคากลาง",
  central_price_conflict: "ราคากลางขัดแย้ง รอผู้ดูแลยืนยัน",
};

const UNRESOLVED_MARKET_LABEL = "ไม่ระบุตลาด";

export function salesReasonLabel(reason: SalesBlockReason): string {
  return REASON_LABELS[reason];
}

function scopeBlockerLabel(blocker: SalesScopeBlocker): string {
  if (blocker.kind === "unresolved_pending_session") {
    return `มีชุดข้อมูลที่ยังไม่ปิด ${blocker.count} ชุด`;
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
function totalBlock(heading: string, total: SalesTotal): string {
  const lines = [
    total.authoritative ? heading : SALES_PARTIAL_HEADING,
    `${satangToBahtText(total.expectedSalesSatang)} บาท`,
  ];
  if (!total.authoritative) {
    lines.push(`ยืนยันได้ ${total.trustedRowCount} รายการ • ยืนยันไม่ได้ ${total.blockedRowCount} รายการ`);
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

function productLine(product: SalesProductSummary): string {
  const suffix = product.total.authoritative ? "" : " • บางส่วน";
  return (
    `${product.productName} (${unitLabel(product.unit)}) — ขาย ${formatQuantity(product.soldQuantity)}`
    + ` • ${satangToBahtText(product.total.expectedSalesSatang)} บาท${suffix}`
  );
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

function isEmpty(report: SalesReport): boolean {
  return report.markets.length === 0 && report.blocked.length === 0;
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
  if (isEmpty(report)) return [`${header}\n\n${SALES_EMPTY_NOTICE}`];

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
  return capAtMaxMessages(messages, options.maxMessages);
}

/**
 * The scheduled 08:10 report.
 *
 * Same numbers, different shape: the per-identity working is dropped in favour
 * of product and market roll-ups, but every blocked entry is still listed in
 * full. Nothing is ever dropped to fit a message budget — this is a push, so
 * the day gets as many parts as it needs.
 */
export function buildSalesAutoBlocks(report: SalesReport): string[] {
  const header = headerBlock(SALES_AUTO_TITLE, report);
  if (isEmpty(report)) return [`${header}\n\n${SALES_EMPTY_NOTICE}`];

  const marketTotals = report.markets.map(
    (market) =>
      `${marketLabel(market)} — ${satangToBahtText(market.total.expectedSalesSatang)} บาท`
      + `${market.total.authoritative ? "" : " • บางส่วน"}`,
  );

  return [
    `${header}\n\n${totalBlock(SALES_TOTAL_HEADING, report.allMarkets)}`,
    ...scopeBlockerBlocks(report),
    ...productBlocks(report),
    ...(marketTotals.length > 0
      ? [[SALES_MARKET_SECTION_HEADING, ...marketTotals].join("\n")]
      : []),
    ...blockedBlocks(report),
  ];
}

export function buildSalesAutoMessages(
  report: SalesReport,
  options: { maxCodePoints?: number } = {},
): string[] {
  return chunkBlocks(
    buildSalesAutoBlocks(report),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
}
