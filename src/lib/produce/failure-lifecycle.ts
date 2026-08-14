/**
 * Produce failure lifecycle — is an old failed attempt still a live problem?
 *
 * Production 2026-08 keeps every refused document forever, and every report
 * read that absence of success as an unresolved accountability issue. Two of
 * the four situations behind such a row are already closed business:
 *
 *   the seller re-sent a corrected document and it landed          (superseded)
 *   the round the attempt belonged to was retired by the successor (abandoned)
 *
 * The other two are real:
 *
 *   nothing ever replaced it                                    (active_failed)
 *   more than one document could be the replacement          (active + ambiguous)
 *
 * This module owns that decision and NOTHING else. It is pure: no database, no
 * clock, no writes. Everything it needs is passed in, so every rule below is
 * unit-testable without Production data.
 *
 * FAIL CLOSED is the whole design. A failure is only ever downgraded when a
 * specific successful document can be POINTED AT. Missing identity, missing
 * timestamps, an unprovable ordering or two candidate successors all leave the
 * failure exactly where it was: active, visible, blocking the day.
 */

import type { TransactionBucket } from "@/lib/summary/transactions";

/**
 * `active_failed` unresolved; must affect report readiness.
 * `superseded`    a later successful document carries the same operational
 *                 intent. Kept for audit, never alerted on.
 * `abandoned`     an authorized workflow retired it (a cancelled accountability
 *                 round). Kept for audit, never alerted on.
 */
export type ProduceFailureState = "active_failed" | "superseded" | "abandoned";

/** Where the failed attempt is recorded. Both are audit evidence, never deleted. */
export type ProduceFailureOrigin = "pending_session" | "raw_message";

/**
 * One refused/unfinalized produce document, reduced to the identity dimensions
 * supersession is allowed to reason about.
 *
 * Every field is nullable because Production really does contain rows missing
 * each of them — and a null is never treated as a wildcard match. It is treated
 * as "cannot prove", which keeps the attempt active.
 */
export interface ProduceFailureAttempt {
  attemptId: string;
  origin: ProduceFailureOrigin;
  /** The business date the document's OWN evidence names, not its insert time. */
  businessDate: string | null;
  /** LINE source (group) that owns the document. */
  sourceId: string | null;
  /** The seller the produce belongs to — not the person typing. */
  staffLabel: string | null;
  /** Market label as written. Compared normalized, never fuzzily. */
  marketLabel: string | null;
  /** เบิก / คืน / คืนเสีย. Null when the document declares more than one. */
  transactionKind: TransactionBucket | null;
  accountabilityRoundId: string | null;
  /** LINE event time of the attempt. Null makes ordering unprovable. */
  attemptedAtMs: number | null;
}

/** One produce document that actually landed — a candidate replacement. */
export interface FinalizedProduceOutcome {
  produceSessionId: string;
  businessDate: string | null;
  sourceId: string | null;
  staffLabel: string | null;
  marketLabel: string | null;
  transactionKind: TransactionBucket | null;
  accountabilityRoundId: string | null;
  /**
   * "main" | "additional". Only a MAIN session can replace a failed attempt:
   * an additional batch (เบิกเพิ่ม / ชั่งคืนเพิ่ม) is additive by contract, so
   * treating one as a replacement would silently drop the original intent.
   */
  sessionKind: string | null;
  finalizedAtMs: number | null;
}

export interface ProduceFailureClassification {
  attemptId: string;
  state: ProduceFailureState;
  /** The document that replaced it. Null unless `state` is "superseded". */
  supersededByProduceSessionId: string | null;
  /**
   * More than one finalized document matched this attempt's intent. The
   * attempt stays ACTIVE and this is surfaced as an integrity issue — picking
   * one of two successors is exactly the guess this layer must never make.
   */
  ambiguousSuccessor: boolean;
}

export interface ProduceFailureContext {
  /** Rounds an authorized workflow retired (accountability_rounds.status). */
  cancelledRoundIds?: ReadonlySet<string>;
}

/** Identity comparison boundary: NFC + trimmed + inner whitespace collapsed. */
function identityText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * True when `outcome` is a provable replacement for `attempt`.
 *
 * Two paths, and only two:
 *
 * ROUND PATH — the attempt names an accountability round. The round IS the
 * identity: seller, market and business date are all fixed by it, and a
 * withdrawal and its return provably share it. Same round + same transaction
 * kind + strictly later is proof.
 *
 * IDENTITY PATH — no round (a legacy or never-bound document). Then EVERY
 * dimension must match explicitly: source, business date, market, seller and
 * transaction kind, and any one of them being unknown disqualifies the match.
 * This is what stops a different market's or a different seller's success from
 * excusing this failure.
 *
 * Both paths require strict ordering: a document that landed BEFORE the failed
 * attempt cannot be its correction.
 */
function isSuccessorOf(
  attempt: ProduceFailureAttempt,
  outcome: FinalizedProduceOutcome,
): boolean {
  // Additive batches are never replacements — see FinalizedProduceOutcome.
  if (outcome.sessionKind !== null && outcome.sessionKind !== "main") return false;

  const kind = attempt.transactionKind;
  if (!kind || outcome.transactionKind !== kind) return false;

  if (attempt.attemptedAtMs === null || outcome.finalizedAtMs === null) return false;
  if (outcome.finalizedAtMs <= attempt.attemptedAtMs) return false;

  const attemptRound = identityText(attempt.accountabilityRoundId);
  if (attemptRound) {
    return identityText(outcome.accountabilityRoundId) === attemptRound;
  }

  const source = identityText(attempt.sourceId);
  const date = identityText(attempt.businessDate);
  const market = identityText(attempt.marketLabel);
  const staff = identityText(attempt.staffLabel);
  if (!source || !date || !market || !staff) return false;

  return (
    identityText(outcome.sourceId) === source
    && identityText(outcome.businessDate) === date
    && identityText(outcome.marketLabel) === market
    && identityText(outcome.staffLabel) === staff
  );
}

/** Classify one failed attempt against every finalized document of the day. */
export function classifyProduceFailure(
  attempt: ProduceFailureAttempt,
  outcomes: readonly FinalizedProduceOutcome[],
  context: ProduceFailureContext = {},
): ProduceFailureClassification {
  const round = identityText(attempt.accountabilityRoundId);
  if (round && context.cancelledRoundIds?.has(round)) {
    // A retired round is a decision an authorized workflow already made (see
    // migration 20260811090000: the successor terminalizes its predecessor).
    return {
      attemptId: attempt.attemptId,
      state: "abandoned",
      supersededByProduceSessionId: null,
      ambiguousSuccessor: false,
    };
  }

  const successors = outcomes.filter((outcome) => isSuccessorOf(attempt, outcome));
  if (successors.length === 1) {
    return {
      attemptId: attempt.attemptId,
      state: "superseded",
      supersededByProduceSessionId: successors[0].produceSessionId,
      ambiguousSuccessor: false,
    };
  }

  return {
    attemptId: attempt.attemptId,
    state: "active_failed",
    supersededByProduceSessionId: null,
    ambiguousSuccessor: successors.length > 1,
  };
}

export function classifyProduceFailures(
  attempts: readonly ProduceFailureAttempt[],
  outcomes: readonly FinalizedProduceOutcome[],
  context: ProduceFailureContext = {},
): ProduceFailureClassification[] {
  return attempts.map((attempt) => classifyProduceFailure(attempt, outcomes, context));
}

/** The attempt ids that still count as unresolved. */
export function activeFailureIds(
  classifications: readonly ProduceFailureClassification[],
): Set<string> {
  return new Set(
    classifications.filter((row) => row.state === "active_failed").map((row) => row.attemptId),
  );
}
