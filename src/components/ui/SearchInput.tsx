"use client";

import { useRouter, usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface SearchInputProps {
  placeholder?: string;
  paramName?: string;
  defaultValue?: string;
  className?: string;
  label?: string;
}

export function SearchInput({
  placeholder = "ค้นหา…",
  paramName = "q",
  defaultValue = "",
  className = "w-full sm:w-48",
  label,
}: SearchInputProps) {
  const router   = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(defaultValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = useCallback(
    (v: string) => {
      const params = new URLSearchParams(window.location.search);
      if (v) { params.set(paramName, v); } else { params.delete(paramName); }
      params.delete("page");

      const targetSearch  = params.toString();
      const currentSearch = window.location.search.replace(/^\?/, "");
      if (targetSearch === currentSearch) return;

      router.replace(`${pathname}?${targetSearch}`);
    },
    [router, pathname, paramName],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push(value), 400);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, push]);

  return (
    <div className={`relative min-w-0 shrink-0 ${className}`}>
      <svg
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-slate-400"
        fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder ?? "ค้นหา"}
        className="h-11 sm:h-9 w-full rounded-lg border border-slate-300 bg-white py-0 pl-8 pr-3 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/15"
      />
    </div>
  );
}
