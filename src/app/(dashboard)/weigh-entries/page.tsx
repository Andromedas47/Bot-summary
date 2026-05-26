import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { StatCard } from "@/components/dashboard/StatCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { ExportButton } from "@/components/ui/ExportButton";
import { SessionsTable } from "@/components/weigh-entries/SessionsTable";
import type { ProduceSession } from "@/types";

const PAGE_SIZE = 50;

const HAS_ERRORS_OPTIONS = [
  { value: "yes", label: "With errors" },
  { value: "no",  label: "No errors" },
];

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string; errors?: string }>;
}

async function getStats(supabase: Awaited<ReturnType<typeof createClient>>) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalRes, todayRes, withErrorsRes] = await Promise.all([
    supabase.from("produce_sessions").select("id", { count: "exact", head: true }),
    supabase
      .from("produce_sessions")
      .select("id", { count: "exact", head: true })
      .gte("created_at", today.toISOString()),
    supabase
      .from("produce_sessions")
      .select("id", { count: "exact", head: true })
      .not("parser_errors", "is", null),
  ]);

  return {
    total:      totalRes.count      ?? 0,
    today:      todayRes.count      ?? 0,
    withErrors: withErrorsRes.count ?? 0,
  };
}

async function getSessions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  page: number,
  q?: string,
  errors?: string,
) {
  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  let query = supabase
    .from("produce_sessions")
    .select("id,session_date,staff_name,session_title,total_items,parser_errors,created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (q)               query = query.ilike("staff_name", `%${q}%`);
  if (errors === "yes") query = query.not("parser_errors", "is", null);
  if (errors === "no")  query = query.is("parser_errors", null);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    sessions:   (data ?? []) as ProduceSession[],
    total:      count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

export default async function WeighEntriesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page   = Math.max(1, parseInt(params.page ?? "1", 10));
  const q      = params.q;
  const errors = params.errors;

  const supabase = await createClient();
  const [stats, { sessions, total, totalPages }] = await timed("weigh-entries:all", () => Promise.all([
    getStats(supabase),
    getSessions(supabase, page, q, errors),
  ]));

  return (
    <>
      <DashboardTopBar title="Weigh Entries" />

      <div className="p-4 sm:p-6 space-y-6">
        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            title="Total Sessions"
            value={stats.total.toLocaleString()}
            description="All time"
            accentColor="bg-emerald-100 text-emerald-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0 0 12 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 0 1-2.031.352 5.988 5.988 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971Zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 0 1-2.031.352 5.989 5.989 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971Z" />
              </svg>
            }
          />
          <StatCard
            title="Sessions Today"
            value={stats.today.toLocaleString()}
            description="Since midnight"
            accentColor="bg-blue-100 text-blue-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
              </svg>
            }
          />
          <StatCard
            title="Sessions with Errors"
            value={stats.withErrors.toLocaleString()}
            description="Partial parse failures"
            accentColor="bg-amber-100 text-amber-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            }
          />
        </div>

        {/* Table card */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Produce Sessions</CardTitle>
                <p className="text-sm text-slate-500 mt-0.5">
                  {total.toLocaleString()} session{total !== 1 ? "s" : ""}
                  {q ? ` matching "${q}"` : ""}
                </p>
              </div>

              <Suspense fallback={<div className="h-9 w-48 animate-pulse rounded-lg bg-slate-100" />}>
                <div className="flex flex-wrap items-center gap-2">
                  <SearchInput placeholder="Search staff…" defaultValue={q ?? ""} />
                  <FilterSelect
                    label="Errors"
                    paramName="errors"
                    options={HAS_ERRORS_OPTIONS}
                  />
                  <ExportButton exportPath="/api/export/weigh-entries" />
                </div>
              </Suspense>
            </div>
          </CardHeader>

          <CardContent className="p-0 pb-2">
            <SessionsTable sessions={sessions} />
            <Pagination
              page={page}
              totalPages={totalPages}
              basePath="/weigh-entries"
              params={{ q, errors }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
