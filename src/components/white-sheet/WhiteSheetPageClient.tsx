"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { formatBusinessDateThai } from "@/lib/white-sheet/business-date-display";
import type { DigitalWhiteSheetSummary } from "@/lib/white-sheet";
import {
  whiteSheetMarketScopeKey,
  type WhiteSheetMarketScopeOption,
} from "@/lib/white-sheet/market-scopes";
import { DigitalWhiteSheetPanel } from "./DigitalWhiteSheetPanel";
import type { WhiteSheetExpenseInput } from "./types";
import { postWhiteSheetLifecycle } from "./white-sheet-lifecycle-client";
import {
  buildWhiteSheetLoadScope,
  fetchWhiteSheetMarketScopes,
} from "./white-sheet-scope-client";

interface DigitalWhiteSheetPageModelResponse {
  entryStatus: "submitted" | "finalized" | "not_submitted";
  summary: DigitalWhiteSheetSummary;
  finalizedAt: string | null;
  finalizedBy: string | null;
}

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 " +
  "placeholder:text-slate-400 focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/20";

function todayBangkokIso(): string {
  // Asia/Bangkok calendar date for the default picker value only.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return y && m && d ? `${y}-${m}-${d}` : "";
}

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
  const [date, setDate] = useState(initial?.date ?? todayBangkokIso());
  const [options, setOptions] = useState<WhiteSheetMarketScopeOption[]>([]);
  const [selectedKey, setSelectedKey] = useState(() =>
    initial?.sourceId && initial?.market
      ? whiteSheetMarketScopeKey(initial.sourceId, initial.market)
      : "",
  );
  const [scopesError, setScopesError] = useState("");
  const [scopesLoading, setScopesLoading] = useState(false);

  const [useAdvancedSource, setUseAdvancedSource] = useState(false);
  const [advancedSourceId, setAdvancedSourceId] = useState(initial?.sourceId ?? "");
  const [advancedMarket, setAdvancedMarket] = useState(initial?.market ?? "");

  const [sourceId, setSourceId] = useState(initial?.sourceId ?? "");
  const [market, setMarket] = useState(initial?.market ?? "");

  const [pageModel, setPageModel] = useState<DigitalWhiteSheetPageModelResponse | null>(
    initial?.pageModel ?? null,
  );
  const [loadError, setLoadError] = useState("");
  const [lifecycleError, setLifecycleError] = useState("");
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const lifecyclePendingRef = useRef(false);
  const [loading, startLoad] = useTransition();

  const thaiDateLabel = formatBusinessDateThai(date);

  useEffect(() => {
    let cancelled = false;
    async function loadScopes() {
      if (!date.trim()) {
        setOptions([]);
        return;
      }
      setScopesLoading(true);
      setScopesError("");
      const result = await fetchWhiteSheetMarketScopes(date);
      if (cancelled) return;
      setScopesLoading(false);
      if (!result.ok) {
        setOptions([]);
        setScopesError(result.error);
        return;
      }
      setOptions(result.options);
      if (result.options.length === 0) {
        setScopesError("ไม่พบตลาดที่มีข้อมูลชั่งสำหรับวันที่นี้");
        setSelectedKey("");
        return;
      }
      setScopesError("");
      setSelectedKey((prev) => {
        if (prev && result.options.some(
          (o) => whiteSheetMarketScopeKey(o.sourceId, o.marketLabel) === prev,
        )) {
          return prev;
        }
        if (result.options.length === 1) {
          return whiteSheetMarketScopeKey(
            result.options[0].sourceId,
            result.options[0].marketLabel,
          );
        }
        return "";
      });
    }
    void loadScopes();
    return () => {
      cancelled = true;
    };
  }, [date]);

  function currentScope() {
    return buildWhiteSheetLoadScope({
      date,
      selectedKey,
      options,
      useAdvancedSource,
      advancedSourceId,
      advancedMarket,
    });
  }

  async function fetchPageModel(scope: {
    sourceId: string;
    market: string;
    date: string;
  }): Promise<void> {
    setLoadError("");
    const params = new URLSearchParams({
      sourceId: scope.sourceId,
      market: scope.market,
      date: scope.date,
    });
    const res = await fetch(`/api/white-sheet?${params}`);
    const json = (await res.json()) as DigitalWhiteSheetPageModelResponse & { error?: string };
    if (!res.ok) {
      setLoadError(json.error ?? "โหลดข้อมูลไม่สำเร็จ");
      setPageModel(null);
      return;
    }
    setSourceId(scope.sourceId);
    setMarket(scope.market);
    setPageModel({
      entryStatus: json.entryStatus,
      summary: json.summary,
      finalizedAt: json.finalizedAt ?? null,
      finalizedBy: json.finalizedBy ?? null,
    });
  }

  function handleLoad() {
    const scope = currentScope();
    if (!scope.ok) {
      setLoadError(scope.error);
      setPageModel(null);
      return;
    }
    startLoad(() => fetchPageModel(scope));
  }

  async function handleSubmitExpenses(input: WhiteSheetExpenseInput): Promise<void> {
    const scope = currentScope();
    if (!scope.ok) throw new Error(scope.error);
    const res = await fetch("/api/white-sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: scope.sourceId,
        market: scope.market,
        date: scope.date,
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
    setSourceId(scope.sourceId);
    setMarket(scope.market);
    setPageModel({
      entryStatus: json.entryStatus,
      summary: json.summary,
      finalizedAt: json.finalizedAt ?? null,
      finalizedBy: json.finalizedBy ?? null,
    });
  }

  async function runLifecycle(action: "finalize" | "reopen", reason?: string): Promise<void> {
    if (lifecyclePendingRef.current) return;
    const scope = currentScope();
    if (!scope.ok) {
      setLifecycleError(scope.error);
      return;
    }
    lifecyclePendingRef.current = true;
    setLifecyclePending(true);
    setLifecycleError("");
    try {
      const result = await postWhiteSheetLifecycle(
        action,
        { sourceId: scope.sourceId, market: scope.market, date: scope.date },
        { reason },
      );
      if (!result.ok) {
        setLifecycleError(result.error);
        return;
      }
      await fetchPageModel(scope);
    } finally {
      lifecyclePendingRef.current = false;
      setLifecyclePending(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
        <div className="space-y-1.5">
          <label
            className="block text-xs font-medium text-slate-500 uppercase tracking-wide"
            htmlFor="white-sheet-business-date"
          >
            วันที่ธุรกิจ
          </label>
          <input
            id="white-sheet-business-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={INPUT_CLS}
            data-testid="white-sheet-business-date"
          />
          {thaiDateLabel && (
            <p
              className="text-xs text-slate-600"
              data-testid="white-sheet-business-date-thai"
            >
              {thaiDateLabel}
            </p>
          )}
        </div>

        <div className="space-y-1.5 sm:col-span-1">
          <label
            className="block text-xs font-medium text-slate-500 uppercase tracking-wide"
            htmlFor="white-sheet-market-scope"
          >
            ตลาด / กลุ่ม LINE
          </label>
          <select
            id="white-sheet-market-scope"
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            disabled={useAdvancedSource || scopesLoading || options.length === 0}
            className={INPUT_CLS}
            data-testid="white-sheet-market-scope"
          >
            <option value="">
              {scopesLoading
                ? "กำลังโหลดรายการตลาด…"
                : options.length === 0
                  ? "ไม่มีตลาดสำหรับวันที่นี้"
                  : "— เลือกตลาด —"}
            </option>
            {options.map((o) => {
              const key = whiteSheetMarketScopeKey(o.sourceId, o.marketLabel);
              return (
                <option key={key} value={key}>
                  {o.displayLabel}
                </option>
              );
            })}
          </select>
          {scopesError && !useAdvancedSource && (
            <p className="text-xs text-amber-700" role="status">
              {scopesError}
            </p>
          )}
        </div>

        <Button isLoading={loading} onClick={handleLoad} data-testid="white-sheet-load-button">
          โหลดใบขาวดิจิทัล
        </Button>
      </div>

      <details
        className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
        data-testid="white-sheet-advanced-source"
      >
        <summary className="cursor-pointer text-xs font-medium text-slate-600">
          โหมดขั้นสูง (Source ID) — สำหรับผู้ดูแลระบบเท่านั้น
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
            <input
              type="checkbox"
              checked={useAdvancedSource}
              onChange={(e) => setUseAdvancedSource(e.target.checked)}
              data-testid="white-sheet-advanced-toggle"
            />
            ใช้ Source ID แบบกรอกเอง
          </label>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
              Source ID
            </label>
            <input
              type="text"
              value={advancedSourceId}
              onChange={(e) => setAdvancedSourceId(e.target.value)}
              disabled={!useAdvancedSource}
              placeholder="LINE source id"
              className={INPUT_CLS}
              data-testid="white-sheet-advanced-source-id"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
              ตลาด
            </label>
            <input
              type="text"
              value={advancedMarket}
              onChange={(e) => setAdvancedMarket(e.target.value)}
              disabled={!useAdvancedSource}
              placeholder="ชื่อตลาด"
              className={INPUT_CLS}
              data-testid="white-sheet-advanced-market"
            />
          </div>
        </div>
      </details>

      {loadError && (
        <p className="text-sm font-medium text-red-600" role="alert" data-testid="white-sheet-load-error">
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
            เลือกวันที่และตลาดด้านบน แล้วกดโหลด เพื่อดูใบขาวดิจิทัล
            {sourceId && market ? ` (ล่าสุด: ${market})` : ""}
          </p>
        )
      )}
    </div>
  );
}
