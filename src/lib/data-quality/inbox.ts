/**
 * Data Quality Inbox — stable identity, lifecycle, and the one upsert path.
 *
 * Stable identity and operator status patches are pure functions. The scan
 * lifecycle itself lives in one PostgreSQL function and is exercised against
 * PostgreSQL, avoiding a read/write planner that could race or drift from the
 * database behavior. The async functions below are thin database boundaries.
 * Recurring scans use one PostgreSQL RPC so the whole candidate set commits or
 * rolls back as one transaction and first-insert races converge through
 * issue_key's UNIQUE constraint.
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
import type { Database, Json } from "@/types/database";
import { severityForCategory, type PersistedDataQualitySeverity } from "./severity";
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

interface AtomicUpsertPayload {
  issue_key: string;
  category: string;
  severity: PersistedDataQualitySeverity;
  business_date: string;
  affected_refs: string[];
  summary_th: string;
  technical_context: Record<string, unknown>;
}

/** Pure payload preparation. Duplicate candidate identities collapse before
 * the RPC because PostgreSQL intentionally rejects affecting one conflict row
 * twice in a single INSERT statement. */
export function prepareAtomicUpsertPayload(
  candidates: readonly DataQualityIssueCandidate[],
): AtomicUpsertPayload[] {
  const byIssueKey = new Map<string, AtomicUpsertPayload>();

  for (const candidate of candidates) {
    const severity = severityForCategory(candidate.category);
    if (severity === "NORMAL") continue;

    const issueKey = buildIssueKey(candidate.category, candidate.businessDate, candidate.entityRefs);
    byIssueKey.set(issueKey, {
      issue_key: issueKey,
      category: candidate.category,
      severity,
      business_date: candidate.businessDate,
      affected_refs: normalizedRefs(candidate.entityRefs),
      summary_th: candidate.summaryTh,
      technical_context: candidate.technicalContext ?? {},
    });
  }

  return [...byIssueKey.values()];
}

/** Persist one complete scan atomically. The SQL function uses INSERT ... ON
 * CONFLICT for race-safe dedup and applies the reviewed lifecycle under the
 * row lock: RESOLVED reopens; IGNORED only advances last_seen. */
export async function upsertDataQualityIssuesAtomically(
  supabase: Supabase,
  candidates: readonly DataQualityIssueCandidate[],
  nowIso: string = new Date().toISOString(),
): Promise<DataQualityIssueRow[]> {
  const payload = prepareAtomicUpsertPayload(candidates);
  if (payload.length === 0) return [];

  const { data, error } = await supabase.rpc("upsert_data_quality_issues", {
    p_candidates: payload as unknown as Json,
    p_seen_at: nowIso,
  });
  if (error) throw new Error(`data_quality_issues atomic upsert failed: ${error.message}`);
  if (!Array.isArray(data)) throw new Error("data_quality_issues atomic upsert returned invalid data");

  return data.map((row) => toIssueRow(
    row as Database["public"]["Tables"]["data_quality_issues"]["Row"],
  ));
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
