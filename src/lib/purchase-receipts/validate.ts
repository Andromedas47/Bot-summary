/**
 * Fail-closed runtime validation for P2B RPC responses.
 *
 * Every value crossing back from PostgreSQL is validated before it is given a
 * TypeScript type. A partial, unexpected, or version-mismatched response is a
 * hard error, never a silently-typed object.
 *
 * Two rules this file exists to enforce:
 *   1. No unchecked casts. `data as Confirmation` would let a NULL column, a
 *      renamed field, or a future contract version flow into P2C as if valid.
 *   2. No stringifying of absent values. `String(undefined)` yields the string
 *      "undefined", which would sail through a `typeof x === "string"` check and
 *      land in a hash-bearing contract. Missing is always an error here.
 */

import {
  PURCHASE_BLOCKER_CODES,
  PURCHASE_CONFIRMATION_CANONICAL_FORM,
  PURCHASE_CONFIRMATION_CONTRACT_VERSION,
  PURCHASE_CONFIRMATION_HASH_ALGORITHM,
  PURCHASE_RECEIPT_MAX_ITEMS,
  type PurchaseBlocker,
  type PurchaseConfirmationItem,
  type PurchaseConfirmationPayload,
  type PurchaseConfirmationSource,
  type PurchaseConfirmationTotals,
  type PurchaseReceiptConfirmation,
  type PurchaseReceiptDraftResult,
  type PurchaseReceiptPostingLockResult,
  type PurchaseReceiptStatus,
  type PurchaseReceiptVoidResult,
} from "./types";

/** A response that did not match the expected contract. Always fail closed. */
export class PurchaseContractViolationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`purchase contract violation at ${path}: ${message}`);
    this.name = "PurchaseContractViolationError";
  }
}

function fail(path: string, message: string): never {
  throw new PurchaseContractViolationError(message, path);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;
/** Optional sign, digits, optional single fractional part. No exponent, no NaN. */
const DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const INTEGER_RE = /^-?(?:0|[1-9][0-9]*)$/u;
const NONNEGATIVE_INTEGER_RE = /^(?:0|[1-9][0-9]*)$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_RE = /^\d{2}:\d{2}$/u;

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

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Requires a present, non-empty string. Absent is an error, never "undefined". */
export function requireString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    fail(`${path}.${key}`, `expected a string, got ${describe(value)}`);
  }
  if (value.length === 0) fail(`${path}.${key}`, "expected a non-empty string");
  return value;
}

export function requireNullableString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = source[key];
  if (value === null) return null;
  // Absent (undefined) is NOT the same as explicitly null: a missing key means
  // the response shape disagrees with the contract.
  if (!(key in source)) fail(`${path}.${key}`, "required key is absent");
  if (typeof value !== "string") {
    fail(`${path}.${key}`, `expected a string or null, got ${describe(value)}`);
  }
  return value;
}

export function requireNullableBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
): boolean | null {
  const value = source[key];
  if (!(key in source)) fail(`${path}.${key}`, "required key is absent");
  if (value === null) return null;
  if (typeof value !== "boolean") {
    fail(`${path}.${key}`, `expected a boolean or null, got ${describe(value)}`);
  }
  return value;
}

/** Requires a present boolean. Absent, null and truthy strings all fail. */
export function requireBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    fail(`${path}.${key}`, `expected a boolean, got ${describe(value)}`);
  }
  return value;
}

function requireBooleanLiteral(
  source: Record<string, unknown>,
  key: string,
  expected: boolean,
  path: string,
): void {
  const value = source[key];
  if (value !== expected) {
    fail(`${path}.${key}`, `expected ${String(expected)}, got ${describe(value)}`);
  }
}

/** Small DB-bounded integer (item_ordinal, item_count, blocker counts). */
export function requireSmallInt(
  source: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    fail(`${path}.${key}`, `expected an integer in [0, ${max}], got ${describe(value)}`);
  }
  return value;
}

function requirePattern(
  source: Record<string, unknown>,
  key: string,
  re: RegExp,
  path: string,
  label: string,
): string {
  const value = requireString(source, key, path);
  if (!re.test(value)) fail(`${path}.${key}`, `expected ${label}, got ${JSON.stringify(value)}`);
  return value;
}

function requireNullablePattern(
  source: Record<string, unknown>,
  key: string,
  re: RegExp,
  path: string,
  label: string,
): string | null {
  const value = requireNullableString(source, key, path);
  if (value === null) return null;
  if (!re.test(value)) fail(`${path}.${key}`, `expected ${label}, got ${JSON.stringify(value)}`);
  return value;
}

export function requireUuid(source: Record<string, unknown>, key: string, path: string): string {
  return requirePattern(source, key, UUID_RE, path, "a UUID");
}

/** Lossless integer-string grammar (satang, bigint identity, revisions). */
export function requireIntegerString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string {
  return requirePattern(source, key, INTEGER_RE, path, "an integer string");
}

/** Lossless integer string that may not be negative (revisions, counters). */
export function requireNonNegativeIntegerString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string {
  return requirePattern(source, key, NONNEGATIVE_INTEGER_RE, path, "a non-negative integer string");
}

export function requireNullableIntegerString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  return requireNullablePattern(source, key, INTEGER_RE, path, "an integer string");
}

/** Lossless decimal-string grammar (quantity, unit_cost). */
export function requireNullableDecimalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  return requireNullablePattern(source, key, DECIMAL_RE, path, "a decimal string");
}

export function requireEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T {
  const value = requireString(source, key, path);
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`${path}.${key}`, `expected one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function requireTimestamp(source: Record<string, unknown>, key: string, path: string): string {
  const value = requireString(source, key, path);
  if (Number.isNaN(Date.parse(value))) {
    fail(`${path}.${key}`, `expected a parseable timestamp, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNullableTimestamp(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = requireNullableString(source, key, path);
  if (value === null) return null;
  if (Number.isNaN(Date.parse(value))) {
    fail(`${path}.${key}`, `expected a parseable timestamp, got ${JSON.stringify(value)}`);
  }
  return value;
}

const RECEIPT_STATUSES = ["draft", "confirmed", "void"] as const;
const IDENTITY_STATUSES = ["RESOLVED", "UNRESOLVED"] as const;
const PRICE_UNIT_STATUSES = ["NOT_APPLICABLE", "RESOLVED", "UNRESOLVED"] as const;
const VAT_KINDS = ["NONE", "AMOUNT"] as const;
const BLOCKER_SEVERITIES = ["BLOCKING", "REVIEW"] as const;
const RECONCILIATION_STATUSES = [
  "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
  "NOT_COMPUTABLE_MISSING_UNIT_COST",
] as const;

function parseItem(raw: unknown, index: number): PurchaseConfirmationItem {
  const path = `payload.items[${index}]`;
  const item = requireObject(raw, path);

  const unitCost = requireNullableDecimalString(item, "unit_cost", path);
  const lineAmount = requireNullableIntegerString(item, "line_amount_satang", path);
  // A stated rate must produce an amount, and a missing rate must NOT be
  // silently valued: the two nullities move together or the contract is broken.
  if ((unitCost === null) !== (lineAmount === null)) {
    fail(path, "unit_cost and line_amount_satang must be null together");
  }

  const priceUnitText = requireNullableString(item, "price_unit_text", path);
  const priceUnitStatus = requireEnum(item, "price_unit_status", PRICE_UNIT_STATUSES, path);
  if ((priceUnitText === null) !== (priceUnitStatus === "NOT_APPLICABLE")) {
    fail(path, "price_unit_text and price_unit_status disagree");
  }

  return {
    receipt_item_id: requireUuid(item, "receipt_item_id", path),
    item_ordinal: requireSmallInt(item, "item_ordinal", path, PURCHASE_RECEIPT_MAX_ITEMS),
    item_number: requireNullableIntegerString(item, "item_number", path),
    product_key: requireString(item, "product_key", path),
    raw_product_text: requireString(item, "raw_product_text", path),
    product_identity_status: requireEnum(item, "product_identity_status", IDENTITY_STATUSES, path),
    quantity: requirePattern(item, "quantity", DECIMAL_RE, path, "a decimal string"),
    unit_key: requireString(item, "unit_key", path),
    raw_unit: requireString(item, "raw_unit", path),
    unit_identity_status: requireEnum(item, "unit_identity_status", IDENTITY_STATUSES, path),
    unit_cost: unitCost,
    price_unit_text: priceUnitText,
    price_unit_status: priceUnitStatus,
    line_amount_satang: lineAmount,
    source_evidence: requireObject(item.source_evidence, `${path}.source_evidence`),
  };
}

function parseBlocker(raw: unknown, index: number): PurchaseBlocker {
  const path = `payload.blockers[${index}]`;
  const blocker = requireObject(raw, path);
  const ordinals = requireArray(blocker.item_ordinals, `${path}.item_ordinals`).map(
    (value, i) => {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        fail(`${path}.item_ordinals[${i}]`, `expected an integer, got ${describe(value)}`);
      }
      return value;
    },
  );

  return {
    code: requireEnum(blocker, "code", PURCHASE_BLOCKER_CODES, path),
    severity: requireEnum(blocker, "severity", BLOCKER_SEVERITIES, path),
    item_count: requireSmallInt(blocker, "item_count", path, Number.MAX_SAFE_INTEGER),
    item_ordinals: ordinals,
    detail: requireString(blocker, "detail", path),
    ...(blocker.flags === undefined ? {} : { flags: blocker.flags }),
  };
}

function parseTotals(raw: unknown): PurchaseConfirmationTotals {
  const path = "payload.totals";
  const totals = requireObject(raw, path);

  const subtotal = requireNullableIntegerString(totals, "line_subtotal_satang", path);
  const payable = requireNullableIntegerString(totals, "payable_total_satang", path);
  const status = requireEnum(totals, "reconciliation_status", RECONCILIATION_STATUSES, path);

  if (status === "NOT_COMPUTABLE_MISSING_UNIT_COST" && (subtotal !== null || payable !== null)) {
    fail(path, "a non-computable total must report null subtotal and payable");
  }
  if (status === "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE" && (subtotal === null || payable === null)) {
    fail(path, "a computed total must report both subtotal and payable");
  }
  if (totals.declared_total_satang !== null) {
    // Slice A captures no declared total; a non-null here means the contract
    // changed and this client must not guess at reconciliation semantics.
    fail(`${path}.declared_total_satang`, "expected null in contract v1");
  }

  return {
    line_subtotal_satang: subtotal,
    freight_satang: requireIntegerString(totals, "freight_satang", path),
    handling_satang: requireIntegerString(totals, "handling_satang", path),
    discount_satang: requireIntegerString(totals, "discount_satang", path),
    vat_satang: requireNullableIntegerString(totals, "vat_satang", path),
    payable_total_satang: payable,
    declared_total_satang: null,
    reconciliation_status: status,
  };
}

function parseSource(raw: unknown): PurchaseConfirmationSource {
  const path = "payload.source";
  const source = requireObject(raw, path);
  const sourceType = requireNullableString(source, "source_type", path);
  if (sourceType !== null && !["user", "group", "room"].includes(sourceType)) {
    fail(`${path}.source_type`, `unexpected source type ${JSON.stringify(sourceType)}`);
  }
  return {
    source_type: sourceType as PurchaseConfirmationSource["source_type"],
    source_id: requireNullableString(source, "source_id", path),
    sender_line_user_id: requireNullableString(source, "sender_line_user_id", path),
    source_line_event_id: requireNullableString(source, "source_line_event_id", path),
    source_raw_message_id: requireNullablePattern(
      source, "source_raw_message_id", UUID_RE, path, "a UUID",
    ),
    source_evidence: requireObject(source.source_evidence, `${path}.source_evidence`),
  };
}

/**
 * Validates an `upsert_purchase_receipt_draft` response.
 *
 * The identity fields are the ones the caller will key retries and corrections
 * on, so a missing one must fail here rather than travel onward as "" — an empty
 * namespace/key would look like a legitimate document identity to every later
 * reader.
 */
export function parseDraftResponse(raw: unknown): PurchaseReceiptDraftResult {
  const path = "saveDraft";
  const row = requireObject(raw, path);
  return {
    receiptId: requireUuid(row, "receipt_id", path),
    documentNamespace: requireString(row, "document_namespace", path),
    documentKey: requireString(row, "document_key", path),
    status: requireEnum(row, "status", RECEIPT_STATUSES, path),
    draftRevision: requireNonNegativeIntegerString(row, "draft_revision", path),
    itemCount: requireSmallInt(row, "item_count", path, PURCHASE_RECEIPT_MAX_ITEMS),
  };
}

/** Validates a `lock_purchase_receipt_for_posting` response. */
export function parsePostingLockResponse(raw: unknown): PurchaseReceiptPostingLockResult {
  const path = "lockForPosting";
  const row = requireObject(raw, path);
  return {
    receiptId: requireUuid(row, "receipt_id", path),
    replayed: requireBoolean(row, "replayed", path),
  };
}

/**
 * Validates a `void_purchase_receipt` response.
 *
 * Both RPC branches — fresh void and idempotent replay — return status 'void',
 * so anything else means the response did not come from a completed void.
 */
export function parseVoidResponse(raw: unknown): PurchaseReceiptVoidResult {
  const path = "void";
  const row = requireObject(raw, path);
  const status = requireEnum(row, "status", RECEIPT_STATUSES, path);
  if (status !== "void") {
    fail(`${path}.status`, `expected the receipt to be void, got ${JSON.stringify(status)}`);
  }
  return {
    receiptId: requireUuid(row, "receipt_id", path),
    status,
    replayed: requireBoolean(row, "replayed", path),
  };
}

export function parseConfirmationPayload(raw: unknown): PurchaseConfirmationPayload {
  const path = "payload";
  const payload = requireObject(raw, path);

  const version = requireString(payload, "contract_version", path);
  if (version !== PURCHASE_CONFIRMATION_CONTRACT_VERSION) {
    fail(
      `${path}.contract_version`,
      `unsupported contract version ${JSON.stringify(version)} (expected ${PURCHASE_CONFIRMATION_CONTRACT_VERSION})`,
    );
  }

  const warehouse = requireString(payload, "intended_warehouse_code", path);
  if (warehouse !== "MAIN") {
    fail(`${path}.intended_warehouse_code`, `unexpected destination ${JSON.stringify(warehouse)}`);
  }

  const itemCount = requireSmallInt(payload, "item_count", path, PURCHASE_RECEIPT_MAX_ITEMS);
  const items = requireArray(payload.items, `${path}.items`).map(parseItem);
  if (items.length !== itemCount) {
    fail(`${path}.items`, `item_count ${itemCount} disagrees with ${items.length} items`);
  }
  const ordinals = items.map((item) => item.item_ordinal);
  if (ordinals.some((value, index) => value !== index + 1)) {
    fail(`${path}.items`, "items must be a dense 1..n sequence ordered by item_ordinal");
  }

  const blockers = requireArray(payload.blockers, `${path}.blockers`).map(parseBlocker);
  const hasBlocking = blockers.some((blocker) => blocker.severity === "BLOCKING");
  if (payload.has_blocking_blockers !== hasBlocking) {
    fail(`${path}.has_blocking_blockers`, "disagrees with the blocker list");
  }

  // P2B must never claim to have posted anything.
  requireBooleanLiteral(payload, "posts_inventory_movement", false, path);
  requireBooleanLiteral(payload, "posts_valuation", false, path);

  const vatKind = requireEnum(payload, "vat_kind", VAT_KINDS, path);

  return {
    contract_version: PURCHASE_CONFIRMATION_CONTRACT_VERSION,
    receipt_id: requireUuid(payload, "receipt_id", path),
    document_namespace: requireString(payload, "document_namespace", path),
    document_key: requireString(payload, "document_key", path),
    parser_contract_version: requireString(payload, "parser_contract_version", path),
    source: parseSource(payload.source),
    business_date: requirePattern(payload, "business_date", DATE_RE, path, "YYYY-MM-DD"),
    purchase_time: requireNullablePattern(payload, "purchase_time", TIME_RE, path, "HH:MM"),
    supplier_key: requireNullableString(payload, "supplier_key", path),
    supplier_raw: requireNullableString(payload, "supplier_raw", path),
    supplier_ref: requireNullableString(payload, "supplier_ref", path),
    reference_text: requireNullableString(payload, "reference_text", path),
    intended_warehouse_code: "MAIN",
    vat_kind: vatKind,
    vat_included_in_item_prices: requireNullableBoolean(
      payload, "vat_included_in_item_prices", path,
    ),
    vat_recoverable: requireNullableBoolean(payload, "vat_recoverable", path),
    item_count: itemCount,
    items,
    totals: parseTotals(payload.totals),
    blockers,
    has_blocking_blockers: hasBlocking,
    posts_inventory_movement: false,
    posts_valuation: false,
  };
}

/** Validates a full get/confirm response. Throws rather than returning partial data. */
export function parseConfirmationResponse(raw: unknown): PurchaseReceiptConfirmation {
  const root = requireObject(raw, "response");
  const receiptId = requireUuid(root, "receipt_id", "response");

  const confirmation = requireObject(root.confirmation, "confirmation");
  const contractVersion = requireString(confirmation, "contract_version", "confirmation");
  if (contractVersion !== PURCHASE_CONFIRMATION_CONTRACT_VERSION) {
    fail("confirmation.contract_version", `unsupported contract version ${JSON.stringify(contractVersion)}`);
  }
  const canonicalForm = requireString(confirmation, "canonical_form", "confirmation");
  if (canonicalForm !== PURCHASE_CONFIRMATION_CANONICAL_FORM) {
    fail("confirmation.canonical_form", `unsupported canonical form ${JSON.stringify(canonicalForm)}`);
  }
  const hashAlgorithm = requireString(confirmation, "hash_algorithm", "confirmation");
  if (hashAlgorithm !== PURCHASE_CONFIRMATION_HASH_ALGORITHM) {
    fail("confirmation.hash_algorithm", `unsupported hash algorithm ${JSON.stringify(hashAlgorithm)}`);
  }

  const hash = requirePattern(confirmation, "hash", SHA256_HEX_RE, "confirmation", "a sha256 hex digest");
  const payload = parseConfirmationPayload(confirmation.payload);
  if (payload.receipt_id !== receiptId) {
    fail("confirmation.payload.receipt_id", "disagrees with the response receipt_id");
  }

  const lifecycle = requireObject(root.lifecycle, "lifecycle");
  const status = requireEnum(lifecycle, "status", RECEIPT_STATUSES, "lifecycle");

  const voidRaw = root.void;
  if (!("void" in root)) fail("response.void", "required key is absent");
  let voidView: PurchaseReceiptConfirmation["void"] = null;
  if (voidRaw !== null) {
    const v = requireObject(voidRaw, "void");
    voidView = {
      voided_at: requireTimestamp(v, "voided_at", "void"),
      voided_by: requireNullableString(v, "voided_by", "void"),
      void_reason: requireString(v, "void_reason", "void"),
    };
  }
  // Void metadata and lifecycle status must agree in both directions.
  if ((status === "void") !== (voidView !== null)) {
    fail("response.void", `void metadata disagrees with lifecycle status ${status}`);
  }

  const correction = requireObject(root.correction, "correction");
  const dedupeKey = requireString(root, "p2c_dedupe_key", "response");
  const expectedDedupe = `purchase-receipt-confirmation:v1:${receiptId}:${hash}`;
  if (dedupeKey !== expectedDedupe) {
    fail("response.p2c_dedupe_key", "does not match the documented dedupe identity");
  }

  const replayed = root.replayed;
  if (typeof replayed !== "boolean") {
    fail("response.replayed", `expected a boolean, got ${describe(replayed)}`);
  }

  return {
    receiptId,
    confirmation: {
      contract_version: PURCHASE_CONFIRMATION_CONTRACT_VERSION,
      canonical_form: PURCHASE_CONFIRMATION_CANONICAL_FORM,
      hash_algorithm: PURCHASE_CONFIRMATION_HASH_ALGORITHM,
      hash,
      confirmation_key: requireString(confirmation, "confirmation_key", "confirmation"),
      confirmed_at: requireTimestamp(confirmation, "confirmed_at", "confirmation"),
      confirmed_by: requireNullableString(confirmation, "confirmed_by", "confirmation"),
      payload,
    },
    lifecycle: {
      status: status as PurchaseReceiptStatus,
      posting_locked_at: requireNullableTimestamp(lifecycle, "posting_locked_at", "lifecycle"),
      posting_locked_by: requireNullableString(lifecycle, "posting_locked_by", "lifecycle"),
    },
    void: voidView,
    correction: {
      supersedes_receipt_id: requireNullablePattern(
        correction, "supersedes_receipt_id", UUID_RE, "correction", "a UUID",
      ),
      superseded_by_receipt_id: requireNullablePattern(
        correction, "superseded_by_receipt_id", UUID_RE, "correction", "a UUID",
      ),
    },
    p2cDedupeKey: dedupeKey,
    replayed,
  };
}
