/**
 * P2A Physical Inventory Snapshot — domain types (Slice A).
 *
 * Capture-only observation model. No database IDs, no ledger semantics.
 */

export const PHYSICAL_INVENTORY_WAREHOUSE_MAIN = "MAIN" as const;
export type PhysicalInventoryWarehouseCode = typeof PHYSICAL_INVENTORY_WAREHOUSE_MAIN;

export const PHYSICAL_INVENTORY_PARSER_VERSION = "p2a-physical-1.0.0";
export const HOUSE_STOCK_PRICED_PARSER_VERSION = "house-stock-priced-1.0.0";

/**
 * Capture-time acceptance only — NOT canonical inventory identity.
 *
 * - ACCEPTED_NORMALIZED: syntactically valid; unit spelling known / product NFC-normalized.
 *   Must NOT be treated by P2C as an authoritative product master key.
 * - ACCEPTED_RAW: syntactically valid observation that cannot yet be capture-normalized
 *   (e.g. unknown unit such as ตะกร้า). Still a saveable observation.
 * - REJECTED: invalid observation (missing qty/unit/product, non-positive qty, etc.).
 */
export type PhysicalInventoryResolutionStatus =
  | "ACCEPTED_NORMALIZED"
  | "ACCEPTED_RAW"
  | "REJECTED";

export interface PhysicalInventoryParsedItem {
  sequence: number | null;
  rawText: string;
  rawProductDescription: string | null;
  quantity: number | null;
  /** Integer satang. Null only for legacy Physical Inventory observations. */
  unitPriceSatang?: number | null;
  rawUnit: string | null;
  /** Spelling-normalized unit when safely known; never a converted/invented unit. */
  normalizedUnit: string | null;
  /**
   * Capture-only NFC + whitespace collapse — never fuzzy / P0 aliases / product master.
   * P2C must not treat this as canonical inventory identity.
   */
  normalizedProduct: string | null;
  resolutionStatus: PhysicalInventoryResolutionStatus;
  reason: string | null;
}

export interface PhysicalInventoryParseIssue {
  code: string;
  message: string;
  line?: string;
}

export interface PhysicalInventoryParsedSession {
  businessDate: string | null;
  warehouseCode: PhysicalInventoryWarehouseCode;
  parserVersion: string;
  headerText: string | null;
  closeText: string | null;
  items: PhysicalInventoryParsedItem[];
  errors: PhysicalInventoryParseIssue[];
  warnings: PhysicalInventoryParseIssue[];
}
