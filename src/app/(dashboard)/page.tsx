import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { StatCard } from "@/components/dashboard/StatCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { MessageTable } from "@/components/messages/MessageTable";
import { SessionsTable } from "@/components/weigh-entries/SessionsTable";
import type { RawMessage, ProduceSession } from "@/types";
import type { Database } from "@/types/database";

// Aggregate counts cached for 60 s — anon client (no cookies) because
// unstable_cache runs outside the request context; RLS allows anon reads.
const getCachedCounts = unstable_cache(
  async () => {
    const db = createSupabaseClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalRes, processedRes, unprocessedRes, sessionsRes, errorsRes, todayRes] =
      await Promise.all([
        db.from("raw_messages").select("id", { count: "exact", head: true }),
        db.from("raw_messages").select("id", { count: "exact", head: true }).eq("is_processed", true),
        db.from("raw_messages").select("id", { count: "exact", head: true }).eq("is_processed", false),
        db.from("produce_sessions").select("id", { count: "exact", head: true }),
        db.from("parse_errors").select("id", { count: "exact", head: true }),
        db.from("raw_messages").select("id", { count: "exact", head: true }).gte("created_at", today.toISOString()),
      ]);

    return {
      total:       totalRes.count       ?? 0,
      processed:   processedRes.count   ?? 0,
      unprocessed: unprocessedRes.count ?? 0,
      sessions:    sessionsRes.count    ?? 0,
      errors:      errorsRes.count      ?? 0,
      today:       todayRes.count       ?? 0,
    };
  },
  ["overview-counts"],
  { revalidate: 60 },
);

async function getRecentData() {
  const supabase = await createClient();
  const [recentMsgsRes, recentSessionsRes] = await timed("overview:recent", () => Promise.all([
    supabase.from("raw_messages")
      .select("id,event_type,message_type,raw_text,is_processed,source_type,created_at")
      .order("created_at", { ascending: false }).limit(10),
    supabase.from("produce_sessions")
      .select("id,session_date,staff_name,session_title,total_items,parser_errors,created_at")
      .order("created_at", { ascending: false }).limit(5),
  ]));
  return {
    recentMessages: (recentMsgsRes.data ?? []) as RawMessage[],
    recentSessions: (recentSessionsRes.data ?? []) as ProduceSession[],
  };
}

export default async function OverviewPage() {
  const [counts, recent] = await Promise.all([getCachedCounts(), getRecentData()]);
  const s = { ...counts, ...recent };

  return (
    <>
      <DashboardTopBar title="Overview" />

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
            title="Produce Sessions"
            value={s.sessions.toLocaleString()}
            description="Weigh sessions logged"
            accentColor="bg-emerald-100 text-emerald-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0 0 12 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 0 1-2.031.352 5.988 5.988 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971Zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 0 1-2.031.352 5.989 5.989 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971Z" />
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

        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Recent Messages</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              <MessageTable events={s.recentMessages} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Sessions</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              <SessionsTable sessions={s.recentSessions} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
