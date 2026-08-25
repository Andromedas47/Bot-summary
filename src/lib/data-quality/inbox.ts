/**
 * Data Quality Inbox — stable identity, lifecycle, and the one upsert path.
 *
 * Every decision here is a PURE function (buildIssueKey / planUpsert /
 * planResolve / planIgnore) so the dedup, reopen, resolve and ignore rules are
 * unit-testable without a database — the same shape as
 * src/lib/produce/daily-close-preflight.ts elsewhere in this repo. The async
 * functions at the bottom are thin: read the current row (if any), hand it to
 * the pure planner, write back exactly what the plan says.
 *
 * LIFECYCLE
 *   OPEN      the default. A recurring scan just refreshes last_seen/details.
 *   RESOLVED  a human fixed the underlying condition. If the SAME issue_key
 *             is produced by a later scan, that means whatever fixed it did
 *             not hold — REOPEN to OPEN, clearing resolution metadata but
 *             keeping the original first_seen (this is not a new problem).
 *   IGNORED   suppressed but NOT silenced: last_seen keeps moving on every
 *             recurring scan so an operator filtering by IGNORED can still
 *             see it is an ongoing condition, but status does not flip back
 *             to OPEN by itself — un-ignoring is a human decision, not
 *             something a nightly scan should reverse silently. (ponytail:
 *             there is no explicit "un-ignore" action yet; today the only way
 *             back to OPEN is Resolve → recur → reopen. Upgrade path: add a
 *             dedicated un-ignore admin action if IGNORED-forever proves too
 *             blunt in practice.)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { severityForCategory } from "./severity";
import type { DataQualityActor, DataQualityIssueCandidate, DataQualityIssueRow } from "./types";

type Supabase = SupabaseClient<Database>;

/**
 * The stable dedup identity: (category, business date, affected entities).
 * Sorted + deduped so ref order/repeats never change the key. This is the
 * ONLY thing the nightly scan upserts on — never a fresh row per run.
 */
export function buildIssueKey(
  category: string,
  businessDate: string,
  entityRefs: readonly string[],
): string {
  const refs = [...new Set(entityRefs.map((r) => r.trim()).filter((r) => r.length > 0))].sort();
  return `${category}::${businessDate}::${refs.join("|")}`;
}

function normalizedRefs(entityRefs: readonly string[]): string[] {
  return [...new Set(entityRefs.map((r) => r.trim()).filter((r) => r.length > 0))].sort();
}

export type UpsertPlan =
  /** The category maps to NORMAL — no user-facing notification, nothing written. */
  | { op: "skip_normal_severity"; issueKey: string }
  | { op: "insert"; issueKey: string; row: Omit<DataQualityIssueRow, "id"> }
  | { op: "update_open"; issueKey: string; patch: Partial<DataQualityIssueRow> }
  | { op: "reopen"; issueKey: string; patch: Partial<DataQualityIssueRow> }
  | { op: "touch_ignored"; issueKey: string; patch: Partial<DataQualityIssueRow> };

/** Pure: given the current row (or null) and a fresh candidate, decide what to write. */
export function planUpsert(
  existing: DataQualityIssueRow | null,
  candidate: DataQualityIssueCandidate,
  nowIso: string,
): UpsertPlan {
  const issueKey = buildIssueKey(candidate.category, candidate.businessDate, candidate.entityRefs);
  const severity = severityForCategory(candidate.category);

  if (severity === "NORMAL") {
    return { op: "skip_normal_severity", issueKey };
  }

  const refreshed = {
    severity,
    business_date: candidate.businessDate,
    affected_refs: normalizedRefs(candidate.entityRefs),
    summary_th: candidate.summaryTh,
    technical_context: candidate.technicalContext ?? {},
    last_seen: nowIso,
  };

  if (!existing) {
    return {
      op: "insert",
      issueKey,
      row: {
        issue_key: issueKey,
        category: candidate.category,
        first_seen: nowIso,
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
        created_at: nowIso,
        status: "OPEN",
        ...refreshed,
      },
    };
  }

  if (existing.status === "OPEN") {
    return { op: "update_open", issueKey, patch: refreshed };
  }

  if (existing.status === "RESOLVED") {
    return {
      op: "reopen",
      issueKey,
      patch: {
        ...refreshed,
        status: "OPEN",
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
      },
    };
  }

  // IGNORED — suppressed but still tracked (see module doc).
  return { op: "touch_ignored", issueKey, patch: { last_seen: nowIso } };
}

export interface ResolutionPatch {
  status: "RESOLVED" | "IGNORED";
  resolved_at: string;
  resolved_by: string;
  resolution_note: string;
}

/** Pure: an operator marks an issue resolved. Allowed from OPEN or IGNORED. */
export function planResolve(actor: DataQualityActor, note: string, nowIso: string): ResolutionPatch {
  return {
    status: "RESOLVED",
    resolved_at: nowIso,
    resolved_by: actor.email ?? actor.id,
    resolution_note: note.trim(),
  };
}

/** Pure: an operator suppresses an issue without calling it fixed. */
export function planIgnore(actor: DataQualityActor, note: string, nowIso: string): ResolutionPatch {
  return {
    status: "IGNORED",
    resolved_at: nowIso,
    resolved_by: actor.email ?? actor.id,
    resolution_note: note.trim(),
  };
}

// ── Thin DB wrappers — read current state, call the pure planner, write it ──

export function toIssueRow(raw: Database["public"]["Tables"]["data_quality_issues"]["Row"]): DataQualityIssueRow {
  return {
    id: raw.id,
    issue_key: raw.issue_key,
    category: raw.category as DataQualityIssueRow["category"],
    severity: raw.severity,
    business_date: raw.business_date,
    affected_refs: Array.isArray(raw.affected_refs) ? (raw.affected_refs as string[]) : [],
    summary_th: raw.summary_th,
    technical_context:
      raw.technical_context && typeof raw.technical_context === "object" && !Array.isArray(raw.technical_context)
        ? (raw.technical_context as Record<string, unknown>)
        : {},
    status: raw.status,
    first_seen: raw.first_seen,
    last_seen: raw.last_seen,
    resolved_at: raw.resolved_at,
    resolved_by: raw.resolved_by,
    resolution_note: raw.resolution_note,
    created_at: raw.created_at,
  };
}

export async function fetchIssueByKey(supabase: Supabase, issueKey: string): Promise<DataQualityIssueRow | null> {
  const { data, error } = await supabase
    .from("data_quality_issues")
    .select("*")
    .eq("issue_key", issueKey)
    .maybeSingle();
  if (error) throw new Error(`data_quality_issues lookup failed: ${error.message}`);
  return data ? toIssueRow(data) : null;
}

export interface UpsertResult {
  plan: UpsertPlan;
  row: DataQualityIssueRow | null;
}

/** Upsert one candidate. Idempotent: calling this twice for the same
 *  candidate on the same day produces exactly one row (see inbox.test.ts). */
export async function upsertDataQualityIssue(
  supabase: Supabase,
  candidate: DataQualityIssueCandidate,
  nowIso: string = new Date().toISOString(),
): Promise<UpsertResult> {
  const issueKey = buildIssueKey(candidate.category, candidate.businessDate, candidate.entityRefs);
  const current = await fetchIssueByKey(supabase, issueKey);
  const plan = planUpsert(current, candidate, nowIso);

  if (plan.op === "skip_normal_severity") {
    return { plan, row: null };
  }

  if (plan.op === "insert") {
    const { data, error } = await supabase
      .from("data_quality_issues")
      .insert(plan.row as Database["public"]["Tables"]["data_quality_issues"]["Insert"])
      .select("*")
      .single();
    if (error) throw new Error(`data_quality_issues insert failed: ${error.message}`);
    return { plan, row: toIssueRow(data) };
  }

  const { data, error } = await supabase
    .from("data_quality_issues")
    .update(plan.patch as Database["public"]["Tables"]["data_quality_issues"]["Update"])
    .eq("issue_key", issueKey)
    .select("*")
    .single();
  if (error) throw new Error(`data_quality_issues update failed: ${error.message}`);
  return { plan, row: toIssueRow(data) };
}

async function applyPatch(
  supabase: Supabase,
  issueKey: string,
  patch: ResolutionPatch,
): Promise<DataQualityIssueRow> {
  const { data, error } = await supabase
    .from("data_quality_issues")
    .update(patch)
    .eq("issue_key", issueKey)
    .select("*")
    .single();
  if (error) throw new Error(`data_quality_issues status update failed: ${error.message}`);
  return toIssueRow(data);
}

export async function resolveDataQualityIssue(
  supabase: Supabase,
  issueKey: string,
  actor: DataQualityActor,
  note: string,
  nowIso: string = new Date().toISOString(),
): Promise<DataQualityIssueRow> {
  return applyPatch(supabase, issueKey, planResolve(actor, note, nowIso));
}

export async function ignoreDataQualityIssue(
  supabase: Supabase,
  issueKey: string,
  actor: DataQualityActor,
  note: string,
  nowIso: string = new Date().toISOString(),
): Promise<DataQualityIssueRow> {
  return applyPatch(supabase, issueKey, planIgnore(actor, note, nowIso));
}
