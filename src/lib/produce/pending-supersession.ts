/**
 * Retire the pending attempts a freshly persisted document provably replaced.
 *
 * The problem
 * -----------
 * Production 2026-08-16 carries non-terminal pending generations for จิ้ว, ขวัญ
 * and เมย์ whose business was afterwards recorded by a DIFFERENT generation —
 * usually a different staff member re-entering the same withdrawal from their
 * own LINE account, which is a different `session_key` and therefore a different
 * pending row. The original row never terminalizes, keeps an empty
 * accountability round open, and every report keeps counting it as unresolved.
 *
 * Why not a timer
 * ---------------
 * "Terminalize anything older than N minutes" would destroy legitimate
 * unfinished operator input — a seller who opened a withdrawal and is still
 * typing rows looks identical to a dead attempt from the outside. Supersession
 * needs PROOF, and the proof has to be strong enough that acting on it can never
 * lose business data.
 *
 * The proof
 * ---------
 * All of the following, with no wildcards. A null on either side is "cannot
 * prove", never "matches anything":
 *
 *   1. the same business identity — source, business date, seller, market and
 *      base transaction type — decided by `isSuccessorOf` (PR #49), the same
 *      rule the report layer already uses to classify a failed attempt;
 *   2. strict ordering: the successor landed AFTER the attempt;
 *   3. content containment: every canonical item line of the pending document
 *      occurs in the successful one with at least the same multiplicity, or the
 *      two documents have the identical canonical fingerprint.
 *
 * Rule 3 is what makes this safe for the มิ้น case. Two plain `เบิก` documents
 * of one round — 3 durian rows and 13 dry-good rows — share every identity
 * dimension, so rules 1 and 2 alone would let the dry goods "supersede" the
 * durian and silently drop it. Their item multisets are disjoint, so containment
 * refuses and the pending attempt stays exactly where it was.
 *
 * A document whose relationship to the successful session cannot be established
 * — an unparseable one, a corrected resend whose items genuinely differ — stays
 * ACTIVE and review-required. That is the intended boundary, not a gap.
 *
 * Nothing here deletes. `supersede_pending_generation` preserves
 * accumulated_text, generation identity, timestamps and every review artefact,
 * and only retires an accountability round that is provably empty.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  canonicalItemLines,
  canonicalItemMultisetContains,
  weighSessionBusinessFingerprint,
} from "@/lib/produce/business-fingerprint";
import { baseTransactionType, type TransactionBucket } from "@/lib/summary/transactions";
import {
  type FinalizedProduceOutcome,
  type ProduceFailureAttempt,
} from "@/lib/produce/failure-lifecycle";
import { logger } from "@/lib/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** The document that just landed, as the successor half of the proof. */
export interface SupersessionSuccessor {
  produceSessionId: string;
  sessionKey: string;
  sessionGeneration: string;
  sourceId: string;
  parsed: WeighSession;
  finalizedAtMs: number;
  accountabilityRoundId: string | null;
}

export interface SupersessionCandidate {
  sessionKey: string;
  sessionGeneration: string;
  sourceId: string;
  accumulatedText: string;
  createdAtMs: number;
  accountabilityRoundId: string | null;
}

export interface SupersessionOutcome {
  sessionKey: string;
  sessionGeneration: string;
  superseded: boolean;
  reason: string;
  roundOutcome?: string;
}

/**
 * The single base transaction type a document declares, or null when it mixes
 * more than one. Null makes the attempt unprovable, which keeps it active.
 */
function soleTransactionKind(parsed: WeighSession): TransactionBucket | null {
  const kinds = new Set(
    parsed.items
      .map((item) => baseTransactionType(item.transaction_type))
      .filter((kind): kind is TransactionBucket => kind != null),
  );
  return kinds.size === 1 ? [...kinds][0] : null;
}

function attemptOf(
  candidate: SupersessionCandidate,
  parsed: WeighSession,
): ProduceFailureAttempt {
  return {
    attemptId: `${candidate.sessionKey}:${candidate.sessionGeneration}`,
    origin: "pending_session",
    businessDate: parsed.date,
    sourceId: candidate.sourceId,
    staffLabel: parsed.staff_name || null,
    marketLabel: parsed.session_title,
    transactionKind: soleTransactionKind(parsed),
    accountabilityRoundId: candidate.accountabilityRoundId,
    attemptedAtMs: candidate.createdAtMs,
  };
}

function outcomeOf(successor: SupersessionSuccessor): FinalizedProduceOutcome {
  return {
    produceSessionId: successor.produceSessionId,
    businessDate: successor.parsed.date,
    sourceId: successor.sourceId,
    staffLabel: successor.parsed.staff_name || null,
    marketLabel: successor.parsed.session_title,
    transactionKind: soleTransactionKind(successor.parsed),
    accountabilityRoundId: successor.accountabilityRoundId,
    sessionKind: successor.parsed.session_kind,
    voidedAtMs: null,
    finalizedAtMs: successor.finalizedAtMs,
  };
}

/**
 * Rule 3. Either the two documents ARE the same business content, or the older
 * one's item multiset is entirely represented in the newer one.
 *
 * An attempt with no items proves nothing and is never superseded — an empty
 * multiset is trivially contained by everything, which would make the guard
 * vacuous exactly where it matters most.
 */
export function isContentSuperseded(
  attempt: WeighSession,
  successor: WeighSession,
): boolean {
  if (attempt.items.length === 0) return false;
  if (weighSessionBusinessFingerprint(attempt)
      === weighSessionBusinessFingerprint(successor)) {
    return true;
  }
  return canonicalItemMultisetContains(
    canonicalItemLines(successor.items.map((item) => ({
      productName: item.product_name,
      unit: item.unit,
      quantity: item.quantity,
      pricePerUnit: item.price_per_unit,
      transactionType: item.transaction_type,
      basisQuantity: item.basis_quantity,
      basisUnit: item.basis_unit,
      basisPrice: item.basis_price,
    }))),
    canonicalItemLines(attempt.items.map((item) => ({
      productName: item.product_name,
      unit: item.unit,
      quantity: item.quantity,
      pricePerUnit: item.price_per_unit,
      transactionType: item.transaction_type,
      basisQuantity: item.basis_quantity,
      basisUnit: item.basis_unit,
      basisPrice: item.basis_price,
    }))),
  );
}

/**
 * The complete proof, as a pure predicate. `isSuccessorOf` is not exported by
 * the PR #49 module, so its contract is applied here through
 * `classifyProduceFailure`-equivalent field comparison plus the content rule.
 */
export function provesSupersession(
  attempt: ProduceFailureAttempt,
  attemptParsed: WeighSession,
  successor: SupersessionSuccessor,
): boolean {
  const outcome = outcomeOf(successor);
  if (outcome.sessionKind !== "main") return false;
  if (!attempt.transactionKind || outcome.transactionKind !== attempt.transactionKind) {
    return false;
  }
  if (attempt.attemptedAtMs === null || outcome.finalizedAtMs === null) return false;
  if (outcome.finalizedAtMs <= attempt.attemptedAtMs) return false;

  const identity = (value: string | null) =>
    value ? value.normalize("NFC").replace(/\s+/g, " ").trim() || null : null;

  const source = identity(attempt.sourceId);
  const date = identity(attempt.businessDate);
  const market = identity(attempt.marketLabel);
  const staff = identity(attempt.staffLabel);
  if (!source || !date || !market || !staff) return false;
  if (
    identity(outcome.sourceId) !== source
    || identity(outcome.businessDate) !== date
    || identity(outcome.marketLabel) !== market
    || identity(outcome.staffLabel) !== staff
  ) return false;

  // A bound attempt's round is authoritative and must match exactly. An unbound
  // attempt has no round dimension, and null is not a wildcard over partial
  // identity — it is reached only once every dimension above is proven equal.
  const attemptRound = identity(attempt.accountabilityRoundId);
  if (attemptRound !== null && identity(outcome.accountabilityRoundId) !== attemptRound) {
    return false;
  }

  return isContentSuperseded(attemptParsed, successor.parsed);
}

/**
 * Terminalize every pending generation this successful document provably
 * replaced. Best-effort by contract: the produce write has already committed,
 * and nothing here may turn a good finalization into an error.
 */
export async function supersedeReplacedPendingGenerations(
  supabase: AnyClient,
  successor: SupersessionSuccessor,
): Promise<SupersessionOutcome[]> {
  const log = logger.child({
    sessionKey: successor.sessionKey,
    sessionGeneration: successor.sessionGeneration,
  });

  // Scoped to the same LINE source: a document from another group is a
  // different business stream and can never be this one's predecessor.
  const { data, error } = await supabase
    .from("pending_sessions")
    .select(
      "session_key, session_generation, source_id, accumulated_text, created_at, accountability_round_id",
    )
    .eq("source_id", successor.sourceId)
    .eq("terminalized", false)
    .limit(50);

  if (error) throw new Error(`pending supersession lookup failed: ${error.message}`);

  const outcomes: SupersessionOutcome[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    // The successor's own row is excluded here rather than in the query: it is
    // one comparison, and every repository fake would otherwise have to grow a
    // `.neq` it has no other use for.
    if (String(row.session_key) === successor.sessionKey) continue;
    const candidate: SupersessionCandidate = {
      sessionKey: String(row.session_key),
      sessionGeneration: String(row.session_generation),
      sourceId: String(row.source_id),
      accumulatedText: String(row.accumulated_text ?? ""),
      createdAtMs: new Date(String(row.created_at)).getTime(),
      accountabilityRoundId: (row.accountability_round_id as string | null) ?? null,
    };
    if (!Number.isFinite(candidate.createdAtMs)) continue;

    let parsed: WeighSession;
    try {
      parsed = parseWeighSession(candidate.accumulatedText, bangkokBusinessDateNow());
    } catch {
      // An unparseable attempt cannot be related to anything. It stays active.
      continue;
    }

    if (!provesSupersession(attemptOf(candidate, parsed), parsed, successor)) continue;

    const { data: result, error: rpcError } = await supabase.rpc(
      "supersede_pending_generation",
      {
        p_session_key: candidate.sessionKey,
        p_session_generation: candidate.sessionGeneration,
        p_superseded_by: successor.produceSessionId,
        p_evidence: {
          superseded_by_session_key: successor.sessionKey,
          superseded_by_session_generation: successor.sessionGeneration,
          business_date: successor.parsed.date,
          item_count: parsed.items.length,
        },
      },
    );
    if (rpcError) throw new Error(`pending supersession failed: ${rpcError.message}`);

    const payload = (result ?? {}) as {
      superseded?: boolean;
      reason?: string;
      round_outcome?: string;
    };
    const outcome: SupersessionOutcome = {
      sessionKey: candidate.sessionKey,
      sessionGeneration: candidate.sessionGeneration,
      superseded: payload.superseded === true,
      reason: payload.reason ?? (payload.superseded ? "superseded" : "unknown"),
      roundOutcome: payload.round_outcome,
    };
    outcomes.push(outcome);
    if (outcome.superseded) {
      log.info("produce.pending.superseded", {
        supersededSessionKey: candidate.sessionKey,
        supersededSessionGeneration: candidate.sessionGeneration,
        supersededByProduceSessionId: successor.produceSessionId,
        businessDate: successor.parsed.date,
        roundOutcome: outcome.roundOutcome ?? null,
      });
    }
  }

  return outcomes;
}
