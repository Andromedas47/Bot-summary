/**
 * P2A Physical Inventory Snapshot — domain types (Slice A).
 *
 * Capture-only observation model. No database IDs, no ledger semantics.
 */

export const PHYSICAL_INVENTORY_WAREHOUSE_MAIN = "MAIN" as const;
export type PhysicalInventoryWarehouseCode = typeof PHYSICAL_INVENTORY_WAREHOUSE_MAIN;

export const PHYSICAL_INVENTORY_PARSER_VERSION = "p2a-physical-1.0.0";

export type PhysicalInventoryResolutionStatus =
  | "ACCEPTED_RESOLVED"
  | "ACCEPTED_RAW"
  | "REJECTED";

export interface PhysicalInventoryParsedItem {
  sequence: number | null;
  rawText: string;
  rawProductDescription: string | null;
  quantity: number | null;
  rawUnit: string | null;
  /** Spelling-normalized unit when safely known; never a converted/invented unit. */
  normalizedUnit: string | null;
  /** Conservative NFC + whitespace collapse only — never fuzzy / P0 alias maps. */
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
