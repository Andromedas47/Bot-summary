export const CORRECTION_STATUSES = [
  "pending", "approved", "rejected", "superseded", "cancelled",
] as const;

export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const CORRECTION_REASON_TYPES = [
  "wrong_price", "wrong_quantity", "wrong_unit", "wrong_product", "duplicate", "other",
] as const;

export type CorrectionReasonType = (typeof CORRECTION_REASON_TYPES)[number];

export interface CorrectionSnapshot {
  sourceTransactionId: string;
  sourceLineMessageId: string | null;
  productName: string;
  sourceNames: string[];
  quantity: number;
  unit: string;
  priceAmount: number;
  priceQuantity: number;
  totalAmount: number;
  transactionType: string;
  transactionDate: string | null;
  staffName: string;
  marketName: string;
  voided: boolean;
}

export interface TransactionCorrection {
  id: string;
  target_transaction_id: string;
  status: CorrectionStatus;
  reason_type: CorrectionReasonType;
  reason_detail: string;
  before_snapshot: CorrectionSnapshot;
  after_snapshot: CorrectionSnapshot;
  requested_by: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  supersedes_correction_id: string | null;
  source_line_message_id: string | null;
  evidence_url: string | null;
  target_version: string;
  request_key: string;
  created_at: string;
  updated_at: string;
}

export interface ProduceTransactionLike {
  id: string;
  product_name: string;
  quantity: number | null;
  unit: string | null;
  price_per_unit: number | null;
  total_amount: number | null;
  transaction_type: string;
  transaction_date: string | null;
  staff_name: string;
  market_name: string | null;
  raw_message_id: string | null;
  basis_quantity?: number | null;
  basis_unit?: string | null;
  basis_price?: number | null;
  [key: string]: unknown;
}

export interface EffectiveTransaction extends ProduceTransactionLike {
  is_corrected: boolean;
  correction_id: string | null;
  correction_reason_type: CorrectionReasonType | null;
  correction_reason_detail: string | null;
  correction_requested_by: string | null;
  correction_approved_by: string | null;
  correction_approved_at: string | null;
  original_product_name: string;
  original_quantity: number | null;
  original_unit: string | null;
  original_price_amount: number | null;
  original_price_quantity: number | null;
  original_total_amount: number | null;
}

export interface CorrectionDraftChanges {
  productName?: string;
  quantity?: number;
  unit?: string;
  priceAmount?: number;
  priceQuantity?: number;
  duplicate?: boolean;
}
