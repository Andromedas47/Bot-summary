/**
 * Canonical withdrawal lines for sessions recorded BEFORE
 * `produce_sessions.canonical_withdrawal_item_lines` existed.
 *
 * The gap
 * -------
 * The containment guard (20260817090100) compares a candidate document against
 * sessions carrying that column. The column is written on the ingest path, so
 * every session recorded before the application ships keeps NULL forever. Read-
 * only Production evidence taken after the migrations were applied: for active
 * sessions with `session_date >= 2026-08-14`, 91 carry NULL and 0 carry a
 * value. Without this module the guard would be blind to all of them — a strict
 * superset resend of any one of those withdrawals would persist a second time,
 * which is the exact โด้ incident the guard exists to stop.
 *
 * Why the lines are computed here and not in SQL
 * ----------------------------------------------
 * `canonicalItemLine` is the identity: reviewed product name, unit alias,
 * quantity at scale 3, price at scale 2, the pricing basis, and the base
 * transaction type. That identity lives in TypeScript and is data-driven
 * (product aliases, unit aliases). A SQL re-implementation would be a SECOND
 * canonicalizer, and the day the two disagreed by one alias it would either
 * block real business data or wave a real duplicate through.
 *
 * So the exact same function runs over the persisted rows. That is not an
 * approximation: `produce_items` stores every field `BusinessItemInput` needs,
 * and `duplicate-detector.ts` has been reading them through this identical
 * mapping since PR #51 — the module contract is that the parsed-document and
 * persisted-row adapters agree digit for digit.
 *
 * What this module does NOT decide
 * --------------------------------
 * Eligibility. It proposes; the RPC disposes. Under the containment advisory
 * lock the RPC re-checks that each proposed session still exists, is not
 * voided, is still column-less, still matches date/seller/reviewed market,
 * still proves its source through its own raw message, and still holds exactly
 * `itemCount` items. Only the canonical CONTENT is taken from here.
 *
 * Nothing here writes. No column is backfilled and no historical row is
 * touched — the lines are derived per call and thrown away.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalItemLines } from "@/lib/produce/business-fingerprint";
import { canonicalMarketLabel } from "@/lib/market";
import { normalizeSellerLabel } from "@/lib/produce/business-fingerprint";
import { baseTransactionType } from "@/lib/summary/transactions";
import { logger } from "@/lib/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** One proposal: what the RPC re-validates, plus the content it cannot derive. */
export interface HistoricalWithdrawalCandidate {
  produce_session_id: string;
  lines: string[];
  item_count: number;
}

/**
 * How many pre-migration sessions one finalization will consider. A business
 * day for one seller at one market holds a handful; this is a ceiling against a
 * pathological day, not a paging contract.
 */
const MAX_HISTORICAL_CANDIDATES = 50;

interface ItemRow {
  session_id: string;
  product_name: string | null;
  unit: string | null;
  quantity: number | string | null;
  price_per_unit: number | string | null;
  transaction_type: string | null;
  basis_quantity: number | string | null;
  basis_unit: string | null;
  basis_price: number | string | null;
}

/** Identity comparison boundary, matching `accountability_round_normalize`. */
function marketIdentity(value: string | null | undefined): string {
  const canonical = canonicalMarketLabel(value);
  return normalizeSellerLabel(canonical ?? value ?? "");
}

/**
 * The pre-migration sessions that could contain, or be contained by, the
 * document about to be persisted.
 *
 * Returns `[]` for anything that is not a plain base withdrawal, for a document
 * with no business date, and on any read failure: an empty proposal leaves the
 * guard exactly as strong as it was before this module existed.
 */
export async function loadHistoricalWithdrawalCandidates(
  supabase: AnyClient,
  input: HistoricalCandidateInput,
): Promise<HistoricalWithdrawalCandidate[]> {
  try {
    return await loadCandidates(supabase, input);
  } catch (error) {
    // Proposing nothing leaves the guard exactly as strong as it was before
    // this module existed, so a read that cannot be made is never allowed to
    // turn a good finalization into an error.
    logger.warn("produce.containment.historical_lookup_failed", {
      sessionDate: input.sessionDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export interface HistoricalCandidateInput {
  sessionDate: string | null;
  staffName: string | null;
  marketLabel: string | null;
  /** Null when the document is not a plain base withdrawal — nothing to compare. */
  canonicalLines: string[] | null;
}

async function loadCandidates(
  supabase: AnyClient,
  input: HistoricalCandidateInput,
): Promise<HistoricalWithdrawalCandidate[]> {
  const sessionDate = (input.sessionDate ?? "").trim();
  if (!input.canonicalLines || input.canonicalLines.length === 0) return [];
  if (!sessionDate) return [];

  const staff = normalizeSellerLabel(input.staffName);
  const market = marketIdentity(input.marketLabel);
  if (!staff || !market) return [];

  const { data: sessions, error } = await supabase
    .from("produce_sessions")
    .select("id, staff_name, session_title, session_kind")
    .eq("session_date", sessionDate)
    .is("canonical_withdrawal_item_lines", null)
    .is("voided_at", null)
    .limit(MAX_HISTORICAL_CANDIDATES);

  if (error) {
    // The guard keeps working against stored-column sessions; only the
    // historical arm is lost, so this is a warning and not a finalization error.
    logger.warn("produce.containment.historical_lookup_failed", {
      sessionDate,
      error: error.message,
    });
    return [];
  }

  const eligible = ((sessions ?? []) as Array<Record<string, unknown>>).filter((row) => {
    // `session_kind` may be absent on the oldest rows; only an explicit
    // `additional` is excluded, matching `canonicalWithdrawalItemLines`.
    if (String(row.session_kind ?? "main") === "additional") return false;
    return normalizeSellerLabel(row.staff_name as string | null) === staff
      && marketIdentity(row.session_title as string | null) === market;
  });
  if (eligible.length === 0) return [];

  const ids = eligible.map((row) => String(row.id));
  const { data: items, error: itemsError } = await supabase
    .from("produce_items")
    .select(
      "session_id, product_name, unit, quantity, price_per_unit, transaction_type, basis_quantity, basis_unit, basis_price",
    )
    .in("session_id", ids);

  if (itemsError) {
    logger.warn("produce.containment.historical_items_failed", {
      sessionDate,
      error: itemsError.message,
    });
    return [];
  }

  const bySession = new Map<string, ItemRow[]>();
  for (const row of (items ?? []) as ItemRow[]) {
    const key = String(row.session_id);
    const bucket = bySession.get(key);
    if (bucket) bucket.push(row);
    else bySession.set(key, [row]);
  }

  const candidates: HistoricalWithdrawalCandidate[] = [];
  for (const id of ids) {
    const rows = bySession.get(id);
    if (!rows || rows.length === 0) continue;
    // The same rule `canonicalWithdrawalItemLines` applies to a parsed
    // document: a session that is not entirely base เบิก is not comparable.
    if (!rows.every((row) => baseTransactionType(row.transaction_type ?? "") === "เบิก")) {
      continue;
    }
    candidates.push({
      produce_session_id: id,
      lines: canonicalItemLines(rows.map((row) => ({
        productName: row.product_name,
        unit: row.unit,
        quantity: row.quantity,
        pricePerUnit: row.price_per_unit,
        transactionType: row.transaction_type,
        basisQuantity: row.basis_quantity,
        basisUnit: row.basis_unit,
        basisPrice: row.basis_price,
      }))),
      item_count: rows.length,
    });
  }
  return candidates;
}
