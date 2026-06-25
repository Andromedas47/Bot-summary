export const KNOWN_TX_TYPES = ["เบิก", "เบิกเพิ่ม", "คืน", "คืนเสีย", "ชั่งคืนเพิ่ม"] as const;

export type TransactionBucket = "เบิก" | "คืน" | "คืนเสีย";

export interface TransactionAmountRow {
  transaction_type: string;
  total_amount: number | null;
}

export interface TransactionTotals {
  เบิก: number;
  คืน: number;
  คืนเสีย: number;
  ยอดส่ง: number;
}

export interface SettlementTotals {
  ยอดโอน: number;
  เงินสด: number;
  ค่าใช้จ่าย: number;
  ค่าแรง: number;
  ยอดขาย: number;
  เงินสดต้องส่งเจ๊: number;
  ขาดเกิน: number;
}

export function emptyTransactionTotals(): TransactionTotals {
  return { เบิก: 0, คืน: 0, คืนเสีย: 0, ยอดส่ง: 0 };
}

export function transactionBucket(type: string): TransactionBucket | null {
  if (type === "เบิก" || type === "เบิกเพิ่ม") return "เบิก";
  // ชั่งคืนเพิ่ม (append return) counts toward the return bucket.
  if (type === "คืน" || type === "ชั่งคืนเพิ่ม") return "คืน";
  if (type === "คืนเสีย") return "คืนเสีย";
  return null;
}

export function isKnownTransactionType(type: string): boolean {
  return transactionBucket(type) !== null;
}

export function addTransactionAmount<T extends TransactionTotals>(
  totals: T,
  row: TransactionAmountRow,
): T {
  const bucket = transactionBucket(row.transaction_type);
  if (!bucket) return totals;

  totals[bucket] += row.total_amount ?? 0;
  totals.ยอดส่ง = calculateYodSong(totals);
  return totals;
}

export function calculateYodSong({
  เบิก,
  คืน,
  คืนเสีย,
}: Pick<TransactionTotals, "เบิก" | "คืน" | "คืนเสีย">): number {
  return เบิก - คืน - คืนเสีย;
}

export function calculateSettlementTotals({
  ยอดส่ง,
  money_transfer,
  money_cash,
  expenses = 0,
  labor = 0,
}: {
  ยอดส่ง: number;
  money_transfer: number;
  money_cash: number;
  expenses?: number;
  labor?: number;
}): SettlementTotals {
  const ยอดขาย = money_transfer + money_cash + expenses + labor;
  return {
    ยอดโอน: money_transfer,
    เงินสด: money_cash,
    ค่าใช้จ่าย: expenses,
    ค่าแรง: labor,
    ยอดขาย,
    เงินสดต้องส่งเจ๊: ยอดส่ง - money_transfer - expenses - labor,
    ขาดเกิน: ยอดขาย - ยอดส่ง,
  };
}
