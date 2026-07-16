"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isCorrectionApprover } from "@/lib/corrections/auth";
import {
  correctionMutationErrorMessage,
  parseCorrectionRequestForm,
  type CorrectionActionState,
} from "@/lib/corrections/request-validation";
import type { Json } from "@/types/database";

async function authenticatedUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("กรุณาเข้าสู่ระบบ");
  return { supabase, user };
}

function returnedCorrectionId(data: Json): string | null {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.id === "string" ? value.id : null;
}

function actionText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createCorrectionAction(
  _previousState: CorrectionActionState,
  formData: FormData,
): Promise<CorrectionActionState> {
  let correctionId: string | null = null;
  try {
    const input = parseCorrectionRequestForm(formData);
    const { supabase } = await authenticatedUser();
    const { data, error } = await supabase.rpc(
      "request_transaction_correction",
      {
        p_target_transaction_id: input.targetTransactionId,
        p_reason_type: input.reasonType,
        p_reason_detail: input.reasonDetail,
        p_requested_changes: input.requestedChanges as unknown as Json,
        p_idempotency_key: input.idempotencyKey,
        p_source_line_message_id: null,
        p_evidence_url: input.evidenceUrl,
      },
    );
    if (error) {
      return { error: correctionMutationErrorMessage(error) };
    }
    correctionId = returnedCorrectionId(data);
    if (!correctionId) {
      return { error: "ฐานข้อมูลไม่คืนรหัสคำขอแก้ไข" };
    }
  } catch (error) {
    return {
      error: correctionMutationErrorMessage({
        message: error instanceof Error ? error.message : undefined,
      }),
    };
  }
  redirect("/corrections/" + correctionId);
}

async function requireApprover() {
  const result = await authenticatedUser();
  if (!isCorrectionApprover(result.user.app_metadata)) {
    throw new Error("บัญชีนี้ไม่มีสิทธิ์อนุมัติหรือปฏิเสธรายการแก้ไข");
  }
  return result.supabase;
}

function revalidateCorrectionViews(id: string): void {
  revalidatePath("/");
  revalidatePath("/reports/compare");
  revalidatePath("/corrections");
  revalidatePath("/corrections/" + id);
}

export async function approveCorrectionAction(
  _previousState: CorrectionActionState,
  formData: FormData,
): Promise<CorrectionActionState> {
  const id = actionText(formData, "id");
  const targetVersion = actionText(formData, "targetVersion");
  if (!id || !targetVersion) return { error: "ข้อมูลคำขออนุมัติไม่ครบ" };

  try {
    const supabase = await requireApprover();
    const { error } = await supabase.rpc("approve_transaction_correction", {
      p_correction_id: id,
      p_expected_target_version: targetVersion,
    });
    if (error) return { error: correctionMutationErrorMessage(error) };
    revalidateCorrectionViews(id);
    return { error: null, success: "อนุมัติและนำ correction ไปใช้แล้ว" };
  } catch (error) {
    return {
      error: correctionMutationErrorMessage({
        message: error instanceof Error ? error.message : undefined,
      }),
    };
  }
}

export async function rejectCorrectionAction(
  _previousState: CorrectionActionState,
  formData: FormData,
): Promise<CorrectionActionState> {
  const id = actionText(formData, "id");
  const rejectionReason = actionText(formData, "rejectionReason");
  if (!id || rejectionReason.length < 3 || rejectionReason.length > 1000) {
    return { error: "กรุณาระบุเหตุผลที่ปฏิเสธ 3-1000 ตัวอักษร" };
  }

  try {
    const supabase = await requireApprover();
    const { error } = await supabase.rpc("reject_transaction_correction", {
      p_correction_id: id,
      p_rejection_reason: rejectionReason,
    });
    if (error) return { error: correctionMutationErrorMessage(error) };
    revalidateCorrectionViews(id);
    return { error: null, success: "ปฏิเสธคำขอแก้ไขแล้ว" };
  } catch (error) {
    return {
      error: correctionMutationErrorMessage({
        message: error instanceof Error ? error.message : undefined,
      }),
    };
  }
}
