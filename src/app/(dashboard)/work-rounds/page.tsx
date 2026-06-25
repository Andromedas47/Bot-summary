/**
 * Work Rounds Review Queue (V2 — PR3).
 *
 * Shows all Work Rounds for a given business date so reviewers can see
 * produce totals, declared settlement, variance, and evidence state.
 * This page replaces the blank settlement-entry form as the primary
 * settlement review surface.
 */

import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { createServiceClient } from "@/lib/supabase/server";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { WorkRoundStatusBadge } from "@/components/work-rounds/WorkRoundStatusBadge";
import { WorkRoundRow } from "@/components/work-rounds/WorkRoundRow";

interface PageProps {
  searchParams: Promise<{ date?: string }>;
}

export default async function WorkRoundsPage({ searchParams }: PageProps) {
  const params       = await searchParams;
  const businessDate = params.date ?? bangkokBusinessDateNow();
  const supabase     = await createServiceClient();

  // Fetch Work Rounds for the requested date, ordered by seller then round_seq.
  const { data: rounds, error } = await supabase
    .from("work_rounds")
    .select("*")
    .eq("business_date", businessDate)
    .order("seller_name", { ascending: true })
    .order("round_seq",   { ascending: true });

  // Fetch settlement drafts for these rounds.
  const roundIds = (rounds ?? []).map((r: { id: string }) => r.id);
  const { data: drafts } = roundIds.length > 0
    ? await supabase
        .from("settlement_drafts")
        .select("*")
        .in("work_round_id", roundIds)
        .order("version", { ascending: false })
    : { data: [] };

  const draftByRound = new Map<string, Record<string, unknown>>();
  for (const d of drafts ?? []) {
    const key = (d as { work_round_id: string }).work_round_id;
    if (!draftByRound.has(key)) draftByRound.set(key, d as Record<string, unknown>);
  }

  return (
    <>
      <DashboardTopBar title="Work Rounds" />

      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Work Rounds</h1>
          <span className="text-sm text-slate-500">{businessDate}</span>
        </div>

        {/* Date navigation */}
        <form method="GET" className="flex gap-2 items-center">
          <input
            type="date"
            name="date"
            defaultValue={businessDate}
            className="rounded border px-2 py-1 text-sm"
          />
          <button type="submit" className="rounded bg-slate-800 text-white px-3 py-1 text-sm">
            ดูวันที่เลือก
          </button>
        </form>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            ไม่สามารถโหลดข้อมูลได้: {error.message}
          </div>
        )}

        {!error && (rounds ?? []).length === 0 && (
          <div className="rounded border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
            ไม่มี Work Round สำหรับวันที่ {businessDate}
          </div>
        )}

        <div className="space-y-3">
          {(rounds ?? []).map((round: Record<string, unknown>) => (
            <WorkRoundRow
              key={round.id as string}
              round={round}
              draft={draftByRound.get(round.id as string) ?? null}
            />
          ))}
        </div>
      </div>
    </>
  );
}
