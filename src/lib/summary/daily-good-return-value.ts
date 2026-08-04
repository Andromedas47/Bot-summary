import { formatThaiDate } from "@/lib/date";
import { cleanMarketName } from "@/lib/market";
import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { quantityTimesSatang, roundHalfUp, satangToBahtText } from "@/lib/sales/calculate";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { latestDataBlock, type LatestDataLookup } from "@/lib/summary/latest-data-hint";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";
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
    const blockers = cellBlockers(cell);
    // An invalid quantity is unknown, not zero — it must never inflate the
    // physical aggregate with a zero-quantity product row. Only a genuinely
    // positive recorded good-return quantity creates or updates the product.
    if (cell.returned > 0) {
      const product = products.get(key) ?? { productName: cell.product, unit: cell.unit, quantity: 0, valuedQuantity: 0, unvaluedQuantity: 0, valueSatang: 0, anomalyMarketCount: 0 };
      product.quantity += cell.returned;
      const value = blockers.length ? null : quantityTimesSatang(cell.returned, [...cell.prices][0]!);
      if (value === null) product.unvaluedQuantity += cell.returned;
      else { product.valuedQuantity += cell.returned; product.valueSatang += value; }
      products.set(key, product);
    }
    if (blockers.length) {
      const markets = anomalyMarketsByProduct.get(key) ?? new Set<string>(); markets.add(cell.market); anomalyMarketsByProduct.set(key, markets);
      anomalies.push({
        marketName: cell.market, productName: cell.product, unit: cell.unit,
        withdrawnQuantity: cell.invalidWithdrawn ? null : cell.withdrawn,
        returnedQuantity: cell.invalidReturned ? null : cell.returned,
        damagedQuantity: cell.invalidDamaged ? null : cell.damaged,
        priceEvidence: [...cell.prices].sort((a, b) => a - b), blockers,
        valuedQuantity: 0, unvaluedQuantity: cell.invalidReturned ? null : cell.returned, valueSatang: 0,
      });
    }
  }
  // Only backfills markets onto a product that actually exists — an
  // invalid-only cell with no sibling valid cell never gets a product row,
  // so it stays a pure anomaly-only entry (products.length can be 0 while
  // anomalies.length > 0).
  for (const [key, markets] of anomalyMarketsByProduct) { const product = products.get(key); if (product) product.anomalyMarketCount = markets.size; }
  return { businessDate, products: [...products.values()].sort(productOrder), anomalies: anomalies.sort(anomalyOrder), hasActivity: cells.size > 0 };
}

function productBlock(row: GoodReturnValueProduct, index: number): string {
  const unit = displayUnit(row.unit); const base = `${index}. ${row.productName} — ${formatQuantity(row.quantity)} ${unit}`;
  if (!row.valuedQuantity) return `${base}\n   ⚠️ รอตรวจทั้งหมดจาก ${row.anomalyMarketCount} ตลาด`;
  if (row.unvaluedQuantity) return `${base} • ${satangToBahtText(row.valueSatang)} บาท\n   ⚠️ รอตรวจ ${formatQuantity(row.unvaluedQuantity)} ${unit} จาก ${row.anomalyMarketCount} ตลาด`;
  // Every quantity this product carries valued cleanly, but at least one OTHER
  // market for the same product+unit is invalid-only (contributed zero
  // quantity, not a trustworthy zero) — still flagged, amount stays unknown.
  if (row.anomalyMarketCount) return `${base} • ${satangToBahtText(row.valueSatang)} บาท\n   ⚠️ มีข้อมูลผิดปกติจาก ${row.anomalyMarketCount} ตลาด (จำนวนไม่ทราบ)`;
  return `${base} • ${satangToBahtText(row.valueSatang)} บาท`;
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
  // A product is only "fully calculated" when nothing about it is flagged —
  // anomalyMarketCount > 0 means some market's evidence is still untrustworthy,
  // even when that market contributed zero to unvaluedQuantity (unknown, not zero).
  const complete = report.products.filter((row) => !row.unvaluedQuantity && !row.anomalyMarketCount).length;
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
type DeliveredGroup = { kind: "product"; entries: Entry[]; text: string } | { kind: "anomaly"; entries: RowEntry[]; text: string };

/**
 * Readability target for a fully-rendered message (heading + entries), well
 * under the 4,000 code-point LINE hard limit. Real Good Return messages were
 * hitting LINE's client-side "See more" collapse (~5-6 visible entries) long
 * before the hard limit, so packing is driven by this instead of a fixed
 * entry count. HEADING_RESERVE is a conservative estimate of the heading +
 * "รายการ N-M จากทั้งหมด ..." continuation lines, which can't be computed
 * exactly until packing (and thus total part count) is finished.
 */
const GOOD_RETURN_READABLE_MAX_CODE_POINTS = 850;
const HEADING_RESERVE = 200;
const HARD_LIMIT_RESERVE = 450;

/**
 * Packs whole product blocks and whole anomaly blocks by rendered code-point
 * length, never splitting an entry. This is a P0-specific readability
 * adjustment — see GOOD_RETURN_READABLE_MAX_CODE_POINTS above — and is
 * deliberately scoped to this report rather than the shared line-chunking
 * helpers.
 *
 * Every generated part is delivered: this scheduled report pushes each part
 * via its own retry-keyed pushLineMessage call, so LINE_REPLY_MAX_MESSAGES
 * (a webhook-reply-flow concept) does not apply here.
 */
export function buildDailyGoodReturnValueMessages(report: GoodReturnValueReport, options: { latest?: LatestDataLookup } = {}): string[] {
  // An anomaly-only report (zero product rows, but invalid-only good-return
  // evidence still flagged) is neither a sold-out day nor a genuinely empty
  // one — it falls through to the normal render path below, which already
  // handles an empty productParts list and a non-empty anomalyParts list.
  if (!report.products.length && !report.anomalies.length) {
    const date = formatThaiDate(report.businessDate);
    if (report.hasActivity) {
      // Withdrawals happened but nothing was weighed back — that is sold out, not missing data.
      return [["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${date}`, "วันนี้ไม่มีของดีชั่งคืนจากตลาด\nสินค้าที่ไม่ได้คืนถือว่าขายออกแล้ว"].join("\n\n")];
    }
    return [["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${date}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง", `ยังไม่พบข้อมูลชั่งคืนประจำวันที่ ${date}`, latestDataBlock(options.latest ?? { status: "unavailable" }, "ยังไม่พบข้อมูลชั่งคืนในระบบ")].filter(Boolean).join("\n\n")];
  }

  // Greedy packing by rendered code-point length: before adding the next
  // whole entry, check whether it would push the in-progress part over the
  // readability target. If a single entry alone already exceeds the target
  // (but stays under the LINE hard limit), it ships alone rather than being
  // split or shortened — only the hard-limit fallback below shortens an entry.
  const productParts: Entry[][] = []; let currentProduct: Entry[] = []; let shortenedProduct = 0;
  for (const [index, row] of report.products.entries()) {
    const entry: Entry = { category: stockCategoryFor(row.productName), block: productBlock(row, index + 1), shortened: false };
    if (countCodePoints(lines([entry])) + HARD_LIMIT_RESERVE > LINE_MESSAGE_MAX_CODE_POINTS) {
      productParts.push([{ category: entry.category, block: `${index + 1}. รายการยาวเกินขีดจำกัด LINE จึงไม่แสดงรายละเอียด`, shortened: true }]);
      shortenedProduct++;
      continue;
    }
    if (currentProduct.length && countCodePoints(lines([...currentProduct, entry])) + HEADING_RESERVE > GOOD_RETURN_READABLE_MAX_CODE_POINTS) { productParts.push(currentProduct); currentProduct = []; }
    currentProduct.push(entry);
  }
  if (currentProduct.length) productParts.push(currentProduct);

  const anomalyParts: RowEntry[][] = []; let currentAnomaly: RowEntry[] = []; let shortenedAnomaly = 0;
  for (const [index, row] of report.anomalies.entries()) {
    const entry: RowEntry = { block: marketAnomalyBlock(row, index + 1), shortened: false };
    if (countCodePoints(entry.block) + HARD_LIMIT_RESERVE > LINE_MESSAGE_MAX_CODE_POINTS) {
      anomalyParts.push([{ block: `${index + 1}. รายละเอียดยาวเกินขีดจำกัด LINE จึงไม่แสดง`, shortened: true }]);
      shortenedAnomaly++;
      continue;
    }
    if (currentAnomaly.length && countCodePoints([...currentAnomaly, entry].map((e) => e.block).join("\n\n")) + HEADING_RESERVE > GOOD_RETURN_READABLE_MAX_CODE_POINTS) { anomalyParts.push(currentAnomaly); currentAnomaly = []; }
    currentAnomaly.push(entry);
  }
  if (currentAnomaly.length) anomalyParts.push(currentAnomaly);

  // This scheduled report delivers every generated part (see function doc) —
  // no LINE_REPLY_MAX_MESSAGES budgeting/dropping here.
  const omittedProductCount = shortenedProduct;
  const omittedAnomalyCount = shortenedAnomaly;

  const deliveredProductTotal = productParts.length;
  const deliveredAnomalyTotal = anomalyParts.length;
  const groups: DeliveredGroup[] = [
    ...productParts.map((entries, index): DeliveredGroup => {
      const first = Number(entries[0]!.block.match(/^(\d+)\./)?.[1] ?? 1);
      return { kind: "product", entries, text: [...header(report, index + 1, deliveredProductTotal, first, first + entries.length - 1), lines(entries)].join("\n") };
    }),
    ...anomalyParts.map((entries, index): DeliveredGroup => {
      const heading = deliveredAnomalyTotal > 1 ? `${ANOMALY_HEADING} (ต่อ ${index + 1}/${deliveredAnomalyTotal})` : ANOMALY_HEADING;
      return { kind: "anomaly", entries, text: [heading, entries.map((e) => e.block).join("\n\n")].join("\n\n") };
    }),
  ];

  const messages = groups.map((g) => g.text);
  const final = summaryBlock(report, omittedProductCount, omittedAnomalyCount); const last = messages[messages.length - 1]!;
  // The summary only rides along on the final message when that stays within
  // the readability target; otherwise it ships as its own short message
  // (never dropped — this flow has no five-message cap).
  if (countCodePoints(`${last}\n\n${final}`) <= GOOD_RETURN_READABLE_MAX_CODE_POINTS) messages[messages.length - 1] = `${last}\n\n${final}`;
  else messages.push(final);
  if (messages.some((message) => countCodePoints(message) > LINE_MESSAGE_MAX_CODE_POINTS)) throw new Error("daily good-return value message exceeds LINE limit");
  return messages;
}
