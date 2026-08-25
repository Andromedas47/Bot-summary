/**
 * LINE Admin Group digest — TYPED BOUNDARY ONLY. Nothing in this file sends a
 * LINE message, imports src/lib/line/reply.ts, or holds a target group id.
 *
 * The eventual shape (once an admin group is actually wired up):
 *   🚨 CRITICAL        → send immediately, one push per new/reopened issue.
 *   ⚠️ ACTION_REQUIRED → batch into a once-daily digest.
 *   ℹ️ ADVISORY        → inbox-only; never pushed to LINE at all.
 *
 * `planAdminDigest` below is the pure grouping decision — it takes issues in,
 * buckets them, and returns data. There is deliberately no `sendAdminDigest`
 * function anywhere in this module: wiring an actual sender is a future,
 * separate change (and must reuse whatever config pattern already holds a
 * target group id, rather than hardcoding one — see src/lib/line/reply.ts's
 * callers for that pattern once this is picked up).
 */

import type { DataQualitySeverity } from "./severity";
import type { DataQualityIssueRow } from "./types";

export type AdminDigestLane = "immediate" | "daily_digest" | "inbox_only";

const LANE_BY_SEVERITY: Record<Exclude<DataQualitySeverity, "NORMAL">, AdminDigestLane> = {
  CRITICAL:        "immediate",
  ACTION_REQUIRED: "daily_digest",
  ADVISORY:        "inbox_only",
};

export interface AdminDigestPlan {
  immediate: DataQualityIssueRow[];
  dailyDigest: DataQualityIssueRow[];
  inboxOnly: DataQualityIssueRow[];
}

/**
 * Pure grouping only — synchronous, no I/O, no network call. Only OPEN issues
 * are ever routed anywhere; RESOLVED/IGNORED issues are inbox history, not
 * something worth interrupting anyone about.
 */
export function planAdminDigest(issues: readonly DataQualityIssueRow[]): AdminDigestPlan {
  const plan: AdminDigestPlan = { immediate: [], dailyDigest: [], inboxOnly: [] };
  for (const issue of issues) {
    if (issue.status !== "OPEN") continue;
    const lane = LANE_BY_SEVERITY[issue.severity];
    if (lane === "immediate") plan.immediate.push(issue);
    else if (lane === "daily_digest") plan.dailyDigest.push(issue);
    else plan.inboxOnly.push(issue);
  }
  return plan;
}
