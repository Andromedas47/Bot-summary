import { createClient } from "@/lib/supabase/server";
import { TopBar } from "@/components/dashboard/TopBar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { MessageTable } from "@/components/messages/MessageTable";
import type { RawEvent } from "@/types";

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{ page?: string; type?: string }>;
}

async function getEvents(page: number, type?: string) {
  const supabase = await createClient();
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("line_raw_events")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (type) {
    query = query.eq("event_type", type);
  }

  const { data, count, error } = await query;

  if (error) throw new Error(error.message);

  return {
    events: (data ?? []) as RawEvent[],
    total: count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

export default async function MessagesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const type = params.type;

  const { events, total, totalPages } = await getEvents(page, type);

  return (
    <>
      <TopBar title="Messages" />

      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {total.toLocaleString()} total event{total !== 1 ? "s" : ""}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Events</CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            <MessageTable events={events} />
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-2">
            {page > 1 && (
              <a
                href={`/messages?page=${page - 1}${type ? `&type=${type}` : ""}`}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Previous
              </a>
            )}
            <span className="text-sm text-slate-500">
              Page {page} of {totalPages}
            </span>
            {page < totalPages && (
              <a
                href={`/messages?page=${page + 1}${type ? `&type=${type}` : ""}`}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Next
              </a>
            )}
          </div>
        )}
      </div>
    </>
  );
}
