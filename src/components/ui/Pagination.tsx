interface PaginationProps {
  page: number;
  totalPages: number;
  basePath: string;
  params?: Record<string, string | undefined>;
}

function href(
  basePath: string,
  params: Record<string, string | undefined>,
  page: number,
) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k !== "page" && v !== undefined) sp.set(k, v);
  }
  sp.set("page", String(page));
  return `${basePath}?${sp.toString()}`;
}

function pageRange(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4)  return [1, 2, 3, 4, 5, "…", total];
  if (current >= total - 3) return [1, "…", total - 4, total - 3, total - 2, total - 1, total];
  return [1, "…", current - 1, current, current + 1, "…", total];
}

const btnBase = "flex items-center gap-1 rounded-lg border px-3 py-1.5 min-h-11 sm:min-h-0 text-sm font-medium transition-all duration-150";
const btnActive = "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 shadow-sm";
const btnDisabled = "border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed";

function ChevronLeft() {
  return (
    <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

export function Pagination({ page, totalPages, basePath, params = {} }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-1 py-3 px-4">
      {page > 1 ? (
        <a href={href(basePath, params, page - 1)} className={`${btnBase} ${btnActive}`}>
          <ChevronLeft /> <span className="hidden sm:inline">ก่อน</span>
        </a>
      ) : (
        <span className={`${btnBase} ${btnDisabled}`}><ChevronLeft /> <span className="hidden sm:inline">ก่อน</span></span>
      )}

      {/* Mobile: "หน้า X / Y" */}
      <span className="sm:hidden px-3 text-sm text-slate-500">
        หน้า <span className="font-semibold text-slate-800">{page}</span> / {totalPages}
      </span>

      {/* Desktop: page number buttons */}
      <div className="hidden sm:flex items-center gap-1 mx-1">
        {pageRange(page, totalPages).map((p, i) =>
          p === "…" ? (
            <span key={`e${i}`} className="px-2 text-slate-400 text-sm">…</span>
          ) : (
            <a
              key={p}
              href={href(basePath, params, p)}
              className={`min-w-8 min-h-11 sm:min-h-0 rounded-lg px-2 py-1.5 text-center text-sm font-medium transition-all duration-150 ${
                p === page
                  ? "bg-[#06C755] text-white shadow-sm"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 shadow-sm"
              }`}
            >
              {p}
            </a>
          ),
        )}
      </div>

      {page < totalPages ? (
        <a href={href(basePath, params, page + 1)} className={`${btnBase} ${btnActive}`}>
          <span className="hidden sm:inline">ถัดไป</span> <ChevronRight />
        </a>
      ) : (
        <span className={`${btnBase} ${btnDisabled}`}><span className="hidden sm:inline">ถัดไป</span> <ChevronRight /></span>
      )}
    </div>
  );
}
