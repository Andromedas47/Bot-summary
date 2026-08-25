/**
 * 🌅 สรุปประจำวัน — the Executive Morning Brief.
 *
 * Pure composition only. Every number here is read from an already-computed
 * report, never derived here:
 *   - Purchase Planning counts are a tally of PurchasePlanningReport.items[]
 *     .status, the SAME classification buildPurchasePlanningBlocks renders
 *     (src/lib/summary/purchase-planning-message.ts) — this module never
 *     re-derives a sell-through band or threshold; see purchase-planning.ts
 *     for the one place that classification lives.
 *   - Financial figures come verbatim from DailyFinancialSettlementResult
 *     (Task 4 — src/lib/settlement/daily-financial-settlement.ts). This
 *     module never computes expected cash, actual cash, or a difference; see
 *     that file's computeDailyFinancialSettlement for the one place the
 *     formula lives.
 *   - Actionable issue counts come from a pluggable ActionableIssueCountSource
 *     (below) so this module never couples to a specific issue-tracking
 *     implementation. A separate branch (feat/data-quality-inbox) is building
 *     a real Data Quality Inbox; it is not available here, so every caller
 *     defaults to NULL_ACTIONABLE_ISSUE_SOURCE until one is wired in.
 *
 * The brief answers exactly three questions and nothing else:
 *   1. What should we do today?      → 📦 แผนซื้อ counts
 *   2. Did yesterday's money close?  → 💰 ผลประกอบการ
 *   3. Is anything urgent?           → ⚠️ ต้องตรวจ
 *
 * ponytail: no per-product or per-issue detail ever appears here — that is
 * what the existing on-demand reports (สรุปสินค้าขายดี, สรุปยอดขาย,
 * สรุปคงเหลือ, the full settlement message, and eventually the Data Quality
 * Inbox) are for. If a future request wants one more headline number, add it
 * to MorningBriefReport and the formatter; do not start printing rows here —
 * that is the ceiling this module is built to. Upgrade path: a richer brief
 * is a new field + one more rendered line, never a second report shape.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { PurchasePlanningReport, PurchaseStatus } from "@/lib/summary/purchase-planning";
import type { DailyFinancialSettlementResult } from "@/lib/settlement/daily-financial-settlement";

type Supabase = SupabaseClient<Database>;

/** Tally of today's Purchase Planning classification — see PurchaseStatus. */
export type PurchasePlanningCounts = Record<PurchaseStatus, number>;

/**
 * Pure tally, not a re-classification. Every item already carries its
 * `status` from buildPurchasePlanningReport (purchase-planning.ts); this
 * function only counts how many of each there are.
 */
export function summarizePurchasePlanningCounts(
  report: Pick<PurchasePlanningReport, "items">,
): PurchasePlanningCounts {
  const counts: PurchasePlanningCounts = { strong: 0, surplus: 0, reduce: 0, unknown: 0 };
  for (const item of report.items) {
    counts[item.status] += 1;
  }
  return counts;
}

/** One (source, market) financial settlement, verbatim from Task 4's contract. */
export interface MorningBriefFinancialEntry {
  marketLabelNormalized: string;
  result: DailyFinancialSettlementResult;
}

/**
 * Minimal port for 🚨 CRITICAL / ⚠️ ACTION_REQUIRED issue counts only. ℹ️
 * advisory-level detail never belongs in the brief, so this interface
 * deliberately has no field that could carry it.
 *
 * feat/data-quality-inbox (a parallel branch, not available here) is expected
 * to grow a real implementation. Until one is wired in via
 * LoadMorningBriefOptions.issueSource, every caller gets
 * NULL_ACTIONABLE_ISSUE_SOURCE, which reports zero of both — the brief
 * degrades to "nothing flagged" rather than failing, guessing, or coupling
 * tightly to a branch this one cannot see.
 */
export interface ActionableIssueCounts {
  critical: number;
  actionRequired: number;
}

export interface ActionableIssueCountSource {
  load(supabase: Supabase, businessDate: string): Promise<ActionableIssueCounts>;
}

/** Safe default when no issue source has been wired in yet. */
export const NULL_ACTIONABLE_ISSUE_SOURCE: ActionableIssueCountSource = {
  async load(): Promise<ActionableIssueCounts> {
    return { critical: 0, actionRequired: 0 };
  },
};

export interface MorningBriefReport {
  businessDate: string;
  purchaseCounts: PurchasePlanningCounts;
  /**
   * Zero (no market had produce activity that date — a genuinely empty day),
   * one (the common Local MVP case, one market per source), or many — one
   * 💰 block per entry.
   */
  financial: MorningBriefFinancialEntry[];
  issues: ActionableIssueCounts;
}
