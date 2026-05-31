"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

interface ExportButtonProps {
  exportPath: string;
  label?: string;
  downloadName?: string;
}

export function ExportButton({ exportPath, label = "Export CSV", downloadName }: ExportButtonProps) {
  const searchParams = useSearchParams();
  const [isExporting, setIsExporting] = useState(false);
  const qs = searchParams.toString();
  const href = qs ? `${exportPath}?${qs}` : exportPath;

  async function handleExport() {
    if (isExporting) return;
    setIsExporting(true);

    try {
      const res = await fetch(href, { credentials: "same-origin" });
      const contentType = res.headers.get("content-type") ?? "";

      if (!res.ok || contentType.includes("text/html") || contentType.includes("application/json")) {
        const detail = contentType.includes("application/json") || contentType.includes("text/html")
          ? await res.text()
          : `HTTP ${res.status}`;
        throw new Error(detail);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const headerName = disposition.match(/filename="([^"]+)"/)?.[1];
      const filename = downloadName ?? headerName ?? "export";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("export failed", err);
      const message = err instanceof Error ? err.message : "Unknown export error";
      alert(`Export failed: ${message}`);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={isExporting}
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap h-11 sm:h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors disabled:opacity-60"
    >
      {isExporting ? (
        <svg className="size-3.5 animate-spin text-slate-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg className="size-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
      )}
      {isExporting ? "กำลังโหลด…" : label}
    </button>
  );
}
