import { classifyPurchaseBlock } from "./classify";
import { validatePurchaseCommand } from "./commands";
import {
  exactDecimalIsZero,
  parseExactDecimal,
  parseExactDocumentMoney,
  type ExactDecimalParseError,
} from "./exact-decimal";
import { flagForBlock, issueForBlock } from "./issues";
import {
  capturePurchaseText,
  trimPurchaseOuterWhitespace,
} from "./text-chunks";
import {
  PURCHASE_CONTRACT_VERSION,
  PURCHASE_INTENDED_WAREHOUSE_MAIN,
  PURCHASE_MAX_ITEM_COUNT,
  PURCHASE_QUANTITY_MAX_SCALE,
  PURCHASE_QUANTITY_MAX_TOTAL_DIGITS,
  PURCHASE_UNIT_RATE_MAX_SCALE,
  PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS,
  type AddPurchaseItemCommand,
  type CapturedText,
  type ClosePurchaseCommand,
  type ExactDecimal,
  type ExactDocumentMoney,
  type OpenPurchaseCommand,
  type PurchaseBlockInput,
  type PurchaseBlockKind,
  type PurchaseBlockParseResult,
  type PurchaseReviewFlag,
  type PurchaseSourceLine,
  type PurchaseStructuralIssue,
  type PurchaseStructuralIssueCode,
  type PurchaseVat,
  type SetPurchaseCostsCommand,
} from "./types";

const HEADER_OPENER =
  /^เริ่มซื้อ ([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}) ([0-9]{2}:[0-9]{2}|ไม่ทราบเวลา)$/u;
const ITEM_OPENER = /^ซื้อรายการ ([0-9]+)$/u;
const CLOSE_OPENER = /^ปิดซื้อ ([0-9]+) รายการ$/u;
const QUANTITY_VALUE = /^([^ \t]+) ([^ \t].*)$/u;
const UNIT_RATE_VALUE = /^([^ \t]+) บาท\/([^ \t].*)$/u;
const MONEY_VALUE = /^([^ \t]+) บาท$/u;
const VALID_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;
const BUDDHIST_DATE =
  /^([0-9]{1,2})\/([0-9]{1,2})\/(25[0-9]{2})$/u;
const UNSIGNED_INTEGER = /^[0-9]+$/u;

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_FOUR = BigInt(4);
const BIGINT_HUNDRED = BigInt(100);
const BIGINT_FOUR_HUNDRED = BigInt(400);
const BIGINT_MAX_ITEM_COUNT = BigInt(String(PURCHASE_MAX_ITEM_COUNT));

function meaningfulLines(input: PurchaseBlockInput): PurchaseSourceLine[] {
  return input.span.lines.filter((line) => line.normalizedText.length > 0);
}

function labeledValue(
  line: PurchaseSourceLine | undefined,
  label: string,
): CapturedText | null {
  if (!line) return null;
  const prefix = `${label}: `;
  if (!line.normalizedText.startsWith(prefix)) return null;
  const normalizedRemainder = line.normalizedText.slice(prefix.length);
  if (
    normalizedRemainder.length === 0
    || normalizedRemainder.startsWith(" ")
    || normalizedRemainder.startsWith("\t")
  ) {
    return null;
  }

  const colonIndex = line.rawText.indexOf(":");
  if (colonIndex < 0) return null;
  const rawLabel = trimPurchaseOuterWhitespace(
    line.rawText.slice(0, colonIndex),
  ).normalize("NFC");
  if (rawLabel !== label) return null;
  return capturePurchaseText(line.rawText.slice(colonIndex + 1));
}

function invalidForWrongBlock(
  input: PurchaseBlockInput,
  expected: PurchaseBlockKind,
): PurchaseBlockParseResult | null {
  const classification = classifyPurchaseBlock(input);
  if (classification === expected) return null;

  const code: PurchaseStructuralIssueCode =
    classification === "EMPTY_BLOCK"
      ? "EMPTY_BLOCK"
      : classification === "INVALID_RESERVED_PURCHASE_BLOCK"
        ? "INVALID_RESERVED_PURCHASE_BLOCK"
        : "UNRECOGNIZED_LINE";

  return {
    status: "INVALID",
    command: null,
    errors: [
      issueForBlock(
        input,
        code,
        `Expected a ${expected.toLowerCase()} purchase block`,
      ),
    ],
    reviewFlags: [],
  };
}

function addExtraLineErrors(
  input: PurchaseBlockInput,
  lines: readonly PurchaseSourceLine[],
  expectedCount: number,
  errors: PurchaseStructuralIssue[],
): void {
  for (const line of lines.slice(expectedCount)) {
    errors.push(
      issueForBlock(
        input,
        "UNRECOGNIZED_LINE",
        "Unexpected nonblank line in purchase block",
        line,
      ),
    );
  }
}

function mapNumericErrors(
  input: PurchaseBlockInput,
  line: PurchaseSourceLine | undefined,
  numericErrors: readonly ExactDecimalParseError[],
  invalidCode: PurchaseStructuralIssueCode,
  invalidMessage: string,
  errors: PurchaseStructuralIssue[],
): void {
  for (const numericError of numericErrors) {
    if (numericError.code === "INVALID_NUMERIC_FORMAT") {
      errors.push(
        issueForBlock(
          input,
          invalidCode,
          invalidMessage,
          line,
          numericError.raw,
        ),
      );
      continue;
    }
    errors.push(
      issueForBlock(
        input,
        numericError.code,
        numericError.code === "NUMERIC_SCALE_EXCEEDED"
          ? "Numeric scale exceeds the purchase contract"
          : "Numeric value exceeds the purchase contract digit limit",
        line,
        numericError.raw,
      ),
    );
  }
}

function normalizedUnsignedInteger(raw: string): string | null {
  if (!UNSIGNED_INTEGER.test(raw)) return null;
  return raw.replace(/^0+(?=[0-9])/u, "");
}

function parseBoundedItemCount(raw: string): bigint | null {
  const normalized = normalizedUnsignedInteger(raw);
  if (!normalized || normalized.length > 3) return null;
  const value = BigInt(normalized);
  if (value < BIGINT_ONE || value > BIGINT_MAX_ITEM_COUNT) return null;
  return value;
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

function daysInGregorianMonth(month: string, year: bigint): bigint | null {
  if (
    month === "01"
    || month === "03"
    || month === "05"
    || month === "07"
    || month === "08"
    || month === "10"
    || month === "12"
  ) {
    return BigInt("31");
  }
  if (
    month === "04"
    || month === "06"
    || month === "09"
    || month === "11"
  ) {
    return BigInt("30");
  }
  if (month === "02") return isLeapYear(year) ? BigInt("29") : BigInt("28");
  return null;
}

function parsePurchaseDate(raw: string): string | null {
  const match = BUDDHIST_DATE.exec(raw);
  if (!match) return null;

  const day = BigInt(match[1] ?? "0");
  const month = BigInt(match[2] ?? "0");
  const buddhistYear = BigInt(match[3] ?? "0");
  if (day < BIGINT_ONE || month < BIGINT_ONE || month > BigInt("12")) {
    return null;
  }

  const gregorianYear = buddhistYear - BigInt("543");
  const monthText = month.toString().padStart(2, "0");
  const maxDay = daysInGregorianMonth(monthText, gregorianYear);
  if (!maxDay || day > maxDay) return null;

  return `${gregorianYear.toString().padStart(4, "0")}-${monthText}-${day
    .toString()
    .padStart(2, "0")}`;
}

function resultFromCommand(
  command:
    | OpenPurchaseCommand
    | AddPurchaseItemCommand
    | SetPurchaseCostsCommand
    | ClosePurchaseCommand
    | null,
  input: PurchaseBlockInput,
  errors: PurchaseStructuralIssue[],
  reviewFlags: PurchaseReviewFlag[],
): PurchaseBlockParseResult {
  if (command) {
    const validation = validatePurchaseCommand(command);
    const existingErrorCodes = new Set(errors.map((error) => error.code));
    for (const diagnostic of validation.errors) {
      if (existingErrorCodes.has(diagnostic.code)) continue;
      errors.push(
        issueForBlock(
          input,
          diagnostic.code,
          diagnostic.message,
          undefined,
          diagnostic.rawValue,
        ),
      );
      existingErrorCodes.add(diagnostic.code);
    }

    const existingFlagCodes = new Set(reviewFlags.map((flag) => flag.code));
    for (const diagnostic of validation.reviewFlags) {
      if (existingFlagCodes.has(diagnostic.code)) continue;
      reviewFlags.push(
        flagForBlock(
          input,
          diagnostic.code,
          diagnostic.message,
          undefined,
          diagnostic.rawValue,
        ),
      );
      existingFlagCodes.add(diagnostic.code);
    }
  }

  if (!command || errors.length > 0) {
    return {
      status: "INVALID",
      command: null,
      errors,
      reviewFlags,
    };
  }
  return {
    status: "PARSED",
    command,
    errors: [],
    reviewFlags,
  };
}

export function parsePurchaseHeaderBlock(
  input: PurchaseBlockInput,
): PurchaseBlockParseResult {
  const wrongBlock = invalidForWrongBlock(input, "HEADER");
  if (wrongBlock) return wrongBlock;

  const lines = meaningfulLines(input);
  const errors: PurchaseStructuralIssue[] = [];
  const reviewFlags: PurchaseReviewFlag[] = [];
  addExtraLineErrors(input, lines, 4, errors);

  const opener = lines[0];
  const openerMatch = opener
    ? HEADER_OPENER.exec(opener.normalizedText)
    : null;
  const dateText = capturePurchaseText(openerMatch?.[1] ?? "");
  const timeText = capturePurchaseText(openerMatch?.[2] ?? "");
  const purchaseDate = parsePurchaseDate(dateText.normalized);
  if (!purchaseDate) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_PURCHASE_DATE",
        "Purchase date must be a real D/M/25YY Buddhist date",
        opener,
        dateText.raw,
      ),
    );
  }

  let purchaseTime: string | null = null;
  let purchaseTimeValid = false;
  if (timeText.normalized === "ไม่ทราบเวลา") {
    purchaseTimeValid = true;
    reviewFlags.push(
      flagForBlock(
        input,
        "UNKNOWN_PURCHASE_TIME",
        "Purchase time was explicitly declared unknown",
        opener,
        timeText.raw,
      ),
    );
  } else if (VALID_TIME.test(timeText.normalized)) {
    purchaseTime = timeText.normalized;
    purchaseTimeValid = true;
  } else {
    errors.push(
      issueForBlock(
        input,
        "INVALID_PURCHASE_TIME",
        "Purchase time must be HH:MM or ไม่ทราบเวลา",
        opener,
        timeText.raw,
      ),
    );
  }

  const supplierText = labeledValue(lines[1], "ผู้ขาย");
  if (!supplierText || supplierText.normalized.length === 0) {
    errors.push(
      issueForBlock(
        input,
        "MISSING_SUPPLIER",
        "A nonempty supplier declaration is required",
        lines[1],
      ),
    );
  }

  const referenceDeclarationText = labeledValue(lines[2], "ใบอ้างอิง");
  let referenceText: CapturedText | null = null;
  if (!referenceDeclarationText || referenceDeclarationText.normalized.length === 0) {
    errors.push(
      issueForBlock(
        input,
        "MISSING_REFERENCE_DECLARATION",
        "Reference must be declared as text or ไม่มี",
        lines[2],
      ),
    );
  } else if (referenceDeclarationText.normalized === "ไม่มี") {
    reviewFlags.push(
      flagForBlock(
        input,
        "NO_REFERENCE",
        "Purchase evidence explicitly has no reference",
        lines[2],
        referenceDeclarationText.raw,
      ),
    );
  } else {
    referenceText = referenceDeclarationText;
  }

  const destinationText = labeledValue(lines[3], "ปลายทาง");
  if (destinationText?.normalized !== PURCHASE_INTENDED_WAREHOUSE_MAIN) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_INTENDED_WAREHOUSE",
        "Only ปลายทาง: MAIN is valid in P2B Slice A",
        lines[3],
        destinationText?.raw ?? lines[3]?.rawText ?? null,
      ),
    );
  }

  const command =
    purchaseDate
    && purchaseTimeValid
    && supplierText
    && supplierText.normalized.length > 0
    && referenceDeclarationText
    && referenceDeclarationText.normalized.length > 0
    && destinationText?.normalized === PURCHASE_INTENDED_WAREHOUSE_MAIN
      ? {
          kind: "OPEN_PURCHASE" as const,
          contractVersion: PURCHASE_CONTRACT_VERSION,
          purchaseDate,
          purchaseDateText: dateText,
          purchaseTime,
          purchaseTimeText: timeText,
          supplierText,
          referenceText,
          referenceDeclarationText,
          intendedWarehouseCode: PURCHASE_INTENDED_WAREHOUSE_MAIN,
        }
      : null;

  return resultFromCommand(command, input, errors, reviewFlags);
}

interface ParsedQuantity {
  quantity: ExactDecimal;
  quantityText: CapturedText;
  unitText: CapturedText;
}

function parseQuantity(
  input: PurchaseBlockInput,
  line: PurchaseSourceLine | undefined,
  errors: PurchaseStructuralIssue[],
): ParsedQuantity | null {
  const field = labeledValue(line, "จำนวน");
  if (!field) {
    errors.push(
      issueForBlock(
        input,
        "MISSING_ITEM_FIELD",
        "Item quantity field is missing or malformed",
        line,
      ),
    );
    return null;
  }

  const match = QUANTITY_VALUE.exec(field.raw);
  if (!match) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_QUANTITY",
        "Quantity must be an exact decimal followed by one literal space and a unit",
        line,
        field.raw,
      ),
    );
    return null;
  }

  const quantityText = capturePurchaseText(match[1] ?? "");
  const unitText = capturePurchaseText(match[2] ?? "");
  const parsed = parseExactDecimal(quantityText.raw, {
    maxTotalDigits: PURCHASE_QUANTITY_MAX_TOTAL_DIGITS,
    maxScale: PURCHASE_QUANTITY_MAX_SCALE,
  });
  if (!parsed.ok) {
    mapNumericErrors(
      input,
      line,
      parsed.errors,
      "INVALID_QUANTITY",
      "Quantity is not a valid exact decimal",
      errors,
    );
    return null;
  }
  if (exactDecimalIsZero(parsed.value)) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_QUANTITY",
        "Quantity must be strictly greater than zero",
        line,
        quantityText.raw,
      ),
    );
    return null;
  }

  return {
    quantity: parsed.value,
    quantityText,
    unitText,
  };
}

interface ParsedUnitRate {
  unitRate: ExactDecimal | null;
  unitRateText: CapturedText;
  priceUnitText: CapturedText | null;
}

function parseUnitRate(
  input: PurchaseBlockInput,
  line: PurchaseSourceLine | undefined,
  quantityUnit: CapturedText | null,
  errors: PurchaseStructuralIssue[],
  reviewFlags: PurchaseReviewFlag[],
): ParsedUnitRate | null {
  const field = labeledValue(line, "ราคา");
  if (!field) {
    errors.push(
      issueForBlock(
        input,
        "MISSING_ITEM_FIELD",
        "Item rate field is missing or malformed",
        line,
      ),
    );
    return null;
  }

  if (field.normalized === "ไม่ทราบ") {
    reviewFlags.push(
      flagForBlock(
        input,
        "MISSING_UNIT_RATE",
        "Unit rate was explicitly declared unknown",
        line,
        field.raw,
      ),
    );
    return {
      unitRate: null,
      unitRateText: field,
      priceUnitText: null,
    };
  }

  const match = UNIT_RATE_VALUE.exec(field.raw);
  if (!match) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_UNIT_RATE",
        "Unit rate must be an exact decimal in the form <amount> บาท/<unit>",
        line,
        field.raw,
      ),
    );
    return null;
  }

  const unitRateText = capturePurchaseText(match[1] ?? "");
  const priceUnitText = capturePurchaseText(match[2] ?? "");
  const parsed = parseExactDecimal(unitRateText.raw, {
    maxTotalDigits: PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS,
    maxScale: PURCHASE_UNIT_RATE_MAX_SCALE,
  });
  if (!parsed.ok) {
    mapNumericErrors(
      input,
      line,
      parsed.errors,
      "INVALID_UNIT_RATE",
      "Unit rate is not a valid exact decimal",
      errors,
    );
    return null;
  }

  if (exactDecimalIsZero(parsed.value)) {
    reviewFlags.push(
      flagForBlock(
        input,
        "ZERO_UNIT_RATE",
        "Unit rate is explicitly zero and requires review",
        line,
        unitRateText.raw,
      ),
    );
  }
  if (
    quantityUnit
    && quantityUnit.normalized !== priceUnitText.normalized
  ) {
    reviewFlags.push(
      flagForBlock(
        input,
        "PRICE_UNIT_REQUIRES_RESOLUTION",
        "Quantity and price units differ and require explicit resolution",
        line,
        `${quantityUnit.raw} != ${priceUnitText.raw}`,
      ),
    );
  }

  return {
    unitRate: parsed.value,
    unitRateText,
    priceUnitText,
  };
}

export function parsePurchaseItemBlock(
  input: PurchaseBlockInput,
): PurchaseBlockParseResult {
  const wrongBlock = invalidForWrongBlock(input, "ITEM");
  if (wrongBlock) return wrongBlock;

  const lines = meaningfulLines(input);
  const errors: PurchaseStructuralIssue[] = [];
  const reviewFlags: PurchaseReviewFlag[] = [];
  addExtraLineErrors(input, lines, 4, errors);

  const opener = lines[0];
  const openerMatch = opener ? ITEM_OPENER.exec(opener.normalizedText) : null;
  const itemNumberText = capturePurchaseText(openerMatch?.[1] ?? "");
  const itemNumber = parseBoundedItemCount(itemNumberText.normalized);
  if (!itemNumber) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_ITEM_NUMBER",
        `Item number must be between 1 and ${PURCHASE_MAX_ITEM_COUNT}`,
        opener,
        itemNumberText.raw,
      ),
    );
  }

  const productText = labeledValue(lines[1], "สินค้า");
  if (!productText || productText.normalized.length === 0) {
    errors.push(
      issueForBlock(
        input,
        "MISSING_ITEM_FIELD",
        "A nonempty product field is required",
        lines[1],
      ),
    );
  }

  const quantity = parseQuantity(input, lines[2], errors);
  const unitRate = parseUnitRate(
    input,
    lines[3],
    quantity?.unitText ?? null,
    errors,
    reviewFlags,
  );

  const command =
    itemNumber && productText && productText.normalized.length > 0
    && quantity && unitRate
      ? {
          kind: "ADD_PURCHASE_ITEM" as const,
          contractVersion: PURCHASE_CONTRACT_VERSION,
          itemNumber,
          itemNumberText,
          productText,
          quantity: quantity.quantity,
          quantityText: quantity.quantityText,
          unitText: quantity.unitText,
          unitRate: unitRate.unitRate,
          unitRateText: unitRate.unitRateText,
          priceUnitText: unitRate.priceUnitText,
        }
      : null;

  return resultFromCommand(command, input, errors, reviewFlags);
}

interface ParsedMoneyField {
  money: ExactDocumentMoney;
  text: CapturedText;
}

function parseMoneyField(
  input: PurchaseBlockInput,
  line: PurchaseSourceLine | undefined,
  label: string,
  errors: PurchaseStructuralIssue[],
): ParsedMoneyField | null {
  const field = labeledValue(line, label);
  if (!field) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_DOCUMENT_MONEY",
        `${label} is mandatory and must use <amount> บาท`,
        line,
      ),
    );
    return null;
  }

  const match = MONEY_VALUE.exec(field.raw);
  if (!match) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_DOCUMENT_MONEY",
        `${label} must use <amount> บาท`,
        line,
        field.raw,
      ),
    );
    return null;
  }

  const text = capturePurchaseText(match[1] ?? "");
  const parsed = parseExactDocumentMoney(text.raw);
  if (!parsed.ok) {
    mapNumericErrors(
      input,
      line,
      parsed.errors,
      "INVALID_DOCUMENT_MONEY",
      `${label} is not valid document money`,
      errors,
    );
    return null;
  }
  return { money: parsed.value, text };
}

function parseExactBoolean(
  input: PurchaseBlockInput,
  line: PurchaseSourceLine | undefined,
  label: string,
  errors: PurchaseStructuralIssue[],
): { value: boolean; text: CapturedText } | null {
  const text = labeledValue(line, label);
  if (!text || (text.normalized !== "ใช่" && text.normalized !== "ไม่ใช่")) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_VAT_DECLARATION",
        `${label} must be exactly ใช่ or ไม่ใช่`,
        line,
        text?.raw ?? line?.rawText ?? null,
      ),
    );
    return null;
  }
  return { value: text.normalized === "ใช่", text };
}

function parseVat(
  input: PurchaseBlockInput,
  lines: readonly PurchaseSourceLine[],
  errors: PurchaseStructuralIssue[],
): PurchaseVat | null {
  const declaration = labeledValue(lines[4], "ภาษีมูลค่าเพิ่ม");
  if (!declaration) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_VAT_DECLARATION",
        "VAT must be declared as ไม่มี or a strictly positive amount",
        lines[4],
      ),
    );
    return null;
  }

  if (declaration.normalized === "ไม่มี") {
    for (const line of lines.slice(5)) {
      errors.push(
        issueForBlock(
          input,
          "INVALID_VAT_DECLARATION",
          "VAT detail lines are forbidden when VAT is ไม่มี",
          line,
        ),
      );
    }
    return { kind: "NONE", declarationText: declaration };
  }

  const match = MONEY_VALUE.exec(declaration.raw);
  if (!match) {
    errors.push(
      issueForBlock(
        input,
        "INVALID_VAT_DECLARATION",
        "VAT must be declared as ไม่มี or <positive amount> บาท",
        lines[4],
        declaration.raw,
      ),
    );
    return null;
  }

  const amountText = capturePurchaseText(match[1] ?? "");
  const amount = parseExactDocumentMoney(amountText.raw);
  if (!amount.ok) {
    mapNumericErrors(
      input,
      lines[4],
      amount.errors,
      "INVALID_VAT_DECLARATION",
      "VAT amount is not valid document money",
      errors,
    );
    return null;
  }
  if (exactDecimalIsZero(amount.value.decimal)) {
    errors.push(
      issueForBlock(
        input,
        "VAT_ZERO_MUST_USE_NONE",
        "Numeric zero VAT is invalid; use ภาษีมูลค่าเพิ่ม: ไม่มี",
        lines[4],
        amountText.raw,
      ),
    );
    for (const line of lines.slice(5)) {
      errors.push(
        issueForBlock(
          input,
          "INVALID_VAT_DECLARATION",
          "VAT detail lines require a strictly positive VAT amount",
          line,
        ),
      );
    }
    return null;
  }

  const included = parseExactBoolean(
    input,
    lines[5],
    "ภาษีรวมในราคาสินค้า",
    errors,
  );
  const recoverable = parseExactBoolean(
    input,
    lines[6],
    "ภาษีขอคืนได้",
    errors,
  );
  if (!included || !recoverable) return null;

  return {
    kind: "AMOUNT",
    amount: amount.value,
    declarationText: declaration,
    includedInItemPrices: included.value,
    includedInItemPricesText: included.text,
    recoverable: recoverable.value,
    recoverableText: recoverable.text,
  };
}

export function parsePurchaseCostsBlock(
  input: PurchaseBlockInput,
): PurchaseBlockParseResult {
  const wrongBlock = invalidForWrongBlock(input, "COSTS");
  if (wrongBlock) return wrongBlock;

  const lines = meaningfulLines(input);
  const errors: PurchaseStructuralIssue[] = [];
  const reviewFlags: PurchaseReviewFlag[] = [];
  const freight = parseMoneyField(input, lines[1], "ค่าขนส่ง", errors);
  const handling = parseMoneyField(input, lines[2], "ค่าจัดการ", errors);
  const discount = parseMoneyField(input, lines[3], "ส่วนลด", errors);
  const vat = parseVat(input, lines, errors);

  const expectedCount = vat?.kind === "NONE" ? 5 : 7;
  addExtraLineErrors(input, lines, expectedCount, errors);

  const command =
    freight && handling && discount && vat
      ? {
          kind: "SET_PURCHASE_COSTS" as const,
          contractVersion: PURCHASE_CONTRACT_VERSION,
          freight: freight.money,
          freightText: freight.text,
          handling: handling.money,
          handlingText: handling.text,
          discount: discount.money,
          discountText: discount.text,
          vat,
        }
      : null;

  return resultFromCommand(command, input, errors, reviewFlags);
}

export function parsePurchaseCloseBlock(
  input: PurchaseBlockInput,
): PurchaseBlockParseResult {
  const wrongBlock = invalidForWrongBlock(input, "CLOSE");
  if (wrongBlock) return wrongBlock;

  const lines = meaningfulLines(input);
  const errors: PurchaseStructuralIssue[] = [];
  const reviewFlags: PurchaseReviewFlag[] = [];
  addExtraLineErrors(input, lines, 1, errors);

  const opener = lines[0];
  const openerMatch = opener ? CLOSE_OPENER.exec(opener.normalizedText) : null;
  const expectedItemCountText = capturePurchaseText(openerMatch?.[1] ?? "");
  const expectedItemCount = parseBoundedItemCount(
    expectedItemCountText.normalized,
  );
  if (!expectedItemCount) {
    errors.push(
      issueForBlock(
        input,
        "CLOSE_COUNT_MISMATCH",
        `Close count must be between 1 and ${PURCHASE_MAX_ITEM_COUNT}`,
        opener,
        expectedItemCountText.raw,
      ),
    );
  }

  const command = expectedItemCount
    ? {
        kind: "CLOSE_PURCHASE" as const,
        contractVersion: PURCHASE_CONTRACT_VERSION,
        expectedItemCount,
        expectedItemCountText,
      }
    : null;

  return resultFromCommand(command, input, errors, reviewFlags);
}

export function parseClassifiedPurchaseBlock(
  input: PurchaseBlockInput,
): PurchaseBlockParseResult {
  const classification = classifyPurchaseBlock(input);
  if (classification === "HEADER") return parsePurchaseHeaderBlock(input);
  if (classification === "ITEM") return parsePurchaseItemBlock(input);
  if (classification === "COSTS") return parsePurchaseCostsBlock(input);
  if (classification === "CLOSE") return parsePurchaseCloseBlock(input);

  const code: PurchaseStructuralIssueCode =
    classification === "EMPTY_BLOCK"
      ? "EMPTY_BLOCK"
      : classification === "INVALID_RESERVED_PURCHASE_BLOCK"
        ? "INVALID_RESERVED_PURCHASE_BLOCK"
        : "UNRECOGNIZED_LINE";
  return {
    status: "INVALID",
    command: null,
    errors: [
      issueForBlock(
        input,
        code,
        classification === "NOT_PURCHASE"
          ? "Unrecognized line in purchase evidence"
          : "Malformed reserved purchase block",
      ),
    ],
    reviewFlags: [],
  };
}
