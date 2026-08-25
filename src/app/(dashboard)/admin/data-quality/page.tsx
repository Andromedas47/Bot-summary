import { Suspense } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { StatCard } from "@/components/dashboard/StatCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Pagination } from "@/components/ui/Pagination";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { DateInput } from "@/components/ui/DateInput";
import { DataQualityIssuesTable } from "@/components/data-quality/DataQualityIssuesTable";
import { listDataQualityIssues } from "@/lib/data-quality/list";
import type { DataQualityIssueStatus } from "@/lib/data-quality/types";
import type { PersistedDataQualitySeverity } from "@/lib/data-quality/severity";

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: "OPEN",     label: "เปิดอยู่" },
  { value: "RESOLVED", label: "แก้ไขแล้ว" },
  { value: "IGNORED",  label: "เพิกเฉย" },
];

const SEVERITY_OPTIONS = [
  { value: "CRITICAL",        label: "🚨 วิกฤต" },
  { value: "ACTION_REQUIRED", label: "⚠️ ต้องตรวจสอบ" },
  { value: "ADVISORY",        label: "ℹ️ แจ้งเพื่อทราบ" },
];

const VALID_STATUSES = new Set(STATUS_OPTIONS.map((o) => o.value));
const VALID_SEVERITIES = new Set(SEVERITY_OPTIONS.map((o) => o.value));

interface PageProps {
  searchParams: Promise<{ page?: string; status?: string; severity?: string; date?: string }>;
}

async function getStats(supabase: Awaited<ReturnType<typeof createServiceClient>>) {
  const [openRes, criticalRes, actionRequiredRes] = await Promise.all([
    supabase.from("data_quality_issues").select("id", { count: "exact", head: true }).eq("status", "OPEN"),
    supabase
      .from("data_quality_issues")
      .select("id", { count: "exact", head: true })
      .eq("status", "OPEN")
      .eq("severity", "CRITICAL"),
    supabase
      .from("data_quality_issues")
      .select("id", { count: "exact", head: true })
      .eq("status", "OPEN")
      .eq("severity", "ACTION_REQUIRED"),
  ]);

  return {
    open: openRes.count ?? 0,
    critical: criticalRes.count ?? 0,
    actionRequired: actionRequiredRes.count ?? 0,
  };
}

export default async function DataQualityInboxPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const status: DataQualityIssueStatus | undefined =
    params.status && VALID_STATUSES.has(params.status) ? (params.status as DataQualityIssueStatus) : undefined;
  const severity: PersistedDataQualitySeverity | undefined =
    params.severity && VALID_SEVERITIES.has(params.severity)
      ? (params.severity as PersistedDataQualitySeverity)
      : undefined;
  const businessDate = params.date || undefined;

  const supabase = await createServiceClient();
  const [stats, { issues, total, totalPages }] = await timed("data-quality-inbox:all", () =>
    Promise.all([
      getStats(supabase),
      listDataQualityIssues(supabase, { status, severity, businessDate, page, pageSize: PAGE_SIZE }),
    ]),
  );

  return (
    <>
      <DashboardTopBar title="ศูนย์รวมปัญหาคุณภาพข้อมูล" />

      <div className="p-4 sm:p-6 space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            title="รายการที่เปิดอยู่"
            value={stats.open.toLocaleString()}
            description="ยังไม่ได้แก้ไขหรือเพิกเฉย"
            accentColor="bg-amber-100 text-amber-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            }
          />
          <StatCard
            title="วิกฤต (🚨)"
            value={stats.critical.toLocaleString()}
            description="ต้องดำเนินการทันที"
            accentColor="bg-red-100 text-red-700"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
            }
          />
          <StatCard
            title="ต้องตรวจสอบ (⚠️)"
            value={stats.actionRequired.toLocaleString()}
            description="รอการตรวจสอบของผู้ดูแล"
            accentColor="bg-blue-100 text-blue-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            }
          />
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>รายการปัญหาคุณภาพข้อมูล</CardTitle>
                <p className="text-sm text-slate-500 mt-0.5">{total.toLocaleString()} รายการ</p>
              </div>

              <Suspense fallback={<div className="h-9 w-64 animate-pulse rounded-lg bg-slate-100" />}>
                <div className="flex flex-wrap items-center gap-2">
                  <DateInput paramName="date" label="วันที่" defaultValue={businessDate ?? ""} />
                  <FilterSelect label="สถานะ" paramName="status" options={STATUS_OPTIONS} allLabel="ทั้งหมด" />
                  <FilterSelect label="ความรุนแรง" paramName="severity" options={SEVERITY_OPTIONS} />
                </div>
              </Suspense>
            </div>
          </CardHeader>

          <CardContent className="p-0 pb-2">
            <DataQualityIssuesTable issues={issues} />
            <Pagination
              page={page}
              totalPages={totalPages}
              basePath="/admin/data-quality"
              params={{ status: params.status, severity, date: businessDate }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
