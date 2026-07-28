import {
  exactDecimalIsZero,
  parseExactDecimal,
  parseExactDocumentMoney,
} from "./exact-decimal";
import {
  PURCHASE_CONTRACT_VERSION,
  PURCHASE_BAHT_LITERAL,
  PURCHASE_BOOLEAN_FALSE_LITERAL,
  PURCHASE_BOOLEAN_TRUE_LITERAL,
  PURCHASE_INTENDED_WAREHOUSE_MAIN,
  PURCHASE_MAX_ITEM_COUNT,
  PURCHASE_NO_VALUE_LITERAL,
  PURCHASE_QUANTITY_MAX_SCALE,
  PURCHASE_QUANTITY_MAX_TOTAL_DIGITS,
  PURCHASE_UNIT_RATE_MAX_SCALE,
  PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS,
  PURCHASE_UNKNOWN_RATE_LITERAL,
  PURCHASE_UNKNOWN_TIME_LITERAL,
  type CapturedText,
  type ExactDecimal,
  type ExactDocumentMoney,
  type GuidedPostbackEvidenceMetadata,
  type PurchaseCommand,
  type PurchaseCommandEnvelope,
  type PurchaseReviewFlag,
  type PurchaseReviewFlagCode,
  type PurchaseStructuralIssue,
  type PurchaseStructuralIssueCode,
} from "./types";

export interface PurchaseCommandErrorDiagnostic {
  code: PurchaseStructuralIssueCode;
  message: string;
  rawValue: string | null;
}

export interface PurchaseCommandReviewDiagnostic {
  code: PurchaseReviewFlagCode;
  message: string;
  rawValue: string | null;
}

export interface PurchaseCommandValidation {
  errors: readonly PurchaseCommandErrorDiagnostic[];
  reviewFlags: readonly PurchaseCommandReviewDiagnostic[];
}

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_MAX_ITEM_COUNT = BigInt(String(PURCHASE_MAX_ITEM_COUNT));
const BIGINT_FOUR = BigInt(4);
const BIGINT_HUNDRED = BigInt(100);
const BIGINT_FOUR_HUNDRED = BigInt(400);
const VALID_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;
const BUDDHIST_DATE =
  /^([0-9]{1,2})\/([0-9]{1,2})\/(25[0-9]{2})$/u;
const UNSIGNED_INTEGER = /^[0-9]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeCapturedRaw(raw: string): string {
  return raw.normalize("NFC").replace(/^[ \t]+|[ \t]+$/gu, "");
}

function isCapturedText(value: unknown): value is CapturedText {
  return (
    isRecord(value)
    && typeof value.raw === "string"
    && typeof value.normalized === "string"
    && value.normalized === normalizeCapturedRaw(value.raw)
  );
}

function capturedRaw(value: unknown): string | null {
  return isRecord(value) && typeof value.raw === "string" ? value.raw : null;
}

function pushError(
  errors: PurchaseCommandErrorDiagnostic[],
  code: PurchaseStructuralIssueCode,
  message: string,
  rawValue: string | null = null,
): void {
  errors.push({ code, message, rawValue });
}

function pushFlag(
  reviewFlags: PurchaseCommandReviewDiagnostic[],
  code: PurchaseReviewFlagCode,
  message: string,
  rawValue: string | null = null,
): void {
  reviewFlags.push({ code, message, rawValue });
}

function isLeapYear(year: bigint): boolean {
  return (
    year % BIGINT_FOUR_HUNDRED === BIGINT_ZERO
    || (
      year % BIGINT_FOUR === BIGINT_ZERO
      && year % BIGINT_HUNDRED !== BIGINT_ZERO
    )
  );
}

function daysInMonth(month: bigint, year: bigint): bigint | null {
  if (
    month === BigInt(1)
    || month === BigInt(3)
    || month === BigInt(5)
    || month === BigInt(7)
    || month === BigInt(8)
    || month === BigInt(10)
    || month === BigInt(12)
  ) {
    return BigInt(31);
  }
  if (
    month === BigInt(4)
    || month === BigInt(6)
    || month === BigInt(9)
    || month === BigInt(11)
  ) {
    return BigInt(30);
  }
  if (month === BigInt(2)) return isLeapYear(year) ? BigInt(29) : BigInt(28);
  return null;
}

function validDateParts(
  day: bigint,
  month: bigint,
  year: bigint,
): boolean {
  if (day < BIGINT_ONE || month < BIGINT_ONE || month > BigInt(12)) {
    return false;
  }
  const maxDay = daysInMonth(month, year);
  return maxDay !== null && day <= maxDay;
}

function canonicalDateFromBuddhistText(value: unknown): string | null {
  if (!isCapturedText(value)) return null;
  const match = BUDDHIST_DATE.exec(value.normalized);
  if (!match) return null;
  const day = BigInt(match[1] ?? "0");
  const month = BigInt(match[2] ?? "0");
  const buddhistYear = BigInt(match[3] ?? "0");
  const gregorianYear = buddhistYear - BigInt(543);
  if (!validDateParts(day, month, gregorianYear)) return null;
  return `${gregorianYear.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  return validDateParts(
    BigInt(match[3] ?? "0"),
    BigInt(match[2] ?? "0"),
    BigInt(match[1] ?? "0"),
  );
}

function exactDecimalMatches(
  actual: unknown,
  expected: ExactDecimal,
): actual is ExactDecimal {
  return (
    isRecord(actual)
    && actual.raw === expected.raw
    && actual.canonical === expected.canonical
    && actual.coefficient === expected.coefficient
    && actual.scale === expected.scale
    && actual.totalDigits === expected.totalDigits
  );
}

function validateExactDecimal(
  value: unknown,
  limits: { maxTotalDigits: number; maxScale: number },
  invalidCode: PurchaseStructuralIssueCode,
  invalidMessage: string,
  errors: PurchaseCommandErrorDiagnostic[],
): ExactDecimal | null {
  if (!isRecord(value) || typeof value.raw !== "string") {
    pushError(errors, invalidCode, invalidMessage, capturedRaw(value));
    return null;
  }

  const parsed = parseExactDecimal(value.raw, limits);
  if (!parsed.ok) {
    for (const error of parsed.errors) {
      pushError(
        errors,
        error.code === "INVALID_NUMERIC_FORMAT" ? invalidCode : error.code,
        error.code === "NUMERIC_SCALE_EXCEEDED"
          ? "Numeric scale exceeds the purchase contract"
          : error.code === "NUMERIC_VALUE_TOO_LARGE"
            ? "Numeric value exceeds the purchase contract digit limit"
            : invalidMessage,
        error.raw,
      );
    }
    return null;
  }

  if (!exactDecimalMatches(value, parsed.value)) {
    pushError(
      errors,
      invalidCode,
      "Exact decimal fields are inconsistent with the preserved raw value",
      value.raw,
    );
    return null;
  }
  return parsed.value;
}

function validateDocumentMoney(
  value: unknown,
  text: unknown | undefined,
  invalidCode: PurchaseStructuralIssueCode,
  errors: PurchaseCommandErrorDiagnostic[],
): ExactDocumentMoney | null {
  if (
    !isRecord(value)
    || !isRecord(value.decimal)
    || typeof value.decimal.raw !== "string"
  ) {
    pushError(errors, invalidCode, "Document money is malformed");
    return null;
  }

  const parsed = parseExactDocumentMoney(value.decimal.raw);
  if (!parsed.ok) {
    for (const error of parsed.errors) {
      pushError(
        errors,
        error.code === "INVALID_NUMERIC_FORMAT" ? invalidCode : error.code,
        error.code === "NUMERIC_SCALE_EXCEEDED"
          ? "Document money scale exceeds the purchase contract"
          : error.code === "NUMERIC_VALUE_TOO_LARGE"
            ? "Document money exceeds the purchase contract digit limit"
            : "Document money is malformed",
        error.raw,
      );
    }
    return null;
  }

  if (
    !exactDecimalMatches(value.decimal, parsed.value.decimal)
    || value.satang !== parsed.value.satang
    || (
      text !== undefined
      && (
        !isCapturedText(text)
        || text.normalized !== parsed.value.decimal.raw
      )
    )
  ) {
    pushError(
      errors,
      invalidCode,
      "Document money fields are inconsistent with the preserved raw value",
      value.decimal.raw,
    );
    return null;
  }
  return parsed.value;
}

function boundedItemInteger(
  value: unknown,
  text: unknown,
): value is bigint {
  if (
    typeof value !== "bigint"
    || value < BIGINT_ONE
    || value > BIGINT_MAX_ITEM_COUNT
    || !isCapturedText(text)
    || !UNSIGNED_INTEGER.test(text.normalized)
  ) {
    return false;
  }
  const normalized = text.normalized.replace(/^0+(?=[0-9])/u, "");
  return normalized.length <= 3 && BigInt(normalized) === value;
}

function validateOpenCommand(
  command: Record<string, unknown>,
  errors: PurchaseCommandErrorDiagnostic[],
  reviewFlags: PurchaseCommandReviewDiagnostic[],
): void {
  const derivedDate = canonicalDateFromBuddhistText(command.purchaseDateText);
  if (
    !isRealIsoDate(command.purchaseDate)
    || derivedDate === null
    || derivedDate !== command.purchaseDate
  ) {
    pushError(
      errors,
      "INVALID_PURCHASE_DATE",
      "Purchase date must be a real D/M/25YY Buddhist date",
      capturedRaw(command.purchaseDateText),
    );
  }

  if (!isCapturedText(command.purchaseTimeText)) {
    pushError(
      errors,
      "INVALID_PURCHASE_TIME",
      "Purchase time evidence is malformed",
      capturedRaw(command.purchaseTimeText),
    );
  }
  if (command.purchaseTime === null) {
    if (
      isCapturedText(command.purchaseTimeText)
      && command.purchaseTimeText.normalized === PURCHASE_UNKNOWN_TIME_LITERAL
    ) {
      pushFlag(
        reviewFlags,
        "UNKNOWN_PURCHASE_TIME",
        "Purchase time was explicitly declared unknown",
        command.purchaseTimeText.raw,
      );
    } else {
      pushError(
        errors,
        "INVALID_PURCHASE_TIME",
        "A null purchase time requires the exact unknown-time declaration",
        capturedRaw(command.purchaseTimeText),
      );
    }
  } else if (
    typeof command.purchaseTime !== "string"
    || !VALID_TIME.test(command.purchaseTime)
    || (
      isCapturedText(command.purchaseTimeText)
      && command.purchaseTimeText.normalized !== command.purchaseTime
    )
  ) {
    pushError(
      errors,
      "INVALID_PURCHASE_TIME",
      "Purchase time must be a valid HH:MM value or null",
      capturedRaw(command.purchaseTimeText),
    );
  }

  if (
    !isCapturedText(command.supplierText)
    || command.supplierText.normalized.length === 0
  ) {
    pushError(
      errors,
      "MISSING_SUPPLIER",
      "A nonempty supplier declaration is required",
      capturedRaw(command.supplierText),
    );
  }

  if (
    !isCapturedText(command.referenceDeclarationText)
    || command.referenceDeclarationText.normalized.length === 0
  ) {
    pushError(
      errors,
      "MISSING_REFERENCE_DECLARATION",
      "A reference declaration is required",
      capturedRaw(command.referenceDeclarationText),
    );
  }
  if (command.referenceText === null) {
    if (
      isCapturedText(command.referenceDeclarationText)
      && command.referenceDeclarationText.normalized
        === PURCHASE_NO_VALUE_LITERAL
    ) {
      pushFlag(
        reviewFlags,
        "NO_REFERENCE",
        "Purchase evidence explicitly has no reference",
        command.referenceDeclarationText.raw,
      );
    } else {
      pushError(
        errors,
        "MISSING_REFERENCE_DECLARATION",
        "A null reference requires the exact no-reference declaration",
        capturedRaw(command.referenceDeclarationText),
      );
    }
  } else if (
    !isCapturedText(command.referenceText)
    || command.referenceText.normalized.length === 0
    || (
      isCapturedText(command.referenceDeclarationText)
      && command.referenceDeclarationText.normalized
        !== command.referenceText.normalized
    )
  ) {
    pushError(
      errors,
      "MISSING_REFERENCE_DECLARATION",
      "Reference text must match its declaration",
      capturedRaw(command.referenceText),
    );
  }

  if (command.intendedWarehouseCode !== PURCHASE_INTENDED_WAREHOUSE_MAIN) {
    pushError(
      errors,
      "INVALID_INTENDED_WAREHOUSE",
      "The intended warehouse code is invalid",
      typeof command.intendedWarehouseCode === "string"
        ? command.intendedWarehouseCode
        : null,
    );
  }
}

function validateItemCommand(
  command: Record<string, unknown>,
  errors: PurchaseCommandErrorDiagnostic[],
  reviewFlags: PurchaseCommandReviewDiagnostic[],
): void {
  if (!boundedItemInteger(command.itemNumber, command.itemNumberText)) {
    pushError(
      errors,
      "INVALID_ITEM_NUMBER",
      `Item number must be between 1 and ${PURCHASE_MAX_ITEM_COUNT}`,
      capturedRaw(command.itemNumberText),
    );
  }
  if (
    !isCapturedText(command.productText)
    || command.productText.normalized.length === 0
  ) {
    pushError(
      errors,
      "MISSING_ITEM_FIELD",
      "A nonempty product field is required",
      capturedRaw(command.productText),
    );
  }
  if (
    !isCapturedText(command.unitText)
    || command.unitText.normalized.length === 0
  ) {
    pushError(
      errors,
      "MISSING_ITEM_FIELD",
      "A nonempty quantity unit is required",
      capturedRaw(command.unitText),
    );
  }

  const quantity = validateExactDecimal(
    command.quantity,
    {
      maxTotalDigits: PURCHASE_QUANTITY_MAX_TOTAL_DIGITS,
      maxScale: PURCHASE_QUANTITY_MAX_SCALE,
    },
    "INVALID_QUANTITY",
    "Quantity is not a valid exact decimal",
    errors,
  );
  if (
    !isCapturedText(command.quantityText)
    || !quantity
    || command.quantityText.normalized !== quantity.raw
  ) {
    if (quantity) {
      pushError(
        errors,
        "INVALID_QUANTITY",
        "Quantity text does not match the exact quantity",
        capturedRaw(command.quantityText),
      );
    }
  }
  if (quantity && exactDecimalIsZero(quantity)) {
    pushError(
      errors,
      "INVALID_QUANTITY",
      "Quantity must be strictly greater than zero",
      quantity.raw,
    );
  }

  if (!isCapturedText(command.unitRateText)) {
    pushError(
      errors,
      "INVALID_UNIT_RATE",
      "Unit rate evidence is malformed",
      capturedRaw(command.unitRateText),
    );
  }
  if (command.unitRate === null) {
    if (command.priceUnitText !== null) {
      pushError(
        errors,
        "INVALID_UNIT_RATE",
        "An unknown unit rate cannot carry a price unit",
        capturedRaw(command.priceUnitText),
      );
    }
    if (
      isCapturedText(command.unitRateText)
      && command.unitRateText.normalized === PURCHASE_UNKNOWN_RATE_LITERAL
    ) {
      pushFlag(
        reviewFlags,
        "MISSING_UNIT_RATE",
        "Unit rate was explicitly declared unknown",
        command.unitRateText.raw,
      );
    } else {
      pushError(
        errors,
        "INVALID_UNIT_RATE",
        "A null unit rate requires the exact unknown-rate declaration",
        capturedRaw(command.unitRateText),
      );
    }
    return;
  }

  const unitRate = validateExactDecimal(
    command.unitRate,
    {
      maxTotalDigits: PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS,
      maxScale: PURCHASE_UNIT_RATE_MAX_SCALE,
    },
    "INVALID_UNIT_RATE",
    "Unit rate is not a valid exact decimal",
    errors,
  );
  if (
    !isCapturedText(command.unitRateText)
    || !unitRate
    || command.unitRateText.normalized !== unitRate.raw
  ) {
    if (unitRate) {
      pushError(
        errors,
        "INVALID_UNIT_RATE",
        "Unit rate text does not match the exact unit rate",
        capturedRaw(command.unitRateText),
      );
    }
  }
  if (
    !isCapturedText(command.priceUnitText)
    || command.priceUnitText.normalized.length === 0
  ) {
    pushError(
      errors,
      "INVALID_UNIT_RATE",
      "A known unit rate requires a nonempty price unit",
      capturedRaw(command.priceUnitText),
    );
  }
  if (unitRate && exactDecimalIsZero(unitRate)) {
    pushFlag(
      reviewFlags,
      "ZERO_UNIT_RATE",
      "Unit rate is explicitly zero and requires review",
      unitRate.raw,
    );
  }
  if (
    isCapturedText(command.unitText)
    && isCapturedText(command.priceUnitText)
    && command.unitText.normalized !== command.priceUnitText.normalized
  ) {
    pushFlag(
      reviewFlags,
      "PRICE_UNIT_REQUIRES_RESOLUTION",
      "Quantity and price units differ and require explicit resolution",
      `${command.unitText.raw} != ${command.priceUnitText.raw}`,
    );
  }
}

function validateCostsCommand(
  command: Record<string, unknown>,
  errors: PurchaseCommandErrorDiagnostic[],
): void {
  validateDocumentMoney(
    command.freight,
    command.freightText,
    "INVALID_DOCUMENT_MONEY",
    errors,
  );
  validateDocumentMoney(
    command.handling,
    command.handlingText,
    "INVALID_DOCUMENT_MONEY",
    errors,
  );
  validateDocumentMoney(
    command.discount,
    command.discountText,
    "INVALID_DOCUMENT_MONEY",
    errors,
  );

  if (!isRecord(command.vat)) {
    pushError(errors, "INVALID_VAT_DECLARATION", "VAT declaration is malformed");
    return;
  }
  if (command.vat.kind === "NONE") {
    if (
      !isCapturedText(command.vat.declarationText)
      || command.vat.declarationText.normalized
        !== PURCHASE_NO_VALUE_LITERAL
      || hasOwn(command.vat, "amount")
      || hasOwn(command.vat, "includedInItemPrices")
      || hasOwn(command.vat, "includedInItemPricesText")
      || hasOwn(command.vat, "recoverable")
      || hasOwn(command.vat, "recoverableText")
    ) {
      pushError(
        errors,
        "INVALID_VAT_DECLARATION",
        "No-VAT evidence must use the exact declaration without detail fields",
        capturedRaw(command.vat.declarationText),
      );
    }
    return;
  }
  if (command.vat.kind !== "AMOUNT") {
    pushError(errors, "INVALID_VAT_DECLARATION", "VAT declaration is malformed");
    return;
  }

  const amount = validateDocumentMoney(
    command.vat.amount,
    undefined,
    "INVALID_VAT_DECLARATION",
    errors,
  );
  if (amount && exactDecimalIsZero(amount.decimal)) {
    pushError(
      errors,
      "VAT_ZERO_MUST_USE_NONE",
      "Numeric zero VAT is invalid; use the no-VAT variant",
      amount.decimal.raw,
    );
  }
  if (
    !isCapturedText(command.vat.declarationText)
    || (
      amount
      && command.vat.declarationText.normalized
        !== `${amount.decimal.raw} ${PURCHASE_BAHT_LITERAL}`
    )
    || typeof command.vat.includedInItemPrices !== "boolean"
    || !isCapturedText(command.vat.includedInItemPricesText)
    || (
      typeof command.vat.includedInItemPrices === "boolean"
      && isCapturedText(command.vat.includedInItemPricesText)
      && command.vat.includedInItemPricesText.normalized
        !== (
          command.vat.includedInItemPrices
            ? PURCHASE_BOOLEAN_TRUE_LITERAL
            : PURCHASE_BOOLEAN_FALSE_LITERAL
        )
    )
    || typeof command.vat.recoverable !== "boolean"
    || !isCapturedText(command.vat.recoverableText)
    || (
      typeof command.vat.recoverable === "boolean"
      && isCapturedText(command.vat.recoverableText)
      && command.vat.recoverableText.normalized
        !== (
          command.vat.recoverable
            ? PURCHASE_BOOLEAN_TRUE_LITERAL
            : PURCHASE_BOOLEAN_FALSE_LITERAL
        )
    )
  ) {
    pushError(
      errors,
      "INVALID_VAT_DECLARATION",
      "Positive VAT requires a declaration and both boolean details",
      capturedRaw(command.vat.declarationText),
    );
  }
}

function validateCloseCommand(
  command: Record<string, unknown>,
  errors: PurchaseCommandErrorDiagnostic[],
): void {
  if (
    !boundedItemInteger(
      command.expectedItemCount,
      command.expectedItemCountText,
    )
  ) {
    pushError(
      errors,
      "CLOSE_COUNT_MISMATCH",
      `Close count must be between 1 and ${PURCHASE_MAX_ITEM_COUNT}`,
      capturedRaw(command.expectedItemCountText),
    );
  }
}

/**
 * Shared pure domain boundary used by text parsers and future guided adapters.
 *
 * It validates runtime command invariants and derives mandatory review flags.
 * It never parses a LINE message and never creates synthetic command text.
 */
export function validatePurchaseCommand(
  input: PurchaseCommand,
): PurchaseCommandValidation {
  const errors: PurchaseCommandErrorDiagnostic[] = [];
  const reviewFlags: PurchaseCommandReviewDiagnostic[] = [];
  const command: unknown = input;
  if (!isRecord(command) || typeof command.kind !== "string") {
    pushError(errors, "UNRECOGNIZED_LINE", "Typed purchase command is malformed");
    return { errors, reviewFlags };
  }

  if (command.contractVersion !== PURCHASE_CONTRACT_VERSION) {
    pushError(
      errors,
      "UNRECOGNIZED_LINE",
      "Purchase command contract version is invalid",
      typeof command.contractVersion === "string"
        ? command.contractVersion
        : null,
    );
  }

  if (command.kind === "OPEN_PURCHASE") {
    validateOpenCommand(command, errors, reviewFlags);
  } else if (command.kind === "ADD_PURCHASE_ITEM") {
    validateItemCommand(command, errors, reviewFlags);
  } else if (command.kind === "SET_PURCHASE_COSTS") {
    validateCostsCommand(command, errors);
  } else if (command.kind === "CLOSE_PURCHASE") {
    validateCloseCommand(command, errors);
  } else {
    pushError(
      errors,
      "UNRECOGNIZED_LINE",
      "Purchase command kind is invalid",
      command.kind,
    );
  }

  return { errors, reviewFlags };
}

function guidedIssue(
  diagnostic: PurchaseCommandErrorDiagnostic,
): PurchaseStructuralIssue {
  return {
    ...diagnostic,
    chunkId: null,
    startLine: null,
    endLine: null,
  };
}

function guidedFlag(
  diagnostic: PurchaseCommandReviewDiagnostic,
): PurchaseReviewFlag {
  return {
    ...diagnostic,
    chunkId: null,
    startLine: null,
    endLine: null,
  };
}

/**
 * Source-specific adapter for future guided-menu commands.
 *
 * Postback values arrive as a typed command and are validated at the same
 * domain boundary as text-derived commands. They are never converted to text.
 */
export function createGuidedPurchaseCommandEnvelope(input: {
  commandOrdinal: number;
  command: PurchaseCommand;
  evidence: GuidedPostbackEvidenceMetadata;
}): PurchaseCommandEnvelope {
  const validation = validatePurchaseCommand(input.command);
  const errors = validation.errors.map(guidedIssue);
  if (
    !Number.isSafeInteger(input.commandOrdinal)
    || input.commandOrdinal < 1
  ) {
    errors.push({
      code: "OUT_OF_ORDER_EVIDENCE",
      message: "Command ordinal must be a positive safe integer",
      chunkId: null,
      startLine: null,
      endLine: null,
      rawValue: String(input.commandOrdinal),
    });
  }
  const reviewFlags = validation.reviewFlags.map(guidedFlag);
  if (errors.length > 0) {
    return {
      status: "INVALID",
      commandOrdinal: input.commandOrdinal,
      command: null,
      provenance: {
        source: "GUIDED_POSTBACK",
        evidence: input.evidence,
      },
      errors,
      reviewFlags,
    };
  }

  return {
    status: "PARSED",
    commandOrdinal: input.commandOrdinal,
    command: input.command,
    provenance: {
      source: "GUIDED_POSTBACK",
      evidence: input.evidence,
    },
    errors: [],
    reviewFlags,
  };
}
