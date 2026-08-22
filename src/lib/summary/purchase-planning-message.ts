/**
 * 📦 สรุปสำหรับวางแผนซื้อของ — LINE rendering.
 *
 * Pure. Takes a PurchasePlanningReport and returns LINE-safe messages through
 * the shared chunker, so this report obeys the same limits as every other one.
 *
 * ponytail: each product block carries its own status emoji rather than relying
 * on the section heading above it. chunkBlocks packs whole blocks and may start
 * a new message mid-section, which would otherwise leave products under no
 * visible heading. Repeating the emoji per product is cheaper and safer than a
 * bespoke section-aware packer.
 */

import { formatThaiDate } from "@/lib/date";
import { formatQuantity } from "@/lib/summary/remaining-fruit";
import {
  capAtMaxMessages,
  chunkBlocks,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/line-chunking";
import {
  HIGH_SELL_THROUGH_MIN_PERCENT,
  MEDIUM_SELL_THROUGH_MIN_PERCENT,
  type PurchasePlanningItem,
  type PurchasePlanningReport,
  type PurchaseStatus,
  type PurchaseUncertaintyReason,
  type SellThroughBand,
  type StockSignalAbsence,
} from "@/lib/summary/purchase-planning";

export const PURCHASE_PLANNING_TITLE = "📦 สรุปสำหรับวางแผนซื้อของ";
export const PURCHASE_PLANNING_METHOD_NOTE = [
  "วิเคราะห์จากยอดเบิก ของดีคืน ของเสีย และของที่เหลือในบ้านหลังเบิก",
  "ราคาไม่ใช้ในการจัดอันดับการขาย",
].join("\n");

/** This report has no web page of its own, so the notice names no destination. */
export const PURCHASE_PLANNING_OVERFLOW_NOTICE =
  "\n\nแสดงได้ไม่ครบ — ข้อความยาวเกินที่ LINE ตอบได้ในครั้งเดียว";

export const PURCHASE_PLANNING_EMPTY_NOTICE =
  "ยังไม่มีข้อมูลเบิก/ชั่งคืนที่บันทึกสำเร็จสำหรับวันนี้";

export const STATUS_HEADINGS: Record<PurchaseStatus, string> = {
  reduce: "🔴 ควรลดการซื้อ",
  surplus: "🟠 ของเหลือค่อนข้างมาก",
  strong: "🟢 ขายดี",
  unknown: "⚠️ ข้อมูลไม่พอประเมิน",
};

const STATUS_EMOJI: Record<PurchaseStatus, string> = {
  reduce: "🔴",
  surplus: "🟠",
  strong: "🟢",
  unknown: "⚠️",
};

/** Report order. Mirrors the operator's reading order, worst news first. */
const STATUS_SEQUENCE: readonly PurchaseStatus[] = ["reduce", "surplus", "strong", "unknown"];

export const PRICE_CONFLICT_NOTE = "⚠️ ราคาขัดแย้ง แต่จำนวนใช้ประเมินได้";

const UNCERTAINTY_TEXT: Record<PurchaseUncertaintyReason, string> = {
  product_return_absent: "ยังไม่พบรายการชั่งคืนของสินค้านี้ในรอบที่เบิก",
  return_not_round_tagged: "มีรายการชั่งคืนของสินค้านี้ แต่ไม่ผูกกับรอบที่เบิก จึงยืนยันความครบไม่ได้",
  session_integrity: "ชุดรายการที่บันทึกสินค้านี้อ่านได้ไม่ครบ",
  return_missing: "รอบที่เบิกยังไม่มีรายการชั่งคืนที่บันทึกสำเร็จ",
  return_incomplete: "มีรายการชั่งคืนที่ยังบันทึกไม่สำเร็จ",
  unattributed_round: "รายการเบิกไม่มีรอบความรับผิดชอบ จึงตรวจความครบของการคืนไม่ได้",
  returns_exceed_withdrawal: "ยอดคืนรวมมากกว่ายอดเบิก",
  no_withdrawal: "ไม่มียอดเบิกให้ใช้เทียบ",
  invalid_quantity: "มีจำนวนที่บันทึกไม่ถูกต้อง",
  unknown_transaction_type: "พบประเภทรายการที่ไม่รู้จัก",
};

const STOCK_ABSENCE_TEXT: Record<StockSignalAbsence, string> = {
  no_snapshot: "เหลือในบ้านหลังเบิก: ยังไม่มีข้อมูลของวันนี้",
  snapshot_conflict: "เหลือในบ้านหลังเบิก: มีข้อมูลซ้ำซ้อน จึงใช้เทียบไม่ได้",
  unavailable: "เหลือในบ้านหลังเบิก: อ่านข้อมูลไม่ได้",
  snapshot_empty: "เหลือในบ้านหลังเบิก: มีการบันทึกของวันนี้ แต่ไม่มีรายการที่ใช้เทียบได้",
  no_match: "เหลือในบ้านหลังเบิก: ไม่พบรายการที่เทียบหน่วยเดียวกันได้",
};

/** Said whenever the house side is missing, so Z is never read as complete. */
export const INCOMPLETE_STOCK_NOTE =
  "→ ยังยืนยันของคงเหลือทั้งหมดไม่ได้ เพราะไม่มีข้อมูลสต๊อกในบ้านที่ใช้เทียบได้";

/**
 * The house-stock report's own display convention (โล is stored, กก. is read).
 * Kept identical so the two reports never name the same unit differently.
 */
export function displayPurchaseUnit(unit: string): string {
  return unit === "โล" ? "กก." : unit;
}

/**
 * One decimal, with a whole number staying whole: 22.9% / 82% / 40.6%.
 *
 * `band` keeps the printed number inside the band the product was actually
 * filed under. Plain rounding lets 39.95% render as "40%" beneath the 🔴
 * heading, so the report would contradict its own threshold on screen; when
 * rounding would cross a boundary the product is not on, it truncates instead.
 */
export function formatSellThroughRate(
  rate: number,
  band?: SellThroughBand | null,
): string {
  let value = Math.round(rate * 10) / 10;
  const truncated = Math.floor(rate * 10) / 10;
  if (band === "low" && value >= MEDIUM_SELL_THROUGH_MIN_PERCENT) value = truncated;
  if (band === "medium" && value >= HIGH_SELL_THROUGH_MIN_PERCENT) value = truncated;
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function quantityLine(label: string, quantity: number, unit: string): string {
  return `${label} ${formatQuantity(quantity)} ${displayPurchaseUnit(unit)}`;
}

function recommendationLines(item: PurchasePlanningItem): string[] {
  if (item.status === "reduce") {
    // "ของเหลือสูง" would be a lie about a product that came back damaged
    // rather than unsold, so the reason names what actually happened.
    if (item.damagedQuantity > item.goodReturnQuantity) {
      return ["→ ขายออกน้อยและมีของเสียสูง ควรลดการซื้อ"];
    }
    if (item.goodReturnQuantity > 0 || (item.nextDayGoodStockQuantity ?? 0) > 0) {
      return ["→ ขายออกน้อยและยังมีของดีเหลือมาก ควรลดการซื้อ"];
    }
    return ["→ ขายออกน้อย ควรลดการซื้อ"];
  }
  if (item.status === "strong") return ["→ ขายออกดีและของดีพร้อมขายต่อเหลือน้อย"];
  if (item.status === "surplus") {
    if (item.band === "medium") return ["→ มีของพร้อมขายต่ออยู่มาก ควรเช็กก่อนซื้อเพิ่ม"];
    // HIGH sell-through held back: either a lot is ready to sell tomorrow, or
    // the house side is unknown. Neither may be presented as 🟢.
    if (item.nextStockToSoldRatio !== null) {
      return ["→ ขายดีแต่ยังมีของพร้อมขายต่ออยู่มาก ควรเช็กก่อนซื้อเพิ่ม"];
    }
    return ["→ ขายดี แต่ยังไม่มีข้อมูลสต๊อกในบ้านที่ใช้เทียบได้", INCOMPLETE_STOCK_NOTE];
  }
  return item.uncertaintyReasons.map((reason) => `→ ${UNCERTAINTY_TEXT[reason]}`);
}

/**
 * The stock story, in the order it physically happened: what stayed home after
 * the markets were supplied, then what came back good, then the sum of the two.
 * Damaged return is never part of that sum, so it never appears here.
 */
function stockLines(item: PurchasePlanningItem): string[] {
  if (item.houseStockQuantity === null) {
    return [STOCK_ABSENCE_TEXT[item.stockAbsence ?? "no_match"]];
  }
  return [
    quantityLine("เหลือในบ้านหลังเบิก", item.houseStockQuantity, item.unit),
    quantityLine(
      "ของดีพร้อมขายต่อประมาณ",
      item.nextDayGoodStockQuantity ?? item.houseStockQuantity,
      item.unit,
    ),
  ];
}

export function buildPurchasePlanningItemBlock(
  item: PurchasePlanningItem,
  position: number,
): string {
  const lines: string[] = [
    `${STATUS_EMOJI[item.status]} ${position}. ${item.productName}`,
  ];

  if (item.withdrawnQuantity > 0) {
    lines.push(quantityLine("เบิก", item.withdrawnQuantity, item.unit));
  }
  if (item.estimatedSoldQuantity !== null) {
    lines.push(quantityLine("ขายประมาณ", item.estimatedSoldQuantity, item.unit));
  }
  lines.push(quantityLine("คืนดีจากตลาด", item.goodReturnQuantity, item.unit));
  if (item.damagedQuantity > 0) {
    lines.push(quantityLine("คืนเสีย", item.damagedQuantity, item.unit));
  }
  if (item.sellThroughRate !== null) {
    lines.push(`ขายออก ${formatSellThroughRate(item.sellThroughRate, item.band)}`);
  } else {
    lines.push("⚠️ ข้อมูลไม่พอประเมิน");
  }
  if (item.status !== "unknown") lines.push(...stockLines(item));
  if (item.priceConflict) lines.push(PRICE_CONFLICT_NOTE);
  lines.push(...recommendationLines(item));

  return lines.join("\n");
}

function globalWarningBlocks(report: PurchasePlanningReport): string[] {
  const blocks: string[] = [];

  if (report.unresolvedSessionCount > 0) {
    blocks.push([
      "⚠️ ข้อมูลวันนี้ยังไม่ครบ",
      `มีชุดรายการที่ยังบันทึกไม่สำเร็จ ${report.unresolvedSessionCount} ชุด`,
      "อันดับนี้อ้างอิงเฉพาะข้อมูลที่บันทึกสำเร็จ",
    ].join("\n"));
  }

  if (report.stockAbsence === "no_snapshot") {
    blocks.push([
      "⚠️ ยังไม่มีข้อมูลสต๊อกในบ้านของวันนี้",
      "สินค้าที่ขายออกดีจึงยังไม่ยืนยันว่าควรซื้อเพิ่ม",
    ].join("\n"));
  } else if (report.stockAbsence === "snapshot_conflict") {
    blocks.push([
      "⚠️ พบข้อมูลสต๊อกในบ้านมากกว่าหนึ่งชุดสำหรับวันนี้",
      "จึงไม่ใช้ข้อมูลสต๊อกในการประเมิน",
    ].join("\n"));
  } else if (report.stockAbsence === "unavailable") {
    blocks.push([
      "⚠️ อ่านข้อมูลสต๊อกในบ้านไม่ได้",
      "จึงไม่ใช้ข้อมูลสต๊อกในการประเมิน",
    ].join("\n"));
  } else if (report.stockAbsence === "snapshot_empty") {
    blocks.push([
      "⚠️ มีการบันทึกสต๊อกในบ้านของวันนี้ แต่ไม่มีรายการที่ใช้เทียบได้",
      "จึงไม่ใช้ข้อมูลสต๊อกในการประเมิน",
    ].join("\n"));
  }

  // Rows that carried no usable product or unit are named rather than left as
  // a quiet difference between what was recorded and what the ranking covers.
  if (report.unidentifiedRowCount > 0) {
    blocks.push([
      `⚠️ มีรายการที่ระบุสินค้าหรือหน่วยไม่ได้ ${report.unidentifiedRowCount} รายการ`,
      "รายการเหล่านี้ไม่ได้อยู่ในอันดับด้านบน",
    ].join("\n"));
  }

  return blocks;
}

export function buildPurchasePlanningBlocks(report: PurchasePlanningReport): string[] {
  const header = [
    PURCHASE_PLANNING_TITLE,
    `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`,
    "",
    PURCHASE_PLANNING_METHOD_NOTE,
  ].join("\n");

  const blocks: string[] = [header];

  if (report.items.length === 0) {
    blocks.push(PURCHASE_PLANNING_EMPTY_NOTICE);
    blocks.push(...globalWarningBlocks(report));
    return blocks;
  }

  // Numbering is continuous across sections, so a product can be referred to by
  // its number no matter which message it landed in.
  let position = 0;
  for (const status of STATUS_SEQUENCE) {
    const items = report.items.filter((item) => item.status === status);
    if (items.length === 0) continue;
    blocks.push(STATUS_HEADINGS[status]);
    for (const item of items) {
      position += 1;
      blocks.push(buildPurchasePlanningItemBlock(item, position));
    }
  }

  blocks.push(...globalWarningBlocks(report));
  return blocks;
}

export function buildPurchasePlanningMessages(
  report: PurchasePlanningReport,
  options: { maxCodePoints?: number; maxMessages?: number } = {},
): string[] {
  const messages = chunkBlocks(
    buildPurchasePlanningBlocks(report),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
  return capAtMaxMessages(
    messages,
    options.maxMessages ?? LINE_REPLY_MAX_MESSAGES,
    PURCHASE_PLANNING_OVERFLOW_NOTICE,
  );
}
