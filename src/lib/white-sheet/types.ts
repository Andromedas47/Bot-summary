export type ProductCategory = "vegetable" | "fruit" | "durian" | "uncategorized";

export type WhiteSheetStatus = "shortage" | "matched" | "overage";

export interface WhiteSheetExpenses {
  labor: number;
  locationFee: number;
  bag: number;
  snack: number;
  other: number;
  otherNote?: string;
}

/**
 * One persisted produce transaction, adapted from produce_transactions.
 * Rows must be supplied in item_created_at order so withdrawal price lots can
 * be consumed deterministically when the same product has multiple prices.
 */
export interface WhiteSheetTransactionRow {
  marketKey: string;
  businessDate: string;
  productName: string;
  unit: string;
  quantity: number;
  transactionType: string;
  /** Required for withdrawal rows; ignored for return rows. */
  unitPrice: number | null;
}

export interface WhiteSheetItemCalculation {
  marketKey: string;
  businessDate: string;
  normalizedProduct: string;
  normalizedUnit: string;
  category: ProductCategory;
  withdrawnQuantity: number;
  goodReturnQuantity: number;
  damagedReturnQuantity: number;
  soldQuantity: number;
  /** Distinct withdrawal prices in first-seen (FIFO lot) order. */
  withdrawalUnitPrices: number[];
  expectedSales: number;
}

export interface DigitalWhiteSheetSummary {
  marketKey: string;
  marketLabel: string;
  businessDate: string;

  expectedSales: number;
  verifiedTransfers: number;

  expenses: WhiteSheetExpenses;
  expenseTotal: number;

  expectedCash: number;
  actualCashSubmitted: number;

  difference: number;
  status: WhiteSheetStatus;

  warnings: string[];
}

export interface DigitalWhiteSheetCalculation extends DigitalWhiteSheetSummary {
  items: WhiteSheetItemCalculation[];
}

export interface DigitalWhiteSheetInput {
  marketKey: string;
  marketLabel: string;
  businessDate: string;
  transactions: readonly WhiteSheetTransactionRow[];
  verifiedTransfers: number;
  expenses: Readonly<WhiteSheetExpenses>;
  actualCashSubmitted: number;
}

export type WhiteSheetValidationCode =
  | "invalid_identity"
  | "invalid_quantity"
  | "invalid_money"
  | "missing_withdrawal_price"
  | "unknown_transaction_type"
  | "negative_sold_quantity"
  | "summary_scope_mismatch";

export interface WhiteSheetValidationIssue {
  code: WhiteSheetValidationCode;
  message: string;
  rowIndex?: number;
  groupKey?: string;
}
