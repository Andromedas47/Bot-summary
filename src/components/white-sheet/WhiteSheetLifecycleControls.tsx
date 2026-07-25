"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 " +
  "placeholder:text-slate-400 focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/20";

function formatFinalizedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function WhiteSheetLifecycleControls({
  entryStatus,
  finalizedAt,
  finalizedBy,
  isPending = false,
  error = "",
  onFinalize,
  onReopen,
}: {
  entryStatus: "submitted" | "finalized" | "not_submitted";
  finalizedAt?: string | null;
  finalizedBy?: string | null;
  isPending?: boolean;
  error?: string;
  onFinalize: () => void | Promise<void>;
  onReopen: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState("");

  if (entryStatus === "not_submitted") {
    return (
      <section
        className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1"
        data-testid="white-sheet-lifecycle"
      >
        <h3 className="text-sm font-semibold text-slate-800">สถานะวงจรชีวิต</h3>
        <p className="text-sm text-slate-600" data-testid="white-sheet-lifecycle-state">
          ยังไม่ได้บันทึกค่าใช้จ่าย — บันทึกก่อนจึงจะยืนยันปิดยอดได้
        </p>
      </section>
    );
  }

  async function handleFinalize() {
    setLocalError("");
    await onFinalize();
  }

  async function handleReopen() {
    const trimmed = reason.normalize("NFC").trim();
    if (!trimmed) {
      setLocalError("ต้องระบุเหตุผลในการเปิดยอดอีกครั้ง");
      return;
    }
    setLocalError("");
    await onReopen(trimmed);
  }

  const displayError = localError || error;

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"
      data-testid="white-sheet-lifecycle"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-800">สถานะวงจรชีวิต</h3>
        {entryStatus === "submitted" ? (
          <p className="text-sm text-slate-600" data-testid="white-sheet-lifecycle-state">
            บันทึกแล้ว — รอผู้ดูแลระบบยืนยันปิดยอด
          </p>
        ) : (
          <div className="space-y-1 text-sm text-slate-600" data-testid="white-sheet-lifecycle-state">
            <p data-testid="white-sheet-lifecycle-finalized">ยืนยันปิดยอดแล้ว</p>
            {finalizedAt && (
              <p data-testid="white-sheet-lifecycle-finalized-at">
                เมื่อ: {formatFinalizedAt(finalizedAt)}
              </p>
            )}
            {finalizedBy && (
              <p data-testid="white-sheet-lifecycle-finalized-by">
                โดย: {finalizedBy}
              </p>
            )}
          </div>
        )}
      </div>

      {entryStatus === "submitted" && (
        <Button
          type="button"
          variant="primary"
          isLoading={isPending}
          disabled={isPending}
          onClick={handleFinalize}
          data-testid="white-sheet-finalize-button"
        >
          Finalize / ยืนยันปิดยอด
        </Button>
      )}

      {entryStatus === "finalized" && (
        <div className="space-y-2">
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            เหตุผลในการเปิดยอดอีกครั้ง
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isPending}
            rows={2}
            className={INPUT_CLS}
            placeholder="ระบุเหตุผล (บังคับ)"
            data-testid="white-sheet-reopen-reason"
          />
          <Button
            type="button"
            variant="secondary"
            isLoading={isPending}
            disabled={isPending}
            onClick={handleReopen}
            data-testid="white-sheet-reopen-button"
          >
            Reopen / เปิดยอดอีกครั้ง
          </Button>
        </div>
      )}

      {displayError && (
        <p
          className="text-sm font-medium text-red-600"
          role="alert"
          data-testid="white-sheet-lifecycle-error"
        >
          {displayError}
        </p>
      )}
    </section>
  );
}
