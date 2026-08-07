/**
 * Fail-closed runtime validation for P2D cost valuation RPC responses.
 *
 * Same rules as the P2C ledger validator (../inventory-ledger/validate), restated
 * because they matter just as much here:
 *   1. No unchecked casts. `data as InventoryCostPostingResult` would let a NULL
 *      column or a renamed field flow into a value balance as if it were valid.
 *   2. No stringifying of absent values. `String(undefined)` yields "undefined",
 *      which passes a `typeof x === "string"` check and would land in a cost
 *      movement identity.
 *   3. An exact amount is NEVER accepted as a JS number. PostgreSQL numeric(24,0)
 *      and numeric(40,10) both exceed what a double represents exactly, so a
 *      `number` arriving here means precision was already lost upstream and the
 *      value cannot be trusted.
 */

import {
  INVENTORY_COST_EVENT_TYPES,
  INVENTORY_COST_VALUATION_BASES,
  type InventoryCostBalance,
  type InventoryCostEventType,
  type InventoryCostLine,
  type InventoryCostPostingResult,
  type InventoryCostValuationBasis,
} from "./types";

/** A response that did not match the expected contract. Always fail closed. */
export class InventoryCostContractViolationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`inventory cost contract violation at ${path}: ${message}`);
    this.name = "InventoryCostContractViolationError";
  }
}

function fail(path: string, message: string): never {
  throw new InventoryCostContractViolationError(message, path);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Optional sign, digits, optional single fractional part. No exponent, no NaN. */
const DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, `expected an object, got ${describe(value)}`);
  return value;
}

function requireString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    fail(`${path}.${key}`, `expected a string, got ${describe(value)}`);
  }
  if (value.length === 0) fail(`${path}.${key}`, "expected a non-empty string");
  return value;
}

function requireNullableString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    fail(`${path}.${key}`, `expected a string or null, got ${describe(value)}`);
  }
  if (value.length === 0) fail(`${path}.${key}`, "expected a non-empty string or null");
  return value;
}

function requireUuid(source: Record<string, unknown>, key: string, path: string): string {
  const value = requireString(source, key, path);
  if (!UUID_RE.test(value)) fail(`${path}.${key}`, `expected a UUID, got ${JSON.stringify(value)}`);
  return value;
}

function requireNullableUuid(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = requireNullableString(source, key, path);
  if (value === null) return null;
  if (!UUID_RE.test(value)) fail(`${path}.${key}`, `expected a UUID, got ${JSON.stringify(value)}`);
  return value;
}

function requireBoolean(source: Record<string, unknown>, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    fail(`${path}.${key}`, `expected a boolean, got ${describe(value)}`);
  }
  return value;
}

/**
 * A small, DB-bounded integer. Rejects floats and anything outside the CHECK
 * envelope so a nonsense count cannot be treated as a real one.
 */
function requireBoundedInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path}.${key}`, `expected an integer, got ${describe(value)}`);
  }
  if (value < 1 || value > max) {
    fail(`${path}.${key}`, `expected an integer in 1..${max}, got ${value}`);
  }
  return value;
}

/**
 * An exact decimal, as a string. A `number` here is rejected rather than
 * coerced: it would already have passed through a double and cannot be trusted
 * to still equal what PostgreSQL summed.
 */
function requireDecimalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = source[key];
  if (typeof value === "number") {
    fail(
      `${path}.${key}`,
      "expected an exact decimal string but got a JS number — precision is already lost",
    );
  }
  if (typeof value !== "string") {
    fail(`${path}.${key}`, `expected a decimal string, got ${describe(value)}`);
  }
  if (!DECIMAL_RE.test(value)) {
    fail(`${path}.${key}`, `expected a plain decimal string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Same as requireDecimalString but null is a legal value (e.g. audit snapshots, zero-quantity averages). */
function requireNullableDecimalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    fail(
      `${path}.${key}`,
      "expected an exact decimal string or null but got a JS number — precision is already lost",
    );
  }
  if (typeof value !== "string") {
    fail(`${path}.${key}`, `expected a decimal string or null, got ${describe(value)}`);
  }
  if (!DECIMAL_RE.test(value)) {
    fail(`${path}.${key}`, `expected a plain decimal string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireCostEventType(
  source: Record<string, unknown>,
  key: string,
  path: string,
): InventoryCostEventType {
  const value = requireString(source, key, path);
  if (!(INVENTORY_COST_EVENT_TYPES as readonly string[]).includes(value)) {
    fail(
      `${path}.${key}`,
      `expected one of ${JSON.stringify(INVENTORY_COST_EVENT_TYPES)}, got ${JSON.stringify(value)}`,
    );
  }
  return value as InventoryCostEventType;
}

function requireValuationBasis(
  source: Record<string, unknown>,
  key: string,
  path: string,
): InventoryCostValuationBasis {
  const value = requireString(source, key, path);
  if (!(INVENTORY_COST_VALUATION_BASES as readonly string[]).includes(value)) {
    fail(
      `${path}.${key}`,
      `expected one of ${JSON.stringify(INVENTORY_COST_VALUATION_BASES)}, got ${JSON.stringify(value)}`,
    );
  }
  return value as InventoryCostValuationBasis;
}

function parseCostLine(row: unknown, path: string): InventoryCostLine {
  const entry = requireObject(row, path);
  return {
    movementLineId: requireUuid(entry, "movement_line_id", path),
    signedValueSatang: requireDecimalString(entry, "signed_value_satang", path),
    unitCostSatangSnapshot: requireNullableDecimalString(entry, "unit_cost_satang_snapshot", path),
    sourceCostLineId: requireNullableUuid(entry, "source_cost_line_id", path),
  };
}

/**
 * Parses the result of any of the four 0054 posting/reversal RPCs — they all
 * share this exact response shape (see inventory_cost_movement_lines_payload
 * and every RETURN jsonb_build_object(...) in 0054_inventory_cost_valuation.sql).
 */
export function parseCostPostingResult(data: unknown): InventoryCostPostingResult {
  const root = requireObject(data, "cost_posting");

  const lines = root.lines;
  if (!Array.isArray(lines)) {
    fail("cost_posting.lines", `expected an array, got ${describe(lines)}`);
  }

  return {
    costMovementId: requireUuid(root, "cost_movement_id", "cost_posting"),
    movementId: requireUuid(root, "movement_id", "cost_posting"),
    costEventType: requireCostEventType(root, "cost_event_type", "cost_posting"),
    valuationBasis: requireValuationBasis(root, "valuation_basis", "cost_posting"),
    dedupeKey: requireString(root, "dedupe_key", "cost_posting"),
    lineCount: requireBoundedInteger(root, "line_count", "cost_posting", 500),
    replayed: requireBoolean(root, "replayed", "cost_posting"),
    lines: lines.map((line, index) => parseCostLine(line, `cost_posting.lines[${index}]`)),
  };
}

export function parseCostBalancesResponse(data: unknown): InventoryCostBalance[] {
  const root = requireObject(data, "cost_balances");
  const rows = root.balances;
  if (!Array.isArray(rows)) {
    fail("cost_balances.balances", `expected an array, got ${describe(rows)}`);
  }
  return rows.map((row, index) => {
    const path = `cost_balances.balances[${index}]`;
    const entry = requireObject(row, path);
    return {
      locationCode: requireString(entry, "location_code", path),
      productKey: requireString(entry, "product_key", path),
      unitKey: requireString(entry, "unit_key", path),
      quantityBalance: requireDecimalString(entry, "quantity_balance", path),
      valueBalanceSatang: requireDecimalString(entry, "value_balance_satang", path),
      averageUnitCostSatang: requireNullableDecimalString(entry, "average_unit_cost_satang", path),
    };
  });
}
