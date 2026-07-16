"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { buildAfterSnapshot } from "@/lib/corrections/effective-transactions";
import { getCorrectionTarget } from "@/lib/corrections/data";
import { isCorrectionApprover } from "@/lib/corrections/auth";
import { CORRECTION_REASON_TYPES, type CorrectionReasonType } from "@/lib/corrections/types";
import type { Json } from "@/types/database";

function text(formData: FormData, key: string): string { return String(formData.get(key) ?? "").trim(); }
function numberValue(formData: FormData, key: string): number | undefined {
  const value = text(formData, key);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${key} ไม่ถูกต้อง`);
  return parsed;
}

async function authenticatedUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("กรุณาเข้าสู่ระบบ");
  return { supabase, user };
}

export async function createCorrectionAction(formData: FormData) {
  const { supabase, user } = await authenticatedUser();
  const transactionId = text(formData, "transactionId");
  const submittedVersion = text(formData, "targetVersion");
  const reasonType = text(formData, "reasonType") as CorrectionReasonType;
  const reasonDetail = text(formData, "reasonDetail");
  if (!CORRECTION_REASON_TYPES.includes(reasonType)) throw new Error("กรุณาเลือกประเภทเหตุผล");
  if (reasonDetail.length < 3) throw new Error("กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร");

  const target = await getCorrectionTarget(transactionId);
  if (target.targetVersion !== submittedVersion) throw new Error("stale version conflict: รายการถูกแก้ไขแล้ว กรุณาเปิดหน้าใหม่");
  const after = buildAfterSnapshot(target.current, {
    productName: text(formData, "productName") || undefined,
    quantity: numberValue(formData, "quantity"),
    unit: text(formData, "unit") || undefined,
    priceAmount: numberValue(formData, "priceAmount"),
    priceQuantity: numberValue(formData, "priceQuantity"),
    duplicate: formData.get("duplicate") === "on",
  });
  const requestKey = text(formData, "requestKey") || randomUUID();
  const { data, error } = await supabase.from("transaction_corrections").insert({
    target_transaction_id: transactionId,
    reason_type: reasonType,
    reason_detail: reasonDetail,
    before_snapshot: target.current as unknown as Json,
    after_snapshot: after as unknown as Json,
    requested_by: user.id,
    supersedes_correction_id: target.supersedesCorrectionId,
    source_line_message_id: target.current.sourceLineMessageId,
    evidence_url: text(formData, "evidenceUrl") || null,
    target_version: target.targetVersion,
    request_key: requestKey,
  }).select("id").single();
  if (error) {
    if (error.code === "23505" && error.message.includes("request_key")) {
      const retry = await supabase.from("transaction_corrections").select("id").eq("request_key", requestKey).single();
      if (retry.data) redirect(`/corrections/${retry.data.id}`);
    }
    throw new Error(error.message);
  }
  redirect(`/corrections/${data.id}`);
}

async function requireApprover() {
  const result = await authenticatedUser();
  if (!isCorrectionApprover(result.user.app_metadata)) throw new Error("ไม่มีสิทธิ์อนุมัติหรือปฏิเสธรายการแก้ไข");
  return result.supabase;
}

export async function approveCorrectionAction(formData: FormData) {
  const supabase = await requireApprover();
  const id = text(formData, "id");
  const { error } = await supabase.rpc("approve_transaction_correction", { p_correction_id: id, p_expected_target_version: text(formData, "targetVersion") });
  if (error) throw new Error(error.message);
  revalidatePath("/"); revalidatePath("/reports/compare"); revalidatePath("/corrections"); revalidatePath(`/corrections/${id}`);
}

export async function rejectCorrectionAction(formData: FormData) {
  const supabase = await requireApprover();
  const id = text(formData, "id");
  const { error } = await supabase.rpc("reject_transaction_correction", { p_correction_id: id, p_rejection_reason: text(formData, "rejectionReason") });
  if (error) throw new Error(error.message);
  revalidatePath("/corrections"); revalidatePath(`/corrections/${id}`);
}
