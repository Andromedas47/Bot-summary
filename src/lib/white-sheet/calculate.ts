import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType, type TransactionBucket } from "@/lib/summary/transactions";
import { classifyProduct } from "./category";
import type {
  DigitalWhiteSheetCalculation,
  DigitalWhiteSheetInput,
  WhiteSheetExpenses,
  WhiteSheetItemCalculation,
  WhiteSheetTransactionRow,
  WhiteSheetValidationCode,
  WhiteSheetValidationIssue,
} from "./types";

const QUANTITY_SCALE = 3;
const MONEY_SCALE = 2;
const MILLIQUANTITY_PER_UNIT = 1_000n;

interface PriceLot {
  quantity: bigint;
  unitPrice: bigint;
}

interface ItemAggregate {
  marketKey: string;
  businessDate: string;
  normalizedProduct: string;
  normalizedUnit: string;
  withdrawn: bigint;
  goodReturn: bigint;
  damagedReturn: bigint;
  priceLots: PriceLot[];
}

interface ItemCalculationParts {
  items: WhiteSheetItemCalculation[];
  expectedSales: bigint;
  warnings: string[];
}

export class WhiteSheetValidationError extends Error {
  readonly issues: readonly WhiteSheetValidationIssue[];

  constructor(issues: readonly WhiteSheetValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "WhiteSheetValidationError";
    this.issues = [...issues];
  }
}

function fail(
  code: WhiteSheetValidationCode,
  message: string,
  context: Pick<WhiteSheetValidationIssue, "rowIndex" | "groupKey"> = {},
): never {
  throw new WhiteSheetValidationError([{ code, message, ...context }]);
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function roundDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

/** Convert a finite non-negative decimal to an integer scale without float arithmetic. */
function toScaledInteger(
  value: number,
  scale: number,
  field: string,
  code: "invalid_quantity" | "invalid_money",
  rowIndex?: number,
): bigint {
  if (!Number.isFinite(value) || value < 0) {
    fail(code, `${field} must be a finite non-negative number`, { rowIndex });
  }

  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const unscaled = BigInt(digits);
  const decimalPlaces = fraction.length - exponent;
  const shift = scale - decimalPlaces;

  if (shift >= 0) return unscaled * powerOfTen(shift);
  return roundDivide(unscaled, powerOfTen(-shift));
}

function fromScaledInteger(value: bigint, scale: number): number {
  const absolute = value < 0n ? -value : value;
  if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("invalid_money", "calculated value exceeds the safe integration range");
  }
  return Number(value) / 10 ** scale;
}

function requireIdentity(value: string, field: string, rowIndex?: number): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) {
    fail("invalid_identity", `${field} must not be empty`, { rowIndex });
  }
  return normalized;
}

function groupKeyOf(
  marketKey: string,
  businessDate: string,
  product: string,
  unit: string,
): string {
  return JSON.stringify([marketKey, businessDate, product, unit]);
}

function groupLabel(group: ItemAggregate): string {
  return `${group.marketKey}/${group.businessDate}/${group.normalizedProduct}/${group.normalizedUnit}`;
}

function moneyLabel(value: bigint): string {
  return fromScaledInteger(value, MONEY_SCALE).toFixed(MONEY_SCALE);
}

function distinctPrices(lots: readonly PriceLot[]): bigint[] {
  const seen = new Set<string>();
  const prices: bigint[] = [];

  for (const lot of lots) {
    const key = lot.unitPrice.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    prices.push(lot.unitPrice);
  }

  return prices;
}

function allocateReturnsFifo(group: ItemAggregate): {
  expectedMilliSatang: bigint;
  distinctUnitPrices: bigint[];
} {
  let returnsRemaining = group.goodReturn + group.damagedReturn;
  let expectedMilliSatang = 0n;

  for (const lot of group.priceLots) {
    const consumed = returnsRemaining < lot.quantity ? returnsRemaining : lot.quantity;
    const soldFromLot = lot.quantity - consumed;
    returnsRemaining -= consumed;
    expectedMilliSatang += soldFromLot * lot.unitPrice;
  }

  return {
    expectedMilliSatang,
    distinctUnitPrices: distinctPrices(group.priceLots),
  };
}

function buildItemCalculationParts(
  rows: readonly WhiteSheetTransactionRow[],
): ItemCalculationParts {
  const groups = new Map<string, ItemAggregate>();

  rows.forEach((row, rowIndex) => {
    const marketKey = requireIdentity(row.marketKey, "marketKey", rowIndex);
    const businessDate = requireIdentity(row.businessDate, "businessDate", rowIndex);
    const normalizedProduct = normalizeProductName(
      requireIdentity(row.productName, "productName", rowIndex),
    );
    const normalizedUnit = normalizeUnitAlias(requireIdentity(row.unit, "unit", rowIndex));
    const transactionType = baseTransactionType(row.transactionType);

    if (!transactionType) {
      fail(
        "unknown_transaction_type",
        `unsupported transaction type at row ${rowIndex}: ${row.transactionType}`,
        { rowIndex },
      );
    }

    const quantity = toScaledInteger(
      row.quantity,
      QUANTITY_SCALE,
      `quantity at row ${rowIndex}`,
      "invalid_quantity",
      rowIndex,
    );
    const key = groupKeyOf(marketKey, businessDate, normalizedProduct, normalizedUnit);
    const group = groups.get(key) ?? {
      marketKey,
      businessDate,
      normalizedProduct,
      normalizedUnit,
      withdrawn: 0n,
      goodReturn: 0n,
      damagedReturn: 0n,
      priceLots: [],
    };

    if (transactionType === "เบิก") {
      if (row.unitPrice === null) {
        fail(
          "missing_withdrawal_price",
          `withdrawal price is required at row ${rowIndex}`,
          { rowIndex, groupKey: key },
        );
      }
      const unitPrice = toScaledInteger(
        row.unitPrice,
        MONEY_SCALE,
        `unitPrice at row ${rowIndex}`,
        "invalid_money",
        rowIndex,
      );
      group.withdrawn += quantity;
      group.priceLots.push({ quantity, unitPrice });
    } else if (transactionType === "คืน") {
      group.goodReturn += quantity;
    } else {
      group.damagedReturn += quantity;
    }

    groups.set(key, group);
  });

  const items: WhiteSheetItemCalculation[] = [];
  const warnings: string[] = [];
  let expectedMilliSatang = 0n;

  for (const [key, group] of groups) {
    const sold = group.withdrawn - group.goodReturn - group.damagedReturn;
    if (sold < 0n) {
      fail(
        "negative_sold_quantity",
        `returns exceed withdrawals for ${groupLabel(group)}`,
        { groupKey: key },
      );
    }

    const allocation = allocateReturnsFifo(group);
    const category = classifyProduct(group.normalizedProduct);
    const expectedSales = roundDivide(allocation.expectedMilliSatang, MILLIQUANTITY_PER_UNIT);
    expectedMilliSatang += allocation.expectedMilliSatang;

    if (category === "uncategorized") {
      warnings.push(
        `Uncategorized product: ${group.normalizedProduct} (${group.normalizedUnit})`,
      );
    }
    if (allocation.distinctUnitPrices.length > 1) {
      warnings.push(
        `Conflicting withdrawal prices for ${group.normalizedProduct} (${group.normalizedUnit}); `
          + `FIFO source-order lots applied: ${allocation.distinctUnitPrices.map(moneyLabel).join(", ")}`,
      );
    }

    items.push({
      marketKey: group.marketKey,
      businessDate: group.businessDate,
      normalizedProduct: group.normalizedProduct,
      normalizedUnit: group.normalizedUnit,
      category,
      withdrawnQuantity: fromScaledInteger(group.withdrawn, QUANTITY_SCALE),
      goodReturnQuantity: fromScaledInteger(group.goodReturn, QUANTITY_SCALE),
      damagedReturnQuantity: fromScaledInteger(group.damagedReturn, QUANTITY_SCALE),
      soldQuantity: fromScaledInteger(sold, QUANTITY_SCALE),
      withdrawalUnitPrices: allocation.distinctUnitPrices.map((price) =>
        fromScaledInteger(price, MONEY_SCALE),
      ),
      expectedSales: fromScaledInteger(expectedSales, MONEY_SCALE),
    });
  }

  return {
    items,
    expectedSales: roundDivide(expectedMilliSatang, MILLIQUANTITY_PER_UNIT),
    warnings,
  };
}

export function calculateWhiteSheetItems(
  rows: readonly WhiteSheetTransactionRow[],
): WhiteSheetItemCalculation[] {
  return buildItemCalculationParts(rows).items;
}

function moneyInput(value: number, field: string): bigint {
  return toScaledInteger(value, MONEY_SCALE, field, "invalid_money");
}

function normalizedExpenses(expenses: Readonly<WhiteSheetExpenses>): {
  expenses: WhiteSheetExpenses;
  total: bigint;
} {
  const labor = moneyInput(expenses.labor, "expenses.labor");
  const locationFee = moneyInput(expenses.locationFee, "expenses.locationFee");
  const bag = moneyInput(expenses.bag, "expenses.bag");
  const snack = moneyInput(expenses.snack, "expenses.snack");
  const other = moneyInput(expenses.other, "expenses.other");

  return {
    expenses: {
      labor: fromScaledInteger(labor, MONEY_SCALE),
      locationFee: fromScaledInteger(locationFee, MONEY_SCALE),
      bag: fromScaledInteger(bag, MONEY_SCALE),
      snack: fromScaledInteger(snack, MONEY_SCALE),
      other: fromScaledInteger(other, MONEY_SCALE),
      ...(expenses.otherNote === undefined ? {} : { otherNote: expenses.otherNote }),
    },
    total: labor + locationFee + bag + snack + other,
  };
}

export function calculateDigitalWhiteSheet(
  input: Readonly<DigitalWhiteSheetInput>,
): DigitalWhiteSheetCalculation {
  const marketKey = requireIdentity(input.marketKey, "marketKey");
  const marketLabel = requireIdentity(input.marketLabel, "marketLabel");
  const businessDate = requireIdentity(input.businessDate, "businessDate");

  input.transactions.forEach((row, rowIndex) => {
    if (row.marketKey.trim() !== marketKey || row.businessDate.trim() !== businessDate) {
      fail(
        "summary_scope_mismatch",
        `transaction row ${rowIndex} does not belong to ${marketKey}/${businessDate}`,
        { rowIndex },
      );
    }
  });

  const itemParts = buildItemCalculationParts(input.transactions);
  const verifiedTransfers = moneyInput(input.verifiedTransfers, "verifiedTransfers");
  const actualCashSubmitted = moneyInput(input.actualCashSubmitted, "actualCashSubmitted");
  const expenseParts = normalizedExpenses(input.expenses);
  const expectedCash = itemParts.expectedSales - verifiedTransfers - expenseParts.total;
  const difference = actualCashSubmitted - expectedCash;
  const status = difference < 0n ? "shortage" : difference > 0n ? "overage" : "matched";

  return {
    marketKey,
    marketLabel,
    businessDate,
    expectedSales: fromScaledInteger(itemParts.expectedSales, MONEY_SCALE),
    verifiedTransfers: fromScaledInteger(verifiedTransfers, MONEY_SCALE),
    expenses: expenseParts.expenses,
    expenseTotal: fromScaledInteger(expenseParts.total, MONEY_SCALE),
    expectedCash: fromScaledInteger(expectedCash, MONEY_SCALE),
    actualCashSubmitted: fromScaledInteger(actualCashSubmitted, MONEY_SCALE),
    difference: fromScaledInteger(difference, MONEY_SCALE),
    status,
    warnings: itemParts.warnings,
    items: itemParts.items,
  };
}
