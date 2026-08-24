/**
 * Scope an unresolved เบิก so Purchase Planning poisons only what that
 * document can actually move.
 *
 * Pure. The failure scan has already decided which attempts are still active
 * and which business date they belong to; this module never re-dates, never
 * infers a seller/market/round from "the same sender recently", and never
 * treats a null identity as a wildcard.
 *
 * Narrowest provable scope, in order:
 *
 *   1. canonical product + unit from the document text
 *   2. canonical product only, when a named item has no reliable unit
 *   3. the accountability round the attempt itself already carries
 *   4. the whole report, when this is a real เบิก and nothing above exists
 */

import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  activeFailureIds,
  type ProduceFailureAttempt,
  type ProduceFailureClassification,
} from "@/lib/produce/failure-lifecycle";
import { normalizeProductName, PRODUCT_ALIASES } from "@/lib/summary/remaining-fruit";
import {
  canonicalIdentity,
  type UnattributableWithdrawalScope,
} from "@/lib/summary/purchase-planning";

export type { UnattributableWithdrawalScope };

function roundIdOf(attempt: ProduceFailureAttempt): string | null {
  const round = attempt.accountabilityRoundId?.trim();
  return round ? round : null;
}

function scopesFromText(text: string): UnattributableWithdrawalScope[] {
  const parsed = parseWeighSession(text);
  const scopes: UnattributableWithdrawalScope[] = [];
  const seen = new Set<string>();

  const add = (scope: UnattributableWithdrawalScope): void => {
    const key = JSON.stringify(scope);
    if (seen.has(key)) return;
    seen.add(key);
    scopes.push(scope);
  };

  for (const item of parsed.items) {
    const identity = canonicalIdentity(item.product_name, item.unit);
    if (identity) {
      add({
        kind: "product_unit",
        productName: identity.productName,
        unit: identity.unit,
      });
      continue;
    }
    const rawName = (item.product_name ?? "").trim();
    if (!rawName) continue;
    const productName = normalizeProductName(rawName, PRODUCT_ALIASES);
    if (productName) add({ kind: "product", productName });
  }

  return scopes;
}

/**
 * Active, still-unresolved เบิก attempts reduced to the uncertainty they
 * are allowed to impose on Purchase Planning.
 *
 * Non-เบิก attempts are ignored here: an unattributed คืน / คืนเสีย already
 * has its own conservative path (hasUnattributedIncompleteReturns). A
 * superseded or abandoned attempt is not active, so it cannot double-poison
 * a persisted equivalent.
 */
export function collectUnattributableWithdrawalScopes(
  attempts: readonly ProduceFailureAttempt[],
  classifications: readonly ProduceFailureClassification[],
): UnattributableWithdrawalScope[] {
  const active = activeFailureIds(classifications);
  const scopes: UnattributableWithdrawalScope[] = [];
  const seen = new Set<string>();

  const add = (scope: UnattributableWithdrawalScope): void => {
    const key = JSON.stringify(scope);
    if (seen.has(key)) return;
    seen.add(key);
    scopes.push(scope);
  };

  for (const attempt of attempts) {
    if (!active.has(attempt.attemptId)) continue;
    if (attempt.transactionKind !== "เบิก") continue;

    const fromText = attempt.sourceText?.trim()
      ? scopesFromText(attempt.sourceText)
      : [];
    if (fromText.length > 0) {
      for (const scope of fromText) add(scope);
      continue;
    }

    const roundId = roundIdOf(attempt);
    if (roundId) {
      add({ kind: "round", roundId });
      continue;
    }

    add({ kind: "report" });
  }

  return scopes;
}
