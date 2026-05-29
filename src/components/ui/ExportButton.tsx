"use client";

import { useSearchParams } from "next/navigation";

interface ExportButtonProps {
  exportPath: string;
  label?: string;
}

export function ExportButton({ exportPath, label = "Export CSV" }: ExportButtonProps) {
  const searchParams = useSearchParams();
  const qs = searchParams.toString();
  const href = qs ? `${exportPath}?${qs}` : exportPath;

  return (
    <a
      href={href}
      download
      className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
    >
      <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
      {label}
    </a>
  );
}
