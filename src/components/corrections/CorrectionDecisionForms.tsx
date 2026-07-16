"use client";

import { useActionState } from "react";
import {
  approveCorrectionAction,
  rejectCorrectionAction,
} from "@/app/(dashboard)/corrections/actions";

export function CorrectionDecisionForms({
  correctionId,
  targetVersion,
}: {
  correctionId: string;
  targetVersion: string;
}) {
  const [approveState, approveAction, approving] = useActionState(
    approveCorrectionAction,
    { error: null },
  );
  const [rejectState, rejectAction, rejecting] = useActionState(
    rejectCorrectionAction,
    { error: null },
  );

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <form action={approveAction} className="space-y-3">
        <input type="hidden" name="id" value={correctionId} />
        <input type="hidden" name="targetVersion" value={targetVersion} />
        <button
          disabled={approving || rejecting}
          className="h-11 w-full cursor-pointer rounded-lg bg-[#06C755] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#05b34d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {approving ? "กำลังตรวจสอบและอนุมัติ…" : "อนุมัติและนำไปใช้"}
        </button>
        {approveState.error && (
          <p role="alert" className="text-sm text-red-700">
            {approveState.error}
          </p>
        )}
        {approveState.success && (
          <p aria-live="polite" className="text-sm text-emerald-700">
            {approveState.success}
          </p>
        )}
      </form>

      <form action={rejectAction} className="space-y-3">
        <input type="hidden" name="id" value={correctionId} />
        <label className="block text-sm font-medium text-slate-700">
          เหตุผลที่ปฏิเสธ
          <textarea
            name="rejectionReason"
            required
            minLength={3}
            maxLength={1000}
            rows={2}
            className="mt-1 block w-full rounded-lg border border-slate-300 p-3 text-base outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 sm:text-sm"
          />
        </label>
        <button
          disabled={approving || rejecting}
          className="h-11 w-full cursor-pointer rounded-lg bg-red-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {rejecting ? "กำลังปฏิเสธ…" : "ปฏิเสธคำขอ"}
        </button>
        {rejectState.error && (
          <p role="alert" className="text-sm text-red-700">
            {rejectState.error}
          </p>
        )}
        {rejectState.success && (
          <p aria-live="polite" className="text-sm text-emerald-700">
            {rejectState.success}
          </p>
        )}
      </form>
    </div>
  );
}
