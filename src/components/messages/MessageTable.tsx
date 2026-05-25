import type { RawMessage } from "@/types";
import { Badge } from "@/components/ui/Badge";

interface MessageTableProps {
  events: RawMessage[];
}

function messageTypeBadge(type: string | null) {
  if (!type) return <Badge variant="default">—</Badge>;
  const map: Record<string, "info" | "success" | "warning" | "default"> = {
    text:     "info",
    image:    "success",
    video:    "success",
    audio:    "success",
    file:     "warning",
    location: "default",
    sticker:  "default",
  };
  return <Badge variant={map[type] ?? "default"}>{type}</Badge>;
}

function eventTypeBadge(type: string) {
  const map: Record<string, "success" | "info" | "warning" | "error" | "default"> = {
    message:  "success",
    follow:   "info",
    unfollow: "warning",
    join:     "info",
    leave:    "warning",
    postback: "default",
  };
  return <Badge variant={map[type] ?? "default"}>{type}</Badge>;
}

function processedBadge(isProcessed: boolean) {
  return isProcessed
    ? <Badge variant="success">done</Badge>
    : <Badge variant="warning">pending</Badge>;
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function MessageTable({ events }: MessageTableProps) {
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <svg className="size-12 mb-3" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
        </svg>
        <p className="text-sm font-medium">No messages yet</p>
        <p className="text-xs mt-1">Messages will appear here when your webhook receives LINE events.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left">
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Event</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Msg type</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap hidden sm:table-cell">Text preview</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Status</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap hidden md:table-cell">Source</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap hidden lg:table-cell">Received</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {events.map((msg) => (
            <tr key={msg.id} className="hover:bg-slate-50 transition-colors">
              <td className="px-4 py-3">{eventTypeBadge(msg.event_type)}</td>
              <td className="px-4 py-3">{messageTypeBadge(msg.message_type)}</td>
              <td className="px-4 py-3 hidden sm:table-cell">
                <span className="text-slate-600 truncate max-w-45 block">
                  {msg.raw_text ?? <span className="text-slate-300 italic">—</span>}
                </span>
              </td>
              <td className="px-4 py-3">{processedBadge(msg.is_processed)}</td>
              <td className="px-4 py-3 hidden md:table-cell">
                <Badge variant="default">{msg.source_type}</Badge>
              </td>
              <td className="px-4 py-3 hidden lg:table-cell text-slate-500 whitespace-nowrap">
                {formatDate(msg.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
