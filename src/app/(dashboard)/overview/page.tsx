import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { StatCard } from "@/components/dashboard/StatCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { SessionsTable } from "@/components/weigh-entries/SessionsTable";
import { ParseErrorsTable } from "@/components/errors/ParseErrorsTable";
import type { ProduceSession, ParseErrorRow } from "@/types";
import type { Database } from "@/types/database";

const getCachedCounts = unstable_cache(
  async () => {
    const db = createSupabaseClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [sessionsRes, todaySessionsRes, errorsRes, todayErrorsRes, unprocessedRes] =
      await Promise.all([
        db.from("produce_sessions").select("id", { count: "exact", head: true }),
        db.from("produce_sessions").select("id", { count: "exact", head: true }).gte("created_at", today.toISOString()),
        db.from("parse_errors").select("id", { count: "exact", head: true }),
        db.from("parse_errors").select("id", { count: "exact", head: true }).gte("created_at", today.toISOString()),
        db.from("raw_messages").select("id", { count: "exact", head: true }).eq("is_processed", false),
      ]);

    return {
      sessions:      sessionsRes.count      ?? 0,
      todaySessions: todaySessionsRes.count ?? 0,
      errors:        errorsRes.count        ?? 0,
      todayErrors:   todayErrorsRes.count   ?? 0,
      unprocessed:   unprocessedRes.count   ?? 0,
    };
  },
  ["overview-counts"],
  { revalidate: 60 },
);

async function getRecentData() {
  const supabase = await createServiceClient();
  const [recentSessionsRes, recentErrorsRes] = await timed("overview:recent", () => Promise.all([
    supabase.from("produce_sessions")
      .select("id,session_date,staff_name,session_title,total_items,parser_errors,created_at")
      .order("created_at", { ascending: false }).limit(8),
    supabase.from("parse_errors")
      .select("id,created_at,parser_name,parser_version,error_type,error_message")
      .order("created_at", { ascending: false }).limit(5),
  ]));
  return {
    recentSessions: (recentSessionsRes.data ?? []) as ProduceSession[],
    recentErrors:   (recentErrorsRes.data   ?? []) as ParseErrorRow[],
  };
}

export default async function OverviewPage() {
  const [counts, recent] = await Promise.all([getCachedCounts(), getRecentData()]);

  return (
    <>
      <DashboardTopBar title="ภาพรวม" />

      <div className="p-4 sm:p-6 space-y-6">
        <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="รายการชั่งวันนี้"
            value={counts.todaySessions.toLocaleString()}
            description="นับตั้งแต่เที่ยงคืน"
            accentColor="bg-emerald-100 text-emerald-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
              </svg>
            }
          />
          <StatCard
            title="รายการชั่งทั้งหมด"
            value={counts.sessions.toLocaleString()}
            description="ตั้งแต่เริ่มใช้งาน"
            accentColor="bg-blue-100 text-blue-600"
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0 0 12 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 0 1-2.031.352 5.988 5.988 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971Zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 0 1-2.031.352 5.989 5.989 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971Z" />
              </svg>
            }
          />
          <StatCard
            title="ข้อผิดพลาดวันนี้"
            value={counts.todayErrors.toLocaleString()}
            description="รายการที่มีปัญหา"
            accentColor={counts.todayErrors > 0 ? "bg-red-100 text-red-600" : "bg-slate-100 text-slate-500"}
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            }
          />
          <StatCard
            title="รอประมวลผล"
            value={counts.unprocessed.toLocaleString()}
            description="ข้อความที่ยังไม่ได้ประมวล"
            accentColor={counts.unprocessed > 0 ? "bg-amber-100 text-amber-600" : "bg-slate-100 text-slate-500"}
            icon={
              <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            }
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>รายการชั่งล่าสุด</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              <SessionsTable sessions={recent.recentSessions} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>ข้อผิดพลาดล่าสุด</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              <ParseErrorsTable errors={recent.recentErrors} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
