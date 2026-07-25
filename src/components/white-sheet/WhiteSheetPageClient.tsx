"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import type { DigitalWhiteSheetSummary } from "@/lib/white-sheet";
import { DigitalWhiteSheetPanel } from "./DigitalWhiteSheetPanel";
import type { WhiteSheetExpenseInput } from "./types";
import { postWhiteSheetLifecycle } from "./white-sheet-lifecycle-client";

interface DigitalWhiteSheetPageModelResponse {
  entryStatus: "submitted" | "finalized" | "not_submitted";
  summary: DigitalWhiteSheetSummary;
  finalizedAt: string | null;
  finalizedBy: string | null;
}

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 " +
  "placeholder:text-slate-400 focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/20";

export function WhiteSheetPageClient({
  initial,
}: {
  initial?: {
    sourceId: string;
    market: string;
    date: string;
    pageModel: DigitalWhiteSheetPageModelResponse;
  };
}) {
  const [sourceId, setSourceId] = useState(initial?.sourceId ?? "");
  const [market, setMarket] = useState(initial?.market ?? "");
  const [date, setDate] = useState(initial?.date ?? "");
  const [pageModel, setPageModel] = useState<DigitalWhiteSheetPageModelResponse | null>(
    initial?.pageModel ?? null,
  );
  const [loadError, setLoadError] = useState("");
  const [lifecycleError, setLifecycleError] = useState("");
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const lifecyclePendingRef = useRef(false);
  const [loading, startLoad] = useTransition();

  async function fetchPageModel(): Promise<void> {
    setLoadError("");
    const params = new URLSearchParams({ sourceId, market, date });
    const res = await fetch(`/api/white-sheet?${params}`);
    const json = (await res.json()) as DigitalWhiteSheetPageModelResponse & { error?: string };
    if (!res.ok) {
      setLoadError(json.error ?? "โหลดข้อมูลไม่สำเร็จ");
      setPageModel(null);
      return;
    }
    setPageModel({
      entryStatus: json.entryStatus,
      summary: json.summary,
      finalizedAt: json.finalizedAt ?? null,
      finalizedBy: json.finalizedBy ?? null,
    });
  }

  function handleLoad() {
    if (!sourceId.trim() || !market.trim() || !date.trim()) {
      setLoadError("กรุณากรอก Source ID, ตลาด และวันที่ให้ครบ");
      return;
    }
    startLoad(fetchPageModel);
  }

  async function handleSubmitExpenses(input: WhiteSheetExpenseInput): Promise<void> {
    const res = await fetch("/api/white-sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId,
        market,
        date,
        labor: input.labor,
        locationFee: input.locationFee,
        bag: input.bag,
        snack: input.snack,
        other: input.other,
        otherNote: input.otherNote,
        actualCashSubmitted: input.actualCashSubmitted,
      }),
    });
    const json = (await res.json()) as DigitalWhiteSheetPageModelResponse & { error?: string };
    if (!res.ok) {
      throw new Error(json.error ?? "บันทึกไม่สำเร็จ");
    }
    setPageModel({
      entryStatus: json.entryStatus,
      summary: json.summary,
      finalizedAt: json.finalizedAt ?? null,
      finalizedBy: json.finalizedBy ?? null,
    });
  }

  async function runLifecycle(action: "finalize" | "reopen", reason?: string): Promise<void> {
    // Ref guard blocks duplicate in-flight clicks before React re-renders
    // the disabled button state.
    if (lifecyclePendingRef.current) return;
    lifecyclePendingRef.current = true;
    setLifecyclePending(true);
    setLifecycleError("");
    try {
      const result = await postWhiteSheetLifecycle(
        action,
        { sourceId, market, date },
        { reason },
      );
      if (!result.ok) {
        setLifecycleError(result.error);
        return;
      }
      await fetchPageModel();
    } finally {
      lifecyclePendingRef.current = false;
      setLifecyclePending(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
            Source ID
          </label>
          <input
            type="text"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            placeholder="LINE source id"
            className={INPUT_CLS}
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
            ตลาด
          </label>
          <input
            type="text"
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            placeholder="ชื่อตลาด"
            className={INPUT_CLS}
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
            วันที่
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
        <Button isLoading={loading} onClick={handleLoad}>
          โหลดใบขาวดิจิทัล
        </Button>
      </div>

      {loadError && (
        <p className="text-sm font-medium text-red-600" role="alert">
          {loadError}
        </p>
      )}

      {pageModel ? (
        <DigitalWhiteSheetPanel
          viewModel={pageModel.summary}
          entryStatus={pageModel.entryStatus}
          finalizedAt={pageModel.finalizedAt}
          finalizedBy={pageModel.finalizedBy}
          onSubmitExpenses={handleSubmitExpenses}
          lifecyclePending={lifecyclePending}
          lifecycleError={lifecycleError}
          onFinalize={() => runLifecycle("finalize")}
          onReopen={(reason) => runLifecycle("reopen", reason)}
        />
      ) : (
        !loadError && (
          <p className="text-sm text-slate-500">
            กรอก Source ID, ตลาด และวันที่ด้านบน แล้วกดโหลด เพื่อดูใบขาวดิจิทัล
          </p>
        )
      )}
    </div>
  );
}
