import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { resolveUnitQuantity } from "@/lib/parsers/weigh-session/units";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;
type CentralPriceRow = Database["public"]["Tables"]["central_selling_prices"]["Row"];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CentralPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CentralPriceError";
  }
}

export interface CentralPriceIdentity {
  productName: string;
  unit: string;
  businessDate: string;
}

export interface CentralPriceKey {
  productKey: string;
  unitKey: string;
  businessDate: string;
}

export interface CentralPriceRecord {
  productKey: string;
  unitKey: string;
  businessDate: string;
  priceBaht: number;
  setBy: string;
  setReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CentralPriceCorrection {
  previousPriceBaht: number | null;
  newPriceBaht: number;
  actor: string;
  reason: string | null;
  createdAt: string;
}

function requireBusinessDate(value: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE_PATTERN.test(trimmed)) {
    throw new CentralPriceError("businessDate must be an ISO date (YYYY-MM-DD)");
  }
  const [year, month, day] = trimmed.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!roundTrips) {
    throw new CentralPriceError(`businessDate is not a valid calendar date: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Canonical identity for one central selling price. Deliberately reuses the
 * SAME normalizeProductName / resolveUnitQuantity(...).unit functions that
 * src/lib/white-sheet/calculate.ts uses to group sold quantity — a price
 * must never be computed under a different canonical key than the item
 * group it is meant to price, or expectedSales would silently fail to find
 * it. Market is never part of this identity (BR-01: global across markets).
 */
/**
 * Join format for the (productKey, unitKey) map used to price item groups —
 * shared by loadCentralPricesForDate (builds the map) and calculate.ts
 * (looks it up), so the two can never drift apart.
 */
export function centralPriceMapKey(productKey: string, unitKey: string): string {
  return `${productKey} ${unitKey}`;
}

export function centralPriceKey(identity: CentralPriceIdentity): CentralPriceKey {
  const rawProduct = identity.productName.normalize("NFC").trim();
  if (!rawProduct) {
    throw new CentralPriceError("productName must not be empty");
  }
  const productKey = normalizeProductName(rawProduct);
  const rawUnit = identity.unit.normalize("NFC").trim();
  if (!rawUnit) {
    throw new CentralPriceError("unit must not be empty");
  }
  const unitKey = resolveUnitQuantity(1, rawUnit).unit;
  const businessDate = requireBusinessDate(identity.businessDate);
  return { productKey, unitKey, businessDate };
}

function bahtToSatang(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new CentralPriceError(`${field} must be a finite non-negative number`);
  }
  const satang = Math.round(value * 100);
  if (Math.abs(value * 100 - satang) > 1e-6) {
    throw new CentralPriceError(`${field} must have at most 2 decimal places`);
  }
  return satang;
}

function satangToBaht(satang: number): number {
  return satang / 100;
}

function requireActor(actor: string): string {
  const trimmed = actor.trim();
  if (!trimmed) {
    throw new CentralPriceError("actor is required");
  }
  return trimmed;
}

function toRecord(row: CentralPriceRow): CentralPriceRecord {
  return {
    productKey: row.product_key,
    unitKey: row.unit_key,
    businessDate: row.business_date,
    priceBaht: satangToBaht(row.price_satang),
    setBy: row.set_by,
    setReason: row.set_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PRICE_COLUMNS =
  "product_key, unit_key, business_date, price_satang, set_by, set_reason, created_at, updated_at" as const;

/** Reads the current central price for one identity, or null if none is set. */
export async function getCentralPrice(
  supabase: Supabase,
  identity: CentralPriceIdentity,
): Promise<CentralPriceRecord | null> {
  const key = centralPriceKey(identity);
  const { data, error } = await supabase
    .from("central_selling_prices")
    .select(PRICE_COLUMNS)
    .eq("product_key", key.productKey)
    .eq("unit_key", key.unitKey)
    .eq("business_date", key.businessDate)
    .maybeSingle();

  if (error) {
    throw new CentralPriceError(`central price query failed: ${error.message}`);
  }
  return data ? toRecord(data as CentralPriceRow) : null;
}

/**
 * Loads every central price set for one business date, keyed by
 * `${productKey} ${unitKey}` — used by the White Sheet loader to price
 * every item group for a date in one round trip.
 */
export async function loadCentralPricesForDate(
  supabase: Supabase,
  businessDate: string,
): Promise<Map<string, number>> {
  const date = requireBusinessDate(businessDate);
  const { data, error } = await supabase
    .from("central_selling_prices")
    .select(PRICE_COLUMNS)
    .eq("business_date", date);

  if (error) {
    throw new CentralPriceError(`central price query failed: ${error.message}`);
  }

  const prices = new Map<string, number>();
  for (const row of (data ?? []) as CentralPriceRow[]) {
    const mapKey = centralPriceMapKey(row.product_key, row.unit_key);
    // The DB UNIQUE constraint should make this impossible; fail closed
    // rather than silently picking one price if it is ever violated.
    if (prices.has(mapKey)) {
      throw new CentralPriceError(
        `conflicting central price rows for ${row.product_key} (${row.unit_key}) on ${date}`,
      );
    }
    prices.set(mapKey, row.price_satang);
  }
  return prices;
}

/**
 * Sets or corrects the central selling price for one identity (BR-01/BR-04).
 * Atomic — delegates to set_central_selling_price(...), which locks the
 * existing row (if any) and records an audit row in the same transaction.
 * Never trusts a client-calculated total; only priceBaht/actor/reason are
 * accepted here.
 */
export async function setCentralPrice(
  supabase: Supabase,
  input: {
    identity: CentralPriceIdentity;
    priceBaht: number;
    actor: string;
    reason?: string | null;
  },
): Promise<CentralPriceRecord> {
  const key = centralPriceKey(input.identity);
  const priceSatang = bahtToSatang(input.priceBaht, "priceBaht");
  const actor = requireActor(input.actor);
  const reason = input.reason?.trim() || null;

  const { data, error } = await supabase.rpc("set_central_selling_price", {
    p_product_key: key.productKey,
    p_unit_key: key.unitKey,
    p_business_date: key.businessDate,
    p_price_satang: priceSatang,
    p_actor: actor,
    p_reason: reason,
  });

  if (error) {
    throw new CentralPriceError(`failed to set central price: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as CentralPriceRow;
  if (!row) {
    throw new CentralPriceError("set_central_selling_price returned no row");
  }
  return toRecord(row);
}

/** Full correction/set audit history for one identity, oldest first. */
export async function getCentralPriceHistory(
  supabase: Supabase,
  identity: CentralPriceIdentity,
): Promise<CentralPriceCorrection[]> {
  const key = centralPriceKey(identity);
  const { data, error } = await supabase
    .from("central_selling_price_corrections")
    .select("previous_price_satang, new_price_satang, actor, reason, created_at")
    .eq("product_key", key.productKey)
    .eq("unit_key", key.unitKey)
    .eq("business_date", key.businessDate)
    .order("created_at", { ascending: true });

  if (error) {
    throw new CentralPriceError(`central price history query failed: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    previousPriceBaht: row.previous_price_satang === null ? null : satangToBaht(row.previous_price_satang),
    newPriceBaht: satangToBaht(row.new_price_satang),
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}
