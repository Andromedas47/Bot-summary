import { Suspense } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { timed } from "@/lib/supabase/timing";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { ExportButton } from "@/components/ui/ExportButton";
import { MessageTable } from "@/components/messages/MessageTable";
import type { RawMessage } from "@/types";
import type { LineEventType } from "@/types/database";

const PAGE_SIZE = 50;

const VALID_EVENT_TYPES = new Set<LineEventType>([
  "message", "follow", "unfollow", "join", "leave",
  "memberJoined", "memberLeft", "postback", "beacon",
  "accountLink", "unsend", "videoPlayComplete",
]);

const PROCESSED_OPTIONS = [
  { value: "yes", label: "ประมวลแล้ว" },
  { value: "no",  label: "รอดำเนินการ" },
];

interface PageProps {
  searchParams: Promise<{ page?: string; type?: string; q?: string; processed?: string }>;
}

async function getMessages(
  page: number,
  q?: string,
  type?: string,
  processed?: string,
) {
  const supabase  = await createServiceClient();
  const from      = (page - 1) * PAGE_SIZE;
  const to        = from + PAGE_SIZE - 1;
  const eventType = type && VALID_EVENT_TYPES.has(type as LineEventType)
    ? (type as LineEventType)
    : undefined;

  let query = supabase
    .from("raw_messages")
    .select("id,event_type,message_type,raw_text,is_processed,source_type,created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (q)                   query = query.ilike("raw_text", `%${q}%`);
  if (eventType)           query = query.eq("event_type", eventType);
  if (processed === "yes") query = query.eq("is_processed", true);
  if (processed === "no")  query = query.eq("is_processed", false);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    messages:   (data ?? []) as RawMessage[],
    total:      count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

export default async function AdminMessagesPage({ searchParams }: PageProps) {
  const params    = await searchParams;
  const page      = Math.max(1, parseInt(params.page ?? "1", 10));
  const q         = params.q;
  const type      = params.type;
  const processed = params.processed;

  const { messages, total, totalPages } = await timed("messages:list", () =>
    getMessages(page, q, type, processed),
  );

  return (
    <>
      <DashboardTopBar title="ข้อความดิบ LINE" />

      <div className="p-4 sm:p-6 space-y-4">
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>ข้อความทั้งหมด</CardTitle>
                <p className="text-sm text-slate-500 mt-0.5">
                  {total.toLocaleString()} ข้อความ
                  {q ? ` ที่ตรงกับ "${q}"` : ""}
                </p>
              </div>

              <Suspense fallback={<div className="h-9 w-48 animate-pulse rounded-lg bg-slate-100" />}>
                <div className="flex flex-wrap items-center gap-2">
                  <SearchInput placeholder="ค้นหาข้อความ…" defaultValue={q ?? ""} />
                  <FilterSelect
                    label="สถานะ"
                    paramName="processed"
                    options={PROCESSED_OPTIONS}
                  />
                  <ExportButton exportPath="/api/export/messages" />
                </div>
              </Suspense>
            </div>
          </CardHeader>

          <CardContent className="p-0 pb-2">
            <MessageTable events={messages} />
            <Pagination
              page={page}
              totalPages={totalPages}
              basePath="/admin/messages"
              params={{ q, type, processed }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
