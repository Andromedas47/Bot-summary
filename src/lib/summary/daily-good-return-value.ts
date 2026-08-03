import { formatThaiDate } from "@/lib/date";
import { latestDataBlock, type LatestDataLookup } from "@/lib/summary/latest-data-hint";
import { cleanMarketName } from "@/lib/market";
import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { quantityTimesSatang, roundHalfUp, satangToBahtText } from "@/lib/sales/calculate";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { STOCK_CATEGORY_EMOJI, STOCK_CATEGORY_ORDER, stockCategoryFor } from "@/lib/summary/stock-categories";
import { dedupeRemainingSourceRows, formatQuantity, normalizeProductName, type RemainingFruitSourceRow } from "@/lib/summary/remaining-fruit";
import { transactionBucket } from "@/lib/summary/transactions";

type Blocker = "ไม่พบรายการเบิกที่ตรงกัน" | "ไม่พบราคาจากรายการเบิก" | "ราคาจากรายการเบิกขัดแย้งกัน" | "คืนมากกว่าเบิก" | "คืนและคืนเสียรวมมากกว่าเบิก" | "จำนวนไม่ถูกต้อง";
export interface GoodReturnValueProduct { productName: string; unit: string; quantity: number; valuedQuantity: number; unvaluedQuantity: number; valueSatang: number; blockers: Blocker[]; }
export interface GoodReturnValueReport { businessDate: string; products: GoodReturnValueProduct[]; }
interface Cell { product: string; unit: string; withdrawn: number; returned: number; damaged: number; prices: Set<number>; hasWithdrawal: boolean; invalid: boolean; }

function priceSatang(value: number | null | undefined): number | null {
  if (!Number.isFinite(value) || value === undefined || value === null || value <= 0) return null;
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split("."); const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0"; const shift = 2 - (fraction.length - exponent);
  const result = shift >= 0 ? BigInt(digits) * BigInt(10) ** BigInt(shift) : roundHalfUp(BigInt(digits), BigInt(10) ** BigInt(-shift));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}
function displayUnit(unit: string): string { return unit === "โล" ? "กก." : unit || "—"; }

/** Read-only, scheduled-only valuation using the same P0 row set and identities. */
export function buildDailyGoodReturnValueReport(businessDate: string, rows: readonly RemainingFruitSourceRow[]): GoodReturnValueReport {
  const source = dedupeRemainingSourceRows(rows); const known = new Set(source.map((row) => normalizeProductName(row.product_name))); const cells = new Map<string, Cell>();
  for (const row of source) {
    const bucket = transactionBucket(row.transaction_type); if (!bucket) continue;
    const market = cleanMarketName(row.market_name) ?? ""; if (isQaMarketLabel(market)) continue;
    const product = normalizeProductName(row.product_name, undefined, known); const unit = row.unit?.trim() ? normalizeUnitAlias(row.unit.trim()) : ""; const key = `${market}||${product}||${unit}`;
    const cell = cells.get(key) ?? { product, unit, withdrawn: 0, returned: 0, damaged: 0, prices: new Set(), hasWithdrawal: false, invalid: false }; const quantity = row.quantity;
    if (quantity === null || !Number.isFinite(quantity) || quantity < 0) cell.invalid = true;
    else if (bucket === "เบิก") { cell.withdrawn += quantity; cell.hasWithdrawal = true; const price = priceSatang(row.price_per_unit); if (price !== null) cell.prices.add(price); }
    else if (bucket === "คืน") cell.returned += quantity; else cell.damaged += quantity;
    cells.set(key, cell);
  }
  const products = new Map<string, GoodReturnValueProduct>();
  for (const cell of cells.values()) {
    if (cell.returned <= 0) continue;
    const blockers: Blocker[] = (cell.invalid || !cell.unit ? ["จำนวนไม่ถูกต้อง"] : !cell.hasWithdrawal || cell.withdrawn <= 0 ? ["ไม่พบรายการเบิกที่ตรงกัน"] : cell.returned > cell.withdrawn ? ["คืนมากกว่าเบิก"] : cell.returned + cell.damaged > cell.withdrawn ? ["คืนและคืนเสียรวมมากกว่าเบิก"] : cell.prices.size === 0 ? ["ไม่พบราคาจากรายการเบิก"] : cell.prices.size > 1 ? ["ราคาจากรายการเบิกขัดแย้งกัน"] : []) as Blocker[];
    const key = `${cell.product}||${cell.unit}`; const product = products.get(key) ?? { productName: cell.product, unit: cell.unit, quantity: 0, valuedQuantity: 0, unvaluedQuantity: 0, valueSatang: 0, blockers: [] }; product.quantity += cell.returned;
    const value = blockers.length ? null : quantityTimesSatang(cell.returned, [...cell.prices][0]!);
    if (value === null) { product.unvaluedQuantity += cell.returned; product.blockers.push(...(blockers.length ? blockers : (["จำนวนไม่ถูกต้อง"] as Blocker[]))); } else { product.valuedQuantity += cell.returned; product.valueSatang += value; }
    products.set(key, product);
  }
  return { businessDate, products: [...products.values()].map((p) => ({ ...p, blockers: [...new Set(p.blockers)] })).sort((a,b) => STOCK_CATEGORY_ORDER.indexOf(stockCategoryFor(a.productName)) - STOCK_CATEGORY_ORDER.indexOf(stockCategoryFor(b.productName)) || b.quantity - a.quantity || a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th")) };
}

function lines(row: GoodReturnValueProduct, index: number): string[] {
  const base = `${index}. ${row.productName} — ${formatQuantity(row.quantity)} ${displayUnit(row.unit)}`;
  if (!row.valuedQuantity) return [`${base}.`, `   ⚠️ ยังระบุมูลค่าไม่ได้ — ${row.blockers.join(", ")}`];
  if (!row.unvaluedQuantity) return [`${base} • ${satangToBahtText(row.valueSatang)} บาท`];
  return [`${base} • ${satangToBahtText(row.valueSatang)} บาท`, `   ⚠️ คิดได้ ${formatQuantity(row.valuedQuantity)} ${displayUnit(row.unit)} • อีก ${formatQuantity(row.unvaluedQuantity)} ${displayUnit(row.unit)} ยังระบุมูลค่าไม่ได้ — ${row.blockers.join(", ")}`];
}

export function buildDailyGoodReturnValueMessages(
  report: GoodReturnValueReport,
  options: { latest?: LatestDataLookup } = {},
): string[] {
  if (!report.products.length) {
    const date = formatThaiDate(report.businessDate);
    return [["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${date}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง", `ยังไม่พบข้อมูลชั่งคืนประจำวันที่ ${date}`, latestDataBlock(options.latest ?? { status: "unavailable" }, "ยังไม่พบข้อมูลชั่งคืนในระบบ")].join("\n\n")];
  }
  const chunks = Array.from({ length: Math.ceil(report.products.length / 15) }, (_, i) => report.products.slice(i * 15, i * 15 + 15));
  return chunks.map((chunk, part) => { const first = part * 15 + 1; const last = first + chunk.length - 1; const output = part ? [`📦 ของดีชั่งคืน — ต่อ ${part + 1}/${chunks.length}`] : ["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง"]; output.push(`รายการ ${first}–${last} จากทั้งหมด ${report.products.length} รายการ`); let category = ""; for (const [offset, row] of chunk.entries()) { const next = stockCategoryFor(row.productName); if (next !== category) { category = next; output.push(`${STOCK_CATEGORY_EMOJI[next]} ${next}`); } output.push(...lines(row, first + offset)); } if (part === chunks.length - 1) { const complete = report.products.filter((row) => !row.unvaluedQuantity).length; output.push("", `รวมมูลค่าของดีที่ยืนยันได้ ${satangToBahtText(report.products.reduce((sum, row) => sum + row.valueSatang, 0))} บาท`, `✅ คิดได้ครบ ${complete} รายการ`, `⚠️ คำนวณไม่ได้หรือได้บางส่วน ${report.products.length - complete} รายการ`); } return output.join("\n"); });
}
