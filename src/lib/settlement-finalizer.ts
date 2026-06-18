import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  reconcile,
  businessDateToUtcRange,
} from "@/lib/reconciliation";
import {
  buildFinalSettlementMessage,
} from "@/lib/line/settlement-message";
import {
  pushLineMessage,
} from "@/lib/line/reply";
import {
  calculateSettlementTotals,
  emptyTransactionTotals,
  addTransactionAmount,
  KNOWN_TX_TYPES,
} from "@/lib/summary/transactions";
import { displayMarketName } from "@/lib/market";
import { logger } from "@/lib/logger";

type Supabase = SupabaseClient<Database>;
type PushFn   = (to: string, text: string, retryKey?: string) => Promise<unknown>;

const defaultPush: PushFn = pushLineMessage;

// A sending row older than this with message_sent_at IS NULL is considered stale
// (process crash or DB update failure after LINE success) and can be reclaimed.
const STALE_SENDING_MS = 5 * 60 * 1000; // 5 minutes

export type FinalizeSettlementResult =
  | "finalized"
  | "not_ready"
  | "already_done"
  | "ambiguous"
  | "failed";

// ── Transaction totals from produce_transactions view ─────────────────────────
// Mirrors /api/settlement's getSettlementContext without the sourceIds lookup.
// ponytail: filters by staff_name+market_name+date — cannot filter by source_id
//           because produce_transactions is a denormalized view without that column.

async function computeTransactionTotals(
  supabase:    Supabase,
  date:        string,
  staff_name:  string,
  market_name: string,
) {
  const base     = supabase
    .from("produce_transactions")
    .select("transaction_type, total_amount, market_name")
    .eq("transaction_date", date);

  const filtered = staff_name ? base.eq("staff_name", staff_name) : base;
  const { data } = await filtered.in("transaction_type", KNOWN_TX_TYPES as unknown as string[]);

  const marketLabel = displayMarketName(market_name, "");
  const rows = (data ?? []).filter((row) => {
    if (!marketLabel) return true;
    return (
      displayMarketName((row.market_name as string) ?? "", "") === marketLabel ||
      row.market_name === market_name
    );
  });

  const totals = emptyTransactionTotals();
  for (const row of rows) {
    addTransactionAmount(totals, {
      transaction_type: row.transaction_type as string,
      total_amount:     (row.total_amount as number) ?? 0,
    });
  }
  return totals;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function tryFinalizeSettlement(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
  push:         PushFn = defaultPush,
): Promise<FinalizeSettlementResult> {
  const log = logger.child({ fn: "tryFinalizeSettlement", sourceId, businessDate });
  const now = new Date().toISOString();

  // ── 1. Detect multiple settlement entries (ambiguous) ──────────────────────
  const { data: entries, error: entryErr } = await supabase
    .from("settlement_entries")
    .select("money_transfer, money_cash, expenses, labor, staff_name, market_name, notes")
    .eq("source_id", sourceId)
    .eq("settlement_date", businessDate);

  if (entryErr) throw new Error(`settlement_entries query failed: ${entryErr.message}`);

  if (!entries || entries.length === 0) {
    log.debug("no settlement entry");
    return "not_ready";
  }

  if (entries.length > 1) {
    // Never downgrade a row that already sent the final message.
    const { data: existingFin } = await supabase
      .from("settlement_finalizations")
      .select("status, message_sent_at")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .maybeSingle();

    if (existingFin?.status === "sent" || existingFin?.message_sent_at) {
      log.info("already sent — ignoring ambiguous entries");
      return "already_done";
    }

    log.warn("multiple settlement entries — marking ambiguous", { count: entries.length });
    await supabase
      .from("settlement_finalizations")
      .upsert(
        { source_id: sourceId, business_date: businessDate, status: "ambiguous", updated_at: now },
        { onConflict: "source_id,business_date" },
      );
    return "ambiguous";
  }

  const entry = entries[0];

  // ── 2. Open manual slip session ────────────────────────────────────────────
  const { data: openSession } = await supabase
    .from("manual_slip_sessions")
    .select("id")
    .eq("source_id", sourceId)
    .eq("business_date", businessDate)
    .eq("status", "open")
    .maybeSingle();

  if (openSession) {
    log.debug("open manual slip session");
    return "not_ready";
  }

  // ── 3. In-flight AI slip batches ───────────────────────────────────────────
  // Uses last_image_at with the same businessDateToUtcRange window as
  // computeAiVerifiedTotal's slip_evidences.received_at query.
  // ponytail: batches spanning midnight may have evidences counted in a
  //           different window than last_image_at — accepted rare inconsistency.
  const { startUtc, endUtc } = businessDateToUtcRange(businessDate);
  const { data: activeBatches } = await supabase
    .from("slip_batches")
    .select("id")
    .eq("source_id", sourceId)
    .in("status", ["collecting", "closing", "processing"])
    .gte("last_image_at", startUtc)
    .lt("last_image_at", endUtc)
    .limit(1);

  if (activeBatches && activeBatches.length > 0) {
    log.debug("in-flight slip batch");
    return "not_ready";
  }

  // ── 4. Unbatched PROCESSING slip_checks ────────────────────────────────────
  // Evidences without a batch_id have no slip_batch row to cover them.
  // If their slip_check is still PROCESSING, reconciliation would undercount.
  // Batched evidences in completed/review_needed batches are accepted even if
  // individual checks are still PROCESSING (batch timeout path — known limit).
  const { data: unbatchedEvs } = await supabase
    .from("slip_evidences")
    .select("id")
    .eq("source_id", sourceId)
    .gte("received_at", startUtc)
    .lt("received_at", endUtc)
    .is("batch_id", null);

  const unbatchedIds = (unbatchedEvs ?? []).map((e) => e.id as string);
  if (unbatchedIds.length > 0) {
    const { data: processingChecks } = await supabase
      .from("slip_checks")
      .select("id")
      .in("evidence_id", unbatchedIds)
      .eq("status", "PROCESSING")
      .limit(1);

    if (processingChecks && processingChecks.length > 0) {
      log.debug("unbatched slip_check in PROCESSING state");
      return "not_ready";
    }
  }

  // ── 5. Atomic claim ────────────────────────────────────────────────────────
  // Three-stage claim: INSERT new → UPDATE pending/failed → reclaim stale sending.
  // A sending row is stale when claimed_at is older than STALE_SENDING_MS AND
  // message_sent_at IS NULL, which happens on process crash or DB update failure
  // after LINE already accepted. Reclaiming reuses the existing line_retry_key so
  // LINE returns 409 already_accepted and we can safely mark sent.

  const { data: insertedRow, error: insertErr } = await supabase
    .from("settlement_finalizations")
    .insert({ source_id: sourceId, business_date: businessDate, status: "sending", claimed_at: now })
    .select("id, line_retry_key, status")
    .maybeSingle();

  let claimedRow: { id: string; line_retry_key: string; status: string } | null = insertedRow;

  if (!claimedRow) {
    if (insertErr && !insertErr.message.includes("duplicate")) {
      throw new Error(`settlement_finalizations insert failed: ${insertErr.message}`);
    }

    // Stage 2: claim a pending or failed row.
    const { data: claimedExisting } = await supabase
      .from("settlement_finalizations")
      .update({ status: "sending", claimed_at: now, updated_at: now })
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .in("status", ["pending", "failed"])
      .select("id, line_retry_key, status")
      .maybeSingle();

    if (claimedExisting) {
      claimedRow = claimedExisting;
    } else {
      // Stage 3: reclaim a stale sending row (process crash / DB-update failure).
      // We only update claimed_at so the stable line_retry_key is preserved.
      const staleCutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
      const { data: reclaimedStale } = await supabase
        .from("settlement_finalizations")
        .update({ claimed_at: now, updated_at: now })
        .eq("source_id", sourceId)
        .eq("business_date", businessDate)
        .eq("status", "sending")
        .is("message_sent_at", null)
        .lte("claimed_at", staleCutoff)
        .select("id, line_retry_key, status")
        .maybeSingle();

      if (reclaimedStale) {
        log.info("reclaimed stale sending row", { id: reclaimedStale.id });
        claimedRow = reclaimedStale;
      } else {
        // Row is in a non-claimable state: re-fetch to determine why.
        const { data: existing } = await supabase
          .from("settlement_finalizations")
          .select("status, message_sent_at")
          .eq("source_id", sourceId)
          .eq("business_date", businessDate)
          .maybeSingle();

        if (existing?.status === "sent" || existing?.message_sent_at) return "already_done";
        if (existing?.status === "ambiguous")                          return "ambiguous";
        // status='sending' and not yet stale: another worker is active.
        log.info("concurrent claim in progress");
        return "not_ready";
      }
    }
  }

  log.info("finalization claimed", { id: claimedRow.id });

  // ── 6. Reconcile (upserts transfer_reconciliations) ────────────────────────
  const reconcileResult = await reconcile(
    supabase,
    sourceId,
    businessDate,
    entry.money_transfer ?? 0,
  );

  if (reconcileResult.blocked) {
    await supabase
      .from("settlement_finalizations")
      .update({ status: "failed", last_error: reconcileResult.reason, updated_at: now })
      .eq("id", claimedRow.id);
    log.warn("reconcile blocked after readiness check passed", { reason: reconcileResult.reason });
    return "not_ready";
  }

  // ── 7. Build combined message ──────────────────────────────────────────────
  const transactions = await computeTransactionTotals(
    supabase,
    businessDate,
    entry.staff_name  ?? "",
    entry.market_name ?? "",
  );

  const settlement = calculateSettlementTotals({
    ยอดส่ง:        transactions.ยอดส่ง,
    money_transfer: entry.money_transfer ?? 0,
    money_cash:     entry.money_cash     ?? 0,
    expenses:       entry.expenses       ?? 0,
    labor:          entry.labor          ?? 0,
  });

  const message = buildFinalSettlementMessage({
    date:           businessDate,
    staffName:      entry.staff_name   ?? "",
    marketName:     entry.market_name  ?? "",
    transactions,
    settlement,
    reconciliation: reconcileResult.result,
    notes:          entry.notes        ?? "",
  });

  // ── 8. Push LINE with stable retry key ────────────────────────────────────
  // Reclaimed stale rows reuse the same line_retry_key. If LINE already accepted
  // the message it returns 409 (already_accepted); pushLineMessage treats that as
  // success so we proceed straight to marking sent.
  const retryKey = claimedRow.line_retry_key;
  try {
    await push(sourceId, message, retryKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("final LINE push failed", { reason, retryKey });
    await supabase
      .from("settlement_finalizations")
      .update({ status: "failed", last_error: reason, updated_at: new Date().toISOString() })
      .eq("id", claimedRow.id);
    return "failed";
  }

  // ── 9. Persist sent status ────────────────────────────────────────────────
  // If this update fails (network, crash), the row stays sending with
  // message_sent_at=null. The stale-reclaim path will retry using the same
  // line_retry_key; LINE returns 409 already_accepted and we mark sent then.
  const sentAt = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("settlement_finalizations")
    .update({ status: "sent", message_sent_at: sentAt, updated_at: sentAt })
    .eq("id", claimedRow.id);

  if (updateErr) {
    log.error("failed to update settlement_finalizations after LINE send — stale reclaim will retry", {
      reason: updateErr.message,
      retryKey,
    });
  }

  log.info("settlement finalized and LINE sent");
  return "finalized";
}
