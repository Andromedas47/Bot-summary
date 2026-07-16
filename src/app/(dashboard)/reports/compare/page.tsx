import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { CompareReportView } from "@/components/compare-report/CompareReportView";
import { fetchCompareFilterOptions, fetchCompareReport } from "@/lib/compare-report-service";

interface PageProps { searchParams: Promise<{ date?: string; worker?: string; market?: string }> }

export default async function CompareReportPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
  const date = params.date ?? today;
  const options = await fetchCompareFilterOptions(date);
  const worker = params.worker ?? "";
  const market = params.market ?? "";
  const report = worker ? await fetchCompareReport({ date, worker, market: market || undefined }) : null;

  return <>
    <DashboardTopBar title="รายงานเปรียบเทียบ" />
    <main className="space-y-4 p-4 sm:p-6">
      <form className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1fr)_auto] sm:items-end">
        <label className="text-sm font-medium text-slate-700">วันที่ธุรกิจ<input name="date" type="date" defaultValue={date} className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3" /></label>
        <label className="text-sm font-medium text-slate-700">พนักงาน<select name="worker" defaultValue={worker} required className="mt-1 block h-10 w-full rounded-lg border border-slate-300 bg-white px-3"><option value="">เลือกพนักงาน</option>{options.workers.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label className="text-sm font-medium text-slate-700">ตลาด<select name="market" defaultValue={market} className="mt-1 block h-10 w-full rounded-lg border border-slate-300 bg-white px-3"><option value="">ทุกตลาด</option>{options.markets.map((name) => <option key={name}>{name}</option>)}</select></label>
        <button className="h-10 rounded-lg bg-[#06C755] px-5 text-sm font-semibold text-white hover:bg-[#05b34d]">แสดงรายงาน</button>
      </form>
      {!worker && <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">เลือกวันที่และพนักงานเพื่อสร้างรายงาน</div>}
      {report && report.rows.length === 0 && <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">ไม่พบรายการตามตัวกรอง</div>}
      {report && report.rows.length > 0 && <CompareReportView report={report} worker={worker} date={date} market={market || undefined} />}
    </main>
  </>;
}
