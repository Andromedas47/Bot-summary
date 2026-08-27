/**
 * Produce anomaly source — adapts the EXISTING Daily Close Preflight
 * (src/lib/produce/daily-close-preflight.ts, src/lib/produce/preflight-service.ts)
 * into Data Quality Inbox candidates. Detection logic is never reimplemented
 * here: this file only reads `DailyClosePreflightResult`, already computed by
 * the same loaders the 08:00/08:10 reports and the LINE `ตรวจความพร้อม`
 * command use, and relabels each finding with an inbox category + severity.
 *
 * Two things are deliberately excluded, both to avoid a second identity for
 * data the preflight already reports elsewhere:
 *   - `unresolved_central_price` issues attached to individual rounds/
 *     integrity — price conflicts are ingested ONCE per product+unit from
 *     `result.pricingConflicts`, not once per round that happens to sell it.
 *   - `result.supersededFailures` — the preflight module's own docs call
 *     these "recorded for audit only"; a failure a later success already
 *     replaced is not an open data-quality problem.
 */

import type {
  DailyClosePreflightResult,
  PreflightIssue,
  PreflightIssueCode,
  PreflightSeverity,
} from "@/lib/produce/daily-close-preflight";
import type { CentralPriceReviewItem } from "@/lib/produce/central-price-candidates";
import type { DataQualityCategory } from "../severity";
import type { DataQualityIssueCandidate } from "../types";

/** Total mapping from (preflight code, preflight severity) to an inbox category. */
function categoryFor(code: PreflightIssueCode, sourceSeverity: PreflightSeverity): DataQualityCategory | null {
  switch (code) {
    case "missing_successful_return":
      return "produce_no_return";
    case "active_failed_produce_session":
    case "pending_produce_session":
      return "produce_stale_failed_session";
    case "unresolved_central_price":
      // Ingested once per product from result.pricingConflicts instead.
      return null;
    case "duplicate_open_accountability_round":
      return sourceSeverity === "blocker"
        ? "produce_duplicate_round_ambiguous"
        : "produce_duplicate_round_review";
    case "unbound_produce_transaction":
      return "produce_unattributable";
    case "exact_duplicate_withdrawal":
      return "produce_duplicate_persistence";
    case "possible_composite_duplicate":
      return "produce_possible_duplicate";
    case "round_identity_ambiguity":
      return "produce_lifecycle_ambiguity";
    case "superseded_failed_session":
    case "abandoned_failed_session":
      // Audit-only per daily-close-preflight.ts; never a data-quality issue.
      return null;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function candidateFromIssue(
  issue: PreflightIssue,
  businessDate: string,
): DataQualityIssueCandidate | null {
  const category = categoryFor(issue.code, issue.severity);
  if (!category) return null;

  const entityRefs = issue.evidenceIds && issue.evidenceIds.length > 0
    ? issue.evidenceIds
    : [issue.accountabilityRoundId, issue.marketName, issue.staffName].filter(
        (v): v is string => !!v,
      );

  return {
    category,
    businessDate,
    entityRefs,
    summaryTh: issue.message,
    technicalContext: {
      preflightCode: issue.code,
      preflightSeverity: issue.severity,
      accountabilityRoundId: issue.accountabilityRoundId ?? null,
      staffName: issue.staffName ?? null,
      marketName: issue.marketName ?? null,
      sourceId: issue.sourceId ?? null,
      sourceMarketScope: issue.sourceMarketScope ?? null,
    },
  };
}

function candidateFromPriceConflict(
  item: CentralPriceReviewItem,
  businessDate: string,
): DataQualityIssueCandidate {
  return {
    category: "produce_price_conflict",
    businessDate,
    entityRefs: [`${item.productKey}::${item.unitKey}`],
    summaryTh:
      `${item.productDisplayName} — พบราคาที่ยังไม่ยืนยัน `
      + item.candidates.map((c) => `${c.priceSatang / 100} บาท (${c.occurrenceCount} รายการ)`).join(" / "),
    technicalContext: {
      productKey: item.productKey,
      unitKey: item.unitKey,
      candidates: item.candidates,
    },
  };
}

/**
 * Every produce-side candidate for one business date. Pure: takes the
 * already-computed preflight result, produces nothing but data.
 */
export function preflightIssuesToCandidates(
  result: DailyClosePreflightResult,
  businessDate: string = result.businessDate,
): DataQualityIssueCandidate[] {
  const out: DataQualityIssueCandidate[] = [];

  for (const round of result.rounds) {
    for (const issue of [...round.blockers, ...round.warnings]) {
      const candidate = candidateFromIssue(issue, businessDate);
      if (candidate) out.push(candidate);
    }
  }

  for (const issue of result.integrityIssues) {
    const candidate = candidateFromIssue(issue, businessDate);
    if (candidate) out.push(candidate);
  }

  for (const item of result.pricingConflicts) {
    out.push(candidateFromPriceConflict(item, businessDate));
  }

  return out;
}
