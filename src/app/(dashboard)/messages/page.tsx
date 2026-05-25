import { createClient } from "@/lib/supabase/server";
import { TopBar } from "@/components/dashboard/TopBar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { MessageTable } from "@/components/messages/MessageTable";
import type { RawMessage } from "@/types";
import type { LineEventType } from "@/types/database";

const VALID_EVENT_TYPES = new Set<LineEventType>([
  "message", "follow", "unfollow", "join", "leave",
  "memberJoined", "memberLeft", "postback", "beacon",
  "accountLink", "unsend", "videoPlayComplete",
]);

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{ page?: string; type?: string }>;
}

async function getMessages(page: number, type?: string) {
  const supabase = await createClient();
  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  const eventType = type && VALID_EVENT_TYPES.has(type as LineEventType)
    ? (type as LineEventType)
    : undefined;

  let query = supabase
    .from("raw_messages")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (eventType) query = query.eq("event_type", eventType);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    messages:   (data ?? []) as RawMessage[],
    total:      count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

export default async function MessagesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page   = Math.max(1, parseInt(params.page ?? "1", 10));
  const type   = params.type;

  const { messages, total, totalPages } = await getMessages(page, type);

  return (
    <>
      <TopBar title="Messages" />

      <div className="p-4 sm:p-6 space-y-4">
        <p className="text-sm text-slate-500">
          {total.toLocaleString()} message{total !== 1 ? "s" : ""}
        </p>

        <Card>
          <CardHeader>
            <CardTitle>All Messages</CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            <MessageTable events={messages} />
          </CardContent>
        </Card>

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
            <span className="text-sm text-slate-500">Page {page} of {totalPages}</span>
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
