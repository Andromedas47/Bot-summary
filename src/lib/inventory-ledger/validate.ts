/**
 * Fail-closed runtime validation for P2C ledger RPC responses.
 *
 * Same two rules as the P2B validator, restated because they matter just as much
 * on the quantity side:
 *   1. No unchecked casts. `data as InventoryPostingResult` would let a NULL
 *      column or a renamed field flow into balance arithmetic as if it were valid.
 *   2. No stringifying of absent values. `String(undefined)` yields "undefined",
 *      which passes a `typeof x === "string"` check and would land in a ledger
 *      identity. Missing is always an error here.
 *
 * A third rule is specific to this module: an exact quantity is NEVER accepted
 * as a JS number. PostgreSQL numeric(18,6) exceeds what a double represents
 * exactly, so a `number` arriving here means precision was already lost upstream
 * and the value cannot be trusted.
 */

import { INVENTORY_POSTING_LOCK_ACTOR } from "./types";
import type {
  InventoryBalance,
  InventoryPostingResult,
  InventoryReversalResult,
} from "./types";

/** A response that did not match the expected contract. Always fail closed. */
export class InventoryContractViolationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`inventory ledger contract violation at ${path}: ${message}`);
    this.name = "InventoryContractViolationError";
  }
}

function fail(path: string, message: string): never {
  throw new InventoryContractViolationError(message, path);
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

/** A present, parseable timestamp string. Absent or unparseable is an error. */
function requireTimestamp(source: Record<string, unknown>, key: string, path: string): string {
  const value = requireString(source, key, path);
  if (!Number.isFinite(Date.parse(value))) {
    fail(`${path}.${key}`, `expected a parseable timestamp, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parses a posting result.
 *
 * The P2B posting lock is REQUIRED on every successful result, replay included.
 * A movement and its lock are written in one transaction and must be observed
 * together; a response reporting a posting without its lock describes a broken
 * pair, and accepting it would let the caller treat an atomicity failure as a
 * success. `posting_locked_by` must be exactly this adapter — a lock held by
 * anything else means some other writer owns the receipt.
 */
export function parsePostingResult(data: unknown): InventoryPostingResult {
  const root = requireObject(data, "posting");

  const postingLockedAt = requireTimestamp(root, "posting_locked_at", "posting");
  const postingLockedBy = requireString(root, "posting_locked_by", "posting");
  if (postingLockedBy !== INVENTORY_POSTING_LOCK_ACTOR) {
    fail(
      "posting.posting_locked_by",
      `expected the lock to be held by ${JSON.stringify(INVENTORY_POSTING_LOCK_ACTOR)}, ` +
        `got ${JSON.stringify(postingLockedBy)}`,
    );
  }

  return {
    movementId: requireUuid(root, "movement_id", "posting"),
    receiptId: requireUuid(root, "receipt_id", "posting"),
    dedupeKey: requireString(root, "dedupe_key", "posting"),
    lineCount: requireBoundedInteger(root, "line_count", "posting", 500),
    replayed: requireBoolean(root, "replayed", "posting"),
    reversedByMovementId: requireNullableUuid(root, "reversed_by_movement_id", "posting"),
    postingLockedAt,
    postingLockedBy: INVENTORY_POSTING_LOCK_ACTOR,
  };
}

export function parseReversalResult(data: unknown): InventoryReversalResult {
  const root = requireObject(data, "reversal");
  const movementId = requireUuid(root, "movement_id", "reversal");
  const reversalId = requireUuid(root, "reversal_id", "reversal");
  if (movementId === reversalId) {
    fail("reversal.reversal_id", "a movement cannot be its own reversal");
  }
  return {
    movementId,
    reversalId,
    dedupeKey: requireString(root, "dedupe_key", "reversal"),
    lineCount: requireBoundedInteger(root, "line_count", "reversal", 500),
    replayed: requireBoolean(root, "replayed", "reversal"),
  };
}

export function parseBalancesResponse(data: unknown): InventoryBalance[] {
  const root = requireObject(data, "balances");
  const rows = root.balances;
  if (!Array.isArray(rows)) {
    fail("balances.balances", `expected an array, got ${describe(rows)}`);
  }
  return rows.map((row, index) => {
    const path = `balances.balances[${index}]`;
    const entry = requireObject(row, path);
    return {
      locationCode: requireString(entry, "location_code", path),
      productKey: requireString(entry, "product_key", path),
      unitKey: requireString(entry, "unit_key", path),
      quantityBalance: requireDecimalString(entry, "quantity_balance", path),
    };
  });
}
