import { Suspense } from "react";
import { createServiceClient } from "@/lib/supabase/server";
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
  searchParams: Promise<{
    page?:    string;
    date?:    string;
    market?:  string;
    staff?:   string;
    product?: string;
  }>;
}

async function getTransactions(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  page:     number,
  date?:    string,
  market?:  string,
  staff?:   string,
  product?: string,
) {
  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  let query = supabase
    .from("produce_transactions")
    .select("*", { count: "exact" })
    .order("session_created_at", { ascending: false })
    .order("item_number",        { ascending: true,  nullsFirst: false })
    .range(from, to);

  if (date)    query = query.eq("transaction_date", date);
  if (market)  query = query.ilike("market_name",   `%${market}%`);
  if (staff)   query = query.ilike("staff_name",    `%${staff}%`);
  if (product) query = query.ilike("product_name",  `%${product}%`);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    rows:       (data ?? []) as DailyRow[],
    total:      count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

export default async function HomePage({ searchParams }: PageProps) {
  const params  = await searchParams;
  const page    = Math.max(1, parseInt(params.page ?? "1", 10));
  const date    = params.date;
  const market  = params.market;
  const staff   = params.staff;
  const product = params.product;

  const supabase = await createServiceClient();
  const { rows, total, totalPages } = await timed("daily-table:list", () =>
    getTransactions(supabase, page, date, market, staff, product),
  );

  const exportQuery = new URLSearchParams();
  if (date)    exportQuery.set("date",    date);
  if (market)  exportQuery.set("market",  market);
  if (staff)   exportQuery.set("staff",   staff);
  if (product) exportQuery.set("product", product);
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
                  {date    ? ` · วันที่ ${date}`           : ""}
                  {market  ? ` · ตลาด "${market}"`         : ""}
                  {staff   ? ` · เจ้าหน้าที่ "${staff}"`  : ""}
                  {product ? ` · สินค้า "${product}"`      : ""}
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
                  <SearchInput
                    placeholder="ค้นหาสินค้า…"
                    paramName="product"
                    defaultValue={product ?? ""}
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
              basePath="/"
              params={{ date, market, staff, product }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
