import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizedMarketLabel } from "@/lib/market";
import type { Database } from "@/types/database";
import { WhiteSheetDataError } from "./load";

type Supabase = SupabaseClient<Database>;

const PAGE_SIZE = 1000;
const SOURCE_LOOKUP_CHUNK_SIZE = 500;
const EFFECTIVE_TRANSACTION_TYPES = ["เบิก", "คืน", "คืนเสีย"] as const;

/** Identity-only columns from the audit produce view (includes voided sessions). */
const AUDIT_IDENTITY_SELECT =
  "id, market_name, raw_message_id, base_transaction_type, item_created_at" as const;

type AuditIdentityRow = {
  id: string;
  market_name: string | null;
  raw_message_id: string;
  base_transaction_type: string;
  item_created_at: string;
};

/**
 * One selectable White Sheet identity for a business date.
 * Preserves the existing (source_id + market + business_date) model —
 * a single LINE source may host multiple markets.
 */
export interface WhiteSheetMarketScopeOption {
  sourceId: string;
  marketLabel: string;
  /** Human-readable option text for the selector. */
  displayLabel: string;
}

export type WhiteSheetMarketScopeResolveResult =
  | { ok: true; sourceId: string; marketLabel: string }
  | { ok: false; error: string };

/** Stable select value: sourceId + unit separator + marketLabel. */
export function whiteSheetMarketScopeKey(sourceId: string, marketLabel: string): string {
  return `${sourceId}\u0001${marketLabel}`;
}

export function parseWhiteSheetMarketScopeKey(
  key: string,
): { sourceId: string; marketLabel: string } | null {
  const sep = key.indexOf("\u0001");
  if (sep <= 0 || sep === key.length - 1) return null;
  const sourceId = key.slice(0, sep).trim();
  const marketLabel = key.slice(sep + 1).normalize("NFC").trim();
  if (!sourceId || !marketLabel) return null;
  return { sourceId, marketLabel };
}

/**
 * Pure builder used by the API and tests. Rows without a resolvable market or
 * source are skipped (fail closed — never guessed). Duplicate (source, market)
 * pairs collapse to one option. When the same market label appears under more
 * than one source, the display label includes a short source suffix so admins
 * can tell them apart without typing the full id.
 */
export function buildWhiteSheetMarketScopeOptions(
  rows: readonly { market_name: string | null; raw_message_id: string }[],
  sourceByRawMessageId: ReadonlyMap<string, string>,
): WhiteSheetMarketScopeOption[] {
  const byKey = new Map<string, { sourceId: string; marketLabel: string }>();

  for (const row of rows) {
    const sourceId = sourceByRawMessageId.get(row.raw_message_id)?.trim();
    if (!sourceId) continue;
    const marketLabel = normalizedMarketLabel(row.market_name);
    if (!marketLabel) continue;
    byKey.set(whiteSheetMarketScopeKey(sourceId, marketLabel), { sourceId, marketLabel });
  }

  return finalizeScopeOptions(byKey);
}

/** Merge already-resolved (sourceId, marketLabel) seeds into selector options. */
export function buildWhiteSheetMarketScopeOptionsFromSeeds(
  seeds: readonly { sourceId: string; marketLabel: string }[],
): WhiteSheetMarketScopeOption[] {
  const byKey = new Map<string, { sourceId: string; marketLabel: string }>();
  for (const seed of seeds) {
    const sourceId = seed.sourceId.trim();
    const marketLabel = normalizedMarketLabel(seed.marketLabel);
    if (!sourceId || !marketLabel) continue;
    byKey.set(whiteSheetMarketScopeKey(sourceId, marketLabel), { sourceId, marketLabel });
  }
  return finalizeScopeOptions(byKey);
}

function finalizeScopeOptions(
  byKey: Map<string, { sourceId: string; marketLabel: string }>,
): WhiteSheetMarketScopeOption[] {
  const labelCounts = new Map<string, number>();
  for (const { marketLabel } of byKey.values()) {
    labelCounts.set(marketLabel, (labelCounts.get(marketLabel) ?? 0) + 1);
  }

  const options = [...byKey.values()].map(({ sourceId, marketLabel }) => {
    const ambiguous = (labelCounts.get(marketLabel) ?? 0) > 1;
    const suffix = ambiguous ? ` · …${sourceId.slice(-6)}` : "";
    return {
      sourceId,
      marketLabel,
      displayLabel: `${marketLabel}${suffix}`,
    };
  });

  return options.sort((a, b) =>
    a.displayLabel.localeCompare(b.displayLabel, "th", { sensitivity: "base" }),
  );
}

/**
 * Resolves a selector value against the option list. Fails closed when the
 * key is missing, malformed, or does not match exactly one known option.
 */
export function resolveWhiteSheetMarketScopeSelection(
  options: readonly WhiteSheetMarketScopeOption[],
  selectedKey: string,
): WhiteSheetMarketScopeResolveResult {
  const trimmed = selectedKey.trim();
  if (!trimmed) {
    return { ok: false, error: "กรุณาเลือกตลาด / กลุ่ม LINE" };
  }

  const parsed = parseWhiteSheetMarketScopeKey(trimmed);
  if (!parsed) {
    return { ok: false, error: "ค่าที่เลือกไม่ถูกต้อง กรุณาเลือกจากรายการอีกครั้ง" };
  }

  const matches = options.filter(
    (o) => o.sourceId === parsed.sourceId && o.marketLabel === parsed.marketLabel,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      error: "ไม่พบตลาดนี้สำหรับวันที่เลือก — โหลดรายการใหม่แล้วลองอีกครั้ง",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: "พบตลาดซ้ำที่ไม่สามารถแยกได้ กรุณาติดต่อผู้ดูแลระบบ",
    };
  }

  return {
    ok: true,
    sourceId: matches[0].sourceId,
    marketLabel: matches[0].marketLabel,
  };
}

async function mapRawMessageSources(
  supabase: Supabase,
  rawMessageIds: readonly string[],
): Promise<Map<string, string>> {
  const sourceById = new Map<string, string>();
  for (let i = 0; i < rawMessageIds.length; i += SOURCE_LOOKUP_CHUNK_SIZE) {
    const chunk = rawMessageIds.slice(i, i + SOURCE_LOOKUP_CHUNK_SIZE);
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, source_id")
      .in("id", chunk);
    if (error) {
      throw new WhiteSheetDataError(`market/source mapping query failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      if (row.source_id) sourceById.set(row.id, row.source_id);
    }
  }
  return sourceById;
}

/**
 * Audit identity rows for selector discovery. Reads produce_transactions_all
 * so VOIDED sessions remain discoverable. Must NEVER be used for trusted
 * financial totals (those continue to use produce_transactions via load.ts).
 */
export async function fetchAuditProduceIdentityRowsForScopeDiscovery(
  supabase: Supabase,
  businessDate: string,
): Promise<AuditIdentityRow[]> {
  const rows: AuditIdentityRow[] = [];
  const seenRowIds = new Set<string>();
  let offset = 0;
  let expectedCount: number | null = null;

  while (true) {
    const { data, error, count } = await supabase
      .from("produce_transactions_all")
      .select(AUDIT_IDENTITY_SELECT, { count: "exact" })
      .eq("transaction_date", businessDate)
      .in("base_transaction_type", [...EFFECTIVE_TRANSACTION_TYPES])
      .order("item_created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new WhiteSheetDataError(
        `produce transaction audit identity query failed: ${error.message}`,
      );
    }
    if (count === null) {
      throw new WhiteSheetDataError(
        "produce transaction audit identity pagination requires an exact row count",
      );
    }
    if (expectedCount === null) {
      expectedCount = count;
    } else if (count !== expectedCount) {
      throw new WhiteSheetDataError(
        "produce transaction audit identity set changed during pagination",
      );
    }

    const page = (data ?? []) as AuditIdentityRow[];
    if (page.length === 0) {
      if (offset === expectedCount) break;
      throw new WhiteSheetDataError(
        "produce transaction audit identity pagination stopped before all rows were loaded",
      );
    }

    for (const row of page) {
      if (seenRowIds.has(row.id)) {
        throw new WhiteSheetDataError(
          "produce transaction audit identity pagination returned a duplicate persisted row",
        );
      }
      seenRowIds.add(row.id);
      rows.push(row);
    }

    offset += page.length;
    if (offset === expectedCount) break;
    if (offset > expectedCount) {
      throw new WhiteSheetDataError(
        "produce transaction audit identity pagination exceeded the exact row count",
      );
    }
  }

  return rows;
}

async function fetchCashEntryIdentitySeeds(
  supabase: Supabase,
  businessDate: string,
): Promise<Array<{ sourceId: string; marketLabel: string }>> {
  const { data, error } = await supabase
    .from("digital_white_sheet_cash_entries")
    .select("source_id, market_label_normalized")
    .eq("business_date", businessDate);
  if (error) {
    throw new WhiteSheetDataError(`white sheet cash identity query failed: ${error.message}`);
  }
  return (data ?? []).map((row) => ({
    sourceId: row.source_id,
    marketLabel: row.market_label_normalized,
  }));
}

/**
 * Server-side options for one business date.
 *
 * Discovery (this function) uses audit-safe identity sources:
 *   - produce_transactions_all (includes VOIDED sessions)
 *   - digital_white_sheet_cash_entries (saved White Sheet identity)
 *
 * Trusted financial calculation remains separate and continues to read
 * produce_transactions (void excluded) inside loadDigitalWhiteSheetCalculation.
 */
export async function listWhiteSheetMarketScopesForDate(
  supabase: Supabase,
  businessDate: string,
): Promise<WhiteSheetMarketScopeOption[]> {
  const date = businessDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new WhiteSheetDataError("businessDate must be YYYY-MM-DD");
  }

  const [auditRows, cashSeeds] = await Promise.all([
    fetchAuditProduceIdentityRowsForScopeDiscovery(supabase, date),
    fetchCashEntryIdentitySeeds(supabase, date),
  ]);

  const rawIds = [...new Set(auditRows.map((r) => r.raw_message_id))];
  const sourceByRaw = await mapRawMessageSources(supabase, rawIds);
  const fromProduce = buildWhiteSheetMarketScopeOptions(auditRows, sourceByRaw);
  const fromCash = buildWhiteSheetMarketScopeOptionsFromSeeds(cashSeeds);

  return buildWhiteSheetMarketScopeOptionsFromSeeds([
    ...fromProduce.map((o) => ({ sourceId: o.sourceId, marketLabel: o.marketLabel })),
    ...fromCash.map((o) => ({ sourceId: o.sourceId, marketLabel: o.marketLabel })),
  ]);
}
