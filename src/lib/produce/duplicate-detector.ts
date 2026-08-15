/**
 * Read-only duplicate-anomaly detection for one business date.
 *
 * This module NEVER writes, merges, binds or voids anything. It reads produce
 * rows that already exist and reports what a human should look at. Two
 * separate findings, deliberately kept apart because they carry very different
 * confidence:
 *
 *   exact_duplicate_withdrawal
 *     Two or more non-void withdrawal sessions with the SAME canonical business
 *     fingerprint — same business date, same normalized seller, same normalized
 *     market, same transaction type, same item multiset. This is the แทน —
 *     ราชพฤก case. Ingest now blocks it (imported_sessions.session_hash), so
 *     going forward this can only surface historical rows.
 *
 *   possible_composite_duplicate
 *     One session's withdrawal multiset is exactly the union of 2 or 3 OTHER
 *     sessions' withdrawal multisets on the same date. This is the ป้าลี —
 *     ตลาด72 (30) = ขวัญ — 72ผลไม้ (27) + โด้ — 72ทุเรียน (3) case. The seller
 *     and market identities DIFFER, so this is never treated as proof and is
 *     never acted on automatically: it is evidence for review.
 *
 * Cost. Everything is scoped to a single business date and driven by
 * precomputed canonical item lines. Exact duplicates are one hash map. The
 * composite search only considers sessions whose multiset is a proper
 * submultiset of the whole — in practice a handful — and only combinations of
 * two or three of them, with a hard candidate cap. No pass is O(N^3) over the
 * date, and no pass touches history.
 */

import {
  canonicalItemLine,
  businessContentFingerprint,
  normalizeSellerLabel,
  type BusinessItemInput,
} from "./business-fingerprint";
import { normalizedMarketLabel } from "@/lib/market";
import { baseTransactionType } from "@/lib/summary/transactions";

/** One persisted produce row, as `produce_transactions` exposes it. */
export interface DuplicateScanRow {
  session_id: string;
  accountability_round_id?: string | null;
  /** "main" or "additional". Only main sessions are judged — see below. */
  session_kind?: string | null;
  staff_name?: string | null;
  market_name?: string | null;
  product_name?: string | null;
  unit?: string | null;
  quantity?: number | string | null;
  price_per_unit?: number | string | null;
  transaction_type?: string | null;
  basis_quantity?: number | string | null;
  basis_unit?: string | null;
  basis_price?: number | string | null;
}

export interface DuplicateSessionSummary {
  sessionId: string;
  accountabilityRoundId: string | null;
  sellerLabel: string;
  marketLabel: string;
  itemCount: number;
  totalAmount: number;
  fingerprint: string;
}

export type DuplicateAnomaly =
  | {
      kind: "exact_duplicate_withdrawal";
      fingerprint: string;
      sessions: readonly DuplicateSessionSummary[];
    }
  | {
      kind: "possible_composite_duplicate";
      whole: DuplicateSessionSummary;
      parts: readonly DuplicateSessionSummary[];
    };

/**
 * Composite search bound. Beyond this many submultiset candidates for one
 * whole, the pair/triple scan is skipped rather than allowed to grow — a
 * warning nobody can act on is not worth an unbounded loop on the close path.
 */
const MAX_COMPOSITE_CANDIDATES = 12;

interface SessionAggregate extends DuplicateSessionSummary {
  /** canonical item line → how many rows carry it. Multiplicity is the point. */
  counts: Map<string, number>;
}

function amountOf(row: DuplicateScanRow): number {
  const quantity = Number(row.quantity ?? 0);
  const price = Number(row.price_per_unit ?? 0);
  if (!Number.isFinite(quantity) || !Number.isFinite(price)) return 0;
  return quantity * price;
}

function itemInputOf(row: DuplicateScanRow): BusinessItemInput {
  return {
    productName: row.product_name ?? null,
    unit: row.unit ?? null,
    quantity: row.quantity ?? null,
    pricePerUnit: row.price_per_unit ?? null,
    transactionType: row.transaction_type ?? null,
    basisQuantity: row.basis_quantity ?? null,
    basisUnit: row.basis_unit ?? null,
    basisPrice: row.basis_price ?? null,
  };
}

/**
 * Fold the date's rows into one aggregate per session, withdrawals only.
 *
 * Returns and คืนเสีย are excluded on purpose: a duplicated withdrawal is what
 * inflates sales, and a return legitimately repeats products the withdrawal
 * already named.
 *
 * `additional` sessions are excluded too, and for the same reason the ingest
 * gate only blocks `main`: a เบิกเพิ่ม batch that happens to repeat the main
 * withdrawal line for line is a real second withdrawal, not a duplicate. The
 * detector must agree with the rule it reports on, or it would block a day for
 * something the system deliberately allowed.
 */
function aggregateWithdrawalSessions(
  businessDate: string,
  rows: readonly DuplicateScanRow[],
): SessionAggregate[] {
  const bySession = new Map<string, { rows: DuplicateScanRow[] }>();

  for (const row of rows) {
    if (!row.session_id) continue;
    if ((row.session_kind ?? "main") !== "main") continue;
    if (baseTransactionType((row.transaction_type ?? "").trim()) !== "เบิก") continue;
    const entry = bySession.get(row.session_id) ?? { rows: [] };
    entry.rows.push(row);
    bySession.set(row.session_id, entry);
  }

  const aggregates: SessionAggregate[] = [];
  for (const [sessionId, entry] of bySession) {
    const counts = new Map<string, number>();
    for (const row of entry.rows) {
      const line = canonicalItemLine(itemInputOf(row));
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    const first = entry.rows[0];
    aggregates.push({
      sessionId,
      accountabilityRoundId: first.accountability_round_id ?? null,
      sellerLabel: normalizeSellerLabel(first.staff_name),
      marketLabel: normalizedMarketLabel(first.market_name),
      itemCount: entry.rows.length,
      totalAmount: Math.round(entry.rows.reduce((sum, row) => sum + amountOf(row), 0) * 100) / 100,
      fingerprint: businessContentFingerprint({
        businessDate,
        sellerLabel: first.staff_name ?? null,
        marketLabel: first.market_name ?? null,
        items: entry.rows.map(itemInputOf),
      }),
      counts,
    });
  }

  return aggregates.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function summaryOf(aggregate: SessionAggregate): DuplicateSessionSummary {
  return {
    sessionId: aggregate.sessionId,
    accountabilityRoundId: aggregate.accountabilityRoundId,
    sellerLabel: aggregate.sellerLabel,
    marketLabel: aggregate.marketLabel,
    itemCount: aggregate.itemCount,
    totalAmount: aggregate.totalAmount,
    fingerprint: aggregate.fingerprint,
  };
}

/** True when every line of `part` fits inside `whole` with its multiplicity. */
function isSubMultiset(part: SessionAggregate, whole: SessionAggregate): boolean {
  for (const [line, count] of part.counts) {
    if ((whole.counts.get(line) ?? 0) < count) return false;
  }
  return true;
}

/** True when the parts, merged, are exactly the whole. */
function unionEqualsWhole(
  parts: readonly SessionAggregate[],
  whole: SessionAggregate,
): boolean {
  const merged = new Map<string, number>();
  for (const part of parts) {
    for (const [line, count] of part.counts) {
      merged.set(line, (merged.get(line) ?? 0) + count);
    }
  }
  if (merged.size !== whole.counts.size) return false;
  for (const [line, count] of whole.counts) {
    if (merged.get(line) !== count) return false;
  }
  return true;
}

function exactDuplicates(aggregates: readonly SessionAggregate[]): DuplicateAnomaly[] {
  const byFingerprint = new Map<string, SessionAggregate[]>();
  for (const aggregate of aggregates) {
    byFingerprint.set(aggregate.fingerprint, [
      ...(byFingerprint.get(aggregate.fingerprint) ?? []),
      aggregate,
    ]);
  }

  const anomalies: DuplicateAnomaly[] = [];
  for (const [fingerprint, group] of byFingerprint) {
    if (group.length < 2) continue;
    anomalies.push({
      kind: "exact_duplicate_withdrawal",
      fingerprint,
      sessions: group.map(summaryOf),
    });
  }
  return anomalies;
}

function compositeDuplicates(
  aggregates: readonly SessionAggregate[],
  duplicateSessionIds: ReadonlySet<string>,
): DuplicateAnomaly[] {
  const anomalies: DuplicateAnomaly[] = [];

  for (const whole of aggregates) {
    if (whole.itemCount < 2) continue;
    // An exact duplicate is already reported as one; re-reporting it as its own
    // composite would be the same fact twice under a weaker name.
    if (duplicateSessionIds.has(whole.sessionId)) continue;

    const candidates = aggregates.filter(
      (candidate) =>
        candidate.sessionId !== whole.sessionId
        && candidate.itemCount > 0
        && candidate.itemCount < whole.itemCount
        && isSubMultiset(candidate, whole),
    );
    if (candidates.length < 2 || candidates.length > MAX_COMPOSITE_CANDIDATES) continue;

    const found = findExactCover(candidates, whole);
    if (found) {
      anomalies.push({
        kind: "possible_composite_duplicate",
        whole: summaryOf(whole),
        parts: found.map(summaryOf),
      });
    }
  }

  return anomalies;
}

/**
 * The smallest cover that is still the pattern we actually saw: two or three
 * sessions whose item counts sum to the whole's and whose merged multiset IS
 * the whole's. The count test runs first because it rejects nearly everything
 * for the price of an addition.
 */
function findExactCover(
  candidates: readonly SessionAggregate[],
  whole: SessionAggregate,
): SessionAggregate[] | null {
  for (let a = 0; a < candidates.length; a += 1) {
    for (let b = a + 1; b < candidates.length; b += 1) {
      const pair = [candidates[a], candidates[b]];
      if (candidates[a].itemCount + candidates[b].itemCount === whole.itemCount) {
        if (unionEqualsWhole(pair, whole)) return pair;
      }
      for (let c = b + 1; c < candidates.length; c += 1) {
        const triple = [candidates[a], candidates[b], candidates[c]];
        const total = triple.reduce((sum, part) => sum + part.itemCount, 0);
        if (total !== whole.itemCount) continue;
        if (unionEqualsWhole(triple, whole)) return triple;
      }
    }
  }
  return null;
}

/**
 * Every duplicate anomaly of one business date. Exact duplicates first, then
 * composite overlaps, each group in stable session order.
 */
export function detectDuplicateAnomalies(
  businessDate: string,
  rows: readonly DuplicateScanRow[],
): DuplicateAnomaly[] {
  const aggregates = aggregateWithdrawalSessions(businessDate, rows);
  const exact = exactDuplicates(aggregates);

  const duplicateSessionIds = new Set(
    exact.flatMap((anomaly) =>
      anomaly.kind === "exact_duplicate_withdrawal"
        ? anomaly.sessions.map((session) => session.sessionId)
        : []),
  );

  return [...exact, ...compositeDuplicates(aggregates, duplicateSessionIds)];
}
