import type { SupabaseClient } from "@supabase/supabase-js";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

const TERMINAL_STATUSES = ["EXTRACTED", "PARTIAL_EXTRACTED"] as const;

export type SlipDuplicateResult =
  | {
      status: "unique";
      transactionId: string;
    }
  | {
      status: "duplicate_same_source";
      transactionId: string;
      originalRecordId: string;
      originalMarketLabel?: string;
      originalBusinessDate?: string;
    }
  | {
      status: "duplicate_cross_source";
      transactionId: string;
      originalRecordId: string;
      originalMarketLabel?: string;
      originalBusinessDate?: string;
    }
  | {
      status: "missing_transaction_id";
    };

export interface SlipDuplicateLookupParams {
  rawTransactionId: string | null;
  sourceId: string;
  excludeCheckId?: string;
}

/**
 * Trims surrounding whitespace only. Case and punctuation are preserved
 * exactly as the extractor returned them — the provider contract does not
 * establish case-insensitivity, so normalizing further would risk merging
 * two genuinely different reference numbers.
 */
export function normalizeTransactionId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Best-effort duplicate lookup for a verified-slip transaction id.
 *
 * ponytail: this is a query-before-write check, not an atomic claim — no
 * database unique constraint backs reference_id yet (slip_checks has none,
 * see schema gap report), so two verifications racing on the same
 * transaction id can both pass this lookup and both get accepted. Add a
 * partial unique index on slip_checks(reference_id) once the gap is closed,
 * then move this check inside an insert-on-conflict flow for true
 * concurrency safety.
 */
export async function findSlipTransactionDuplicate(
  supabase: Supabase,
  params: SlipDuplicateLookupParams,
): Promise<SlipDuplicateResult> {
  const transactionId = normalizeTransactionId(params.rawTransactionId);
  if (!transactionId) return { status: "missing_transaction_id" };

  const { data: checks, error } = await supabase
    .from("slip_checks")
    .select("id, evidence_id, created_at")
    .eq("reference_id", transactionId)
    .in("status", TERMINAL_STATUSES)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`slip transaction duplicate lookup failed: ${error.message}`);

  const original = (checks ?? []).find((row) => row.id !== params.excludeCheckId);
  if (!original) return { status: "unique", transactionId };

  const { data: evidence } = await supabase
    .from("slip_evidences")
    .select("source_id, received_at, batch_id")
    .eq("id", original.evidence_id)
    .maybeSingle();

  let originalMarketLabel: string | undefined;
  if (evidence?.batch_id) {
    const { data: batch } = await supabase
      .from("slip_batches")
      .select("market_name")
      .eq("id", evidence.batch_id)
      .maybeSingle();
    originalMarketLabel = batch?.market_name ?? undefined;
  }

  const originalBusinessDate = evidence?.received_at
    ? bangkokBusinessDateFromTimestamp(Date.parse(evidence.received_at)) ?? undefined
    : undefined;

  const sameSource = evidence?.source_id != null && evidence.source_id === params.sourceId;

  return {
    status: sameSource ? "duplicate_same_source" : "duplicate_cross_source",
    transactionId,
    originalRecordId: original.id,
    originalMarketLabel,
    originalBusinessDate,
  };
}

/**
 * Resolves, for a batch of candidate reference ids, which slip_checks row is
 * the globally-earliest accepted record for each id — across every source
 * and business date, not just the caller's scope.
 *
 * ponytail: one batched query rather than one lookup per reference id.
 * Still a read-then-decide check, not an atomic claim (same caveat as
 * findSlipTransactionDuplicate above).
 */
export async function resolveGloballyAcceptedCheckIds(
  supabase: Supabase,
  referenceIds: string[],
): Promise<Set<string>> {
  if (referenceIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from("slip_checks")
    .select("id, reference_id, created_at")
    .in("reference_id", referenceIds)
    .in("status", TERMINAL_STATUSES)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`global reference resolution failed: ${error.message}`);

  const winners = new Map<string, string>();
  for (const row of data ?? []) {
    if (!row.reference_id) continue;
    if (!winners.has(row.reference_id)) winners.set(row.reference_id, row.id);
  }
  return new Set(winners.values());
}
