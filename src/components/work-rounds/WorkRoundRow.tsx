import type { WorkRoundStatus } from "@/types/database";
import { WorkRoundStatusBadge } from "./WorkRoundStatusBadge";

interface WorkRoundLike {
  id:            string;
  seller_name:   string;
  market_name:   string;
  round_seq:     number;
  status:        WorkRoundStatus;
  business_date: string;
}

interface DraftLike {
  declared_transfer: number | null;
  declared_cash:     number | null;
  declared_expenses: number | null;
  declared_labor:    number | null;
  status:            string;
}

interface RoundMetrics {
  expectedSales: number;
  verifiedSlipTotal: number;
  variance: number | null;
  evidenceState: string;
  appendCount: number;
  correctionCount: number;
}

function fmt(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("th-TH");
}

export function WorkRoundRow({
  round,
  draft,
  metrics,
  returnTo,
}: {
  round: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  metrics: RoundMetrics | null;
  returnTo: string;
}) {
  const r  = round  as unknown as WorkRoundLike;
  const d  = draft  as unknown as DraftLike | null;
  const totalDeclared =
    (d?.declared_transfer ?? 0) +
    (d?.declared_cash     ?? 0) +
    (d?.declared_expenses ?? 0) +
    (d?.declared_labor    ?? 0);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-medium text-slate-900">
            {r.seller_name} — {r.market_name}
          </span>
          {r.round_seq > 1 && (
            <span className="ml-2 text-xs text-slate-400">รอบที่ {r.round_seq}</span>
          )}
        </div>
        <WorkRoundStatusBadge status={r.status} />
      </div>

      {d ? (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <span className="text-slate-500">โอน</span>{" "}
            <span className="font-medium">{fmt(d.declared_transfer)} บาท</span>
          </div>
          <div>
            <span className="text-slate-500">สด</span>{" "}
            <span className="font-medium">{fmt(d.declared_cash)} บาท</span>
          </div>
          <div>
            <span className="text-slate-500">ค่าใช้จ่าย</span>{" "}
            <span className="font-medium">{fmt(d.declared_expenses)} บาท</span>
          </div>
          <div>
            <span className="text-slate-500">ค่าแรง</span>{" "}
            <span className="font-medium">{fmt(d.declared_labor)} บาท</span>
          </div>
          <div className="col-span-2 sm:col-span-4 border-t pt-1 mt-1">
            <span className="text-slate-500">รวมที่แจ้ง</span>{" "}
            <span className="font-semibold text-slate-900">
              {totalDeclared.toLocaleString("th-TH")} บาท
            </span>
            <span className="ml-3 text-xs text-slate-400">({d.status})</span>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-400">ยังไม่มีการแจ้งยอดส่งเงิน</p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-3 text-sm sm:grid-cols-4">
        <div>
          <span className="text-slate-500">Expected sales</span>{" "}
          <span className="font-medium">{(metrics?.expectedSales ?? 0).toLocaleString("th-TH")} บาท</span>
        </div>
        <div>
          <span className="text-slate-500">Verified slips</span>{" "}
          <span className="font-medium">{(metrics?.verifiedSlipTotal ?? 0).toLocaleString("th-TH")} บาท</span>
        </div>
        <div>
          <span className="text-slate-500">Variance</span>{" "}
          <span className="font-medium">{metrics?.variance == null ? "—" : `${metrics.variance.toLocaleString("th-TH")} บาท`}</span>
        </div>
        <div>
          <span className="text-slate-500">Evidence</span>{" "}
          <span className="font-medium">{metrics?.evidenceState ?? "unknown"}</span>
        </div>
        <div className="col-span-2 sm:col-span-4 text-xs text-slate-500">
          Append sessions: {metrics?.appendCount ?? 0} · Review/correction history: {metrics?.correctionCount ?? 0}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
        <form action="/api/work-rounds/review" method="POST">
          <input type="hidden" name="work_round_id" value={r.id} />
          <input type="hidden" name="action" value="approve" />
          <input type="hidden" name="return_to" value={returnTo} />
          <button type="submit" className="rounded bg-green-700 px-3 py-1 text-sm font-medium text-white">
            Approve
          </button>
        </form>
        <form action="/api/work-rounds/review" method="POST" className="flex gap-2">
          <input type="hidden" name="work_round_id" value={r.id} />
          <input type="hidden" name="action" value="needs_correction" />
          <input type="hidden" name="return_to" value={returnTo} />
          <input
            name="reason"
            placeholder="Reason"
            className="w-44 rounded border px-2 py-1 text-sm"
          />
          <button type="submit" className="rounded border border-rose-300 px-3 py-1 text-sm font-medium text-rose-700">
            Needs correction
          </button>
        </form>
      </div>
    </div>
  );
}
