import { formatThaiDate } from "@/lib/date";
import { satangToBahtText } from "@/lib/sales/calculate";
import {
  capAtMaxMessages,
  chunkBlocks,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/line-chunking";
import {
  MORNING_BRIEF_NAME_LIMIT,
  type MorningBriefPurchaseGroup,
  type MorningBriefReport,
} from "@/lib/summary/morning-brief";

export const MORNING_BRIEF_TITLE = "🌅 สรุปเช้า";
export const MORNING_BRIEF_OVERFLOW_NOTICE =
  "\n\nแสดงได้ไม่ครบ — ข้อความยาวเกินที่ LINE ตอบได้ในครั้งเดียว";

const PRODUCT_NAME_MAX_CODE_POINTS = 80;

function boundedProductName(name: string): string {
  const codePoints = [...name];
  if (codePoints.length <= PRODUCT_NAME_MAX_CODE_POINTS) return name;
  return `${codePoints.slice(0, PRODUCT_NAME_MAX_CODE_POINTS - 1).join("")}…`;
}

function purchaseGroupLines(
  icon: string,
  label: string,
  group: MorningBriefPurchaseGroup,
): string[] {
  const lines = [`${icon} ${label} — ${group.count} รายการ`];
  if (group.productNames.length === 0) return lines;

  const shownNames = group.productNames.slice(0, MORNING_BRIEF_NAME_LIMIT);
  const suffix = group.count > shownNames.length
    ? ` ... +อีก ${group.count - shownNames.length} รายการ`
    : "";
  lines.push(`${shownNames.map(boundedProductName).join(", ")}${suffix}`);
  return lines;
}

function buildPurchaseBlock(report: MorningBriefReport): string {
  const { strong, surplus, reduce, unknown } = report.purchasePlanning;
  return [
    "🛒 แผนซื้อของ",
    ...purchaseGroupLines("🟢", "ควรซื้อเพิ่ม", strong),
    "",
    ...purchaseGroupLines("🟠", "ยังไม่ควรซื้อเพิ่ม", surplus),
    "",
    ...purchaseGroupLines("🔴", "ควรลดการซื้อ", reduce),
    "",
    `⚠️ ยังประเมินไม่ได้ ${unknown.count} รายการ`,
  ].join("\n");
}

function buildSalesBlock(report: MorningBriefReport): string {
  const sales = report.sales;
  const amountLabel = sales.valueAuthoritative ? "ยอดขายรวม" : "⚠️ ยอดที่ยืนยันแล้ว";
  const lines = [
    "💰 ยอดขาย",
    `${amountLabel} ${satangToBahtText(sales.confirmedSalesSatang)} บาท`,
    `✅ ยืนยันได้ ${sales.trustedCount} รายการ • ⚠️ รอตรวจ ${sales.unresolvedCount} รายการ`,
  ];
  if (sales.soldOutCount > 0) {
    lines.push(`✅ ถือว่าขายหมดเพราะไม่มีรายการคืน — ${sales.soldOutCount} รายการ`);
  }
  return lines.join("\n");
}

function buildHouseStockBlock(report: MorningBriefReport): string {
  const stock = report.houseStock;
  if (stock.status === "missing") return "🏠 ของในบ้าน\nยังไม่มีข้อมูลสต๊อกบ้าน";
  if (stock.status === "unavailable") return "🏠 ของในบ้าน\n⚠️ ยังตรวจสต๊อกบ้านไม่ได้";
  return [
    "🏠 ของในบ้าน",
    `${stock.groupCount} รายการ • มูลค่า ${satangToBahtText(stock.totalValueSatang)} บาท`,
  ].join("\n");
}

export function buildMorningBriefBlocks(report: MorningBriefReport): string[] {
  const blocks = [
    `${MORNING_BRIEF_TITLE} — ${formatThaiDate(report.businessDate)}`,
    buildPurchaseBlock(report),
    buildSalesBlock(report),
  ];

  if (report.sales.priceConflictCount > 0) {
    blocks.push([
      "⚠️ ต้องตรวจ",
      `ราคากลางขัดแย้ง ${report.sales.priceConflictCount} จุด / ${report.sales.priceConflictMarketCount} ตลาด`,
    ].join("\n"));
  }

  blocks.push(buildHouseStockBlock(report));
  return blocks;
}

export function buildMorningBriefMessage(report: MorningBriefReport): string {
  return buildMorningBriefBlocks(report).join("\n\n");
}

export function buildMorningBriefMessages(
  report: MorningBriefReport,
  options: { maxCodePoints?: number; maxMessages?: number } = {},
): string[] {
  const messages = chunkBlocks(
    buildMorningBriefBlocks(report),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
  return capAtMaxMessages(
    messages,
    options.maxMessages ?? LINE_REPLY_MAX_MESSAGES,
    MORNING_BRIEF_OVERFLOW_NOTICE,
  );
}
