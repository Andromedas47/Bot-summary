import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export const SLIP_BATCH_QUIET_SECONDS = 20;

type Supabase = SupabaseClient<Database>;

export interface BatchResult {
  batchId: string;
  isNewBatch: boolean;
}

export interface SlipBatchIngestor {
  attachEvidence(batchId: string, evidenceId: string): Promise<void>;
}

export class SlipBatchService implements SlipBatchIngestor {
  constructor(private readonly supabase: Supabase) {}

  // Delegates to a single Postgres RPC that holds pg_advisory_xact_lock for
  // the duration of the transaction.  This prevents two concurrent webhook
  // requests for the same source/sender from both creating a new batch and
  // both sending the first-image acknowledgement.
  async getOrCreateBatch(
    sourceId: string,
    sourceType: string,
    senderId: string | null,
  ): Promise<BatchResult> {
    const { data, error } = await this.supabase.rpc("get_or_create_slip_batch", {
      p_source_id:     sourceId,
      p_source_type:   sourceType,
      p_sender_id:     senderId,
      p_quiet_seconds: SLIP_BATCH_QUIET_SECONDS,
    });

    if (error) throw new Error(`get_or_create_slip_batch failed: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.batch_id) throw new Error("get_or_create_slip_batch returned no row");

    return { batchId: row.batch_id, isNewBatch: row.is_new_batch };
  }

  async attachEvidence(batchId: string, evidenceId: string): Promise<void> {
    const { error } = await this.supabase.rpc("attach_evidence_to_slip_batch", {
      p_batch_id:    batchId,
      p_evidence_id: evidenceId,
    });
    if (error) throw new Error(`Failed to attach evidence to batch: ${error.message}`);
  }
}
