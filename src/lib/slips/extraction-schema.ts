import type { Json } from "@/types/database";

export const SLIP_CHECK_STATUSES = [
  "PROCESSING",
  "EXTRACTED",
  "PARTIAL_EXTRACTED",
  "NEED_REVIEW",
  "FAILED",
] as const;

export const SLIP_TYPES = [
  "BANK_SLIP_QR",
  "BANK_SLIP_NO_QR",
  "THAI_HELP_THAI",
  "GWALLET",
  "NUMBERS_ONLY",
  "WHITE_PAPER",
  "UNKNOWN",
] as const;

export type SlipCheckStatus = (typeof SLIP_CHECK_STATUSES)[number];
export type SlipType = (typeof SLIP_TYPES)[number];

export interface SlipExtraction {
  slipType: SlipType;
  grossAmount: number | null;
  discountAmount: number | null;
  paidAmount: number | null;
  transferAmount: number | null;
  referenceId: string | null;
  transactionTime: string | null;
  senderName: string | null;
  receiverName: string | null;
  receiverAccountTail: string | null;
  confidence: number;
}

export const SLIP_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    slip_type: { type: "string", enum: SLIP_TYPES },
    gross_amount: { type: ["number", "null"], minimum: 0 },
    discount_amount: { type: ["number", "null"], minimum: 0 },
    paid_amount: { type: ["number", "null"], minimum: 0 },
    transfer_amount: { type: ["number", "null"], minimum: 0 },
    reference_id: { type: ["string", "null"] },
    transaction_time: {
      type: ["string", "null"],
      description: "ISO 8601 timestamp with an explicit UTC offset when visible.",
    },
    sender_name: { type: ["string", "null"] },
    receiver_name: { type: ["string", "null"] },
    receiver_account_tail: {
      type: ["string", "null"],
      description: "Only the visible last four account digits, never a full account number.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "slip_type",
    "gross_amount",
    "discount_amount",
    "paid_amount",
    "transfer_amount",
    "reference_id",
    "transaction_time",
    "sender_name",
    "receiver_name",
    "receiver_account_tail",
    "confidence",
  ],
} as const;

export function parseSlipExtraction(value: unknown): SlipExtraction {
  if (!isRecord(value)) throw new Error("Extractor returned a non-object result");

  return {
    slipType: parseSlipType(value.slip_type),
    grossAmount: parseNullableAmount(value.gross_amount),
    discountAmount: parseNullableAmount(value.discount_amount),
    paidAmount: parseNullableAmount(value.paid_amount),
    transferAmount: parseNullableAmount(value.transfer_amount),
    referenceId: parseNullableText(value.reference_id),
    transactionTime: parseNullableTimestamp(value.transaction_time),
    senderName: parseNullableText(value.sender_name),
    receiverName: parseNullableText(value.receiver_name),
    receiverAccountTail: parseAccountTail(value.receiver_account_tail),
    confidence: parseConfidence(value.confidence),
  };
}

export function determineSlipCheckStatus(extraction: SlipExtraction): SlipCheckStatus {
  const hasTime = extraction.transactionTime !== null;
  const hasReference = extraction.referenceId !== null;
  const hasReceiver = extraction.receiverName !== null;

  if (extraction.slipType === "BANK_SLIP_QR" || extraction.slipType === "BANK_SLIP_NO_QR") {
    if (extraction.transferAmount !== null && hasTime && hasReference) return "EXTRACTED";
    if (
      extraction.transferAmount !== null
      && (hasTime || hasReference || hasReceiver)
    ) return "PARTIAL_EXTRACTED";
    return "NEED_REVIEW";
  }

  if (extraction.slipType === "THAI_HELP_THAI" || extraction.slipType === "GWALLET") {
    if (
      extraction.grossAmount !== null
      && extraction.discountAmount !== null
      && extraction.paidAmount !== null
      && hasTime
      && hasReference
    ) return "EXTRACTED";
    if (
      extraction.paidAmount !== null
      && (hasTime || hasReference || hasReceiver)
    ) return "PARTIAL_EXTRACTED";
    return "NEED_REVIEW";
  }

  return "NEED_REVIEW";
}

export function extractionToJson(extraction: SlipExtraction): Json {
  return {
    slip_type: extraction.slipType,
    gross_amount: extraction.grossAmount,
    discount_amount: extraction.discountAmount,
    paid_amount: extraction.paidAmount,
    transfer_amount: extraction.transferAmount,
    reference_id: extraction.referenceId,
    transaction_time: extraction.transactionTime,
    sender_name: extraction.senderName,
    receiver_name: extraction.receiverName,
    receiver_account_tail: extraction.receiverAccountTail,
    confidence: extraction.confidence,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSlipType(value: unknown): SlipType {
  return typeof value === "string" && SLIP_TYPES.includes(value as SlipType)
    ? value as SlipType
    : "UNKNOWN";
}

function parseNullableAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parseNullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseNullableTimestamp(value: unknown): string | null {
  const text = parseNullableText(value);
  if (!text) return null;

  const normalized = normalizeVisibleThaiTimestamp(text);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

const THAI_MONTHS: Record<string, number> = {
  "ม.ค.": 1,
  "มกราคม": 1,
  "ก.พ.": 2,
  "กุมภาพันธ์": 2,
  "มี.ค.": 3,
  "มีนาคม": 3,
  "เม.ย.": 4,
  "เมษายน": 4,
  "พ.ค.": 5,
  "พฤษภาคม": 5,
  "มิ.ย.": 6,
  "มิถุนายน": 6,
  "ก.ค.": 7,
  "กรกฎาคม": 7,
  "ส.ค.": 8,
  "สิงหาคม": 8,
  "ก.ย.": 9,
  "กันยายน": 9,
  "ต.ค.": 10,
  "ตุลาคม": 10,
  "พ.ย.": 11,
  "พฤศจิกายน": 11,
  "ธ.ค.": 12,
  "ธันวาคม": 12,
};

function normalizeVisibleThaiTimestamp(text: string): string {
  const trimmed = text.trim();

  const thaiMonthMatch = /^(\d{1,2})\s+([\u0E00-\u0E7F.]+)\s+(\d{2}|\d{4})(?:\s+(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?\s*(?:น\.?)?)?$/.exec(trimmed);
  if (thaiMonthMatch) {
    const day = parseInt(thaiMonthMatch[1], 10);
    const month = THAI_MONTHS[thaiMonthMatch[2]];
    const year = normalizeThaiYear(parseInt(thaiMonthMatch[3], 10));
    const hour = parseInt(thaiMonthMatch[4] ?? "0", 10);
    const minute = parseInt(thaiMonthMatch[5] ?? "0", 10);
    const second = parseInt(thaiMonthMatch[6] ?? "0", 10);
    if (month && isValidDateTimeParts(year, month, day, hour, minute, second)) {
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+07:00`;
    }
  }

  const compactIsoMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})$/.exec(trimmed);
  if (compactIsoMatch) {
    const year = normalizeThaiYear(parseInt(compactIsoMatch[1], 10));
    const month = parseInt(compactIsoMatch[2], 10);
    const day = parseInt(compactIsoMatch[3], 10);
    const hour = parseInt(compactIsoMatch[4], 10);
    const minute = parseInt(compactIsoMatch[5], 10);
    const second = parseInt(compactIsoMatch[6], 10);
    if (isValidDateTimeParts(year, month, day, hour, minute, second)) {
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${normalizeOffset(compactIsoMatch[7])}`;
    }
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(T.*)$/.exec(trimmed);
  if (isoMatch) {
    const year = normalizeThaiYear(parseInt(isoMatch[1], 10));
    return `${year}-${isoMatch[2]}-${isoMatch[3]}${normalizeColonlessOffset(isoMatch[4])}`;
  }

  return normalizeColonlessOffset(trimmed);
}

function normalizeThaiYear(year: number): number {
  const fullYear = year < 100 ? year + 2500 : year;
  return fullYear > 2400 ? fullYear - 543 : fullYear;
}

function isValidDateTimeParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (year < 1900 || year > 2200) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function normalizeOffset(offset: string): string {
  if (offset === "Z") return "Z";
  return offset.includes(":") ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
}

function normalizeColonlessOffset(text: string): string {
  return text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseAccountTail(value: unknown): string | null {
  const text = parseNullableText(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function parseConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}
