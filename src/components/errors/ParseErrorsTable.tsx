import type { ParseErrorRow } from "@/types";
import { Badge } from "@/components/ui/Badge";

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

const ERROR_TYPE_THAI: Record<string, string> = {
  format_error:     "รูปแบบไม่ถูกต้อง",
  validation_error: "ข้อมูลไม่ถูกต้อง",
  unknown_format:   "รูปแบบไม่รู้จัก",
  parser_crash:     "ระบบขัดข้อง",
  timeout:          "หมดเวลา",
  unsupported_type: "ประเภทไม่รองรับ",
};

const ERROR_TYPE_VARIANT: Record<string, "error" | "warning" | "info" | "default"> = {
  format_error:     "warning",
  validation_error: "warning",
  unknown_format:   "default",
  parser_crash:     "error",
  timeout:          "error",
  unsupported_type: "info",
};

const TH = "px-4 py-2.5 text-left text-[0.6875rem] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap";

export function ParseErrorsTable({ errors }: { errors: ParseErrorRow[] }) {
  if (errors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <div className="flex size-12 items-center justify-center rounded-full bg-slate-100 mb-3">
          <svg className="size-6 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-slate-600">ไม่มีข้อผิดพลาด</p>
        <p className="text-xs mt-1 text-slate-400">ระบบทำงานปกติ ไม่พบข้อผิดพลาดในการประมวลผล</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-y border-slate-200">
            <th className={`${TH} hidden sm:table-cell`}>เวลา</th>
            <th className={TH}>ประเภทข้อผิดพลาด</th>
            <th className={TH}>รายละเอียด</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {errors.map((e) => (
            <tr key={e.id} className="hover:bg-[#06C755]/5 transition-colors">
              <td className="px-4 py-3 hidden sm:table-cell text-slate-500 whitespace-nowrap text-sm">
                {formatDate(e.created_at)}
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-sm">
                <Badge variant={ERROR_TYPE_VARIANT[e.error_type] ?? "default"} dot>
                  {ERROR_TYPE_THAI[e.error_type] ?? e.error_type}
                </Badge>
              </td>
              <td className="px-4 py-3 text-sm">
                <span className="text-slate-600 truncate max-w-sm block" title={e.error_message}>
                  {e.error_message}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
