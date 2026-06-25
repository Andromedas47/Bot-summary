import type { WorkRoundStatus } from "@/types/database";

const STATUS_LABEL: Record<WorkRoundStatus, string> = {
  open:                 "เปิดอยู่",
  produce_complete:     "รายการสินค้าครบ",
  awaiting_settlement:  "รอยอดส่งเงิน",
  awaiting_evidence:    "รอหลักฐาน",
  variance_found:       "ยอดไม่ตรง",
  ready_for_review:     "พร้อมตรวจ",
  approved:             "อนุมัติแล้ว",
  needs_correction:     "ต้องแก้ไข",
};

const STATUS_CLASS: Record<WorkRoundStatus, string> = {
  open:                 "bg-blue-100 text-blue-800",
  produce_complete:     "bg-indigo-100 text-indigo-800",
  awaiting_settlement:  "bg-yellow-100 text-yellow-800",
  awaiting_evidence:    "bg-orange-100 text-orange-800",
  variance_found:       "bg-red-100 text-red-800",
  ready_for_review:     "bg-purple-100 text-purple-800",
  approved:             "bg-green-100 text-green-800",
  needs_correction:     "bg-rose-100 text-rose-800",
};

export function WorkRoundStatusBadge({ status }: { status: WorkRoundStatus }) {
  const label = STATUS_LABEL[status] ?? status;
  const cls   = STATUS_CLASS[status] ?? "bg-slate-100 text-slate-800";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
