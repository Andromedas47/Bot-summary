export default function HomeLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-16 border-b border-slate-200 bg-white px-6 flex items-center gap-3">
        <div className="h-4 w-36 rounded bg-slate-200" />
      </div>

      <div className="p-4 sm:p-6">
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="p-5 border-b border-slate-100 flex items-center justify-between">
            <div className="space-y-1.5">
              <div className="h-5 w-40 rounded bg-slate-200" />
              <div className="h-4 w-24 rounded bg-slate-100" />
            </div>
            <div className="flex gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-9 w-32 rounded-lg bg-slate-100" />
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-425">
              <thead>
                <tr className="bg-slate-100 border-b-2 border-slate-200">
                  {Array.from({ length: 17 }).map((_, i) => (
                    <th key={i} className="px-3 py-3">
                      <div className="h-3 rounded bg-slate-200" style={{ width: `${40 + (i % 4) * 20}px` }} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 20 }).map((_, r) => (
                  <tr key={r} className={`border-b border-slate-100 ${r % 2 === 0 ? "bg-white" : "bg-slate-50/50"}`}>
                    {Array.from({ length: 17 }).map((_, c) => (
                      <td key={c} className="px-3 py-2.5">
                        <div className="h-4 rounded bg-slate-100" style={{ width: `${30 + (c % 5) * 15}px` }} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
