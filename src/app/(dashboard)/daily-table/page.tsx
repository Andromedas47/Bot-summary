import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { DateInput } from "@/components/ui/DateInput";
import { ExportButton } from "@/components/ui/ExportButton";
import { DailyTable } from "@/components/daily-table/DailyTable";
import type { DailyRow } from "@/components/daily-table/DailyTable";

const PAGE_SIZE = 100;

interface PageProps {
  searchParams: Promise<{ page?: string; date?: string; market?: string; staff?: string }>;
}

async function getRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  page: number,
  date?: string,
  market?: string,
  staff?: string,
) {
  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from("produce_items")
    .select(
      "id,item_number,product_name,price_per_unit,quantity,unit,section,created_at," +
      "produce_sessions!inner(session_date,session_title,staff_name)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .order("item_number", { ascending: true, nullsFirst: false })
    .range(from, to);

  if (date)   query = query.eq("produce_sessions.session_date", date);
  if (market) query = query.ilike("produce_sessions.session_title", `%${market}%`);
  if (staff)  query = query.ilike("produce_sessions.staff_name", `%${staff}%`);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    rows:       (data ?? []) as DailyRow[],
    total:      count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

export default async function DailyTablePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page   = Math.max(1, parseInt(params.page ?? "1", 10));
  const date   = params.date;
  const market = params.market;
  const staff  = params.staff;

  const supabase = await createClient();
  const { rows, total, totalPages } = await timed("daily-table:list", () =>
    getRows(supabase, page, date, market, staff),
  );

  const exportQuery = new URLSearchParams();
  if (date)   exportQuery.set("date", date);
  if (market) exportQuery.set("market", market);
  if (staff)  exportQuery.set("staff", staff);
  const exportPath = `/api/export/daily-table${exportQuery.size > 0 ? `?${exportQuery}` : ""}`;

  return (
    <>
      <DashboardTopBar title="ตารางรายวัน" />

      <div className="p-4 sm:p-6">
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>ตารางรายการสินค้า</CardTitle>
                <p className="text-sm text-slate-500 mt-0.5">
                  {total.toLocaleString()} รายการ
                  {date   ? ` · วันที่ ${date}`            : ""}
                  {market ? ` · ตลาด "${market}"`          : ""}
                  {staff  ? ` · เจ้าหน้าที่ "${staff}"`   : ""}
                </p>
              </div>

              <Suspense fallback={<div className="h-9 w-64 animate-pulse rounded-lg bg-slate-100" />}>
                <div className="flex flex-wrap items-center gap-2">
                  <DateInput defaultValue={date ?? ""} />
                  <SearchInput
                    placeholder="ค้นหาตลาด…"
                    paramName="market"
                    defaultValue={market ?? ""}
                  />
                  <SearchInput
                    placeholder="ค้นหาเจ้าหน้าที่…"
                    paramName="staff"
                    defaultValue={staff ?? ""}
                  />
                  <ExportButton exportPath={exportPath} />
                </div>
              </Suspense>
            </div>
          </CardHeader>

          <CardContent className="p-0 pb-2">
            <DailyTable rows={rows} />
            <Pagination
              page={page}
              totalPages={totalPages}
              basePath="/daily-table"
              params={{ date, market, staff }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
