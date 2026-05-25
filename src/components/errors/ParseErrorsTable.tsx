import type { ParseErrorRow } from "@/types";
import { Badge } from "@/components/ui/Badge";

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

const errorTypeBadge: Record<string, "error" | "warning" | "info" | "default"> = {
  format_error:     "warning",
  validation_error: "warning",
  unknown_format:   "default",
  parser_crash:     "error",
  timeout:          "error",
  unsupported_type: "info",
};

export function ParseErrorsTable({ errors }: { errors: ParseErrorRow[] }) {
  if (errors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <svg className="size-12 mb-3" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
        <p className="text-sm font-medium">No parse errors</p>
        <p className="text-xs mt-1">All messages have been parsed successfully.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left">
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap hidden sm:table-cell">Time</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Parser</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Type</th>
            <th className="px-4 py-3 font-medium text-slate-600">Message</th>
            <th className="px-4 py-3 font-medium text-slate-600 whitespace-nowrap hidden lg:table-cell">Version</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {errors.map((e) => (
            <tr key={e.id} className="hover:bg-slate-50 transition-colors">
              <td className="px-4 py-3 hidden sm:table-cell text-slate-500 whitespace-nowrap">
                {formatDate(e.created_at)}
              </td>
              <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">
                {e.parser_name}
              </td>
              <td className="px-4 py-3">
                <Badge variant={errorTypeBadge[e.error_type] ?? "default"}>{e.error_type}</Badge>
              </td>
              <td className="px-4 py-3">
                <span className="text-slate-600 truncate max-w-sm block" title={e.error_message}>
                  {e.error_message}
                </span>
              </td>
              <td className="px-4 py-3 hidden lg:table-cell text-slate-400 text-xs">
                {e.parser_version}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
