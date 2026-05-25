import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
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
  { value: "format_error",     label: "Format error" },
  { value: "validation_error", label: "Validation error" },
  { value: "unknown_format",   label: "Unknown format" },
  { value: "parser_crash",     label: "Parser crash" },
  { value: "timeout",          label: "Timeout" },
  { value: "unsupported_type", label: "Unsupported type" },
];

const PARSER_OPTIONS = [
  { value: "weigh-session", label: "weigh-session" },
];

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string; type?: string; parser?: string }>;
}

async function getStats(supabase: Awaited<ReturnType<typeof createClient>>) {
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
    total:  totalRes.count  ?? 0,
    today:  todayRes.count  ?? 0,
    crashes: crashRes.count ?? 0,
  };
}

async function getErrors(
  supabase: Awaited<ReturnType<typeof createClient>>,
  page: number,
  q?: string,
  type?: string,
  parser?: string,
) {
  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  const errorType = type && VALID_ERROR_TYPES.has(type as ParseErrorType)
    ? (type as ParseErrorType)
    : undefined;

  let query = supabase
    .from("parse_errors")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (q)         query = query.ilike("error_message", `%${q}%`);
  if (errorType) query = query.eq("error_type", errorType);
  if (parser)    query = query.eq("parser_name", parser);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    errors:     (data ?? []) as ParseErrorRow[],
    total:      count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

export default async function ErrorsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page   = Math.max(1, parseInt(params.page ?? "1", 10));
  const q      = params.q;
  const type   = params.type;
  const parser = params.parser;

  const supabase = await createClient();
  const [stats, { errors, total, totalPages }] = await Promise.all([
    getStats(supabase),
    getErrors(supabase, page, q, type, parser),
  ]);

  return (
    <>
      <DashboardTopBar title="Parse Errors" />

      <div className="p-4 sm:p-6 space-y-6">
        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            title="Total Errors"
            value={stats.total.toLocaleString()}
            description="All time"
            accentColor="bg-red-100 text-red-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            }
          />
          <StatCard
            title="Errors Today"
            value={stats.today.toLocaleString()}
            description="Since midnight"
            accentColor="bg-orange-100 text-orange-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            }
          />
          <StatCard
            title="Parser Crashes"
            value={stats.crashes.toLocaleString()}
            description="Unhandled exceptions"
            accentColor="bg-red-100 text-red-700"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
            }
          />
        </div>

        {/* Table card */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Parse Errors</CardTitle>
                <p className="text-sm text-slate-500 mt-0.5">
                  {total.toLocaleString()} error{total !== 1 ? "s" : ""}
                  {q ? ` matching "${q}"` : ""}
                </p>
              </div>

              <Suspense fallback={<div className="h-9 w-48 animate-pulse rounded-lg bg-slate-100" />}>
                <div className="flex flex-wrap items-center gap-2">
                  <SearchInput placeholder="Search errors…" defaultValue={q ?? ""} />
                  <FilterSelect
                    label="Type"
                    paramName="type"
                    options={ERROR_TYPE_OPTIONS}
                  />
                  <FilterSelect
                    label="Parser"
                    paramName="parser"
                    options={PARSER_OPTIONS}
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
              basePath="/errors"
              params={{ q, type, parser }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
