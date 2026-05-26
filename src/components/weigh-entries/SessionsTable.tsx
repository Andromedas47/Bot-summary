import type { ProduceSession } from "@/types";
import { Badge } from "@/components/ui/Badge";

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function SessionsTable({ sessions }: { sessions: ProduceSession[] }) {
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <svg className="size-12 mb-3" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0 0 12 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 0 1-2.031.352 5.988 5.988 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971Zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 0 1-2.031.352 5.989 5.989 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971Z" />
        </svg>
        <p className="text-sm font-medium">ยังไม่มีรายการชั่ง</p>
        <p className="text-xs mt-1">รายการจะแสดงที่นี่เมื่อมีการชั่งผ่าน LINE</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left">
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap hidden sm:table-cell">วันที่</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap">เจ้าหน้าที่</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap hidden md:table-cell">รอบชั่ง</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap text-right">รายการ</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap">สถานะ</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap hidden lg:table-cell">บันทึกเมื่อ</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sessions.map((s) => {
            const errorCount = Array.isArray(s.parser_errors) ? s.parser_errors.length : 0;
            return (
              <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3.5 hidden sm:table-cell text-slate-600 whitespace-nowrap">
                  {s.session_date ?? <span className="text-slate-300">—</span>}
                </td>
                <td className="px-4 py-3.5 font-medium text-slate-900">{s.staff_name}</td>
                <td className="px-4 py-3.5 hidden md:table-cell">
                  <span className="text-slate-600 truncate max-w-48 block">
                    {s.session_title ?? <span className="text-slate-300 italic">—</span>}
                  </span>
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-slate-700 font-medium">
                  {s.total_items}
                </td>
                <td className="px-4 py-3.5">
                  {errorCount > 0 ? (
                    <Badge variant="warning">มีปัญหา {errorCount}</Badge>
                  ) : (
                    <Badge variant="success">ปกติ</Badge>
                  )}
                </td>
                <td className="px-4 py-3.5 hidden lg:table-cell text-slate-500 whitespace-nowrap">
                  {formatDate(s.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
