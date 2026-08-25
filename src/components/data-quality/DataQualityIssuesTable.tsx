"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CATEGORY_LABEL_TH, STATUS_LABEL_TH } from "@/lib/data-quality/labels";
import { SEVERITY_ICON } from "@/lib/data-quality/severity";
import type { DataQualityIssueRow } from "@/lib/data-quality/types";
import { postIgnoreDataQualityIssue, postResolveDataQualityIssue } from "./data-quality-client";

const TH =
  "px-4 py-2.5 text-left text-[0.6875rem] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap";

const SEVERITY_VARIANT: Record<string, "error" | "warning" | "info" | "default"> = {
  CRITICAL: "error",
  ACTION_REQUIRED: "warning",
  ADVISORY: "info",
};

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function DataQualityIssuesTable({ issues }: { issues: DataQualityIssueRow[] }) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (issues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <p className="text-sm font-semibold text-slate-600">ไม่พบรายการ</p>
        <p className="text-xs mt-1 text-slate-400">ไม่มีรายการที่ตรงกับตัวกรองนี้</p>
      </div>
    );
  }

  // ponytail: a native prompt() stands in for a proper reason modal (the
  // pattern void-session/SessionsTable.tsx uses). Fine for a first cut of an
  // internal admin tool; upgrade to a real modal if this needs to feel less
  // rough for daily use.
  async function handleAction(issue: DataQualityIssueRow, action: "resolve" | "ignore") {
    const note = window.prompt(
      action === "resolve" ? "เหตุผลที่แก้ไขแล้ว:" : "เหตุผลที่เพิกเฉย:",
      "",
    );
    if (note === null) return;
    setPendingKey(issue.issue_key);
    setError("");
    try {
      const result = action === "resolve"
        ? await postResolveDataQualityIssue({ issueKey: issue.issue_key, note })
        : await postIgnoreDataQualityIssue({ issueKey: issue.issue_key, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm font-medium text-red-600" role="alert" data-testid="data-quality-error">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-y border-slate-200">
              <th className={TH}>ความรุนแรง</th>
              <th className={TH}>หมวด</th>
              <th className={`${TH} hidden sm:table-cell`}>วันที่</th>
              <th className={TH}>รายละเอียด</th>
              <th className={`${TH} hidden md:table-cell`}>พบล่าสุด</th>
              <th className={TH}>สถานะ</th>
              <th className={TH}>จัดการ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {issues.map((issue) => (
              <tr key={issue.id} className="hover:bg-[#06C755]/5 transition-colors" data-testid={`issue-row-${issue.id}`}>
                <td className="px-4 py-3 text-sm whitespace-nowrap">
                  <Badge variant={SEVERITY_VARIANT[issue.severity] ?? "default"} dot>
                    {SEVERITY_ICON[issue.severity]} {issue.severity}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-sm whitespace-nowrap">
                  {CATEGORY_LABEL_TH[issue.category] ?? issue.category}
                </td>
                <td className="px-4 py-3 hidden sm:table-cell whitespace-nowrap text-sm">
                  {issue.business_date}
                </td>
                <td className="px-4 py-3 text-sm">
                  <span className="text-slate-600 truncate max-w-sm block" title={issue.summary_th}>
                    {issue.summary_th}
                  </span>
                </td>
                <td className="px-4 py-3 hidden md:table-cell whitespace-nowrap text-sm text-slate-500">
                  {formatDate(issue.last_seen)}
                </td>
                <td className="px-4 py-3 text-sm whitespace-nowrap">
                  <Badge variant={issue.status === "OPEN" ? "warning" : "default"} dot>
                    {STATUS_LABEL_TH[issue.status]}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-sm whitespace-nowrap">
                  {issue.status === "OPEN" ? (
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        variant="secondary"
                        className="!h-8 !px-2.5 !text-xs"
                        disabled={pendingKey === issue.issue_key}
                        onClick={() => handleAction(issue, "resolve")}
                        data-testid={`resolve-button-${issue.id}`}
                      >
                        แก้ไขแล้ว
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="!h-8 !px-2.5 !text-xs"
                        disabled={pendingKey === issue.issue_key}
                        onClick={() => handleAction(issue, "ignore")}
                        data-testid={`ignore-button-${issue.id}`}
                      >
                        เพิกเฉย
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">
                      {issue.resolved_by ? `โดย ${issue.resolved_by}` : "—"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
