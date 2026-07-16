import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { CorrectionForm } from "@/components/corrections/CorrectionForm";
import { getCorrectionTarget } from "@/lib/corrections/data";
import { snapshotFromTransaction } from "@/lib/corrections/effective-transactions";

interface PageProps { searchParams: Promise<{ transactionId?: string; view?: string }> }
function money(value: number): string { return value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default async function NewCorrectionPage({ searchParams }: PageProps) {
  const { transactionId, view } = await searchParams;
  if (!transactionId) notFound();
  const target = await getCorrectionTarget(transactionId);
  const rawSnapshot = snapshotFromTransaction(target.raw);
  const shown = view === "original" ? rawSnapshot : target.current;
  return <><DashboardTopBar title={view === "original" ? "รายการต้นฉบับ" : "แจ้งแก้ไขรายการ"} /><main className="p-4 sm:p-6"><div className="mx-auto max-w-4xl rounded-xl border border-slate-200 bg-white shadow-sm"><header className="border-b border-slate-200 p-5"><div className="flex items-start justify-between gap-4"><div><h1 className="text-lg font-bold text-slate-900">{shown.productName} · {shown.transactionType}</h1><p className="mt-1 text-sm text-slate-500">{shown.transactionDate} · {shown.staffName} · {shown.marketName}</p></div><Link href="/corrections" className="text-sm text-slate-500 hover:underline">กลับรายการแก้ไข</Link></div><div className="mt-4 grid gap-2 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-4"><div>จำนวน <b>{shown.quantity} {shown.unit}</b></div><div>ราคา <b>{money(shown.priceAmount)} / {shown.priceQuantity} {shown.unit}</b></div><div>ยอด <b>{money(shown.totalAmount)}</b></div><div>รหัสต้นฉบับ <b className="font-mono text-xs">{transactionId.slice(0, 8)}…</b></div></div></header><div className="p-5">{view === "original" ? <div className="space-y-3"><p className="text-sm text-slate-600">หน้านี้แสดงข้อมูลต้นฉบับที่ไม่ถูกแก้ทับ</p><Link href={`/corrections/new?transactionId=${transactionId}`} className="inline-flex rounded-lg bg-[#06C755] px-4 py-2 text-sm font-semibold text-white">แจ้งแก้ไข</Link></div> : <CorrectionForm transactionId={transactionId} snapshot={target.current} />}</div></div></main></>;
}
