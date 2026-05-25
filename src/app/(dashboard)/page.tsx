import { createClient } from "@/lib/supabase/server";
import { TopBar } from "@/components/dashboard/TopBar";
import { StatCard } from "@/components/dashboard/StatCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { MessageTable } from "@/components/messages/MessageTable";
import type { RawMessage } from "@/types";

async function getDashboardStats() {
  const supabase = await createClient();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalRes, processedRes, unprocessedRes, weighRes, errorsRes, todayRes, recentRes] =
    await Promise.all([
      supabase.from("raw_messages").select("id", { count: "exact", head: true }),
      supabase.from("raw_messages").select("id", { count: "exact", head: true }).eq("is_processed", true),
      supabase.from("raw_messages").select("id", { count: "exact", head: true }).eq("is_processed", false),
      supabase.from("weigh_entries").select("id", { count: "exact", head: true }),
      supabase.from("parse_errors").select("id", { count: "exact", head: true }),
      supabase.from("raw_messages").select("id", { count: "exact", head: true }).gte("created_at", today.toISOString()),
      supabase.from("raw_messages").select("*").order("created_at", { ascending: false }).limit(10),
    ]);

  return {
    total:       totalRes.count       ?? 0,
    processed:   processedRes.count   ?? 0,
    unprocessed: unprocessedRes.count ?? 0,
    weigh:       weighRes.count       ?? 0,
    errors:      errorsRes.count      ?? 0,
    today:       todayRes.count       ?? 0,
    recent:      (recentRes.data ?? []) as RawMessage[],
  };
}

export default async function OverviewPage() {
  const s = await getDashboardStats();

  return (
    <>
      <TopBar title="Overview" />

      <div className="p-4 sm:p-6 space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard
            title="Total Messages"
            value={s.total.toLocaleString()}
            description="All time"
            accentColor="bg-slate-100 text-slate-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
              </svg>
            }
          />
          <StatCard
            title="Today's Messages"
            value={s.today.toLocaleString()}
            description="Since midnight"
            accentColor="bg-blue-100 text-blue-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
              </svg>
            }
          />
          <StatCard
            title="Weight Entries"
            value={s.weigh.toLocaleString()}
            description="Parsed weigh-ins"
            accentColor="bg-emerald-100 text-emerald-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
              </svg>
            }
          />
          <StatCard
            title="Unprocessed"
            value={s.unprocessed.toLocaleString()}
            description="Awaiting a parser"
            accentColor="bg-amber-100 text-amber-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            }
          />
          <StatCard
            title="Parse Errors"
            value={s.errors.toLocaleString()}
            description="Failed parse attempts"
            accentColor="bg-red-100 text-red-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            }
          />
          <StatCard
            title="Processed"
            value={s.processed.toLocaleString()}
            description="Successfully handled"
            accentColor="bg-violet-100 text-violet-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            }
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent Messages</CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            <MessageTable events={s.recent} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
