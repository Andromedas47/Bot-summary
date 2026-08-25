import type { DataQualityCategory, PersistedDataQualitySeverity } from "./severity";

export type DataQualityIssueStatus = "OPEN" | "RESOLVED" | "IGNORED";

/**
 * What a scan SOURCE produces. Not yet a row — severity, the dedup key and
 * every status field are derived from this by inbox.ts, never set here.
 */
export interface DataQualityIssueCandidate {
  category: DataQualityCategory;
  /** Business date (YYYY-MM-DD), the same calendar the rest of the app uses. */
  businessDate: string;
  /** Stable entity identifiers that make this occurrence unique (round ids,
   *  session ids, product+unit keys, ...). Order does not matter — the key
   *  builder sorts and dedupes them. */
  entityRefs: string[];
  /** Operator-safe Thai summary, shown on the admin list without drilling in. */
  summaryTh: string;
  /** Machine detail for the admin detail view. MUST NEVER contain secrets,
   *  tokens, or raw credentials — sources must pass only display-safe facts
   *  (ids, counts, amounts, labels), never headers, keys or payloads. */
  technicalContext?: Record<string, unknown>;
}

/** A persisted row. Mirrors the data_quality_issues table exactly. */
export interface DataQualityIssueRow {
  id: string;
  issue_key: string;
  category: DataQualityCategory;
  severity: PersistedDataQualitySeverity;
  business_date: string;
  affected_refs: string[];
  summary_th: string;
  technical_context: Record<string, unknown>;
  status: DataQualityIssueStatus;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface DataQualityActor {
  id: string;
  email: string | null;
}
