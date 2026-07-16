import { notFound } from "next/navigation";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { approveCorrectionAction, rejectCorrectionAction } from "@/app/(dashboard)/corrections/actions";
import { getCorrection } from "@/lib/corrections/data";
import { createClient } from "@/lib/supabase/server";
import { isCorrectionApprover } from "@/lib/corrections/auth";

interface PageProps { params: Promise<{ id: string }> }
function money(value: number): string { return value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default async function CorrectionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const correction = await getCorrection(id);
  if (!correction) notFound();
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  const canApprove = isCorrectionApprover(user?.app_metadata);
  const before = correction.before_snapshot, after = correction.after_snapshot;
  return <><DashboardTopBar title="รายละเอียดการปรับแก้" /><main className="p-4 sm:p-6"><div className="mx-auto max-w-4xl space-y-4"><section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><div><h1 className="text-xl font-bold text-slate-900">{after.productName}</h1><p className="mt-1 text-sm text-slate-500">{before.transactionDate} · {before.staffName} · {before.marketName} · {before.transactionType}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold">{correction.status}</span></div><div className="mt-5 grid gap-4 sm:grid-cols-3"><div className="rounded-lg bg-slate-50 p-4"><div className="text-xs text-slate-500">ราคา</div><div className="mt-1 font-semibold">{money(before.priceAmount)} → {money(after.priceAmount)}</div></div><div className="rounded-lg bg-slate-50 p-4"><div className="text-xs text-slate-500">จำนวน</div><div className="mt-1 font-semibold">{before.quantity} {before.unit} → {after.quantity} {after.unit}</div></div><div className="rounded-lg bg-amber-50 p-4"><div className="text-xs text-amber-700">ผลกระทบยอด</div><div className="mt-1 font-semibold text-amber-950">{money(after.totalAmount - before.totalAmount)} บาท</div></div></div><dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">เหตุผล</dt><dd>{correction.reason_type} — {correction.reason_detail}</dd></div><div><dt className="text-slate-500">ผู้แจ้ง</dt><dd className="font-mono">{correction.requested_by}</dd></div><div><dt className="text-slate-500">ผู้อนุมัติ</dt><dd className="font-mono">{correction.approved_by ?? '—'}</dd></div><div><dt className="text-slate-500">เวลา</dt><dd>{new Date(correction.requested_at).toLocaleString('th-TH')}</dd></div></dl></section>{correction.status === 'pending' && <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold text-slate-900">การอนุมัติ</h2>{canApprove ? <div className="mt-4 grid gap-3 sm:grid-cols-2"><form action={approveCorrectionAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="targetVersion" value={correction.target_version} /><button className="h-10 w-full rounded-lg bg-[#06C755] px-4 text-sm font-semibold text-white">อนุมัติและนำไปใช้</button></form><form action={rejectCorrectionAction} className="flex gap-2"><input type="hidden" name="id" value={id} /><input name="rejectionReason" required minLength={3} placeholder="เหตุผลที่ปฏิเสธ" className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3" /><button className="h-10 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white">ปฏิเสธ</button></form></div> : <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">บัญชีนี้ดูประวัติได้ แต่ไม่มีสิทธิ์อนุมัติ ระบบจะตรวจสิทธิ์ซ้ำที่เซิร์ฟเวอร์และฐานข้อมูล</p>}</section>}</div></main></>;
}
