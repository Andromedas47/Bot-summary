export default function ErrorsLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-16 border-b border-slate-200 bg-white px-6 flex items-center gap-3">
        <div className="h-4 w-28 rounded bg-slate-200" />
      </div>

      <div className="p-4 sm:p-6 space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 rounded-xl bg-slate-100" />
          ))}
        </div>
        <div className="h-96 rounded-xl bg-slate-100" />
      </div>
    </div>
  );
}
