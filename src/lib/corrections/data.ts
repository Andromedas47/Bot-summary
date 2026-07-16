import "server-only";

import { createServiceClient } from "@/lib/supabase/server";
import { correctionTargetVersion, rawTargetVersion, snapshotFromTransaction } from "@/lib/corrections/effective-transactions";
import type { CorrectionSnapshot, ProduceTransactionLike, TransactionCorrection } from "@/lib/corrections/types";
import type { TransactionCorrectionRow } from "@/types/database";

function rowToCorrection(row: TransactionCorrectionRow): TransactionCorrection {
  return { ...row, before_snapshot: row.before_snapshot as unknown as CorrectionSnapshot, after_snapshot: row.after_snapshot as unknown as CorrectionSnapshot };
}

export async function getCorrection(id: string): Promise<TransactionCorrection | null> {
  const { data, error } = await createServiceClient().from("transaction_corrections").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToCorrection(data) : null;
}

export async function listCorrections(filters: { date?: string; worker?: string; status?: string; reason?: string }): Promise<TransactionCorrection[]> {
  let query = createServiceClient().from("transaction_corrections").select("*").order("requested_at", { ascending: false }).limit(1000);
  if (filters.status) query = query.eq("status", filters.status as TransactionCorrectionRow["status"]);
  if (filters.reason) query = query.eq("reason_type", filters.reason as TransactionCorrectionRow["reason_type"]);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToCorrection).filter((row) => {
    if (filters.date && row.before_snapshot.transactionDate !== filters.date) return false;
    if (filters.worker && row.before_snapshot.staffName !== filters.worker) return false;
    return true;
  });
}

export async function getCorrectionTarget(transactionId: string): Promise<{
  raw: ProduceTransactionLike;
  current: CorrectionSnapshot;
  targetVersion: string;
  supersedesCorrectionId: string | null;
}> {
  const supabase = createServiceClient();
  const [{ data: raw, error: rawError }, { data: active, error: correctionError }] = await Promise.all([
    supabase.from("produce_transactions").select("id, product_name, quantity, unit, price_per_unit, total_amount, transaction_type, transaction_date, staff_name, market_name, raw_message_id, basis_quantity, basis_unit, basis_price").eq("id", transactionId).single(),
    supabase.from("transaction_corrections").select("*").eq("target_transaction_id", transactionId).eq("status", "approved").maybeSingle(),
  ]);
  if (rawError) throw new Error(rawError.message);
  if (correctionError) throw new Error(correctionError.message);
  const source = raw as ProduceTransactionLike;
  return {
    raw: source,
    current: active ? (active.after_snapshot as unknown as CorrectionSnapshot) : snapshotFromTransaction(source),
    targetVersion: active ? correctionTargetVersion(active.id) : rawTargetVersion(transactionId),
    supersedesCorrectionId: active?.id ?? null,
  };
}
