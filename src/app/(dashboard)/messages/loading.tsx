export default function MessagesLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-16 border-b border-slate-200 bg-white px-6 flex items-center gap-3">
        <div className="h-4 w-24 rounded bg-slate-200" />
      </div>

      <div className="p-4 sm:p-6">
        <div className="rounded-xl bg-slate-100 h-[calc(100vh-8rem)]" />
      </div>
    </div>
  );
}
