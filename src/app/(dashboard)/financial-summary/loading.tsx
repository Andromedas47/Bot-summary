export default function FinancialSummaryLoading() {
  return (
    <div className="p-4 sm:p-6 space-y-5 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-9 w-28 rounded-lg bg-slate-100" />
        <div className="h-5 w-40 rounded bg-slate-200" />
        <div className="h-9 w-28 rounded-lg bg-slate-100" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-slate-50 rounded-lg">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <div className="h-3 w-14 rounded bg-slate-200" />
            <div className="h-7 w-20 rounded bg-slate-200" />
          </div>
        ))}
      </div>

      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-32 rounded bg-slate-200" />
          <div className="h-40 rounded-lg border border-slate-200 bg-slate-50" />
        </div>
      ))}
    </div>
  );
}
