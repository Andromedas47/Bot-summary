export type WhiteSheetStatus = "shortage" | "matched" | "overage";

export type DigitalWhiteSheetViewModel = {
  marketKey: string;
  marketLabel: string;
  businessDate: string;

  expectedSales: number;
  verifiedTransfers: number;

  expenses: {
    labor: number;
    locationFee: number;
    bag: number;
    snack: number;
    other: number;
    otherNote?: string;
  };

  expenseTotal: number;
  expectedCash: number;
  actualCashSubmitted: number;

  difference: number;
  status: WhiteSheetStatus;
  warnings: string[];
};

export type WhiteSheetExpenseInput = {
  labor: number;
  locationFee: number;
  bag: number;
  snack: number;
  other: number;
  otherNote?: string;
  actualCashSubmitted: number;
};
