import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { CorrectionDecisionForms } from "@/components/corrections/CorrectionDecisionForms";
import { getCorrectionAuditRecord } from "@/lib/corrections/data";
import { mapCorrectionAuditDetail } from "@/lib/corrections/audit-detail";
import { createClient } from "@/lib/supabase/server";
import { isCorrectionApprover } from "@/lib/corrections/auth";

interface PageProps {
  params: Promise<{ id: string }>;
}

const statusPresentation = {
  pending: ["รออนุมัติ", "bg-amber-100 text-amber-900"],
  approved: ["อนุมัติแล้ว", "bg-emerald-100 text-emerald-900"],
  rejected: ["ปฏิเสธ", "bg-red-100 text-red-900"],
  superseded: ["ถูกแทนที่", "bg-slate-200 text-slate-800"],
  cancelled: ["ยกเลิก", "bg-slate-200 text-slate-800"],
} as const;

const reasonLabel = {
  wrong_price: "ราคาผิด",
  wrong_quantity: "จำนวนผิด",
  wrong_unit: "หน่วยผิด",
  wrong_product: "ชื่อสินค้าผิด",
  duplicate: "รายการซ้ำ",
  other: "อื่น ๆ",
} as const;

function money(value: number): string {
  return value.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function number(value: number): string {
  return value.toLocaleString("th-TH", { maximumFractionDigits: 3 });
}

function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("th-TH") : "—";
}

function actor(value: string | null): string {
  return value ?? "—";
}

function ComparisonRow({
  label,
  before,
  after,
  important = false,
}: {
  label: string;
  before: string;
  after: string;
  important?: boolean;
}) {
  return (
    <div className={important ? "grid gap-2 rounded-lg bg-amber-50 p-3 sm:grid-cols-[9rem_1fr_1fr]" : "grid gap-2 border-b border-slate-100 py-3 last:border-0 sm:grid-cols-[9rem_1fr_1fr]"}>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div><span className="mr-2 text-xs text-slate-400 sm:hidden">ก่อน</span>{before}</div>
      <div className={important ? "font-semibold text-amber-950" : "font-medium text-slate-900"}><span className="mr-2 text-xs font-normal text-slate-400 sm:hidden">หลัง</span>{after}</div>
    </div>
  );
}

function AuditItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 p-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm text-slate-900">{children}</dd>
    </div>
  );
}

export default async function CorrectionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const record = await getCorrectionAuditRecord(id);
  if (!record) notFound();
  const audit = mapCorrectionAuditDetail(record.correction, record.supersededById);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const canApprove = isCorrectionApprover(user?.app_metadata);
  const [statusText, statusClass] = statusPresentation[audit.status];

  return (
    <>
      <DashboardTopBar title="รายละเอียดการปรับแก้" />
      <main className="p-4 sm:p-6">
        <div className="mx-auto max-w-5xl space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500">รหัสคำขอ {audit.id}</p>
                <h1 className="mt-1 text-xl font-bold text-slate-900">{audit.afterProductName}</h1>
                <p className="mt-1 break-all text-sm text-slate-500">รายการต้นทาง {audit.targetTransactionId}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-sm font-semibold ${statusClass}`}>{statusText}</span>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-900">ข้อมูลก่อนและหลังแก้ไข</h2>
            <div className="mt-4 hidden grid-cols-[9rem_1fr_1fr] gap-2 border-b border-slate-200 pb-2 text-xs font-semibold text-slate-500 sm:grid">
              <span>ข้อมูล</span><span>ก่อนแก้ไข</span><span>หลังแก้ไข</span>
            </div>
            <ComparisonRow label="ชื่อสินค้า" before={audit.beforeProductName} after={audit.afterProductName} />
            <ComparisonRow label="จำนวน" before={`${number(audit.beforeQuantity)} ${audit.beforeUnit}`} after={`${number(audit.afterQuantity)} ${audit.afterUnit}`} />
            <ComparisonRow label="หน่วย" before={audit.beforeUnit} after={audit.afterUnit} />
            <ComparisonRow label="ราคา" before={`${money(audit.beforePriceAmount)} บาท / ${number(audit.beforePriceQuantity)} ${audit.beforeUnit}`} after={`${money(audit.afterPriceAmount)} บาท / ${number(audit.afterPriceQuantity)} ${audit.afterUnit}`} important />
            <ComparisonRow label="ยอดรวม" before={`${money(audit.beforeTotalAmount)} บาท`} after={audit.afterVoided ? "ตัดออกจากยอด (รายการซ้ำ)" : `${money(audit.afterTotalAmount)} บาท`} important />
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="text-xs font-medium text-amber-800">ผลกระทบทางการเงิน</div>
              <div className="mt-1 text-xl font-bold tabular-nums text-amber-950">{audit.financialDelta > 0 ? "+" : ""}{money(audit.financialDelta)} บาท</div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-900">เหตุผลและหลักฐาน</h2>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <AuditItem label="ประเภทเหตุผล">{reasonLabel[audit.reasonType]}</AuditItem>
              <AuditItem label="รายละเอียดเหตุผล">{audit.reasonDetail}</AuditItem>
              <AuditItem label="ข้อความ LINE ต้นทาง">{audit.sourceLineMessageId ?? "—"}</AuditItem>
              <AuditItem label="หลักฐาน">{audit.evidenceUrl ? <a href={audit.evidenceUrl} target="_blank" rel="noreferrer" className="text-emerald-700 underline underline-offset-2">เปิดหลักฐาน</a> : "—"}</AuditItem>
            </dl>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-900">ประวัติการตรวจสอบ</h2>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <AuditItem label="ผู้แจ้ง">{actor(audit.requestedBy)}</AuditItem>
              <AuditItem label="เวลาที่แจ้ง">{dateTime(audit.requestedAt)}</AuditItem>
              <AuditItem label="Target version">{audit.targetVersion}</AuditItem>
              <AuditItem label="ผู้อนุมัติ">{actor(audit.approvedBy)}</AuditItem>
              <AuditItem label="เวลาที่อนุมัติ">{dateTime(audit.approvedAt)}</AuditItem>
              <AuditItem label="Snapshot ก่อน/หลัง">{audit.beforeSourceVersion} / {audit.afterSourceVersion}</AuditItem>
              <AuditItem label="ผู้ปฏิเสธ">{actor(audit.rejectedBy)}</AuditItem>
              <AuditItem label="เวลาที่ปฏิเสธ">{dateTime(audit.rejectedAt)}</AuditItem>
              <AuditItem label="เหตุผลที่ปฏิเสธ">{audit.rejectionReason ?? "—"}</AuditItem>
              <AuditItem label="แทนที่คำขอ">{audit.supersedesCorrectionId ? <Link href={`/corrections/${audit.supersedesCorrectionId}`} className="text-emerald-700 underline underline-offset-2">{audit.supersedesCorrectionId}</Link> : "—"}</AuditItem>
              <AuditItem label="ถูกแทนที่โดย">{audit.supersededById ? <Link href={`/corrections/${audit.supersededById}`} className="text-emerald-700 underline underline-offset-2">{audit.supersededById}</Link> : "—"}</AuditItem>
              <AuditItem label="สถานะใน snapshot">{audit.afterVoided ? "ตัดรายการซ้ำออกจาก effective view" : "นำรายการหลังแก้ไขไปใช้เมื่ออนุมัติ"}</AuditItem>
            </dl>
          </section>

          {audit.status === "pending" && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-slate-900">การอนุมัติ</h2>
              <p className="mt-1 text-sm text-slate-600">ระบบฐานข้อมูลจะตรวจรายการต้นทาง, snapshot, ราคาและยอดรวมซ้ำแบบ atomic ก่อนเปลี่ยนสถานะ</p>
              {canApprove ? (
                <CorrectionDecisionForms correctionId={audit.id} targetVersion={audit.targetVersion} />
              ) : (
                <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">บัญชีนี้ดูประวัติได้ แต่ไม่มีสิทธิ์อนุมัติหรือปฏิเสธ ระบบจะตรวจสิทธิ์ซ้ำที่ Server Action และฐานข้อมูล</p>
              )}
            </section>
          )}
        </div>
      </main>
    </>
  );
}
