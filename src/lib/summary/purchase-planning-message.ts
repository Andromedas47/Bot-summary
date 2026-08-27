/**
 * 📦 แผนซื้อของประจำวัน — compact LINE rendering.
 *
 * Pure. Classification and quantities come from PurchasePlanningReport; this
 * module only decides what the operator sees. Audit fields stay on the report
 * so a later detail command can use them without changing the decision model.
 */

import { formatThaiDate } from "@/lib/date";
import { formatQuantity } from "@/lib/summary/remaining-fruit";
import {
  capAtMaxMessages,
  chunkBlocks,
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/line-chunking";
import {
  HIGH_SELL_THROUGH_MIN_PERCENT,
  MEDIUM_SELL_THROUGH_MIN_PERCENT,
  type PurchasePlanningItem,
  type PurchasePlanningReport,
  type PurchaseStatus,
  type SellThroughBand,
} from "@/lib/summary/purchase-planning";

export const PURCHASE_PLANNING_TITLE = "📦 แผนซื้อของประจำวัน";

/** This report has no web page of its own, so the notice names no destination. */
export const PURCHASE_PLANNING_OVERFLOW_NOTICE =
  "\n\nแสดงได้ไม่ครบ — ข้อความยาวเกินที่ LINE ตอบได้ในครั้งเดียว";

export const PURCHASE_PLANNING_EMPTY_NOTICE =
  "ยังไม่มีข้อมูลเบิก/ชั่งคืนที่บันทึกสำเร็จสำหรับวันนี้";

/** Category-specific empty copy. Only green is shown when empty today. */
export const EMPTY_STATUS_NOTICE = {
  strong: "วันนี้ยังไม่มีสินค้าที่ควรซื้อเพิ่ม",
  surplus: "วันนี้ยังไม่มีสินค้าที่ต้องชะลอการซื้อ",
  reduce: "วันนี้ยังไม่มีสินค้าที่ควรลดการซื้อ",
} as const;

export const EMPTY_GREEN_NOTICE = EMPTY_STATUS_NOTICE.strong;

export const WAITING_HOUSE_STOCK = "รอสต๊อกในบ้าน";

export const STATUS_HEADINGS: Record<PurchaseStatus, string> = {
  reduce: "🔴 ควรลดการซื้อ",
  surplus: "🟠 ยังไม่ควรซื้อเพิ่ม",
  strong: "🟢 ควรซื้อเพิ่ม",
  unknown: "⚠️ ยังประเมินไม่ได้",
};

/** Buy-first reading order. Green is always shown, even when empty. */
const STATUS_SEQUENCE: readonly PurchaseStatus[] = ["strong", "surplus", "reduce", "unknown"];

export const PRICE_CONFLICT_FOOTER =
  "ℹ️ บางรายการมีราคาขัดแย้ง แต่จำนวนยังใช้ประเมินได้";

export const CAUSE_HEADING = "สาเหตุ:";

export const PRODUCT_RETURN_ABSENT_CAUSE =
  "มีสินค้าบางรายการไม่พบในรายการคืนที่บันทึกไว้";

export const INCOMPLETE_DATA_SAFETY_NOTICE =
  "ระบบจะไม่นำสินค้าที่ข้อมูลยังไม่ครบไปใช้ตัดสินใจซื้อ";

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

function byIdentity(a: PurchasePlanningItem, b: PurchasePlanningItem): number {
  return (
    a.productName.localeCompare(b.productName, "th")
    || a.unit.localeCompare(b.unit, "th")
  );
}

function isHighWaitingForHouseStock(item: PurchasePlanningItem): boolean {
  return item.status === "surplus"
    && item.band === "high"
    && item.nextStockToSoldRatio === null;
}

/** Presentation order only. Does not change classification. */
function sortForDisplay(
  items: PurchasePlanningItem[],
  status: PurchaseStatus,
): PurchasePlanningItem[] {
  const copy = [...items];
  if (status === "strong") {
    return copy.sort((a, b) => {
      const rate = (b.sellThroughRate ?? 0) - (a.sellThroughRate ?? 0);
      return rate !== 0 ? rate : byIdentity(a, b);
    });
  }
  if (status === "surplus") {
    return copy.sort((a, b) => {
      const aWait = isHighWaitingForHouseStock(a);
      const bWait = isHighWaitingForHouseStock(b);
      if (aWait !== bWait) return aWait ? -1 : 1;
      const rate = (b.sellThroughRate ?? 0) - (a.sellThroughRate ?? 0);
      return rate !== 0 ? rate : byIdentity(a, b);
    });
  }
  if (status === "reduce") {
    return copy.sort((a, b) => {
      const rate = (a.sellThroughRate ?? 0) - (b.sellThroughRate ?? 0);
      return rate !== 0 ? rate : byIdentity(a, b);
    });
  }
  return copy.sort(byIdentity);
}

function productLabel(
  item: PurchasePlanningItem,
  duplicateNames: ReadonlySet<string>,
): string {
  if (!duplicateNames.has(item.productName)) return item.productName;
  return `${item.productName} (${displayPurchaseUnit(item.unit)})`;
}

export function buildPurchasePlanningItemBlock(
  item: PurchasePlanningItem,
  duplicateNames: ReadonlySet<string> = new Set(),
): string {
  const name = productLabel(item, duplicateNames);
  if (item.sellThroughRate === null) return name;

  const parts = [`${name} — ขายออก ${formatSellThroughRate(item.sellThroughRate, item.band)}`];
  if (isHighWaitingForHouseStock(item)) {
    parts.push(WAITING_HOUSE_STOCK);
  } else if (item.nextDayGoodStockQuantity !== null) {
    parts.push(
      `เหลือขายต่อ ~${formatQuantity(item.nextDayGoodStockQuantity)} ${displayPurchaseUnit(item.unit)}`,
    );
  }
  return parts.join(" • ");
}

function packedNameBlocks(names: readonly string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const name of names) {
    const candidate = current.length === 0 ? name : `${current.join(", ")}, ${name}`;
    if (countCodePoints(candidate) <= LINE_MESSAGE_MAX_CODE_POINTS) {
      current.push(name);
      continue;
    }
    if (current.length > 0) blocks.push(current.join(", "));
    current = [name];
  }
  if (current.length > 0) blocks.push(current.join(", "));
  return blocks;
}

function hasReason(
  report: PurchasePlanningReport,
  reason: PurchasePlanningItem["uncertaintyReasons"][number],
): boolean {
  return report.items.some((item) => item.uncertaintyReasons.includes(reason));
}

function unattributableWithdrawalCause(count: number): string {
  if (count <= 0) return "พบรายการเบิกที่ยังระบุรอบไม่ได้";
  return `พบรายการเบิก ${count} ชุดที่ยังระบุรอบไม่ได้`;
}

function incompleteDataCause(count: number): string {
  return `พบข้อมูลที่ไม่สมบูรณ์ ${count} ชุด`;
}

function incompleteGoodReturnCause(count: number): string {
  return `พบรายการชั่งคืน ${count} ชุดที่ยังบันทึกไม่สำเร็จ`;
}

function incompleteDamagedReturnCause(count: number): string {
  return `พบรายการคืนเสีย ${count} ชุดที่ยังบันทึกไม่สำเร็จ`;
}

function unknownProduceTypeCause(count: number): string {
  return `พบข้อมูล Produce ${count} ชุดที่ยังระบุประเภทรายการไม่ได้`;
}

/**
 * One operator-facing cause block from existing report metadata only.
 * A bullet is omitted when that cause did not occur.
 */
export function buildIncompleteReasonBlock(report: PurchasePlanningReport): string | null {
  const bullets: string[] = [];
  const unattributable =
    report.unsafeReportReason === "unattributable_withdrawal"
    || hasReason(report, "unattributable_withdrawal");
  const typed = report.unresolvedSessionCounts;
  const typedTotal = typed.withdrawal
    + typed.goodReturn
    + typed.damagedReturn
    + typed.unknown;

  if (typedTotal > 0) {
    if (typed.withdrawal > 0) {
      bullets.push(unattributable
        ? unattributableWithdrawalCause(typed.withdrawal)
        : incompleteDataCause(typed.withdrawal));
    }
    if (typed.goodReturn > 0) bullets.push(incompleteGoodReturnCause(typed.goodReturn));
    if (typed.damagedReturn > 0) {
      bullets.push(incompleteDamagedReturnCause(typed.damagedReturn));
    }
    if (typed.unknown > 0) bullets.push(unknownProduceTypeCause(typed.unknown));
    const unclassified = report.unresolvedSessionCount - typedTotal;
    if (unclassified > 0) bullets.push(incompleteDataCause(unclassified));
  } else if (unattributable) {
    // Backward-compatible fail-closed rendering for manually built reports
    // that predate typed evidence metadata.
    bullets.push(unattributableWithdrawalCause(report.unresolvedSessionCount));
  } else if (report.unresolvedSessionCount > 0) {
    bullets.push(incompleteDataCause(report.unresolvedSessionCount));
  }

  if (hasReason(report, "product_return_absent")) {
    bullets.push(PRODUCT_RETURN_ABSENT_CAUSE);
  }

  if (bullets.length === 0) return null;
  bullets.push(INCOMPLETE_DATA_SAFETY_NOTICE);
  return [CAUSE_HEADING, ...bullets.map((line) => `• ${line}`)].join("\n");
}

function globalWarningBlocks(report: PurchasePlanningReport): string[] {
  const blocks: string[] = [];
  const reasonBlock = buildIncompleteReasonBlock(report);
  if (reasonBlock) blocks.push(reasonBlock);

  if (report.stockAbsence === "no_snapshot") {
    blocks.push("⚠️ ยังไม่มีข้อมูลสต๊อกในบ้านของวันนี้");
  } else if (report.stockAbsence === "snapshot_conflict") {
    blocks.push("⚠️ พบข้อมูลสต๊อกในบ้านมากกว่าหนึ่งชุด จึงไม่ใช้เทียบ");
  } else if (report.stockAbsence === "unavailable") {
    blocks.push("⚠️ อ่านข้อมูลสต๊อกในบ้านไม่ได้ จึงไม่ใช้เทียบ");
  } else if (report.stockAbsence === "snapshot_empty") {
    blocks.push("⚠️ มีการบันทึกสต๊อกในบ้าน แต่ไม่มีรายการที่ใช้เทียบได้");
  }

  if (report.unidentifiedRowCount > 0) {
    blocks.push(`⚠️ มีรายการที่ระบุสินค้าหรือหน่วยไม่ได้ ${report.unidentifiedRowCount} รายการ`);
  }

  if (report.items.some((item) => item.priceConflict)) {
    blocks.push(PRICE_CONFLICT_FOOTER);
  }

  return blocks;
}

export function buildPurchasePlanningBlocks(report: PurchasePlanningReport): string[] {
  const header = [
    PURCHASE_PLANNING_TITLE,
    `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`,
  ].join("\n");

  const blocks: string[] = [header];
  const duplicateNames = new Set(
    report.items
      .filter((item, index, all) =>
        all.some((other, otherIndex) =>
          otherIndex !== index && other.productName === item.productName,
        ),
      )
      .map((item) => item.productName),
  );

  if (report.items.length === 0) {
    blocks.push(STATUS_HEADINGS.strong);
    blocks.push(EMPTY_GREEN_NOTICE);
    blocks.push(PURCHASE_PLANNING_EMPTY_NOTICE);
    blocks.push(...globalWarningBlocks(report));
    return blocks;
  }

  if (report.unsafeReportReason === "unattributable_withdrawal") {
    blocks.push(STATUS_HEADINGS.strong);
    blocks.push(EMPTY_GREEN_NOTICE);
    const unknowns = sortForDisplay(
      report.items.filter((item) => item.status === "unknown"),
      "unknown",
    );
    if (unknowns.length > 0) {
      blocks.push(`${STATUS_HEADINGS.unknown} ${unknowns.length} รายการ`);
      blocks.push(...packedNameBlocks(unknowns.map((item) => productLabel(item, duplicateNames))));
    }
    blocks.push(...globalWarningBlocks(report));
    return blocks;
  }

  for (const status of STATUS_SEQUENCE) {
    const items = sortForDisplay(
      report.items.filter((item) => item.status === status),
      status,
    );
    if (status === "strong") {
      blocks.push(STATUS_HEADINGS.strong);
      if (items.length === 0) {
        blocks.push(EMPTY_GREEN_NOTICE);
        continue;
      }
      for (const item of items) {
        blocks.push(buildPurchasePlanningItemBlock(item, duplicateNames));
      }
      continue;
    }
    if (items.length === 0) continue;
    if (status === "unknown") {
      blocks.push(`${STATUS_HEADINGS.unknown} ${items.length} รายการ`);
      blocks.push(...packedNameBlocks(items.map((item) => productLabel(item, duplicateNames))));
      continue;
    }
    blocks.push(STATUS_HEADINGS[status]);
    for (const item of items) {
      blocks.push(buildPurchasePlanningItemBlock(item, duplicateNames));
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
