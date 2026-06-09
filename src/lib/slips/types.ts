import type { LineSourceType, SlipEvidenceStatus } from "@/types/database";

export const SLIP_EVIDENCE_BUCKET = "slip-evidence";
export const DOWNLOAD_FAILED_SHA256 = "0".repeat(64);

export type { SlipEvidenceStatus };

export interface SlipEvidenceInput {
  rawMessageId: string;
  lineMessageId: string;
  sourceId: string;
  sourceType: LineSourceType;
  lineUserId: string | null;
  eventTimestamp: number;
}

export interface SlipEvidenceResult {
  status: SlipEvidenceStatus;
  storagePath: string;
  sha256: string;
}

export interface SlipEvidenceIngestor {
  ingest(input: SlipEvidenceInput): Promise<SlipEvidenceResult>;
}
