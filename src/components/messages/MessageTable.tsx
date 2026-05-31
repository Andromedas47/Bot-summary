import type { RawMessage } from "@/types";
import { Badge } from "@/components/ui/Badge";

interface MessageTableProps {
  events: RawMessage[];
}

const MESSAGE_TYPE_LABEL: Record<string, string> = {
  text:     "ข้อความ",
  image:    "รูปภาพ",
  video:    "วิดีโอ",
  audio:    "เสียง",
  file:     "ไฟล์",
  location: "ตำแหน่ง",
  sticker:  "สติกเกอร์",
};

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
  const label = MESSAGE_TYPE_LABEL[type] ?? type;
  return <Badge variant={map[type] ?? "default"}>{label}</Badge>;
}

function statusBadge(isProcessed: boolean) {
  return isProcessed
    ? <Badge variant="success">สำเร็จ</Badge>
    : <Badge variant="warning">รอดำเนินการ</Badge>;
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

const TH = "px-4 py-2.5 text-left text-[0.6875rem] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap";

export function MessageTable({ events }: MessageTableProps) {
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <div className="flex size-12 items-center justify-center rounded-full bg-slate-100 mb-3">
          <svg className="size-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-slate-600">ยังไม่มีข้อความ</p>
        <p className="text-xs mt-1 text-slate-400">ข้อความจาก LINE จะแสดงที่นี่เมื่อมีการส่งเข้ามา</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-y border-slate-200">
            <th className={TH}>ประเภท</th>
            <th className={`${TH} hidden sm:table-cell`}>ข้อความ</th>
            <th className={TH}>สถานะ</th>
            <th className={`${TH} hidden lg:table-cell`}>เวลา</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {events.map((msg) => (
            <tr key={msg.id} className="hover:bg-[#06C755]/5 transition-colors">
              <td className="px-4 py-3 text-sm">{messageTypeBadge(msg.message_type)}</td>
              <td className="px-4 py-3 hidden sm:table-cell text-sm">
                <span className="text-slate-600 truncate max-w-xs block">
                  {msg.raw_text ?? <span className="text-slate-300 italic">—</span>}
                </span>
              </td>
              <td className="px-4 py-3 text-sm">{statusBadge(msg.is_processed)}</td>
              <td className="px-4 py-3 hidden lg:table-cell text-slate-500 whitespace-nowrap text-sm">
                {formatDate(msg.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
