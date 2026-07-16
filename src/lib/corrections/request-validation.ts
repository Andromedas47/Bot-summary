import {
  CORRECTION_REASON_TYPES,
  type CorrectionDraftChanges,
  type CorrectionReasonType,
} from "@/lib/corrections/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)$/;

export interface ParsedCorrectionRequest {
  targetTransactionId: string;
  reasonType: CorrectionReasonType;
  reasonDetail: string;
  requestedChanges: CorrectionDraftChanges;
  evidenceUrl: string | null;
  idempotencyKey: string;
}

export interface CorrectionActionState {
  error: string | null;
  success?: string | null;
}

function entryText(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(key + " ต้องเป็นข้อความ");
  return value;
}

function requiredText(
  formData: FormData,
  key: string,
  min: number,
  max: number,
): string {
  const value = entryText(formData, key)?.trim() ?? "";
  if (value.length < min || value.length > max) {
    throw new Error(key + " ต้องมีความยาว " + min + "-" + max + " ตัวอักษร");
  }
  return value;
}

function optionalText(
  formData: FormData,
  key: string,
  max: number,
): string | undefined {
  const raw = entryText(formData, key);
  if (raw == null) return undefined;
  const value = raw.trim();
  if (!value || value.length > max) {
    throw new Error(key + " ต้องไม่ว่างและยาวไม่เกิน " + max + " ตัวอักษร");
  }
  return value;
}

function optionalNumber(
  formData: FormData,
  key: string,
  min: number,
  max: number,
  inclusiveMin: boolean,
): number | undefined {
  const raw = entryText(formData, key);
  if (raw == null) return undefined;
  const value = raw.trim();
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(key + " ต้องเป็นตัวเลขเท่านั้น");
  }
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed)
    || (inclusiveMin ? parsed < min : parsed <= min)
    || parsed > max
  ) {
    const comparison = inclusiveMin ? "ไม่น้อยกว่า" : "มากกว่า";
    throw new Error(
      key + " ต้อง" + comparison + " " + min + " และไม่เกิน " + max,
    );
  }
  return parsed;
}

function requiredUuid(formData: FormData, key: string): string {
  const value = requiredText(formData, key, 36, 36);
  if (!UUID_PATTERN.test(value)) throw new Error(key + " ไม่ถูกต้อง");
  return value;
}

export function parseCorrectionRequestForm(
  formData: FormData,
): ParsedCorrectionRequest {
  const targetTransactionId = requiredUuid(formData, "transactionId");
  const idempotencyKey = requiredUuid(formData, "requestKey");
  const reasonType = requiredText(formData, "reasonType", 3, 30);
  if (!CORRECTION_REASON_TYPES.includes(reasonType as CorrectionReasonType)) {
    throw new Error("กรุณาเลือกประเภทเหตุผลที่ถูกต้อง");
  }
  const typedReason = reasonType as CorrectionReasonType;
  const reasonDetail = requiredText(formData, "reasonDetail", 3, 1000);

  const rawDuplicate = entryText(formData, "duplicate");
  if (
    rawDuplicate != null
    && rawDuplicate !== "on"
    && rawDuplicate !== "true"
  ) {
    throw new Error("duplicate ต้องเป็น boolean");
  }
  const duplicate = rawDuplicate != null;
  const fieldKeys = [
    "productName",
    "quantity",
    "unit",
    "priceAmount",
    "priceQuantity",
  ] as const;
  if (duplicate && fieldKeys.some((key) => formData.has(key))) {
    throw new Error("รายการซ้ำต้องไม่ส่งการแก้ค่าอื่นร่วมด้วย");
  }

  const requestedChanges: CorrectionDraftChanges = duplicate
    ? { duplicate: true }
    : {
        productName: optionalText(formData, "productName", 200),
        quantity: optionalNumber(formData, "quantity", 0, 1_000_000, false),
        unit: optionalText(formData, "unit", 50),
        priceAmount: optionalNumber(
          formData,
          "priceAmount",
          0,
          1_000_000,
          true,
        ),
        priceQuantity: optionalNumber(
          formData,
          "priceQuantity",
          0.001,
          1_000_000,
          true,
        ),
      };

  for (const key of Object.keys(requestedChanges) as Array<
    keyof CorrectionDraftChanges
  >) {
    if (requestedChanges[key] === undefined) delete requestedChanges[key];
  }
  if (Object.keys(requestedChanges).length === 0) {
    throw new Error("กรุณาเปลี่ยนอย่างน้อยหนึ่งค่า");
  }
  if (typedReason === "duplicate" && !duplicate) {
    throw new Error("เหตุผลรายการซ้ำต้องเลือกยกเลิกรายการซ้ำ");
  }
  if (typedReason !== "duplicate" && duplicate) {
    throw new Error("การยกเลิกรายการซ้ำต้องใช้เหตุผลรายการซ้ำ");
  }

  const evidenceText = entryText(formData, "evidenceUrl")?.trim() ?? "";
  let evidenceUrl: string | null = null;
  if (evidenceText) {
    if (evidenceText.length > 2048) {
      throw new Error("URL หลักฐานยาวเกิน 2048 ตัวอักษร");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(evidenceText);
    } catch {
      throw new Error("URL หลักฐานไม่ถูกต้อง");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("URL หลักฐานต้องเป็น http หรือ https");
    }
    evidenceUrl = parsedUrl.toString();
  }

  return {
    targetTransactionId,
    reasonType: typedReason,
    reasonDetail,
    requestedChanges,
    evidenceUrl,
    idempotencyKey,
  };
}

export function correctionMutationErrorMessage(error: {
  code?: string;
  message?: string;
}): string {
  const message = error.message ?? "";
  if (error.code === "42501" || message.includes("not authorized")) {
    return "บัญชีนี้ไม่มีสิทธิ์ดำเนินการ";
  }
  if (error.code === "40001" || message.includes("stale")) {
    return "รายการต้นทางเปลี่ยนแล้ว กรุณาเปิดหน้าใหม่และตรวจสอบอีกครั้ง";
  }
  if (error.code === "23505") {
    return message.includes("pending")
      ? "รายการนี้มีคำขอแก้ไขที่รออนุมัติอยู่แล้ว"
      : "คำขอนี้ถูกส่งไปแล้ว ระบบจะไม่สร้างรายการซ้ำ";
  }
  if (error.code === "P0002" || message.includes("not found")) {
    return "ไม่พบรายการต้นทางที่ต้องการแก้ไข";
  }
  if (message.includes("voided")) {
    return "รายการนี้ถูกยกเลิกแล้วและไม่สามารถแก้ไขซ้ำได้";
  }
  if (message.includes("malformed") || message.includes("invalid")) {
    return "ข้อมูลคำขอไม่ถูกต้อง กรุณาตรวจสอบค่าที่กรอก";
  }
  return message || "ไม่สามารถดำเนินการคำขอแก้ไขได้";
}
