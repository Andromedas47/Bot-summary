"use client";

import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { SignOutButton } from "@/components/auth/SignOutButton";

interface TopBarProps {
  title: string;
  userEmail?: string | null;
}

export function TopBar({ title, userEmail }: TopBarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full shadow-xl">
            <Sidebar onClose={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
        {/* Mobile menu toggle */}
        <button
          type="button"
          className="rounded-lg p-2 min-h-11 min-w-11 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors lg:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="เปิดเมนู"
          aria-expanded={mobileOpen}
        >
          <svg className="size-4.5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>

        <h1 className="text-base font-semibold text-slate-800 tracking-tight">{title}</h1>

        <div className="ml-auto flex items-center gap-2">
          {/* Webhook status indicator */}
          <div className="hidden sm:flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200/60">
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            เชื่อมต่อแล้ว
          </div>

          {userEmail && (
            <span className="hidden md:block text-xs text-slate-400 max-w-36 truncate">
              {userEmail}
            </span>
          )}

          <SignOutButton />
        </div>
      </header>
    </>
  );
}
