import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { StatCard } from "@/components/dashboard/StatCard";
import { DateInput } from "@/components/ui/DateInput";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { ReconciliationTable } from "@/components/reconciliation/ReconciliationTable";
import { fetchReconciliationReport } from "@/lib/reconciliation-report-service";
import {
  STATUS_FILTER_OPTIONS,
  type ReconciliationStatusFilter,
} from "@/lib/reconciliation-report";

interface PageProps {
  searchParams: Promise<{
    from?:   string;
    to?:     string;
    market?: string;
    status?: string;
  }>;
}

function shiftIsoDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function fmtBaht(v: number): string {
  return v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const VALID_STATUSES = new Set(STATUS_FILTER_OPTIONS.map((o) => o.value));

function parseStatus(value: string | undefined): ReconciliationStatusFilter | undefined {
  return value && VALID_STATUSES.has(value as ReconciliationStatusFilter)
    ? (value as ReconciliationStatusFilter)
    : undefined;
}

export default async function ReconciliationPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const today    = bangkokBusinessDateNow();
  const fromDate = params.from ?? shiftIsoDate(today, -6);
  const toDate   = params.to ?? today;
  const market   = params.market || undefined;
  const status   = parseStatus(params.status);

  const supabase = await createServiceClient();
  const { rows, summary, markets } = await timed("reconciliation-report", () =>
    fetchReconciliationReport(supabase, { fromDate, toDate, market, status }),
  );

  const exportParams = new URLSearchParams({ from: fromDate, to: toDate });
  if (market) exportParams.set("market", market);
  if (status) exportParams.set("status", status);
  const exportUrl = `/api/export/reconciliation?${exportParams}`;

  const moneyIcon = (
    <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
  const reviewIcon = (
    <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  );

  return (
    <>
      <DashboardTopBar title="รายงานกระทบยอดรายกลุ่มและวันธุรกิจ" />

      <div className="p-4 sm:p-6 space-y-5">
        {/* Granularity disclosure: rows are per LINE group + business date,
            not strictly per market. Market is supporting metadata only. */}
        <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-800">
          <svg className="mt-0.5 size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
          <span>
            ยอดกระทบแต่ละแถวสรุปตาม <strong>กลุ่ม LINE + วันที่ธุรกิจ</strong> ไม่ใช่รายตลาดโดยตรง
            คอลัมน์ &ldquo;ตลาด&rdquo; เป็นข้อมูลประกอบ และอาจแทนหลายตลาดที่อยู่ในกลุ่มเดียวกันในวันเดียวกัน
            จึงยังไม่ใช้แยกยอดรายตลาด
          </span>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">ตั้งแต่ (วันที่ธุรกิจ)</label>
            <DateInput paramName="from" defaultValue={fromDate} label="วันที่เริ่มต้น" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">ถึง (วันที่ธุรกิจ)</label>
            <DateInput paramName="to" defaultValue={toDate} label="วันที่สิ้นสุด" />
          </div>
          <FilterSelect
            label="ตลาด"
            paramName="market"
            options={markets.map((m) => ({ value: m, label: m }))}
          />
          <FilterSelect
            label="สถานะ"
            paramName="status"
            options={STATUS_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <a
            href={exportUrl}
            className="ml-auto flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
          >
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            ส่งออก Excel
          </a>
        </div>

        {/* Summary metrics */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="ยอดโอนที่ส่งรวม"
            value={fmtBaht(summary.submitted_transfer_total)}
            description="บาท"
            icon={moneyIcon}
            accentColor="bg-slate-100 text-slate-500"
          />
          <StatCard
            title="ยอดสลิปที่ตรวจรวม"
            value={fmtBaht(summary.checked_slip_total)}
            description="AI + สลิปมือ (บาท)"
            icon={moneyIcon}
            accentColor="bg-blue-50 text-blue-500"
          />
          <StatCard
            title="ส่วนต่างรวม"
            value={fmtBaht(summary.difference_total)}
            description="ยอดโอน − ยอดสลิปที่ตรวจ"
            icon={moneyIcon}
            accentColor={
              Math.abs(summary.difference_total) < 0.005
                ? "bg-emerald-50 text-emerald-500"
                : "bg-red-50 text-red-500"
            }
          />
          <StatCard
            title="รายการที่ต้องตรวจสอบ"
            value={summary.needs_review_count}
            description={`จากทั้งหมด ${summary.total_count} รายการ`}
            icon={reviewIcon}
            accentColor={
              summary.needs_review_count > 0
                ? "bg-amber-50 text-amber-500"
                : "bg-emerald-50 text-emerald-500"
            }
          />
        </div>

        <ReconciliationTable rows={rows} />
      </div>
    </>
  );
}
