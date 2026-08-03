import { formatThaiDate } from "@/lib/date";
import { cleanMarketName } from "@/lib/market";
import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { quantityTimesSatang, roundHalfUp, satangToBahtText } from "@/lib/sales/calculate";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { latestDataBlock, type LatestDataLookup } from "@/lib/summary/latest-data-hint";
import { LINE_MESSAGE_MAX_CODE_POINTS, LINE_REPLY_MAX_MESSAGES, countCodePoints } from "@/lib/summary/line-chunking";
import { STOCK_CATEGORY_EMOJI, STOCK_CATEGORY_ORDER, stockCategoryFor } from "@/lib/summary/stock-categories";
import type { StockIncompleteEntry } from "@/lib/summary/stock-summary";
import { dedupeRemainingSourceRows, formatQuantity, normalizeProductName, type RemainingFruitSourceRow } from "@/lib/summary/remaining-fruit";
import { transactionBucket } from "@/lib/summary/transactions";

type Blocker = "ไม่พบรายการเบิกที่ตรงกัน" | "รายการเบิกไม่มีราคา" | "ราคาจากรายการเบิกขัดแย้งกัน" | "คืนมากกว่าเบิก" | "คืนและคืนเสียรวมมากกว่าเบิก" | "จำนวนไม่ถูกต้อง" | "ระบุตลาดไม่ได้";
export interface GoodReturnValueProduct { productName: string; unit: string; quantity: number; valuedQuantity: number; unvaluedQuantity: number; valueSatang: number; blockers: Blocker[]; }
export interface GoodReturnValueReport { businessDate: string; products: GoodReturnValueProduct[]; }
interface Cell { product: string; unit: string; resolvedMarket: boolean; withdrawn: number; returned: number; damaged: number; prices: Set<number>; hasWithdrawal: boolean; invalidQuantity: boolean; invalidPrice: boolean; }
interface Entry { category: string; block: string; shortened: boolean; }

function priceSatang(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split("."); const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0"; const shift = 2 - (fraction.length - exponent);
  const satang = shift >= 0 ? BigInt(digits) * BigInt(10) ** BigInt(shift) : roundHalfUp(BigInt(digits), BigInt(10) ** BigInt(-shift));
  return satang <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(satang) : null;
}
function displayUnit(unit: string): string { return unit === "โล" ? "กก." : unit || "—"; }
function cellBlockers(cell: Cell): Blocker[] {
  if (!cell.resolvedMarket) return ["ระบุตลาดไม่ได้"];
  if (cell.invalidQuantity || !cell.unit) return ["จำนวนไม่ถูกต้อง"];
  if (!cell.hasWithdrawal || cell.withdrawn <= 0) return ["ไม่พบรายการเบิกที่ตรงกัน"];
  if (cell.returned > cell.withdrawn) return ["คืนมากกว่าเบิก"];
  if (cell.returned + cell.damaged > cell.withdrawn) return ["คืนและคืนเสียรวมมากกว่าเบิก"];
  if (cell.invalidPrice || cell.prices.size === 0) return ["รายการเบิกไม่มีราคา"];
  return cell.prices.size > 1 ? ["ราคาจากรายการเบิกขัดแย้งกัน"] : [];
}

/** Scheduled-only valuation; P0 rows, aliases, units, QA filtering, and dedup stay authoritative. */
export function buildDailyGoodReturnValueReport(businessDate: string, rows: readonly RemainingFruitSourceRow[]): GoodReturnValueReport {
  const source = dedupeRemainingSourceRows(rows); const known = new Set(source.map((row) => normalizeProductName(row.product_name))); const cells = new Map<string, Cell>();
  source.forEach((row, index) => {
    const bucket = transactionBucket(row.transaction_type); if (!bucket) return;
    const market = cleanMarketName(row.market_name); if (market && isQaMarketLabel(market)) return;
    const product = normalizeProductName(row.product_name, undefined, known); const unit = row.unit?.trim() ? normalizeUnitAlias(row.unit.trim()) : "";
    // Never let two unresolved rows become matching price evidence.
    const key = market ? `${market}||${product}||${unit}` : `unresolved:${index}`;
    const cell = cells.get(key) ?? { product, unit, resolvedMarket: Boolean(market), withdrawn: 0, returned: 0, damaged: 0, prices: new Set(), hasWithdrawal: false, invalidQuantity: false, invalidPrice: false };
    if (row.quantity === null || !Number.isFinite(row.quantity) || row.quantity < 0) cell.invalidQuantity = true;
    else if (bucket === "เบิก") { cell.withdrawn += row.quantity; cell.hasWithdrawal = true; const price = priceSatang(row.price_per_unit); if (price === null) cell.invalidPrice = true; else cell.prices.add(price); }
    else if (bucket === "คืน") cell.returned += row.quantity; else cell.damaged += row.quantity;
    cells.set(key, cell);
  });
  const products = new Map<string, GoodReturnValueProduct>();
  for (const cell of cells.values()) {
    if (cell.returned <= 0) continue;
    const key = `${cell.product}||${cell.unit}`; const product = products.get(key) ?? { productName: cell.product, unit: cell.unit, quantity: 0, valuedQuantity: 0, unvaluedQuantity: 0, valueSatang: 0, blockers: [] }; product.quantity += cell.returned;
    const blockers = cellBlockers(cell); const value = blockers.length ? null : quantityTimesSatang(cell.returned, [...cell.prices][0]!);
    if (value === null) { product.unvaluedQuantity += cell.returned; product.blockers.push(...(blockers.length ? blockers : (["จำนวนไม่ถูกต้อง"] as Blocker[]))); } else { product.valuedQuantity += cell.returned; product.valueSatang += value; }
    products.set(key, product);
  }
  return { businessDate, products: [...products.values()].map((row) => ({ ...row, blockers: [...new Set(row.blockers)] })).sort((a,b) => STOCK_CATEGORY_ORDER.indexOf(stockCategoryFor(a.productName)) - STOCK_CATEGORY_ORDER.indexOf(stockCategoryFor(b.productName)) || b.quantity - a.quantity || a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th")) };
}

function productBlock(row: GoodReturnValueProduct, index: number): string {
  const base = `${index}. ${row.productName} — ${formatQuantity(row.quantity)} ${displayUnit(row.unit)}`;
  if (!row.valuedQuantity) return `${base}.\n   ⚠️ ยังระบุมูลค่าไม่ได้ — ${row.blockers.join(", ")}`;
  if (!row.unvaluedQuantity) return `${base} • ${satangToBahtText(row.valueSatang)} บาท`;
  return `${base} • ${satangToBahtText(row.valueSatang)} บาท\n   ⚠️ คิดได้ ${formatQuantity(row.valuedQuantity)} ${displayUnit(row.unit)} • อีก ${formatQuantity(row.unvaluedQuantity)} ${displayUnit(row.unit)} ยังระบุมูลค่าไม่ได้ — ${row.blockers.join(", ")}`;
}
function incompleteBlock(incomplete: readonly StockIncompleteEntry[]): string | null {
  if (!incomplete.length) return null;
  return `⚠️ พบรายการเบิกที่ไม่มีข้อมูลชั่งคืน\n${incomplete.length} รายการ จาก ${new Set(incomplete.map((row) => row.marketName)).size} ตลาด`;
}
function header(report: GoodReturnValueReport, part: number, totalParts: number, first: number, last: number): string[] {
  const lines = part === 1 ? ["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง"] : [`📦 ของดีชั่งคืน — ต่อ ${part}/${totalParts}`];
  return [...lines, `รายการ ${first}–${last} จากทั้งหมด ${report.products.length} รายการ`];
}
function summaryBlock(report: GoodReturnValueReport, incomplete: readonly StockIncompleteEntry[], omitted: number): string {
  const complete = report.products.filter((row) => !row.unvaluedQuantity).length;
  return [incompleteBlock(incomplete), omitted ? `⚠️ แสดงรายละเอียดไม่ครบ ${omitted} รายการ เนื่องจากเกินขีดจำกัดข้อความ LINE` : null, `รวมมูลค่าของดีที่ยืนยันได้ ${satangToBahtText(report.products.reduce((sum, row) => sum + row.valueSatang, 0))} บาท`, `✅ คิดได้ครบ ${complete} รายการ`, `⚠️ คำนวณไม่ได้หรือได้บางส่วน ${report.products.length - complete} รายการ`].filter((line): line is string => Boolean(line)).join("\n\n");
}
function lines(entries: readonly Entry[]): string {
  return entries.flatMap((item, index) => [index === 0 || item.category !== entries[index - 1]!.category ? `${STOCK_CATEGORY_EMOJI[item.category as keyof typeof STOCK_CATEGORY_EMOJI]} ${item.category}` : null, item.block]).filter(Boolean).join("\n");
}

/** Packs whole product+warning blocks under both LINE limits. */
export function buildDailyGoodReturnValueMessages(report: GoodReturnValueReport, options: { latest?: LatestDataLookup; incomplete?: readonly StockIncompleteEntry[] } = {}): string[] {
  const incomplete = options.incomplete ?? [];
  if (!report.products.length) {
    const date = formatThaiDate(report.businessDate); const activity = incompleteBlock(incomplete);
    return [["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${date}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง", activity ?? `ยังไม่พบข้อมูลชั่งคืนประจำวันที่ ${date}`, activity ? null : latestDataBlock(options.latest ?? { status: "unavailable" }, "ยังไม่พบข้อมูลชั่งคืนในระบบ")].filter(Boolean).join("\n\n")];
  }
  const parts: Entry[][] = []; let current: Entry[] = []; let shortened = 0;
  for (const [index, row] of report.products.entries()) {
    const entry = { category: stockCategoryFor(row.productName), block: productBlock(row, index + 1), shortened: false };
    if (current.length && (current.length === 15 || countCodePoints(lines([...current, entry])) + 450 > LINE_MESSAGE_MAX_CODE_POINTS)) { parts.push(current); current = []; }
    if (countCodePoints(lines([entry])) + 450 > LINE_MESSAGE_MAX_CODE_POINTS) {
      parts.push([{ category: entry.category, block: `${index + 1}. รายการยาวเกินขีดจำกัด LINE จึงไม่แสดงรายละเอียด`, shortened: true }]);
      shortened++;
    } else current.push(entry);
  }
  if (current.length) parts.push(current);
  const omittedRows = (groups: readonly (readonly Entry[])[]) => groups.reduce((count, group) => count + group.filter((entry) => !entry.shortened).length, 0);
  let omitted = shortened + (parts.length > LINE_REPLY_MAX_MESSAGES ? omittedRows(parts.slice(LINE_REPLY_MAX_MESSAGES - 1)) : 0);
  const delivered = parts.length > LINE_REPLY_MAX_MESSAGES ? parts.slice(0, LINE_REPLY_MAX_MESSAGES - 1) : parts;
  const messages = delivered.map((part, index) => {
    const first = Number(part[0]!.block.match(/^(\d+)\./)?.[1] ?? index * 15 + 1);
    return [...header(report, index + 1, delivered.length, first, first + part.length - 1), lines(part)].join("\n");
  });
  const final = summaryBlock(report, incomplete, omitted); const last = messages[messages.length - 1]!;
  if (countCodePoints(`${last}\n\n${final}`) <= LINE_MESSAGE_MAX_CODE_POINTS) messages[messages.length - 1] = `${last}\n\n${final}`;
  else if (messages.length < LINE_REPLY_MAX_MESSAGES) messages.push(final);
  else { omitted += omittedRows([delivered.pop()!]); messages.pop(); messages.push(summaryBlock(report, incomplete, omitted)); }
  if (messages.some((message) => countCodePoints(message) > LINE_MESSAGE_MAX_CODE_POINTS)) throw new Error("daily good-return value message exceeds LINE limit");
  return messages;
}
