"use client";

import { useId, useState } from "react";

export function FilterPanel({
  exportButton,
  children,
}: {
  exportButton: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="flex flex-col gap-2 w-full xl:w-auto">
      {/* Mobile top row */}
      <div className="flex items-center gap-2 xl:hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex flex-1 items-center justify-center gap-2 h-11 sm:h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <svg className="size-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591L15.75 12.5V19.5a.75.75 0 0 1-.437.688l-3 1.5a.75.75 0 0 1-1.063-.688V12.5L4.659 7.409A2.25 2.25 0 0 1 4 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />
          </svg>
          ตัวกรอง
          <svg
            className={`size-3.5 text-slate-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
          </svg>
        </button>
        {exportButton}
      </div>

      {/* Filter inputs */}
      <div
        id={panelId}
        className={`${
          open ? "flex" : "hidden"
        } flex-wrap items-center gap-2 xl:flex xl:flex-nowrap xl:items-center`}
      >
        {children}
        <div className="hidden xl:block">{exportButton}</div>
      </div>
    </div>
  );
}
