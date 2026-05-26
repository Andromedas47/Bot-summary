import { Suspense } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { StatCard } from "@/components/dashboard/StatCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { ExportButton } from "@/components/ui/ExportButton";
import { ParseErrorsTable } from "@/components/errors/ParseErrorsTable";
import type { ParseErrorRow, ParseErrorType } from "@/types";

const PAGE_SIZE = 50;

const VALID_ERROR_TYPES = new Set<ParseErrorType>([
  "format_error", "validation_error", "unknown_format",
  "parser_crash", "timeout", "unsupported_type",
]);

const ERROR_TYPE_OPTIONS = [
  { value: "format_error",     label: "รูปแบบไม่ถูกต้อง" },
  { value: "validation_error", label: "ข้อมูลไม่ถูกต้อง" },
  { value: "unknown_format",   label: "รูปแบบไม่รู้จัก" },
  { value: "parser_crash",     label: "ระบบขัดข้อง" },
  { value: "timeout",          label: "หมดเวลา" },
  { value: "unsupported_type", label: "ประเภทไม่รองรับ" },
];

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string; type?: string }>;
}

async function getStats(supabase: Awaited<ReturnType<typeof createServiceClient>>) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalRes, todayRes, crashRes] = await Promise.all([
    supabase.from("parse_errors").select("id", { count: "exact", head: true }),
    supabase
      .from("parse_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", today.toISOString()),
    supabase
      .from("parse_errors")
      .select("id", { count: "exact", head: true })
      .eq("error_type", "parser_crash"),
  ]);

  return {
    total:   totalRes.count  ?? 0,
    today:   todayRes.count  ?? 0,
    crashes: crashRes.count  ?? 0,
  };
}

async function getErrors(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  page: number,
  q?: string,
  type?: string,
) {
  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  const errorType = type && VALID_ERROR_TYPES.has(type as ParseErrorType)
    ? (type as ParseErrorType)
    : undefined;

  let query = supabase
    .from("parse_errors")
    .select("id,created_at,parser_name,parser_version,error_type,error_message", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (q)         query = query.ilike("error_message", `%${q}%`);
  if (errorType) query = query.eq("error_type", errorType);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    errors:     (data ?? []) as ParseErrorRow[],
    total:      count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

export default async function AdminErrorsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page   = Math.max(1, parseInt(params.page ?? "1", 10));
  const q      = params.q;
  const type   = params.type;

  const supabase = await createServiceClient();
  const [stats, { errors, total, totalPages }] = await timed("errors:all", () =>
    Promise.all([
      getStats(supabase),
      getErrors(supabase, page, q, type),
    ]),
  );

  return (
    <>
      <DashboardTopBar title="บันทึกข้อผิดพลาด" />

      <div className="p-4 sm:p-6 space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            title="ข้อผิดพลาดทั้งหมด"
            value={stats.total.toLocaleString()}
            description="ตั้งแต่เริ่มใช้งาน"
            accentColor="bg-red-100 text-red-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            }
          />
          <StatCard
            title="ข้อผิดพลาดวันนี้"
            value={stats.today.toLocaleString()}
            description="นับตั้งแต่เที่ยงคืน"
            accentColor="bg-orange-100 text-orange-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            }
          />
          <StatCard
            title="ข้อผิดพลาดร้ายแรง"
            value={stats.crashes.toLocaleString()}
            description="ปัญหาที่ไม่สามารถดำเนินการต่อได้"
            accentColor="bg-red-100 text-red-700"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
            }
          />
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>รายการข้อผิดพลาด</CardTitle>
                <p className="text-sm text-slate-500 mt-0.5">
                  {total.toLocaleString()} รายการ
                  {q ? ` ที่ตรงกับ "${q}"` : ""}
                </p>
              </div>

              <Suspense fallback={<div className="h-9 w-48 animate-pulse rounded-lg bg-slate-100" />}>
                <div className="flex flex-wrap items-center gap-2">
                  <SearchInput placeholder="ค้นหาข้อผิดพลาด…" defaultValue={q ?? ""} />
                  <FilterSelect
                    label="ประเภท"
                    paramName="type"
                    options={ERROR_TYPE_OPTIONS}
                  />
                  <ExportButton exportPath="/api/export/errors" />
                </div>
              </Suspense>
            </div>
          </CardHeader>

          <CardContent className="p-0 pb-2">
            <ParseErrorsTable errors={errors} />
            <Pagination
              page={page}
              totalPages={totalPages}
              basePath="/admin/errors"
              params={{ q, type }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
