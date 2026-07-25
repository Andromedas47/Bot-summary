import { formatThaiDate } from "@/lib/date";
import { formatQuantity } from "@/lib/summary/remaining-fruit";
import { STOCK_CATEGORY_EMOJI } from "@/lib/summary/stock-categories";
import { packSection, stockDisplayUnit } from "@/lib/summary/stock-summary-message";
import type { LowStockCategoryGroup, LowStockReport } from "@/lib/summary/low-stock";
import {
  capAtMaxMessages,
  chunkBlocks,
  LINE_MESSAGE_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";

/**
 * The automatic 08:00 message: an attention list, not an inventory dump and not
 * a purchase order.
 *
 * Wording is deliberately advisory ("คงเหลือน้อย", "ตรวจสอบก่อนซื้อ"). The
 * system has no approved reorder quantities, so it must never say ควรซื้อ /
 * ต้องซื้อ or suggest an amount. The closing note repeats that in the message
 * itself so a forwarded screenshot cannot be mistaken for an order.
 *
 * The full inventory stays on the manual `สรุปคงเหลือ` command. No per-market
 * detail is appended here.
 */

export const LOW_STOCK_TITLE = "🚨 รายการคงเหลือน้อย — ตรวจสอบก่อนซื้อ";
export const LOW_STOCK_SCOPE_LINE = "รวมทุกตลาด";
export const LOW_STOCK_INCOMPLETE_HEADING = "⚠️ ข้อมูลยังไม่ครบ";
export const LOW_STOCK_NONE_NOTICE = "✅ ไม่มีรายการคงเหลือน้อยตามเกณฑ์ที่ตั้งไว้";
export const LOW_STOCK_DISCLAIMER =
  "หมายเหตุ:\nรายการนี้เป็นการแจ้งเตือนสต๊อกต่ำ\nไม่ใช่คำสั่งซื้ออัตโนมัติ";

function itemLine(productName: string, quantity: number, unit: string, threshold: number): string {
  const label = stockDisplayUnit(unit);
  return `${productName} — ${formatQuantity(quantity)} ${label} (เกณฑ์ ${formatQuantity(threshold)} ${label})`;
}

function categoryBlocks(group: LowStockCategoryGroup): string[] {
  const heading = `${STOCK_CATEGORY_EMOJI[group.category]} ${group.category}`;
  return packSection(
    heading,
    group.products.map((p) => itemLine(p.productName, p.quantity, p.unit, p.threshold)),
  );
}

/**
 * The aggregate missing-ชั่งคืน warning. It is reported even when nothing is
 * low, because products held back by incomplete data are exactly the ones whose
 * true remaining stock is still unknown.
 */
function incompleteBlocks(report: LowStockReport): string[] {
  if (report.isComplete) return [];
  return [
    `${LOW_STOCK_INCOMPLETE_HEADING}\n${report.incompleteMarketCount} ตลาด / ${report.incompleteItemCount} รายการยังไม่มีข้อมูลชั่งคืน`,
  ];
}

export function buildLowStockBlocks(report: LowStockReport): string[] {
  const header = `${LOW_STOCK_TITLE}\nข้อมูลวันที่ ${formatThaiDate(report.businessDate)}\n${LOW_STOCK_SCOPE_LINE}`;

  const body =
    report.itemCount > 0 ? report.categories.flatMap(categoryBlocks) : [LOW_STOCK_NONE_NOTICE];

  return [header, ...body, ...incompleteBlocks(report), LOW_STOCK_DISCLAIMER];
}

/** LINE-ready messages for the scheduled delivery. */
export function buildLowStockMessages(
  report: LowStockReport,
  options: { maxMessages?: number } = {},
): string[] {
  const messages = chunkBlocks(buildLowStockBlocks(report), LINE_MESSAGE_MAX_CODE_POINTS);
  return capAtMaxMessages(messages, options.maxMessages);
}
