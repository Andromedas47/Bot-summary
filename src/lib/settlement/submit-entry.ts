/**
 * The authoritative settlement-entry submission, extracted verbatim from the
 * `source_id` branch of POST /api/settlement so LINE and the Dashboard share
 * ONE implementation.
 *
 * The contract is unchanged and is not re-derived anywhere else:
 *   1. reconcile() first — an open manual-slip session blocks the write;
 *   2. upsert on (settlement_date, settlement_time, staff_name, market_name);
 *   3. tryFinalizeSettlement() — authoritative and idempotent on retry.
 *
 * No caller may re-implement any of the three, and no caller may invent
 * overwrite semantics: the upsert key IS the update rule.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcile, type ReconciliationResult } from "@/lib/reconciliation";
import {
  tryFinalizeSettlement,
  type FinalizeSettlementResult,
} from "@/lib/settlement-finalizer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** Exactly the operator-supplied columns of settlement_entries. */
export type SettlementEntryValues = {
  settlement_date: string;
  settlement_time: string;
  staff_name: string;
  market_name: string;
  money_transfer: number;
  money_cash: number;
  expenses: number;
  labor: number;
  notes: string;
};

export type SubmitSettlementEntryResult =
  /** reconcile() refused — nothing was written. */
  | { status: "blocked"; reason: string }
  /** The upsert itself failed — nothing was written. */
  | { status: "failed"; reason: string }
  | {
      status: "saved";
      entry: Record<string, unknown>;
      reconciliation: ReconciliationResult;
      /** null when the caller deferred finalization to its own close step. */
      finalizeStatus: FinalizeSettlementResult | null;
    };

export type SettlementPushFn = (
  to: string,
  text: string,
  retryKey?: string,
) => Promise<unknown>;

export async function submitSettlementEntryForSource(
  supabase: AnyClient,
  sourceId: string,
  values: SettlementEntryValues,
  options: {
    /** Omitted keeps the finalizer's own LINE push (Dashboard behaviour). */
    push?: SettlementPushFn;
    /**
     * Defaults to true — POST /api/settlement finalizes on submit. The guided
     * LINE flow passes false because its close step is "ปิดรอบ", which applies
     * the guided lifecycle blockers (including a non-zero difference) and then
     * calls the SAME finalizer. Finalizing on submit there would skip them.
     */
    finalize?: boolean;
    accountabilityRoundId?: string | null;
  } = {},
): Promise<SubmitSettlementEntryResult> {
  const reconcileResult = await reconcile(
    supabase,
    sourceId,
    values.settlement_date,
    values.money_transfer,
    options.accountabilityRoundId,
  );
  if (reconcileResult.blocked) {
    return { status: "blocked", reason: reconcileResult.reason };
  }

  const { data, error } = await supabase
    .from("settlement_entries")
    .upsert(
      {
        ...values,
        source_id: sourceId,
        accountability_round_id: options.accountabilityRoundId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "settlement_date,settlement_time,staff_name,market_name" },
    )
    .select()
    .single();

  if (error) return { status: "failed", reason: error.message };

  const finalizeStatus =
    options.finalize === false
      ? null
      : options.push
        ? await tryFinalizeSettlement(
            supabase,
            sourceId,
            values.settlement_date,
            options.push,
            options.accountabilityRoundId,
          )
        : await tryFinalizeSettlement(
            supabase,
            sourceId,
            values.settlement_date,
            undefined,
            options.accountabilityRoundId,
          );

  return {
    status: "saved",
    entry: (data ?? {}) as Record<string, unknown>,
    reconciliation: reconcileResult.result,
    finalizeStatus,
  };
}
