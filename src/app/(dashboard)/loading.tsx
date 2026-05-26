export default function OverviewLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-16 border-b border-slate-200 bg-white px-6 flex items-center gap-3">
        <div className="h-4 w-28 rounded bg-slate-200" />
      </div>

      <div className="p-4 sm:p-6 space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 rounded-xl bg-slate-100" />
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <div className="h-72 rounded-xl bg-slate-100" />
          <div className="h-72 rounded-xl bg-slate-100" />
        </div>
      </div>
    </div>
  );
}
