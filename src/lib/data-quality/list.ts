/**
 * Data Quality Inbox — the read side for the admin list page. Thin: filters,
 * pages, and reshapes rows. All identity/lifecycle decisions live in inbox.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { toIssueRow } from "./inbox";
import type { PersistedDataQualitySeverity } from "./severity";
import type { DataQualityIssueRow, DataQualityIssueStatus } from "./types";

type Supabase = SupabaseClient<Database>;

export interface ListDataQualityIssuesFilters {
  status?: DataQualityIssueStatus;
  severity?: PersistedDataQualitySeverity;
  businessDate?: string;
  page: number;
  pageSize: number;
}

export interface ListDataQualityIssuesResult {
  issues: DataQualityIssueRow[];
  total: number;
  totalPages: number;
}

export async function listDataQualityIssues(
  supabase: Supabase,
  filters: ListDataQualityIssuesFilters,
): Promise<ListDataQualityIssuesResult> {
  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("data_quality_issues")
    .select("*", { count: "exact" })
    .order("last_seen", { ascending: false })
    .range(from, to);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (filters.businessDate) query = query.eq("business_date", filters.businessDate);

  const { data, count, error } = await query;
  if (error) throw new Error(`data_quality_issues list failed: ${error.message}`);

  const rows = (data ?? []) as Database["public"]["Tables"]["data_quality_issues"]["Row"][];
  const issues: DataQualityIssueRow[] = rows.map(toIssueRow);

  return {
    issues,
    total: count ?? 0,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / filters.pageSize)),
  };
}
