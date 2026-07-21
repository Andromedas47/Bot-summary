import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { cleanMarketName } from "@/lib/market";
import { transactionBucket, type TransactionBucket } from "@/lib/summary/transactions";
import { logger } from "@/lib/logger";

export const REMAINING_STOCK_REPORT_TITLE = "\u0E2A\u0E23\u0E38\u0E1B\u0E1C\u0E25\u0E44\u0E21\u0E49\u0E04\u0E07\u0E40\u0E2B\u0E25\u0E37\u0E2D";
export const UNIDENTIFIED_MARKET_SECTION = "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E22\u0E31\u0E07\u0E23\u0E30\u0E1A\u0E38\u0E15\u0E25\u0E32\u0E14\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49";

export const PRODUCT_ALIASES: Record<string, string> = {
  "\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E16\u0E31\u0E48\u0E27\u0E1E\u0E39": "\u0E16\u0E31\u0E48\u0E27\u0E1E\u0E39",
  "\u0E16\u0E31\u0E48\u0E27\u0E1E\u0E4D": "\u0E16\u0E31\u0E48\u0E27\u0E1E\u0E39",
  "\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E01\u0E30\u0E2B\u0E25\u0E48\u0E33\u0E1B\u0E35": "\u0E01\u0E30\u0E2B\u0E25\u0E48\u0E33\u0E1B\u0E35",
  "\u0E43\u0E1A\u0E21\u0E31\u0E07\u0E25\u0E35\u0E01": "\u0E43\u0E1A\u0E21\u0E31\u0E07\u0E25\u0E31\u0E01",
  "\u0E43\u0E1A\u0E15\u0E31\u0E48\u0E07\u0E42\u0E2D\u0E49": "\u0E43\u0E1A\u0E15\u0E31\u0E48\u0E07\u0E42\u0E2D\u0E49",
};

const KNOWN_PREFIX = "\u0E40\u0E1E\u0E34\u0E48\u0E21";

function baseNormalize(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function normalizeProductName(
  name: string,
  aliases: Record<string, string> = PRODUCT_ALIASES,
  knownNames?: ReadonlySet<string>,
): string {
  const n = baseNormalize(name);
  const aliased = aliases[n] ?? n;
  if (aliased !== n) return aliased;

  if (knownNames && n.startsWith(KNOWN_PREFIX)) {
    const rest = n.slice(KNOWN_PREFIX.length).trim();
    if (rest && knownNames.has(rest)) return rest;
  }
  return n;
}

export function formatQuantity(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? r.toString() : r.toFixed(3).replace(/0+$/, "");
}

export interface RemainingFruitSourceRow {
  market_name: string | null;
  product_name: string;
  quantity: number | null;
  unit: string | null;
  transaction_type: string;
  /** Identity fields used only for session-aware dedup — optional so existing callers/fixtures keep compiling. */
  session_id?: string;
  sender_name?: string | null;
  source_id?: string | null;
  session_time?: string | null;
}

export interface RemainingFruitItem {
  fruitName: string;
  unit: string;
  withdrawnQuantity: number;
  returnGoodQuantity: number;
  damagedQuantity: number;
  remainingForResaleQuantity: number;
  hasReturnGoodData: boolean;
  hasWithdrawnData: boolean;
  hasDamagedData: boolean;
}

export interface RemainingFruitMarketSection {
  marketName: string;
  items: RemainingFruitItem[];
}

export interface RemainingFruitOverallBreakdown {
  marketName: string;
  quantity: number;
}

export interface RemainingFruitOverallItem {
  fruitName: string;
  unit: string;
  totalRemainingForResale: number;
  marketBreakdown: RemainingFruitOverallBreakdown[];
}

export interface RemainingFruitReport {
  markets: RemainingFruitMarketSection[];
  overall: RemainingFruitOverallItem[];
  unidentified: {
    markets: RemainingFruitMarketSection[];
    overall: RemainingFruitOverallItem[];
  } | null;
}

interface AggregateCell {
  fruitName: string;
  unit: string;
  withdrawnQuantity: number;
  returnGoodQuantity: number;
  damagedQuantity: number;
  hasReturnGoodData: boolean;
  hasWithdrawnData: boolean;
  hasDamagedData: boolean;
}

export function normalizeRemainingUnit(unit: string | null | undefined): string {
  const trimmed = (unit ?? "").trim();
  if (!trimmed) return "";
  return normalizeUnitAlias(trimmed);
}

/** Display label for LINE / web — keeps grouping key separate from presentation. */
export function displayRemainingUnit(unit: string): string {
  if (unit === "โล") return "กิโล";
  return unit || "—";
}

function toItem(cell: AggregateCell): RemainingFruitItem {
  return {
    fruitName: cell.fruitName,
    unit: cell.unit,
    withdrawnQuantity: cell.withdrawnQuantity,
    returnGoodQuantity: cell.returnGoodQuantity,
    damagedQuantity: cell.damagedQuantity,
    remainingForResaleQuantity: cell.returnGoodQuantity,
    hasReturnGoodData: cell.hasReturnGoodData,
    hasWithdrawnData: cell.hasWithdrawnData,
    hasDamagedData: cell.hasDamagedData,
  };
}

function addQuantity(
  cell: AggregateCell,
  bucket: TransactionBucket,
  quantity: number,
): void {
  if (bucket === "เบิก") {
    cell.withdrawnQuantity += quantity;
    cell.hasWithdrawnData = true;
    return;
  }
  if (bucket === "คืน") {
    cell.returnGoodQuantity += quantity;
    cell.hasReturnGoodData = true;
    return;
  }
  cell.damagedQuantity += quantity;
  cell.hasDamagedData = true;
}

function emptyCell(fruitName: string, unit: string): AggregateCell {
  return {
    fruitName,
    unit,
    withdrawnQuantity: 0,
    returnGoodQuantity: 0,
    damagedQuantity: 0,
    hasReturnGoodData: false,
    hasWithdrawnData: false,
    hasDamagedData: false,
  };
}

function shouldIncludeItem(cell: AggregateCell): boolean {
  if (!cell.unit || displayRemainingUnit(cell.unit) === "\u2014") return false;
  if (cell.hasReturnGoodData && cell.returnGoodQuantity <= 0) return false;
  return cell.hasReturnGoodData || cell.hasWithdrawnData || cell.hasDamagedData;
}

function shouldIncludeInOverall(item: RemainingFruitItem): boolean {
  return (
    item.hasReturnGoodData &&
    item.remainingForResaleQuantity > 0 &&
    !!item.unit &&
    displayRemainingUnit(item.unit) !== "\u2014"
  );
}

function buildOverallFromSections(sections: RemainingFruitMarketSection[]): RemainingFruitOverallItem[] {
  const overallMap = new Map<string, RemainingFruitOverallItem>();

  for (const section of sections) {
    for (const item of section.items) {
      if (!shouldIncludeInOverall(item)) continue;

      const key = `${item.fruitName}||${item.unit}`;
      let overall = overallMap.get(key);
      if (!overall) {
        overall = {
          fruitName: item.fruitName,
          unit: item.unit,
          totalRemainingForResale: 0,
          marketBreakdown: [],
        };
        overallMap.set(key, overall);
      }

      overall.totalRemainingForResale += item.remainingForResaleQuantity;
      overall.marketBreakdown.push({
        marketName: section.marketName,
        quantity: item.remainingForResaleQuantity,
      });
    }
  }

  return [...overallMap.values()]
    .map((row) => ({
      ...row,
      marketBreakdown: row.marketBreakdown.sort((a, b) =>
        a.marketName.localeCompare(b.marketName, "th"),
      ),
    }))
    .sort((a, b) =>
      a.fruitName.localeCompare(b.fruitName, "th") || a.unit.localeCompare(b.unit, "th"),
    );
}

function sortItems(a: RemainingFruitItem, b: RemainingFruitItem): number {
  return a.fruitName.localeCompare(b.fruitName, "th") || a.unit.localeCompare(b.unit, "th");
}

// Session must be finalized (or created, if never explicitly finalized) within this
// window of a candidate identified session to be considered the same real-world event.
const DEDUPE_TIME_WINDOW_MS = 10 * 60 * 1000;
// A single matching product is never enough proof — require at least this many
// distinct return-good product/unit/quantity keys to overlap.
const DEDUPE_MIN_MATCHED_KEYS = 2;
// The unidentified session's return-good row count must cover at least this
// fraction of the candidate identified session's return-good row count.
const DEDUPE_MIN_COVERAGE_RATIO = 0.8;

interface ReturnGoodCell {
  count: number;
  indices: number[];
}

interface DedupeSessionInfo {
  resolvedMarkets: Set<string>;
  sourceId: string | null;
  senderKey: string | null;
  timeMs: number | null;
  returnGood: Map<string, ReturnGoodCell>;
  returnGoodRowCount: number;
}

interface DedupeDiagnostics {
  suppressedSessionPairs: number;
  suppressedReturnRows: number;
  ambiguousUnidentifiedSessions: number;
  skippedMissingIdentitySessions: number;
  [key: string]: number;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function emptySessionInfo(): DedupeSessionInfo {
  return {
    resolvedMarkets: new Set(),
    sourceId: null,
    senderKey: null,
    timeMs: null,
    returnGood: new Map(),
    returnGoodRowCount: 0,
  };
}

function buildSessionInfo(
  source: readonly RemainingFruitSourceRow[],
  aliases: Record<string, string>,
  knownNames: ReadonlySet<string>,
): Map<string, DedupeSessionInfo> {
  const sessions = new Map<string, DedupeSessionInfo>();

  source.forEach((row, index) => {
    if (!row.session_id) return;

    let info = sessions.get(row.session_id);
    if (!info) {
      info = emptySessionInfo();
      sessions.set(row.session_id, info);
    }

    const resolvedMarket = cleanMarketName(row.market_name);
    if (resolvedMarket) info.resolvedMarkets.add(resolvedMarket);

    if (!info.sourceId && row.source_id) info.sourceId = row.source_id;
    if (!info.senderKey) {
      const sender = nonEmpty(row.sender_name);
      if (sender) info.senderKey = sender;
    }
    if (info.timeMs === null) {
      const t = parseTimeMs(row.session_time);
      if (t !== null) info.timeMs = t;
    }

    const bucket = transactionBucket(row.transaction_type);
    if (bucket !== "คืน") return;
    const qty = row.quantity ?? 0;
    if (!Number.isFinite(qty)) return;

    const fruitName = normalizeProductName(row.product_name, aliases, knownNames);
    const unit = normalizeRemainingUnit(row.unit);
    const key = `${fruitName}||${unit}||${qty}`;

    const cell = info.returnGood.get(key) ?? { count: 0, indices: [] };
    cell.count += 1;
    cell.indices.push(index);
    info.returnGood.set(key, cell);
    info.returnGoodRowCount += 1;
  });

  return sessions;
}

type SessionRole =
  | { kind: "identified"; market: string }
  | { kind: "unidentified" }
  | { kind: "ambiguous" };

/** More than one distinct resolved market inside one session means we can't trust either — never used for matching. */
function classifySession(info: DedupeSessionInfo): SessionRole {
  if (info.resolvedMarkets.size === 0) return { kind: "unidentified" };
  if (info.resolvedMarkets.size === 1) {
    const [market] = info.resolvedMarkets;
    return { kind: "identified", market };
  }
  return { kind: "ambiguous" };
}

/**
 * Suppress unidentified-session return-good ("คืน") rows only when they are
 * proven duplicates of an identified session: same LINE source/group, matching sender
 * where both are known, finalized within a short window of each other, and the
 * unidentified session's return-good rows (with multiplicity) are a subset of a single
 * identified session's return-good rows, with enough overlap to rule out coincidence.
 * Withdrawal/damaged rows and ambiguous- or unmatched-identity sessions are never touched.
 */
export function dedupeRemainingSourceRows(
  source: readonly RemainingFruitSourceRow[],
  aliases: Record<string, string> = PRODUCT_ALIASES,
): RemainingFruitSourceRow[] {
  const knownNames = new Set(
    source.map((row) => {
      const n = row.product_name.normalize("NFC").replace(/\s+/g, " ").trim();
      return aliases[n] ?? n;
    }),
  );

  const sessions = buildSessionInfo(source, aliases, knownNames);

  const identified: DedupeSessionInfo[] = [];
  const unidentified: DedupeSessionInfo[] = [];
  for (const info of sessions.values()) {
    const role = classifySession(info);
    if (role.kind === "identified") identified.push(info);
    else if (role.kind === "unidentified") unidentified.push(info);
    // ambiguous sessions participate in neither role
  }

  const exclude = new Set<number>();
  const diagnostics: DedupeDiagnostics = {
    suppressedSessionPairs: 0,
    suppressedReturnRows: 0,
    ambiguousUnidentifiedSessions: 0,
    skippedMissingIdentitySessions: 0,
  };

  for (const u of unidentified) {
    if (u.returnGood.size === 0) continue;
    // A one-item session must never be suppressed solely because it matches another session.
    if (u.returnGood.size < DEDUPE_MIN_MATCHED_KEYS) continue;

    if (!u.sourceId || u.timeMs === null) {
      diagnostics.skippedMissingIdentitySessions += 1;
      continue;
    }
    const uSourceId = u.sourceId;
    const uTimeMs = u.timeMs;

    const candidates = identified.filter((i) => {
      if (i.sourceId !== uSourceId) return false;
      if (i.timeMs === null) return false;
      if (Math.abs(i.timeMs - uTimeMs) > DEDUPE_TIME_WINDOW_MS) return false;
      if (u.senderKey && i.senderKey && u.senderKey !== i.senderKey) return false;
      if (i.returnGoodRowCount === 0) return false;
      if (u.returnGoodRowCount / i.returnGoodRowCount < DEDUPE_MIN_COVERAGE_RATIO) return false;

      for (const [key, cell] of u.returnGood) {
        const iCell = i.returnGood.get(key);
        if (!iCell || iCell.count < cell.count) return false;
      }
      return true;
    });

    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      diagnostics.ambiguousUnidentifiedSessions += 1;
      continue;
    }

    diagnostics.suppressedSessionPairs += 1;
    for (const cell of u.returnGood.values()) {
      for (const index of cell.indices) {
        exclude.add(index);
        diagnostics.suppressedReturnRows += 1;
      }
    }
  }

  if (
    diagnostics.suppressedSessionPairs > 0 ||
    diagnostics.ambiguousUnidentifiedSessions > 0 ||
    diagnostics.skippedMissingIdentitySessions > 0
  ) {
    logger.info("summary.remaining-fruit.dedupe", diagnostics);
  }

  return source.filter((_, index) => !exclude.has(index));
}

/**
 * Aggregate produce rows for one business date.
 * Remaining for resale is always the summed ชั่งคืน (transaction_type "คืน") quantity —
 * never derived from เบิก − ชั่งคืน − คืนเสีย.
 */
export function buildRemainingFruitReport(
  source: readonly RemainingFruitSourceRow[],
  options: {
    marketFilter?: string | null;
    aliases?: Record<string, string>;
  } = {},
): RemainingFruitReport {
  const aliases = options.aliases ?? PRODUCT_ALIASES;
  const marketFilter = options.marketFilter?.trim() || null;
  const sourceRows = dedupeRemainingSourceRows(source, aliases);

  const pass1Names = new Set(
    sourceRows.map((r) => {
      const n = r.product_name.normalize("NFC").replace(/\s+/g, " ").trim();
      return aliases[n] ?? n;
    }),
  );

  const byMarket = new Map<string, Map<string, AggregateCell>>();

  for (const row of sourceRows) {
    const bucket = transactionBucket(row.transaction_type);
    if (!bucket) continue;

    const rawMarket = row.market_name ?? "";
    const resolvedMarket = cleanMarketName(rawMarket);
    if (marketFilter) {
      const haystack = `${rawMarket} ${resolvedMarket ?? ""}`.toLowerCase();
      if (!haystack.includes(marketFilter.toLowerCase())) continue;
    }

    const market = resolvedMarket ?? UNIDENTIFIED_MARKET_SECTION;

    const fruitName = normalizeProductName(row.product_name, aliases, pass1Names);
    const unit = normalizeRemainingUnit(row.unit);
    const key = `${fruitName}||${unit}`;
    const qty = row.quantity ?? 0;
    if (!Number.isFinite(qty)) continue;

    let marketMap = byMarket.get(market);
    if (!marketMap) {
      marketMap = new Map();
      byMarket.set(market, marketMap);
    }

    let cell = marketMap.get(key);
    if (!cell) {
      cell = emptyCell(fruitName, unit);
      marketMap.set(key, cell);
    }

    addQuantity(cell, bucket, qty);
  }

  const allSections: RemainingFruitMarketSection[] = [...byMarket.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "th"))
    .map(([marketName, cells]) => ({
      marketName,
      items: [...cells.values()]
        .filter(shouldIncludeItem)
        .map(toItem)
        .sort(sortItems),
    }))
    .filter((section) => section.items.length > 0);

  const markets = allSections.filter((section) => section.marketName !== UNIDENTIFIED_MARKET_SECTION);
  const unidentifiedSections = allSections.filter(
    (section) => section.marketName === UNIDENTIFIED_MARKET_SECTION,
  );

  const overall = buildOverallFromSections(markets);
  const unidentifiedOverall = buildOverallFromSections(unidentifiedSections);

  return {
    markets,
    overall,
    unidentified:
      unidentifiedSections.length > 0
        ? { markets: unidentifiedSections, overall: unidentifiedOverall }
        : null,
  };
}
