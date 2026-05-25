import { createClient } from "@/lib/supabase/server";
import { TopBar } from "@/components/dashboard/TopBar";
import { StatCard } from "@/components/dashboard/StatCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { MessageTable } from "@/components/messages/MessageTable";
import type { RawEvent } from "@/types";

async function getDashboardStats() {
  const supabase = await createClient();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalResult, parsedResult, errorResult, todayResult, recentResult] =
    await Promise.all([
      supabase.from("line_raw_events").select("id", { count: "exact", head: true }),
      supabase.from("parsed_messages").select("id", { count: "exact", head: true }).eq("status", "parsed"),
      supabase.from("parsed_messages").select("id", { count: "exact", head: true }).eq("status", "error"),
      supabase.from("line_raw_events").select("id", { count: "exact", head: true }).gte("created_at", today.toISOString()),
      supabase.from("line_raw_events").select("*").order("created_at", { ascending: false }).limit(10),
    ]);

  return {
    total: totalResult.count ?? 0,
    parsed: parsedResult.count ?? 0,
    errors: errorResult.count ?? 0,
    today: todayResult.count ?? 0,
    recent: (recentResult.data ?? []) as RawEvent[],
  };
}

export default async function OverviewPage() {
  const stats = await getDashboardStats();

  return (
    <>
      <TopBar title="Overview" />

      <div className="p-4 sm:p-6 space-y-6">
        {/* Stat cards */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Total Events"
            value={stats.total.toLocaleString()}
            description="All time"
            accentColor="bg-slate-100 text-slate-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
              </svg>
            }
          />
          <StatCard
            title="Today's Events"
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
            title="Parsed"
            value={stats.parsed.toLocaleString()}
            description="Successfully parsed"
            accentColor="bg-emerald-100 text-emerald-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            }
          />
          <StatCard
            title="Errors"
            value={stats.errors.toLocaleString()}
            description="Parse failures"
            accentColor="bg-red-100 text-red-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            }
          />
        </div>

        {/* Recent events */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Events</CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            <MessageTable events={stats.recent} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
