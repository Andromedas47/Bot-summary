import type { TransactionCorrection } from "@/lib/corrections/types";

export interface CorrectionAuditDetail {
  id: string;
  targetTransactionId: string;
  status: TransactionCorrection["status"];
  reasonType: TransactionCorrection["reason_type"];
  reasonDetail: string;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  sourceLineMessageId: string | null;
  evidenceUrl: string | null;
  supersedesCorrectionId: string | null;
  supersededById: string | null;
  targetVersion: string;
  beforeSourceVersion: string;
  afterSourceVersion: string;
  beforeProductName: string;
  afterProductName: string;
  beforeQuantity: number;
  afterQuantity: number;
  beforeUnit: string;
  afterUnit: string;
  beforePriceAmount: number;
  afterPriceAmount: number;
  beforePriceQuantity: number;
  afterPriceQuantity: number;
  beforeTotalAmount: number;
  afterTotalAmount: number;
  financialDelta: number;
  beforeVoided: boolean;
  afterVoided: boolean;
}

export function mapCorrectionAuditDetail(
  correction: TransactionCorrection,
  supersededById: string | null,
): CorrectionAuditDetail {
  const before = correction.before_snapshot;
  const after = correction.after_snapshot;
  return {
    id: correction.id,
    targetTransactionId: correction.target_transaction_id,
    status: correction.status,
    reasonType: correction.reason_type,
    reasonDetail: correction.reason_detail,
    requestedBy: correction.requested_by,
    requestedAt: correction.requested_at,
    approvedBy: correction.approved_by,
    approvedAt: correction.approved_at,
    rejectedBy: correction.rejected_by,
    rejectedAt: correction.rejected_at,
    rejectionReason: correction.rejection_reason,
    sourceLineMessageId: correction.source_line_message_id,
    evidenceUrl: correction.evidence_url,
    supersedesCorrectionId: correction.supersedes_correction_id,
    supersededById,
    targetVersion: correction.target_version,
    beforeSourceVersion: before.sourceVersion,
    afterSourceVersion: after.sourceVersion,
    beforeProductName: before.productName,
    afterProductName: after.productName,
    beforeQuantity: before.quantity,
    afterQuantity: after.quantity,
    beforeUnit: before.unit,
    afterUnit: after.unit,
    beforePriceAmount: before.priceAmount,
    afterPriceAmount: after.priceAmount,
    beforePriceQuantity: before.priceQuantity,
    afterPriceQuantity: after.priceQuantity,
    beforeTotalAmount: before.totalAmount,
    afterTotalAmount: after.totalAmount,
    financialDelta: after.totalAmount - before.totalAmount,
    beforeVoided: before.voided,
    afterVoided: after.voided,
  };
}
