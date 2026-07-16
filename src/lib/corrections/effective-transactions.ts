import type {
  CorrectionDraftChanges,
  CorrectionSnapshot,
  EffectiveTransaction,
  ProduceTransactionLike,
  TransactionCorrection,
} from "@/lib/corrections/types";

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function rawTargetVersion(transactionId: string): string {
  return `raw:${transactionId}`;
}

export function correctionTargetVersion(correctionId: string): string {
  return `correction:${correctionId}`;
}

export function calculateSnapshotTotal(snapshot: Pick<
  CorrectionSnapshot,
  "quantity" | "priceAmount" | "priceQuantity"
>): number {
  if (!Number.isFinite(snapshot.quantity) || snapshot.quantity < 0) {
    throw new Error("quantity must be a non-negative number");
  }
  if (!Number.isFinite(snapshot.priceAmount) || snapshot.priceAmount < 0) {
    throw new Error("priceAmount must be a non-negative number");
  }
  if (!Number.isFinite(snapshot.priceQuantity) || snapshot.priceQuantity <= 0) {
    throw new Error("priceQuantity must be greater than zero");
  }
  return roundMoney(snapshot.quantity * snapshot.priceAmount / snapshot.priceQuantity);
}

export function snapshotFromTransaction(row: ProduceTransactionLike): CorrectionSnapshot {
  const priceAmount = row.basis_price ?? row.price_per_unit ?? 0;
  const priceQuantity = row.basis_quantity ?? 1;
  const quantity = row.quantity ?? 0;
  return {
    sourceTransactionId: row.id,
    sourceLineMessageId: row.raw_message_id,
    sourceVersion: rawTargetVersion(row.id),
    productName: row.product_name,
    sourceNames: [row.product_name],
    quantity,
    unit: row.unit ?? "",
    priceAmount,
    priceQuantity,
    totalAmount: row.total_amount ?? calculateSnapshotTotal({ quantity, priceAmount, priceQuantity }),
    transactionType: row.transaction_type,
    transactionDate: row.transaction_date,
    staffName: row.staff_name,
    marketName: row.market_name ?? "",
    voided: false,
  };
}

export function buildAfterSnapshot(
  before: CorrectionSnapshot,
  changes: CorrectionDraftChanges,
): CorrectionSnapshot {
  const after: CorrectionSnapshot = {
    ...before,
    sourceNames: [...before.sourceNames],
    productName: changes.productName?.trim() || before.productName,
    quantity: changes.quantity ?? before.quantity,
    unit: changes.unit?.trim() || before.unit,
    priceAmount: changes.priceAmount ?? before.priceAmount,
    priceQuantity: changes.priceQuantity ?? before.priceQuantity,
    voided: changes.duplicate ?? false,
  };
  after.totalAmount = after.voided ? 0 : calculateSnapshotTotal(after);
  return after;
}

function correctionTime(correction: TransactionCorrection): number {
  return Date.parse(correction.approved_at ?? correction.updated_at ?? correction.created_at);
}

export function activeApprovedCorrections(
  corrections: readonly TransactionCorrection[],
): Map<string, TransactionCorrection> {
  const active = new Map<string, TransactionCorrection>();
  for (const correction of corrections) {
    if (correction.status !== "approved") continue;
    const previous = active.get(correction.target_transaction_id);
    if (!previous || correctionTime(correction) >= correctionTime(previous)) {
      active.set(correction.target_transaction_id, correction);
    }
  }
  return active;
}

/** Pure in-memory counterpart of the effective SQL view. */
export function applyApprovedCorrections<T extends ProduceTransactionLike>(
  transactions: readonly T[],
  corrections: readonly TransactionCorrection[],
): EffectiveTransaction[] {
  const active = activeApprovedCorrections(corrections);
  const effective: EffectiveTransaction[] = [];

  for (const transaction of transactions) {
    const correction = active.get(transaction.id);
    const originalPriceAmount = transaction.basis_price ?? transaction.price_per_unit;
    const originalPriceQuantity = transaction.basis_quantity ?? 1;
    const audit = {
      original_product_name: transaction.product_name,
      original_quantity: transaction.quantity,
      original_unit: transaction.unit,
      original_price_amount: originalPriceAmount,
      original_price_quantity: originalPriceQuantity,
      original_total_amount: transaction.total_amount,
    };

    if (!correction) {
      effective.push({
        ...transaction,
        is_corrected: false,
        correction_id: null,
        correction_reason_type: null,
        correction_reason_detail: null,
        correction_requested_by: null,
        correction_approved_by: null,
        correction_approved_at: null,
        ...audit,
      });
      continue;
    }

    const after = correction.after_snapshot;
    if (after.voided) continue;

    effective.push({
      ...transaction,
      product_name: after.productName,
      quantity: after.quantity,
      unit: after.unit,
      price_per_unit: after.priceAmount / after.priceQuantity,
      total_amount: after.totalAmount,
      basis_quantity: after.priceQuantity === 1 ? null : after.priceQuantity,
      basis_unit: after.priceQuantity === 1 ? null : after.unit,
      basis_price: after.priceQuantity === 1 ? null : after.priceAmount,
      is_corrected: true,
      correction_id: correction.id,
      correction_reason_type: correction.reason_type,
      correction_reason_detail: correction.reason_detail,
      correction_requested_by: correction.requested_by,
      correction_approved_by: correction.approved_by,
      correction_approved_at: correction.approved_at,
      ...audit,
    });
  }
  return effective;
}
