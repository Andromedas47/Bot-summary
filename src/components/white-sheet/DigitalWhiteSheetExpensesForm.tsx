"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import type { DigitalWhiteSheetSummary } from "@/lib/white-sheet";
import type { WhiteSheetExpenseInput } from "./types";
import {
  parseWhiteSheetMoneyInput,
  validateWhiteSheetExpensesInput,
} from "./white-sheet-presentation";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 " +
  "placeholder:text-slate-400 focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/20";

function expenseDefaults(
  viewModel?: Pick<DigitalWhiteSheetSummary, "expenses" | "actualCashSubmitted">,
): WhiteSheetExpenseInput {
  return {
    labor: viewModel?.expenses.labor ?? 0,
    locationFee: viewModel?.expenses.locationFee ?? 0,
    bag: viewModel?.expenses.bag ?? 0,
    snack: viewModel?.expenses.snack ?? 0,
    other: viewModel?.expenses.other ?? 0,
    otherNote: viewModel?.expenses.otherNote ?? "",
    actualCashSubmitted: viewModel?.actualCashSubmitted ?? 0,
  };
}

export function DigitalWhiteSheetExpensesForm({
  viewModel,
  onSubmitExpenses,
  isSubmitting = false,
}: {
  viewModel?: Pick<DigitalWhiteSheetSummary, "expenses" | "actualCashSubmitted">;
  onSubmitExpenses: (input: WhiteSheetExpenseInput) => void | Promise<void>;
  isSubmitting?: boolean;
}) {
  const [form, setForm] = useState<WhiteSheetExpenseInput>(() => expenseDefaults(viewModel));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [pending, startTransition] = useTransition();

  function updateNumberField(
    key: keyof Omit<WhiteSheetExpenseInput, "otherNote">,
    raw: string,
  ) {
    const parsed = parseWhiteSheetMoneyInput(raw);
    setForm((prev) => ({ ...prev, [key]: parsed }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleSubmit() {
    setSubmitError("");
    const validation = validateWhiteSheetExpensesInput(form);
    if (!validation.valid) {
      setFieldErrors(validation.errors);
      return;
    }

    startTransition(async () => {
      try {
        await onSubmitExpenses({
          ...form,
          otherNote: form.otherNote?.trim() || undefined,
        });
      } catch {
        setSubmitError("บันทึกไม่สำเร็จ กรุณาลองใหม่");
      }
    });
  }

  const loading = isSubmitting || pending;

  return (
    <div className="space-y-4 max-w-lg" data-testid="white-sheet-expenses-form">
      <div className="grid grid-cols-2 gap-4">
        {(
          [
            ["labor", "ค่าแรง"],
            ["locationFee", "ค่าที่"],
            ["bag", "ค่าถุง"],
            ["snack", "ค่าขนม"],
            ["other", "ค่าใช้จ่ายอื่น"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
              {label}
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={Number.isFinite(form[key]) && form[key] !== 0 ? form[key] : ""}
              placeholder="0"
              onChange={(e) => updateNumberField(key, e.target.value)}
              className={INPUT_CLS + " text-right tabular-nums"}
              aria-invalid={fieldErrors[key] ? true : undefined}
            />
            {fieldErrors[key] && (
              <p className="text-xs text-red-600" role="alert">
                {fieldErrors[key]}
              </p>
            )}
          </div>
        ))}

        <div className="col-span-2 space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
            หมายเหตุค่าใช้จ่ายอื่น
          </label>
          <textarea
            value={form.otherNote ?? ""}
            onChange={(e) => setForm((prev) => ({ ...prev, otherNote: e.target.value }))}
            placeholder="หมายเหตุ (ถ้ามี)"
            rows={2}
            className={INPUT_CLS + " resize-none"}
          />
        </div>

        <div className="col-span-2 space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
            เงินสดส่งจริง
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={
              Number.isFinite(form.actualCashSubmitted) && form.actualCashSubmitted !== 0
                ? form.actualCashSubmitted
                : ""
            }
            placeholder="0"
            onChange={(e) => updateNumberField("actualCashSubmitted", e.target.value)}
            className={INPUT_CLS + " text-right tabular-nums"}
            aria-invalid={fieldErrors.actualCashSubmitted ? true : undefined}
          />
          {fieldErrors.actualCashSubmitted && (
            <p className="text-xs text-red-600" role="alert">
              {fieldErrors.actualCashSubmitted}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button isLoading={loading} onClick={handleSubmit}>
          บันทึกค่าใช้จ่าย
        </Button>
        {submitError && (
          <span className="text-sm font-medium text-red-600" role="alert">
            {submitError}
          </span>
        )}
      </div>
    </div>
  );
}
