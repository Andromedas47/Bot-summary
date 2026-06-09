import type {
  SlipCheckStatus,
  SlipExtraction,
  SlipType,
} from "@/lib/slips/extraction-schema";

const THAI_MONTHS = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

export function buildSlipLineSummary(
  extraction: SlipExtraction,
  status: SlipCheckStatus,
): string {
  if (status === "NEED_REVIEW" || status === "FAILED") {
    return [
      "🔴 อ่านข้อมูลไม่ครบ",
      "",
      "ระบบไม่เห็นยอดเงิน / เวลา / เลขอ้างอิงครบถ้วน",
      "กรุณาส่งรูปใหม่ให้เห็นทั้งหน้า หรือให้แอดมินตรวจมือ",
    ].join("\n");
  }

  if (extraction.slipType === "THAI_HELP_THAI" || extraction.slipType === "GWALLET") {
    return compactLines([
      "🟡 อ่านข้อมูลจากรูปแล้ว",
      "",
      `ประเภท ${formatSlipType(extraction.slipType)}`,
      amountLine("ยอดสินค้า", extraction.grossAmount),
      amountLine("ส่วนลด/สิทธิ", extraction.discountAmount),
      amountLine("ยอดชำระจริง", extraction.paidAmount),
      textLine("ร้าน/ผู้รับ", extraction.receiverName),
      textLine("เวลา", formatBangkokTransactionTime(extraction.transactionTime)),
      textLine("เลขอ้างอิง", extraction.referenceId),
      "",
      "สถานะ อ่านข้อมูลได้จากภาพ ยังไม่ใช่การยืนยันจากธนาคาร",
    ]);
  }

  return compactLines([
    "🟡 อ่านข้อมูลจากสลิปแล้ว",
    "",
    `ประเภท ${formatSlipType(extraction.slipType)}`,
    amountLine("ยอดโอน", extraction.transferAmount),
    textLine("ผู้โอน", extraction.senderName),
    textLine("ผู้รับ", extraction.receiverName),
    textLine("บัญชีผู้รับลงท้าย", extraction.receiverAccountTail),
    textLine("เวลา", formatBangkokTransactionTime(extraction.transactionTime)),
    textLine("เลขอ้างอิง", extraction.referenceId),
    "",
    "สถานะ อ่านข้อมูลได้จากภาพ รอตรวจสอบขั้นถัดไป",
  ]);
}

export function formatBangkokTransactionTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = numberPart("year");
  const month = numberPart("month");
  const day = numberPart("day");
  const hour = numberPart("hour");
  const minute = numberPart("minute");

  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  return `${day} ${THAI_MONTHS[month - 1]} ${year + 543} ${pad(hour)}:${pad(minute)}`;
}

function formatSlipType(type: SlipType): string {
  switch (type) {
    case "THAI_HELP_THAI":
      return "ไทยช่วยไทย";
    case "GWALLET":
      return "G-Wallet";
    case "BANK_SLIP_QR":
      return "สลิปโอนเงิน (มี QR)";
    case "BANK_SLIP_NO_QR":
      return "สลิปโอนเงิน";
    default:
      return "หลักฐานการชำระเงิน";
  }
}

function amountLine(label: string, value: number | null): string | null {
  return value === null
    ? null
    : `${label} ${value.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`;
}

function textLine(label: string, value: string | null): string | null {
  return value ? `${label} ${value}` : null;
}

function compactLines(lines: Array<string | null>): string {
  return lines.filter((line): line is string => line !== null).join("\n");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
