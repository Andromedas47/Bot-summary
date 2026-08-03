import { formatThaiDate } from "@/lib/date";
import { cleanMarketName } from "@/lib/market";
import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { quantityTimesSatang, roundHalfUp, satangToBahtText } from "@/lib/sales/calculate";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { latestDataBlock, type LatestDataLookup } from "@/lib/summary/latest-data-hint";
import { LINE_MESSAGE_MAX_CODE_POINTS, LINE_REPLY_MAX_MESSAGES, countCodePoints } from "@/lib/summary/line-chunking";
import { STOCK_CATEGORY_EMOJI, STOCK_CATEGORY_ORDER, stockCategoryFor } from "@/lib/summary/stock-categories";
import { dedupeRemainingSourceRows, formatQuantity, normalizeProductName, type RemainingFruitSourceRow } from "@/lib/summary/remaining-fruit";
import { transactionBucket } from "@/lib/summary/transactions";

type Blocker = "ไม่พบรายการเบิกที่ตรงกัน" | "รายการเบิกไม่มีราคา" | "ราคาจากรายการเบิกขัดแย้งกัน" | "คืนมากกว่าเบิก" | "คืนและคืนเสียรวมมากกว่าเบิก" | "จำนวนไม่ถูกต้อง" | "ระบุตลาดไม่ได้";

/** Aggregated across every contributing market — the number the business reads first. */
export interface GoodReturnValueProduct { productName: string; unit: string; quantity: number; valuedQuantity: number; unvaluedQuantity: number; valueSatang: number; /** Distinct markets whose cells for this product+unit are unvalued. */ anomalyMarketCount: number; }

/**
 * One market + product + unit whose valuation is fail-closed. Never aggregated away — this IS the actionable detail.
 *
 * withdrawnQuantity/returnedQuantity/damagedQuantity/unvaluedQuantity are `null`
 * when the underlying transaction row itself carried an invalid numeric
 * quantity — a dirty-data reading must never be displayed as if it were a
 * trustworthy zero or a trustworthy count.
 */
export interface MarketAnomaly { marketName: string; productName: string; unit: string; withdrawnQuantity: number | null; returnedQuantity: number | null; damagedQuantity: number | null; /** Distinct matching-withdrawal prices, in satang, ascending. */ priceEvidence: number[]; blockers: Blocker[]; valuedQuantity: number; unvaluedQuantity: number | null; valueSatang: number; }

/** hasActivity: any non-QA, resolved-bucket produce transaction row existed for this date — distinguishes a genuine sold-out day (withdrawals, zero good returns) from a genuinely empty date (no relevant rows at all). */
export interface GoodReturnValueReport { businessDate: string; products: GoodReturnValueProduct[]; anomalies: MarketAnomaly[]; hasActivity: boolean; }

interface Cell {
  market: string; product: string; unit: string; resolvedMarket: boolean;
  withdrawn: number; returned: number; damaged: number;
  invalidWithdrawn: boolean; invalidReturned: boolean; invalidDamaged: boolean;
  prices: Set<number>; hasWithdrawal: boolean; invalidPrice: boolean;
}
interface RowEntry { block: string; shortened: boolean; }
interface Entry extends RowEntry { category: string; }

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
  if (cell.invalidWithdrawn || cell.invalidReturned || cell.invalidDamaged || !cell.unit) return ["จำนวนไม่ถูกต้อง"];
  if (!cell.hasWithdrawal || cell.withdrawn <= 0) return ["ไม่พบรายการเบิกที่ตรงกัน"];
  if (cell.returned > cell.withdrawn) return ["คืนมากกว่าเบิก"];
  if (cell.returned + cell.damaged > cell.withdrawn) return ["คืนและคืนเสียรวมมากกว่าเบิก"];
  if (cell.invalidPrice || cell.prices.size === 0) return ["รายการเบิกไม่มีราคา"];
  return cell.prices.size > 1 ? ["ราคาจากรายการเบิกขัดแย้งกัน"] : [];
}

const productOrder = (a: GoodReturnValueProduct, b: GoodReturnValueProduct) =>
  STOCK_CATEGORY_ORDER.indexOf(stockCategoryFor(a.productName)) - STOCK_CATEGORY_ORDER.indexOf(stockCategoryFor(b.productName)) ||
  b.quantity - a.quantity || a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th");
const anomalyOrder = (a: MarketAnomaly, b: MarketAnomaly) =>
  STOCK_CATEGORY_ORDER.indexOf(stockCategoryFor(a.productName)) - STOCK_CATEGORY_ORDER.indexOf(stockCategoryFor(b.productName)) ||
  a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th") || a.marketName.localeCompare(b.marketName, "th");

/**
 * Scheduled-only valuation; P0 rows, aliases, units, QA filtering, and dedup stay authoritative.
 *
 * Business truth: a withdrawal with no good return is normal (sold), never a
 * warning. Every fail-closed cell keeps its market identity all the way to
 * the anomaly list below — aggregation never discards which market caused it.
 * A good-return row with an invalid quantity is dirty data, not silence: it
 * still surfaces as a market-level anomaly even when it contributes zero to
 * the physical aggregate.
 */
export function buildDailyGoodReturnValueReport(businessDate: string, rows: readonly RemainingFruitSourceRow[]): GoodReturnValueReport {
  const source = dedupeRemainingSourceRows(rows); const known = new Set(source.map((row) => normalizeProductName(row.product_name))); const cells = new Map<string, Cell>();
  source.forEach((row, index) => {
    const bucket = transactionBucket(row.transaction_type); if (!bucket) return;
    const market = cleanMarketName(row.market_name); if (market && isQaMarketLabel(market)) return;
    const product = normalizeProductName(row.product_name, undefined, known); const unit = row.unit?.trim() ? normalizeUnitAlias(row.unit.trim()) : "";
    // Never let two unresolved rows become matching price/withdrawal evidence.
    const key = market ? `${market}||${product}||${unit}` : `unresolved:${index}`;
    const cell = cells.get(key) ?? { market: market ?? (row.market_name?.trim() || "ไม่ทราบตลาด"), product, unit, resolvedMarket: Boolean(market), withdrawn: 0, returned: 0, damaged: 0, invalidWithdrawn: false, invalidReturned: false, invalidDamaged: false, prices: new Set<number>(), hasWithdrawal: false, invalidPrice: false };
    if (row.quantity === null || !Number.isFinite(row.quantity) || row.quantity < 0) {
      if (bucket === "เบิก") cell.invalidWithdrawn = true; else if (bucket === "คืน") cell.invalidReturned = true; else cell.invalidDamaged = true;
    } else if (bucket === "เบิก") { cell.withdrawn += row.quantity; cell.hasWithdrawal = true; const price = priceSatang(row.price_per_unit); if (price === null) cell.invalidPrice = true; else cell.prices.add(price); }
    else if (bucket === "คืน") cell.returned += row.quantity; else cell.damaged += row.quantity;
    cells.set(key, cell);
  });
  const products = new Map<string, GoodReturnValueProduct>(); const anomalies: MarketAnomaly[] = []; const anomalyMarketsByProduct = new Map<string, Set<string>>();
  for (const cell of cells.values()) {
    // Normal: a withdrawal with no good return is sold, not a warning. But an
    // invalid good-return row IS reportable dirty data even with zero valid quantity.
    if (cell.returned <= 0 && !cell.invalidReturned) continue;
    const key = `${cell.product}||${cell.unit}`;
    const product = products.get(key) ?? { productName: cell.product, unit: cell.unit, quantity: 0, valuedQuantity: 0, unvaluedQuantity: 0, valueSatang: 0, anomalyMarketCount: 0 };
    product.quantity += cell.returned;
    const blockers = cellBlockers(cell); const value = blockers.length ? null : quantityTimesSatang(cell.returned, [...cell.prices][0]!);
    if (value === null) {
      product.unvaluedQuantity += cell.returned;
      const markets = anomalyMarketsByProduct.get(key) ?? new Set<string>(); markets.add(cell.market); anomalyMarketsByProduct.set(key, markets);
      anomalies.push({
        marketName: cell.market, productName: cell.product, unit: cell.unit,
        withdrawnQuantity: cell.invalidWithdrawn ? null : cell.withdrawn,
        returnedQuantity: cell.invalidReturned ? null : cell.returned,
        damagedQuantity: cell.invalidDamaged ? null : cell.damaged,
        priceEvidence: [...cell.prices].sort((a, b) => a - b), blockers,
        valuedQuantity: 0, unvaluedQuantity: cell.invalidReturned ? null : cell.returned, valueSatang: 0,
      });
    } else { product.valuedQuantity += cell.returned; product.valueSatang += value; }
    products.set(key, product);
  }
  for (const [key, markets] of anomalyMarketsByProduct) { const product = products.get(key); if (product) product.anomalyMarketCount = markets.size; }
  return { businessDate, products: [...products.values()].sort(productOrder), anomalies: anomalies.sort(anomalyOrder), hasActivity: cells.size > 0 };
}

function productBlock(row: GoodReturnValueProduct, index: number): string {
  const unit = displayUnit(row.unit); const base = `${index}. ${row.productName} — ${formatQuantity(row.quantity)} ${unit}`;
  if (!row.valuedQuantity) return `${base}\n   ⚠️ รอตรวจทั้งหมดจาก ${row.anomalyMarketCount} ตลาด`;
  if (!row.unvaluedQuantity) return `${base} • ${satangToBahtText(row.valueSatang)} บาท`;
  return `${base} • ${satangToBahtText(row.valueSatang)} บาท\n   ⚠️ รอตรวจ ${formatQuantity(row.unvaluedQuantity)} ${unit} จาก ${row.anomalyMarketCount} ตลาด`;
}
const ANOMALY_HEADING = "⚠️ รายละเอียดข้อมูลผิดปกติ";
function marketAnomalyBlock(row: MarketAnomaly, index: number): string {
  const unit = displayUnit(row.unit);
  const qty = (value: number | null) => (value === null ? "ไม่ถูกต้อง" : `${formatQuantity(value)} ${unit}`);
  const priceLine = row.priceEvidence.length ? `\nราคาที่พบ: ${row.priceEvidence.map((satang) => `${satangToBahtText(satang)} บาท`).join(", ")}` : "";
  const pendingLine = row.unvaluedQuantity === null ? "" : `\nปริมาณรอตรวจ: ${formatQuantity(row.unvaluedQuantity)} ${unit}`;
  return `${index}. ${row.marketName} — ${row.productName} — ${unit}\nเบิก ${qty(row.withdrawnQuantity)} | คืนดี ${qty(row.returnedQuantity)} | คืนเสีย ${qty(row.damagedQuantity)}${priceLine}\nปัญหา: ${row.blockers.join(", ")}${pendingLine}`;
}
function header(report: GoodReturnValueReport, part: number, totalParts: number, first: number, last: number): string[] {
  const lines = part === 1 ? ["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง"] : [`📦 ของดีชั่งคืน — ต่อ ${part}/${totalParts}`];
  return [...lines, `รายการ ${first}–${last} จากทั้งหมด ${report.products.length} รายการ`];
}
function summaryBlock(report: GoodReturnValueReport, omittedProductCount: number, omittedAnomalyCount: number): string {
  const complete = report.products.filter((row) => !row.unvaluedQuantity).length;
  const anomalyMarketCount = new Set(report.anomalies.map((row) => row.marketName)).size;
  return [
    omittedProductCount ? `⚠️ ไม่ได้แสดงสินค้าบางส่วน ${omittedProductCount} รายการ เนื่องจากขีดจำกัด LINE` : null,
    omittedAnomalyCount ? `⚠️ ไม่ได้แสดงรายละเอียดผิดปกติ ${omittedAnomalyCount} รายการ เนื่องจากขีดจำกัด LINE` : null,
    `รวมมูลค่าของดีที่ยืนยันได้ ${satangToBahtText(report.products.reduce((sum, row) => sum + row.valueSatang, 0))} บาท`,
    `✅ สินค้าที่คำนวณมูลค่าได้ครบ ${complete} รายการ`,
    report.anomalies.length ? `⚠️ พบข้อมูลผิดปกติ ${report.anomalies.length} รายการ จาก ${anomalyMarketCount} ตลาด` : null,
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}
function lines(entries: readonly Entry[]): string {
  return entries.flatMap((item, index) => [index === 0 || item.category !== entries[index - 1]!.category ? `${STOCK_CATEGORY_EMOJI[item.category as keyof typeof STOCK_CATEGORY_EMOJI]} ${item.category}` : null, item.block]).filter(Boolean).join("\n");
}
const omittedRows = (groups: readonly (readonly RowEntry[])[]) => groups.reduce((count, group) => count + group.filter((entry) => !entry.shortened).length, 0);

type DeliveredGroup = { kind: "product"; entries: Entry[]; text: string } | { kind: "anomaly"; entries: RowEntry[]; text: string };

/**
 * Packs whole product blocks (max 15/message) and whole anomaly blocks under both LINE limits, never splitting either.
 *
 * Allocation is capacity-reserved, not first-come-first-served: the final
 * summary and (whenever anomalies exist) at least one anomaly-detail message
 * are budgeted BEFORE product messages claim the remaining slots. A realistic
 * day with many products and a few anomalies must never let the product list
 * alone crowd out every market-level anomaly detail — that detail is the
 * entire point of this report.
 */
export function buildDailyGoodReturnValueMessages(report: GoodReturnValueReport, options: { latest?: LatestDataLookup } = {}): string[] {
  if (!report.products.length) {
    const date = formatThaiDate(report.businessDate);
    if (report.hasActivity) {
      // Withdrawals happened but nothing was weighed back — that is sold out, not missing data.
      return [["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${date}`, "วันนี้ไม่มีของดีชั่งคืนจากตลาด\nสินค้าที่ไม่ได้คืนถือว่าขายออกแล้ว"].join("\n\n")];
    }
    return [["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${date}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง", `ยังไม่พบข้อมูลชั่งคืนประจำวันที่ ${date}`, latestDataBlock(options.latest ?? { status: "unavailable" }, "ยังไม่พบข้อมูลชั่งคืนในระบบ")].filter(Boolean).join("\n\n")];
  }

  const productParts: Entry[][] = []; let currentProduct: Entry[] = []; let shortenedProduct = 0;
  for (const [index, row] of report.products.entries()) {
    const entry: Entry = { category: stockCategoryFor(row.productName), block: productBlock(row, index + 1), shortened: false };
    if (currentProduct.length && (currentProduct.length === 15 || countCodePoints(lines([...currentProduct, entry])) + 450 > LINE_MESSAGE_MAX_CODE_POINTS)) { productParts.push(currentProduct); currentProduct = []; }
    if (countCodePoints(lines([entry])) + 450 > LINE_MESSAGE_MAX_CODE_POINTS) { productParts.push([{ category: entry.category, block: `${index + 1}. รายการยาวเกินขีดจำกัด LINE จึงไม่แสดงรายละเอียด`, shortened: true }]); shortenedProduct++; }
    else currentProduct.push(entry);
  }
  if (currentProduct.length) productParts.push(currentProduct);

  const anomalyParts: RowEntry[][] = []; let currentAnomaly: RowEntry[] = []; let shortenedAnomaly = 0;
  for (const [index, row] of report.anomalies.entries()) {
    const entry: RowEntry = { block: marketAnomalyBlock(row, index + 1), shortened: false };
    if (currentAnomaly.length && (currentAnomaly.length === 15 || countCodePoints([...currentAnomaly, entry].map((e) => e.block).join("\n\n")) + 450 > LINE_MESSAGE_MAX_CODE_POINTS)) { anomalyParts.push(currentAnomaly); currentAnomaly = []; }
    if (countCodePoints(entry.block) + 450 > LINE_MESSAGE_MAX_CODE_POINTS) { anomalyParts.push([{ block: `${index + 1}. รายละเอียดยาวเกินขีดจำกัด LINE จึงไม่แสดง`, shortened: true }]); shortenedAnomaly++; }
    else currentAnomaly.push(entry);
  }
  if (currentAnomaly.length) anomalyParts.push(currentAnomaly);

  // Reserve one slot for the final summary and, whenever anomalies exist, one
  // slot for at least one anomaly-detail message. Products get only what's left.
  const anomalyReserve = anomalyParts.length > 0 ? 1 : 0;
  const productBudget = Math.max(0, LINE_REPLY_MAX_MESSAGES - 1 - anomalyReserve);
  const deliveredProductParts = productParts.slice(0, productBudget);
  const droppedProductParts = productParts.slice(productBudget);
  const anomalyBudget = Math.max(0, LINE_REPLY_MAX_MESSAGES - 1 - deliveredProductParts.length);
  const deliveredAnomalyParts = anomalyParts.slice(0, anomalyBudget);
  const droppedAnomalyParts = anomalyParts.slice(anomalyBudget);

  let omittedProductCount = shortenedProduct + omittedRows(droppedProductParts);
  let omittedAnomalyCount = shortenedAnomaly + omittedRows(droppedAnomalyParts);

  const deliveredProductTotal = deliveredProductParts.length;
  const deliveredAnomalyTotal = deliveredAnomalyParts.length;
  const groups: DeliveredGroup[] = [
    ...deliveredProductParts.map((entries, index): DeliveredGroup => {
      const first = Number(entries[0]!.block.match(/^(\d+)\./)?.[1] ?? index * 15 + 1);
      return { kind: "product", entries, text: [...header(report, index + 1, deliveredProductTotal, first, first + entries.length - 1), lines(entries)].join("\n") };
    }),
    ...deliveredAnomalyParts.map((entries, index): DeliveredGroup => {
      const heading = deliveredAnomalyTotal > 1 ? `${ANOMALY_HEADING} (ต่อ ${index + 1}/${deliveredAnomalyTotal})` : ANOMALY_HEADING;
      return { kind: "anomaly", entries, text: [heading, entries.map((e) => e.block).join("\n\n")].join("\n\n") };
    }),
  ];

  const messages = groups.map((g) => g.text);
  const final = summaryBlock(report, omittedProductCount, omittedAnomalyCount); const last = messages[messages.length - 1]!;
  if (countCodePoints(`${last}\n\n${final}`) <= LINE_MESSAGE_MAX_CODE_POINTS) messages[messages.length - 1] = `${last}\n\n${final}`;
  else if (messages.length < LINE_REPLY_MAX_MESSAGES) messages.push(final);
  else {
    const popped = groups.pop()!; messages.pop();
    if (popped.kind === "product") omittedProductCount += omittedRows([popped.entries]); else omittedAnomalyCount += omittedRows([popped.entries]);
    messages.push(summaryBlock(report, omittedProductCount, omittedAnomalyCount));
  }
  if (messages.some((message) => countCodePoints(message) > LINE_MESSAGE_MAX_CODE_POINTS)) throw new Error("daily good-return value message exceeds LINE limit");
  return messages;
}
