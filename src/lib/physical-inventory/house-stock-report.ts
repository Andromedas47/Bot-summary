import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { formatThaiDate } from "@/lib/date";
import { quantityTimesSatang, satangToBahtText, toMilliQuantity } from "@/lib/sales/calculate";
import { formatQuantity } from "@/lib/summary/remaining-fruit";
import {
  chunkBlocks,
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";
import {
  extractPhysicalInventoryBundlePricingBasis,
  type PhysicalInventoryBundlePricingBasis,
} from "./parse";
import {
  HOUSE_STOCK_PRICED_PARSER_VERSION,
  type PhysicalInventoryParsedItem,
} from "./types";

type Supabase = SupabaseClient<Database>;
type ItemRow = Database["public"]["Tables"]["physical_inventory_items"]["Row"];

export class HouseStockSnapshotConflictError extends Error {
  constructor() {
    super("conflicting_active_house_stock_snapshots");
    this.name = "HouseStockSnapshotConflictError";
  }
}

export interface HouseStockReport {
  businessDate: string;
  itemCount: number;
  groupCount: number;
  totalValueSatang: number;
  messages: string[];
}

interface Group {
  product: string;
  unit: string;
  unitPriceSatang: number;
  quantities: number[];
  quantityMilli: bigint;
  valueSatang: number;
  /**
   * The bundle-pricing expression (e.g. "3 โล 100 บาท") behind this group's
   * effective per-unit price, shown so staff can see it came from a bundle
   * rather than mistake the computed price for what was actually entered.
   * Cleared to null the moment a second raw entry disagrees, so the note
   * only ever reflects a single, unambiguous source line.
   */
  bundleBasis: PhysicalInventoryBundlePricingBasis | null | "unset";
}

function sameBundleBasis(
  a: PhysicalInventoryBundlePricingBasis | null,
  b: PhysicalInventoryBundlePricingBasis | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.pricingQuantity === b.pricingQuantity
    && a.pricingUnit === b.pricingUnit
    && a.totalPriceSatang === b.totalPriceSatang;
}

const displayUnit = (unit: string): string => unit === "โล" ? "กก." : unit;
const displayPrice = (satang: number): string => satangToBahtText(satang).replace(/\.00$/, "");
const milliToQuantity = (milli: bigint): number => Number(milli) / 1_000;

function reportFromItems(businessDate: string, items: readonly ItemRow[]): HouseStockReport {
  const groups = new Map<string, Group>();
  const unitTotals = new Map<string, bigint>();
  let totalValueSatang = 0;

  for (const [index, item] of items.entries()) {
    const product = item.normalized_product?.trim() || item.raw_product_description?.trim();
    const unit = item.normalized_unit?.trim() || item.raw_unit?.trim();
    const quantity = Number(item.quantity);
    const unitPriceSatang = Number(item.unit_price_satang);
    const quantityMilli = toMilliQuantity(quantity);
    const valueSatang = quantityTimesSatang(quantity, unitPriceSatang);
    if (!product || !unit || !quantityMilli || !Number.isSafeInteger(unitPriceSatang)
      || unitPriceSatang <= 0 || valueSatang === null) {
      throw new Error(`invalid_priced_house_stock_item:${index + 1}`);
    }

    const key = `${product}\u001f${unit}\u001f${unitPriceSatang}`;
    const group = groups.get(key) ?? {
      product,
      unit,
      unitPriceSatang,
      quantities: [],
      quantityMilli: BigInt(0),
      valueSatang: 0,
      bundleBasis: "unset",
    };
    const itemBundleBasis = extractPhysicalInventoryBundlePricingBasis(item.raw_text ?? "");
    group.bundleBasis = group.bundleBasis === "unset"
      ? itemBundleBasis
      : sameBundleBasis(group.bundleBasis, itemBundleBasis) ? group.bundleBasis : null;
    group.quantities.push(quantity);
    group.quantityMilli += quantityMilli;
    group.valueSatang += valueSatang;
    groups.set(key, group);
    unitTotals.set(unit, (unitTotals.get(unit) ?? BigInt(0)) + quantityMilli);
    totalValueSatang += valueSatang;
  }

  const header = `🏠 สรุปสต๊อกคงเหลือในบ้าน\nข้อมูลวันที่ ${formatThaiDate(businessDate)}`;
  let omitted = 0;
  const rows = [...groups.values()].map((group, index) => {
    const expression = group.quantities.length > 1
      ? `${group.quantities.map(formatQuantity).join(" + ")} = ${formatQuantity(milliToQuantity(group.quantityMilli))}`
      : formatQuantity(group.quantities[0]!);
    // Bundle-priced entries (e.g. "3 โล 100 บาท") get converted to an
    // effective per-unit price for storage/valuation; note the original
    // expression here so staff never mistake the computed price for what
    // was actually keyed in.
    const bundleNote = group.bundleBasis && typeof group.bundleBasis === "object"
      ? ` (ซื้อ ${formatQuantity(group.bundleBasis.pricingQuantity)} ${displayUnit(group.bundleBasis.pricingUnit)} ${displayPrice(group.bundleBasis.totalPriceSatang)} บาท)`
      : "";
    const block = [
      `${index + 1}. ${group.product} — ${displayPrice(group.unitPriceSatang)} บาท/${displayUnit(group.unit)}${bundleNote}`,
      `${expression} ${displayUnit(group.unit)}`,
      `มูลค่า ${satangToBahtText(group.valueSatang)} บาท`,
    ].join("\n");
    if (countCodePoints(block) <= LINE_MESSAGE_MAX_CODE_POINTS) return block;
    omitted += 1;
    return `${index + 1}. รายการยาวเกินขีดจำกัด LINE จึงไม่แสดงรายละเอียด`;
  });

  const quantityTotal = unitTotals.size === 1
    ? `รวม ${formatQuantity(milliToQuantity([...unitTotals.values()][0]!))} ${displayUnit([...unitTotals.keys()][0]!)}`
    : [
      "รวมตามหน่วย",
      ...[...unitTotals].map(([unit, total]) =>
        `${displayUnit(unit)} — ${formatQuantity(milliToQuantity(total))} ${displayUnit(unit)}`),
    ].join("\n");
  const totals = [
    omitted ? `⚠️ ไม่ได้แสดงรายละเอียด ${omitted} รายการ เนื่องจากขีดจำกัด LINE` : null,
    quantityTotal,
    `รวมมูลค่า ${satangToBahtText(totalValueSatang)} บาท`,
  ].filter((line): line is string => Boolean(line)).join("\n");

  return {
    businessDate,
    itemCount: items.length,
    groupCount: groups.size,
    totalValueSatang,
    messages: chunkBlocks([header, ...rows, totals], LINE_MESSAGE_MAX_CODE_POINTS),
  };
}

export function buildHouseStockReport(
  businessDate: string,
  items: readonly ItemRow[],
): HouseStockReport {
  return reportFromItems(businessDate, items);
}

export function buildHouseStockInvalidMessage(
  items: ReadonlyArray<Pick<PhysicalInventoryParsedItem, "sequence" | "reason"> & {
    resolutionStatus?: PhysicalInventoryParsedItem["resolutionStatus"];
  }>,
): string {
  const invalid = items.filter((item) => !item.resolutionStatus || item.resolutionStatus === "REJECTED");
  const detail = invalid.map((item, index) => {
    const sequence = item.sequence ?? index + 1;
    const reason = item.reason === "missing_unit_price"
      ? "ไม่พบราคาต่อหน่วย"
      : item.reason === "invalid_unit_price"
        ? "ราคาต่อหน่วยไม่ถูกต้อง"
        : ["missing_quantity", "zero_quantity", "negative_quantity", "missing_unit"].includes(item.reason ?? "")
          ? "จำนวนหรือหน่วยไม่ถูกต้อง"
          : "ข้อมูลสินค้าไม่ถูกต้อง";
    return `รายการที่ ${sequence}: ${reason}`;
  });
  return [
    "⚠️ ยังสรุปผลไม้คงเหลือในบ้านไม่ได้",
    ...detail,
    "กรุณาแก้ข้อมูลแล้วส่งใหม่",
  ].join("\n\n");
}

export function buildNoHouseStockMessage(businessDate: string): string[] {
  return [[
    "🏠 สต๊อกคงเหลือในบ้าน",
    `ข้อมูลวันที่ ${formatThaiDate(businessDate)}`,
    "ยังไม่มีการบันทึกผลไม้คงเหลือในบ้านสำหรับวันนี้",
  ].join("\n\n")];
}

/** The one authoritative snapshot for a business date, with its item rows. */
export interface AuthoritativeHouseStockItems {
  /** The snapshot's own business date, not the requested one. */
  businessDate: string;
  items: ItemRow[];
}

/**
 * The authoritative House Stock snapshot for a date, as structured rows.
 *
 * Extracted from fetchAuthoritativeHouseStockReport so the formatted 🏠 report
 * and any other consumer read through ONE definition of "authoritative": a
 * single finalized MAIN snapshot of the priced parser version that nothing has
 * replaced. Anything that needs quantities must call this rather than parse the
 * formatted Thai report back into data, or the two would drift.
 *
 * Returns null when the day has no such snapshot; throws
 * HouseStockSnapshotConflictError when more than one is active, because
 * choosing one silently would invent a stock level.
 */
export async function fetchAuthoritativeHouseStockItems(
  supabase: Supabase,
  businessDate: string,
): Promise<AuthoritativeHouseStockItems | null> {
  const { data: snapshots, error: snapshotError } = await supabase
    .from("physical_inventory_snapshots")
    .select("*")
    .eq("business_date", businessDate)
    .eq("warehouse_code", "MAIN")
    .eq("status", "finalized")
    .eq("parser_version", HOUSE_STOCK_PRICED_PARSER_VERSION)
    .is("replacement_snapshot_id", null);
  if (snapshotError) throw new Error(`House Stock snapshot lookup failed: ${snapshotError.message}`);
  if (!snapshots?.length) return null;
  if (snapshots.length !== 1) throw new HouseStockSnapshotConflictError();

  const snapshot = snapshots[0]!;
  const { data: items, error: itemError } = await supabase
    .from("physical_inventory_items")
    .select("*")
    .eq("snapshot_id", snapshot.id)
    .order("item_ordinal", { ascending: true });
  if (itemError) throw new Error(`House Stock item lookup failed: ${itemError.message}`);
  return { businessDate: snapshot.business_date, items: items ?? [] };
}

export async function fetchAuthoritativeHouseStockReport(
  supabase: Supabase,
  businessDate: string,
): Promise<HouseStockReport | null> {
  const snapshot = await fetchAuthoritativeHouseStockItems(supabase, businessDate);
  if (!snapshot) return null;
  return reportFromItems(snapshot.businessDate, snapshot.items);
}
