"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface FilterSelectProps {
  label: string;
  paramName: string;
  options: { value: string; label: string }[];
  allLabel?: string;
}

export function FilterSelect({ label, paramName, options, allLabel = "ทั้งหมด" }: FilterSelectProps) {
  const router       = useRouter();
  const pathname     = usePathname();
  const searchParams = useSearchParams();
  const current      = searchParams.get(paramName) ?? "";

  const onChange = useCallback(
    (v: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (v) { params.set(paramName, v); } else { params.delete(paramName); }
      params.delete("page");
      router.replace(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams, paramName],
  );

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs font-medium text-slate-500 whitespace-nowrap">{label}</label>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-lg border border-slate-300 bg-white pl-3 pr-7 text-sm text-slate-900 transition-colors focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/15"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
