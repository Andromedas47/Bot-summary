/**
 * Fail-closed runtime validation for P3 profitability RPC responses.
 *
 * Same rules as the P2D cost validator (../inventory-cost/validate), restated
 * because a profit figure is the most consequential number this system emits:
 *
 *   1. No unchecked casts. `data as ProfitabilitySnapshot` would let a renamed
 *      column or a NULL arrive as a real, signed profit and be reported to an
 *      operator as fact.
 *   2. No stringifying of absent values. `String(undefined)` yields "undefined",
 *      which passes a `typeof x === "string"` check and would land in a
 *      snapshot identity.
 *   3. An exact amount is NEVER accepted as a JS number. Every money term is
 *      numeric(24,0) satang and every quantity is numeric(18,6); both exceed
 *      what a double holds exactly, and the read RPC casts all of them to TEXT
 *      for precisely that reason. A `number` arriving here means precision was
 *      already lost upstream and the value cannot be trusted — so it is
 *      refused, never coerced back into a string.
 *   4. `null` is preserved as `null`, end to end. It means "not provable" and
 *      is always paired with a named reason. Nothing here may substitute "0":
 *      that would convert "we could not prove it" into "there was none".
 *   5. `certification_state` and `incomplete_reasons` are the same fact stated
 *      twice, and the migration's certified_iff_no_reasons CHECK keeps them
 *      agreeing. This validator re-checks the agreement instead of trusting
 *      either field on its own — a CERTIFIED header carrying reasons, or an
 *      INCOMPLETE one carrying none, is a corrupt payload, not a nuance.
 */

import {
  PROFITABILITY_ARTIFACT_KINDS,
  PROFITABILITY_CERTIFICATION_STATES,
  PROFITABILITY_INCOMPLETE_REASONS,
  type ProfitabilityCertificationState,
  type ProfitabilityIncompleteReason,
  type ProfitabilityPostingResult,
  type ProfitabilitySnapshot,
  type ProfitabilitySnapshotLine,
  type ProfitabilitySnapshotSource,
} from "./types";

/** A response (or an argument) that did not match the contract. Always fail closed. */
export class ProfitabilityContractViolationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`profitability contract violation at ${path}: ${message}`);
    this.name = "ProfitabilityContractViolationError";
  }
}

function fail(path: string, message: string): never {
  throw new ProfitabilityContractViolationError(message, path);
}

export const PROFITABILITY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Optional sign, digits, optional single fractional part. No exponent, no NaN. */
export const PROFITABILITY_DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
/** The same shape with no fractional part at all — satang are whole by definition. */
export const PROFITABILITY_INTEGER_RE = /^-?(?:0|[1-9][0-9]*)$/u;
/** sha256, lowercase hex — mirrors the migration's input_hash CHECK. */
const INPUT_HASH_RE = /^[0-9a-f]{64}$/u;

export function isProfitabilityUuid(value: unknown): value is string {
  return typeof value === "string" && PROFITABILITY_UUID_RE.test(value);
}

/**
 * True for an exact whole-satang decimal STRING.
 *
 * A `number` is false here on purpose rather than being range-checked: the
 * point is that the value never passed through a double, not merely that it
 * happens to be integral right now. `"1e3"` is false too — an exponent is not
 * a plain decimal and PostgreSQL's `trunc()` equality check is not what decides
 * whether this client may send it.
 */
export function isExactSatangString(value: unknown): value is string {
  return typeof value === "string" && PROFITABILITY_INTEGER_RE.test(value);
}

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

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `expected an array, got ${describe(value)}`);
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
  if (!PROFITABILITY_UUID_RE.test(value)) {
    fail(`${path}.${key}`, `expected a UUID, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNullableUuid(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = requireNullableString(source, key, path);
  if (value === null) return null;
  if (!PROFITABILITY_UUID_RE.test(value)) {
    fail(`${path}.${key}`, `expected a UUID, got ${JSON.stringify(value)}`);
  }
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
 * A positive counter. `revision` and `line_ordinal` are the ONLY numeric fields
 * in this module; both are ordinals, neither is money, and both are bounded by
 * a `> 0` CHECK in the migration.
 */
function requirePositiveInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path}.${key}`, `expected an integer, got ${describe(value)}`);
  }
  if (value < 1 || !Number.isSafeInteger(value)) {
    fail(`${path}.${key}`, `expected a positive safe integer, got ${value}`);
  }
  return value;
}

/**
 * An exact decimal, as a string. A `number` here is rejected rather than
 * coerced: it would already have passed through a double and cannot be trusted
 * to still equal what PostgreSQL computed.
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
  if (!PROFITABILITY_DECIMAL_RE.test(value)) {
    fail(`${path}.${key}`, `expected a plain decimal string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Same as requireDecimalString, but null is legal and MEANINGFUL: it is the
 * migration saying the term could not be proven. It is returned as null,
 * never widened to "0".
 */
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
  if (!PROFITABILITY_DECIMAL_RE.test(value)) {
    fail(`${path}.${key}`, `expected a plain decimal string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** One of a closed set of literals. An unlisted value fails rather than passing through. */
function requireEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T {
  const value = requireString(source, key, path);
  if (!(allowed as readonly string[]).includes(value)) {
    fail(
      `${path}.${key}`,
      `expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

/** An array of non-empty strings, with per-element paths so a bad element is locatable. */
function requireStringArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string[] {
  const rows = requireArray(source[key], `${path}.${key}`);
  return rows.map((row, index) => {
    if (typeof row !== "string") {
      fail(`${path}.${key}[${index}]`, `expected a string, got ${describe(row)}`);
    }
    if (row.length === 0) fail(`${path}.${key}[${index}]`, "expected a non-empty string");
    return row;
  });
}

/**
 * The reason array, checked element by element against the closed set.
 *
 * An unrecognised reason is refused: it means the database is emitting a reason
 * this build does not know how to name, and a client that cannot name a reason
 * cannot honestly present the snapshot carrying it.
 */
function requireIncompleteReasons(
  source: Record<string, unknown>,
  key: string,
  path: string,
): ProfitabilityIncompleteReason[] {
  return requireStringArray(source, key, path).map((reason, index) => {
    if (!(PROFITABILITY_INCOMPLETE_REASONS as readonly string[]).includes(reason)) {
      fail(
        `${path}.${key}[${index}]`,
        `expected a known incomplete reason, got ${JSON.stringify(reason)}`,
      );
    }
    return reason as ProfitabilityIncompleteReason;
  });
}

/**
 * The one cross-field invariant: CERTIFIED means, and only means, that there is
 * nothing left unproven. The migration enforces it with a CHECK; if a payload
 * ever disagrees, the row did not come from that CHECK and nothing in it can be
 * trusted — least of all a profit figure labelled "certified".
 */
function requireCertificationAgreement(
  state: ProfitabilityCertificationState,
  reasons: readonly ProfitabilityIncompleteReason[],
  path: string,
): void {
  const certified = state === "CERTIFIED";
  if (certified !== (reasons.length === 0)) {
    fail(
      `${path}.certification_state`,
      `certification_state ${JSON.stringify(state)} disagrees with ` +
        `${reasons.length} incomplete_reasons — CERTIFIED holds exactly when there are none`,
    );
  }
}

/** Parses the result of record_profitability_snapshot (replay and fresh post alike). */
export function validateProfitabilityPostingResult(data: unknown): ProfitabilityPostingResult {
  const path = "profitability_posting";
  const root = requireObject(data, path);

  const certificationState = requireEnum(
    root,
    "certification_state",
    path,
    PROFITABILITY_CERTIFICATION_STATES,
  );
  const incompleteReasons = requireIncompleteReasons(root, "incomplete_reasons", path);
  requireCertificationAgreement(certificationState, incompleteReasons, path);

  return {
    replayed: requireBoolean(root, "replayed", path),
    snapshotId: requireUuid(root, "snapshot_id", path),
    accountabilityRoundId: requireUuid(root, "accountability_round_id", path),
    revision: requirePositiveInteger(root, "revision", path),
    certificationState,
    incompleteReasons,
  };
}

function parseSnapshotLine(row: unknown, path: string): ProfitabilitySnapshotLine {
  const entry = requireObject(row, path);
  return {
    lineOrdinal: requirePositiveInteger(entry, "line_ordinal", path),
    locationCode: requireString(entry, "location_code", path),
    productKey: requireString(entry, "product_key", path),
    unitKey: requireString(entry, "unit_key", path),

    issuedQuantity: requireDecimalString(entry, "issued_quantity", path),
    goodReturnQuantity: requireDecimalString(entry, "good_return_quantity", path),
    damagedQuantity: requireDecimalString(entry, "damaged_quantity", path),
    soldQuantity: requireDecimalString(entry, "sold_quantity", path),
    issuedLedgerQuantity: requireNullableDecimalString(entry, "issued_ledger_quantity", path),

    // integer satang in the table, but still delivered as TEXT and still read
    // as a string here — a price is money and never becomes a JS number.
    priceSatang: requireNullableDecimalString(entry, "price_satang", path),

    issuedCostSatang: requireNullableDecimalString(entry, "issued_cost_satang", path),
    goodReturnCostSatang: requireNullableDecimalString(entry, "good_return_cost_satang", path),
    damageLossSatang: requireNullableDecimalString(entry, "damage_loss_satang", path),
    cogsSoldSatang: requireNullableDecimalString(entry, "cogs_sold_satang", path),
    expectedMoneySatang: requireNullableDecimalString(entry, "expected_money_satang", path),

    incompleteReasons: requireIncompleteReasons(entry, "incomplete_reasons", path),
  };
}

function parseSnapshotSource(row: unknown, path: string): ProfitabilitySnapshotSource {
  const entry = requireObject(row, path);
  return {
    artifactKind: requireEnum(entry, "artifact_kind", path, PROFITABILITY_ARTIFACT_KINDS),
    artifactId: requireUuid(entry, "artifact_id", path),
  };
}

/** Parses the result of get_profitability_snapshot for one existing snapshot. */
export function validateProfitabilitySnapshot(data: unknown): ProfitabilitySnapshot {
  const path = "profitability_snapshot";
  const root = requireObject(data, path);

  const certificationState = requireEnum(
    root,
    "certification_state",
    path,
    PROFITABILITY_CERTIFICATION_STATES,
  );
  const incompleteReasons = requireIncompleteReasons(root, "incomplete_reasons", path);
  requireCertificationAgreement(certificationState, incompleteReasons, path);

  const inputHash = requireString(root, "input_hash", path);
  if (!INPUT_HASH_RE.test(inputHash)) {
    fail(`${path}.input_hash`, "expected 64 lowercase hex characters");
  }

  return {
    snapshotId: requireUuid(root, "snapshot_id", path),
    accountabilityRoundId: requireUuid(root, "accountability_round_id", path),
    revision: requirePositiveInteger(root, "revision", path),
    calculationVersion: requireString(root, "calculation_version", path),
    inputHash,
    certificationState,
    incompleteReasons,
    supersededBySnapshotId: requireNullableUuid(root, "superseded_by_snapshot_id", path),
    createdAt: requireString(root, "created_at", path),

    issuedQuantity: requireNullableDecimalString(root, "issued_quantity", path),
    goodReturnQuantity: requireNullableDecimalString(root, "good_return_quantity", path),
    damagedQuantity: requireNullableDecimalString(root, "damaged_quantity", path),
    soldQuantity: requireNullableDecimalString(root, "sold_quantity", path),

    issuedCostSatang: requireNullableDecimalString(root, "issued_cost_satang", path),
    goodReturnCostSatang: requireNullableDecimalString(root, "good_return_cost_satang", path),
    damageLossSatang: requireNullableDecimalString(root, "damage_loss_satang", path),
    cogsSoldSatang: requireNullableDecimalString(root, "cogs_sold_satang", path),
    expectedMoneySatang: requireNullableDecimalString(root, "expected_money_satang", path),
    standardMarginSatang: requireNullableDecimalString(root, "standard_margin_satang", path),
    approvedExpensesSatang: requireNullableDecimalString(root, "approved_expenses_satang", path),
    approvedWagesSatang: requireNullableDecimalString(root, "approved_wages_satang", path),
    purchasingExpensesSatang: requireNullableDecimalString(
      root,
      "purchasing_expenses_satang",
      path,
    ),
    expectedOperatingPlSatang: requireNullableDecimalString(
      root,
      "expected_operating_pl_satang",
      path,
    ),
    verifiedTransfersSatang: requireNullableDecimalString(root, "verified_transfers_satang", path),
    actualCashSatang: requireNullableDecimalString(root, "actual_cash_satang", path),
    shortageOverageSatang: requireNullableDecimalString(root, "shortage_overage_satang", path),
    realizedPlSatang: requireNullableDecimalString(root, "realized_pl_satang", path),

    lines: requireArray(root.lines, `${path}.lines`).map((line, index) =>
      parseSnapshotLine(line, `${path}.lines[${index}]`),
    ),
    sources: requireArray(root.sources, `${path}.sources`).map((source, index) =>
      parseSnapshotSource(source, `${path}.sources[${index}]`),
    ),
  };
}

/** Exported for the service's argument validation; not part of the response path. */
export { requireEnum, requireObject, requireStringArray };
