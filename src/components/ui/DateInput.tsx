"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface DateInputProps {
  defaultValue?: string;
  paramName?: string;
}

export function DateInput({ defaultValue = "", paramName = "date" }: DateInputProps) {
  const router       = useRouter();
  const pathname     = usePathname();
  const searchParams = useSearchParams();

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
    <input
      type="date"
      defaultValue={defaultValue}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-slate-300 bg-white py-2 px-3 text-sm text-slate-900 focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/20"
    />
  );
}
