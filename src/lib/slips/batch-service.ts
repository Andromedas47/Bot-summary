import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export const SLIP_BATCH_QUIET_SECONDS = 20;

type Supabase = SupabaseClient<Database>;

export interface BatchResult {
  batchId: string;
  isNewBatch: boolean;
}

export interface SlipBatchIngestor {
  getOrCreateBatch(
    sourceId: string,
    sourceType: string,
    senderId: string | null,
  ): Promise<BatchResult>;
  attachEvidence(batchId: string, evidenceId: string): Promise<void>;
}

export class SlipBatchService implements SlipBatchIngestor {
  constructor(private readonly supabase: Supabase) {}

  async getOrCreateBatch(
    sourceId: string,
    sourceType: string,
    senderId: string | null,
  ): Promise<BatchResult> {
    const cutoff = new Date(Date.now() - SLIP_BATCH_QUIET_SECONDS * 1000).toISOString();

    const existing = await this.findActiveBatch(sourceId, senderId, cutoff);
    if (existing) {
      return { batchId: existing.id, isNewBatch: false };
    }

    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("slip_batches")
      .insert({
        source_id:     sourceId,
        source_type:   sourceType,
        sender_id:     senderId,
        status:        "collecting",
        first_image_at: now,
        last_image_at:  now,
        image_count:   0,
      })
      .select("id")
      .single();

    if (error || !data) throw new Error("Failed to create slip batch");
    return { batchId: data.id, isNewBatch: true };
  }

  async attachEvidence(batchId: string, evidenceId: string): Promise<void> {
    const { error } = await this.supabase.rpc("attach_evidence_to_slip_batch", {
      p_batch_id:    batchId,
      p_evidence_id: evidenceId,
    });
    if (error) throw new Error(`Failed to attach evidence to batch: ${error.message}`);
  }

  private async findActiveBatch(
    sourceId: string,
    senderId: string | null,
    cutoff: string,
  ): Promise<{ id: string } | null> {
    // Two branches to keep type safety — `.is(null)` and `.eq(value)` differ.
    if (senderId !== null) {
      const { data } = await this.supabase
        .from("slip_batches")
        .select("id")
        .eq("source_id", sourceId)
        .eq("status", "collecting")
        .eq("sender_id", senderId)
        .gte("last_image_at", cutoff)
        .order("last_image_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ?? null;
    }

    const { data } = await this.supabase
      .from("slip_batches")
      .select("id")
      .eq("source_id", sourceId)
      .eq("status", "collecting")
      .is("sender_id", null)
      .gte("last_image_at", cutoff)
      .order("last_image_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ?? null;
  }
}
