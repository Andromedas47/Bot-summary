import {
  resolveWhiteSheetMarketScopeSelection,
  type WhiteSheetMarketScopeOption,
} from "@/lib/white-sheet/market-scopes";

export type WhiteSheetLoadScope =
  | { ok: true; sourceId: string; market: string; date: string }
  | { ok: false; error: string };

/**
 * Builds the exact scope passed to GET/POST /api/white-sheet.
 * Normal path: selector key → sourceId + marketLabel.
 * Advanced path: optional raw source_id + market for troubleshooting only.
 */
export function buildWhiteSheetLoadScope(input: {
  date: string;
  selectedKey: string;
  options: readonly WhiteSheetMarketScopeOption[];
  useAdvancedSource?: boolean;
  advancedSourceId?: string;
  advancedMarket?: string;
}): WhiteSheetLoadScope {
  const date = input.date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "กรุณาเลือกวันที่ธุรกิจ (รูปแบบ YYYY-MM-DD)" };
  }

  if (input.useAdvancedSource) {
    const sourceId = (input.advancedSourceId ?? "").trim();
    const market = (input.advancedMarket ?? "").normalize("NFC").trim();
    if (!sourceId || !market) {
      return {
        ok: false,
        error: "โหมดขั้นสูงต้องกรอก Source ID และชื่อตลาดให้ครบ",
      };
    }
    return { ok: true, sourceId, market, date };
  }

  if (input.options.length === 0) {
    return {
      ok: false,
      error: "ไม่พบตลาดที่มีข้อมูลชั่งสำหรับวันที่นี้ — เลือกวันอื่น หรือใช้โหมดขั้นสูง",
    };
  }

  const resolved = resolveWhiteSheetMarketScopeSelection(input.options, input.selectedKey);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    sourceId: resolved.sourceId,
    market: resolved.marketLabel,
    date,
  };
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchWhiteSheetMarketScopes(
  date: string,
  fetchImpl: FetchLike = fetch,
): Promise<
  | { ok: true; options: WhiteSheetMarketScopeOption[] }
  | { ok: false; error: string }
> {
  const trimmed = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: false, error: "กรุณาเลือกวันที่ก่อน" };
  }

  try {
    const res = await fetchImpl(
      `/api/white-sheet/scopes?date=${encodeURIComponent(trimmed)}`,
    );
    const json = (await res.json()) as {
      options?: WhiteSheetMarketScopeOption[];
      error?: string;
    };
    if (!res.ok) {
      return { ok: false, error: json.error ?? "โหลดรายการตลาดไม่สำเร็จ" };
    }
    return { ok: true, options: json.options ?? [] };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "โหลดรายการตลาดไม่สำเร็จ",
    };
  }
}
