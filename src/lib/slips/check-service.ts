import type { SupabaseClient } from "@supabase/supabase-js";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import {
  determineSlipCheckStatus,
  extractionToJson,
} from "@/lib/slips/extraction-schema";
import {
  OpenAiSlipExtractor,
  type SlipExtractor,
} from "@/lib/slips/extractor";
import { buildSlipLineSummary } from "@/lib/slips/line-summary";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;
type PushMessage = (to: string, text: string) => Promise<void>;

export interface SlipCheckProcessor {
  processEvidence(evidenceId: string): Promise<void>;
}

export class SlipCheckService implements SlipCheckProcessor {
  constructor(
    private readonly supabase: Supabase,
    private readonly extractor: SlipExtractor = new OpenAiSlipExtractor(),
    private readonly pushMessage: PushMessage = pushLineMessage,
  ) {}

  async processEvidence(evidenceId: string): Promise<void> {
    const log = logger.child({ evidenceId });
    let checkId: string | null = null;
    // Track whether this evidence belongs to a batch so we can suppress the
    // per-image LINE push (the batch finalizer sends a single summary instead).
    let isInBatch = false;

    try {
      const evidence = await this.loadEvidence(evidenceId);
      isInBatch = evidence.batch_id !== null;
      checkId = await this.createProcessingCheck(evidenceId);
      const bytes = await this.downloadEvidence(
        evidence.storage_bucket,
        evidence.storage_path,
      );
      const extraction = await this.extractor.extract({
        bytes,
        mimeType: evidence.mime_type ?? "image/jpeg",
      });
      const status = determineSlipCheckStatus(extraction);

      const { error: updateError } = await this.supabase
        .from("slip_checks")
        .update({
          status,
          slip_type: extraction.slipType,
          gross_amount: extraction.grossAmount,
          discount_amount: extraction.discountAmount,
          paid_amount: extraction.paidAmount,
          transfer_amount: extraction.transferAmount,
          reference_id: extraction.referenceId,
          transaction_time: extraction.transactionTime,
          sender_name: extraction.senderName,
          receiver_name: extraction.receiverName,
          receiver_account_tail: extraction.receiverAccountTail,
          confidence: extraction.confidence,
          extracted_json: extractionToJson(extraction),
          failure_reason: null,
        })
        .eq("id", checkId);

      if (updateError) throw new Error("Could not save extracted slip fields");

      log.info("slip extraction completed", {
        checkId,
        status,
        slipType: extraction.slipType,
        confidence: extraction.confidence,
        isInBatch,
      });

      // Skip per-image LINE push when the evidence is part of a batch.
      // The batch finalizer will aggregate results and send one summary.
      if (!isInBatch) {
        await this.pushSummary(
          evidence.source_id,
          buildSlipLineSummary(extraction, status),
          log,
        );
      }
    } catch (error) {
      const failureReason = safeFailureReason(error);
      log.error("slip extraction failed", { checkId, reason: failureReason });

      if (checkId) {
        const { error: updateError } = await this.supabase
          .from("slip_checks")
          .update({
            status: "FAILED",
            failure_reason: failureReason,
          })
          .eq("id", checkId);

        if (updateError) {
          log.error("failed to mark slip check as failed", {
            reason: "database_update_failed",
          });
        }
      }

      if (!isInBatch) {
        const sourceId = await this.findSourceId(evidenceId);
        if (sourceId) {
          await this.pushSummary(
            sourceId,
            buildSlipLineSummary(emptyExtraction, "FAILED"),
            log,
          );
        }
      }
    }
  }

  private async loadEvidence(evidenceId: string) {
    const { data, error } = await this.supabase
      .from("slip_evidences")
      .select("id, source_id, storage_bucket, storage_path, mime_type, status, batch_id")
      .eq("id", evidenceId)
      .single();

    if (error || !data) throw new Error("Slip evidence could not be loaded");
    if (data.status !== "RECEIVED") throw new Error("Slip evidence is not ready");
    return data;
  }

  private async createProcessingCheck(evidenceId: string): Promise<string> {
    const { data, error } = await this.supabase
      .from("slip_checks")
      .upsert(
        {
          evidence_id: evidenceId,
          status: "PROCESSING",
          slip_type: "UNKNOWN",
          failure_reason: null,
        },
        { onConflict: "evidence_id" },
      )
      .select("id")
      .single();

    if (error || !data) throw new Error("Slip check could not be created");
    return data.id;
  }

  private async downloadEvidence(bucket: string, path: string): Promise<Uint8Array> {
    const { data, error } = await this.supabase.storage.from(bucket).download(path);
    if (error || !data) throw new Error("Private slip evidence could not be downloaded");
    return new Uint8Array(await data.arrayBuffer());
  }

  private async findSourceId(evidenceId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from("slip_evidences")
      .select("source_id")
      .eq("id", evidenceId)
      .maybeSingle();
    return data?.source_id ?? null;
  }

  private async pushSummary(
    sourceId: string,
    text: string,
    log: ReturnType<typeof logger.child>,
  ): Promise<void> {
    try {
      await this.pushMessage(sourceId, text);
    } catch {
      log.error("slip summary push failed", { reason: "line_push_failed" });
    }
  }
}

const emptyExtraction = {
  slipType: "UNKNOWN" as const,
  grossAmount: null,
  discountAmount: null,
  paidAmount: null,
  transferAmount: null,
  referenceId: null,
  transactionTime: null,
  senderName: null,
  receiverName: null,
  receiverAccountTail: null,
  confidence: 0,
};

function safeFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_extraction_failure";

  const knownMessages: Record<string, string> = {
    "OPENAI_API_KEY is not configured": "extractor_not_configured",
    "Slip evidence could not be loaded": "evidence_load_failed",
    "Slip evidence is not ready": "evidence_not_ready",
    "Slip check could not be created": "check_create_failed",
    "Private slip evidence could not be downloaded": "evidence_download_failed",
    "Could not save extracted slip fields": "check_update_failed",
    "Image extraction provider returned no structured output": "extractor_empty_output",
    "Image extraction provider returned invalid JSON": "extractor_invalid_output",
    "Extractor returned a non-object result": "extractor_invalid_output",
  };

  if (knownMessages[error.message]) return knownMessages[error.message];
  if (error.message.startsWith("Image extraction provider returned HTTP ")) {
    return "extractor_http_error";
  }
  return "unknown_extraction_failure";
}
