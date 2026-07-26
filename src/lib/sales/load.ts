import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizedMarketLabel } from "@/lib/market";
import { resolveCentralPricesForDate } from "@/lib/white-sheet/load";
import type { Database } from "@/types/database";
import {
  calculateSalesReport,
  type SalesBlockReason,
  type SalesReport,
  type SalesScopeBlocker,
  type SalesSourceRow,
} from "./calculate";

/**
 * P1 Daily Sales — the only path from the database to a SalesReport.
 *
 * Both the manual `สรุปยอดขาย` LINE command and the scheduled 08:10 delivery go
 * through here, so the two can never drift apart. Every read is read-only; this
 * module writes nothing, seeds no price, and touches no P0 Stock code path.
 *
 * Sources, and why each one:
 *   produce_transactions   the persisted, void-filtered transaction evidence
 *   raw_messages           source_id — the stable half of the market identity
 *   produce_sessions       parser errors and the persisted item-count claim
 *   central_selling_prices the ONLY trusted price (via the White Sheet resolver)
 *   pending_sessions       produce data that never finalized
 *   parse_errors           messages whose parse crashed — data that never landed
 */

type Supabase = SupabaseClient<Database>;
type ProduceTransactionRow = Database["public"]["Views"]["produce_transactions"]["Row"];

const PAGE_SIZE = 1000;
const LOOKUP_CHUNK_SIZE = 500;

/**
 * Every column P1 needs. NO transaction-type filter is applied to the query:
 * the legacy "เสีย" spelling is not normalized by the view's
 * base_transaction_type CASE, so filtering on that column server-side would
 * silently drop damage rows and overstate what was sold. Classification happens
 * in the calculator through baseTransactionType, and a genuinely unknown type
 * blocks its identity instead of disappearing.
 */
const PRODUCE_SELECT =
  "id, session_id, market_name, product_name, quantity, unit, transaction_type, base_transaction_type, price_per_unit, basis_quantity, raw_message_id, session_kind, item_created_at" as const;

/**
 * parse_errors rows that mean produce data may be missing. "unsupported_type"
 * is excluded on purpose — a sticker or an image is not lost produce data, and
 * treating it as one would block every business date forever.
 */
const BLOCKING_PARSE_ERROR_TYPES = ["parser_crash", "timeout"] as const;

export class SalesDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesDataError";
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

/**
 * The UTC instants bounding one Bangkok business date. The existing 04:00
 * cutoff defines the day (see bangkokBusinessDateFromTimestamp), and Bangkok is
 * UTC+7 year-round with no DST, so business date D runs from D−1T21:00Z to
 * DT21:00Z.
 */
export function bangkokBusinessDateWindow(businessDate: string): { start: string; end: string } {
  const [year, month, day] = businessDate.split("-").map(Number);
  const startOfDayUtc = Date.UTC(year, month - 1, day);
  const start = new Date(startOfDayUtc - 3 * 60 * 60 * 1000).toISOString();
  const end = new Date(startOfDayUtc + 21 * 60 * 60 * 1000).toISOString();
  return { start, end };
}

/**
 * Paginates the day's produce rows with an exact row count, refusing to return
 * a partial set. Same discipline as the White Sheet loader: a short read here
 * would silently understate sales.
 */
export async function fetchSalesProduceRows(
  supabase: Supabase,
  businessDate: string,
): Promise<ProduceTransactionRow[]> {
  const rows: ProduceTransactionRow[] = [];
  const seenRowIds = new Set<string>();
  let offset = 0;
  let expectedCount: number | null = null;

  while (true) {
    const { data, error, count } = await supabase
      .from("produce_transactions")
      .select(PRODUCE_SELECT, { count: "exact" })
      .eq("transaction_date", businessDate)
      .order("item_created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new SalesDataError(`produce transaction query failed: ${error.message}`);
    if (count === null) {
      throw new SalesDataError("produce transaction pagination requires an exact row count");
    }
    if (expectedCount === null) expectedCount = count;
    else if (count !== expectedCount) {
      throw new SalesDataError("produce transaction set changed during pagination");
    }

    const page = (data ?? []) as ProduceTransactionRow[];
    if (page.length === 0) {
      if (offset === expectedCount) break;
      throw new SalesDataError(
        "produce transaction pagination stopped before all rows were loaded",
      );
    }

    for (const row of page) {
      if (seenRowIds.has(row.id)) {
        throw new SalesDataError("produce transaction pagination returned a duplicate row");
      }
      seenRowIds.add(row.id);
      rows.push(row);
    }

    offset += page.length;
    if (offset === expectedCount) break;
    if (offset > expectedCount) {
      throw new SalesDataError("produce transaction pagination exceeded the exact row count");
    }
  }

  return rows;
}

async function mapRawMessageSources(
  supabase: Supabase,
  rawMessageIds: readonly string[],
): Promise<Map<string, string>> {
  const sourceByRawMessageId = new Map<string, string>();

  for (const chunk of chunks(rawMessageIds, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, source_id")
      .in("id", chunk);
    if (error) throw new SalesDataError(`market/source mapping query failed: ${error.message}`);
    for (const row of data ?? []) {
      if (row.source_id) sourceByRawMessageId.set(row.id, row.source_id);
    }
  }

  return sourceByRawMessageId;
}

/**
 * Session integrity findings, keyed by session id.
 *
 * parser_errors: the parser could not read every line of the message, so the
 * session's item set is incomplete by the parser's own admission.
 *
 * total_items vs persisted rows: the session recorded how many items it parsed;
 * a different number of rows actually landed. Either way the day's quantities
 * for that session are not provably complete, so its identities are blocked.
 */
async function loadSessionIssues(
  supabase: Supabase,
  rows: readonly ProduceTransactionRow[],
): Promise<Map<string, SalesBlockReason[]>> {
  const issues = new Map<string, SalesBlockReason[]>();
  const sessionIds = [...new Set(rows.map((row) => row.session_id))];
  if (sessionIds.length === 0) return issues;

  const persistedCounts = new Map<string, number>();
  for (const row of rows) {
    persistedCounts.set(row.session_id, (persistedCounts.get(row.session_id) ?? 0) + 1);
  }

  for (const chunk of chunks(sessionIds, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("produce_sessions")
      .select("id, total_items, parser_errors")
      .in("id", chunk);
    if (error) throw new SalesDataError(`produce session integrity query failed: ${error.message}`);

    for (const session of data ?? []) {
      const found: SalesBlockReason[] = [];
      const parserErrors = session.parser_errors;
      if (Array.isArray(parserErrors) ? parserErrors.length > 0 : parserErrors != null) {
        found.push("session_parser_errors");
      }
      // Every item of a session shares its session_date, so the rows fetched for
      // this business date are that session's complete persisted item set.
      if ((persistedCounts.get(session.id) ?? 0) !== session.total_items) {
        found.push("session_item_count_mismatch");
      }
      if (found.length > 0) issues.set(session.id, found);
    }
  }

  return issues;
}

/**
 * Integrity problems that cannot be pinned to one market.
 *
 * A pending session that never finalized, or a message whose parse crashed, may
 * hold produce lines for ANY market — so neither can be attributed, and both
 * demote every total in the scope rather than a single market's.
 *
 * pending_sessions rows are deleted once finalization succeeds, so a row still
 * present inside the business-date window is by definition unresolved.
 */
async function loadScopeBlockers(
  supabase: Supabase,
  businessDate: string,
): Promise<SalesScopeBlocker[]> {
  const window = bangkokBusinessDateWindow(businessDate);
  const blockers: SalesScopeBlocker[] = [];

  // pending_sessions is not part of the generated Database types (it is
  // operational webhook state, never a report source), so this one read uses a
  // loosened client exactly as PendingSessionService does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looseClient = supabase as unknown as SupabaseClient<any>;
  const { data: pending, error: pendingError } = await looseClient
    .from("pending_sessions")
    .select("id, finalized_at, finalized_produce_session_id, finalization_status")
    .gte("created_at", window.start)
    .lt("created_at", window.end);
  if (pendingError) {
    throw new SalesDataError(`pending session query failed: ${pendingError.message}`);
  }

  const unresolvedPending = (pending ?? []).filter(
    (row: {
      finalized_at?: string | null;
      finalized_produce_session_id?: string | null;
      finalization_status?: string | null;
    }) =>
      !row.finalized_at &&
      !row.finalized_produce_session_id &&
      row.finalization_status !== "finalized" &&
      row.finalization_status !== "duplicate",
  ).length;
  if (unresolvedPending > 0) {
    blockers.push({ kind: "unresolved_pending_session", count: unresolvedPending });
  }

  const { data: parseErrors, error: parseErrorsError } = await supabase
    .from("parse_errors")
    .select("id")
    .in("error_type", [...BLOCKING_PARSE_ERROR_TYPES])
    .gte("created_at", window.start)
    .lt("created_at", window.end);
  if (parseErrorsError) {
    throw new SalesDataError(`parse error query failed: ${parseErrorsError.message}`);
  }
  if ((parseErrors ?? []).length > 0) {
    blockers.push({ kind: "message_parser_error", count: (parseErrors ?? []).length });
  }

  return blockers;
}

/**
 * Adapts persisted rows to calculator input.
 *
 * The market label is resolved through the SAME normalizedMarketLabel boundary
 * the White Sheet uses, and it is only ever half of the identity — the other
 * half is the LINE source that produced the session. A row missing either half
 * is passed through with a null source so the calculator keys it by session and
 * blocks it; it is never merged into a market it might not belong to.
 */
function adaptRows(
  rows: readonly ProduceTransactionRow[],
  sourceByRawMessageId: ReadonlyMap<string, string>,
  sessionIssues: ReadonlyMap<string, SalesBlockReason[]>,
): SalesSourceRow[] {
  return rows.map((row) => {
    const marketLabel = normalizedMarketLabel(row.market_name);
    return {
      sourceId: sourceByRawMessageId.get(row.raw_message_id) ?? null,
      marketName: marketLabel || null,
      sessionId: row.session_id,
      sessionKind: row.session_kind,
      productName: row.product_name,
      unit: row.unit,
      quantity: row.quantity === null ? null : Number(row.quantity),
      transactionType: row.transaction_type,
      sessionIssues: sessionIssues.get(row.session_id),
    };
  });
}

export async function loadSalesReport(
  supabase: Supabase,
  businessDate: string,
): Promise<SalesReport> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new SalesDataError("businessDate must be an ISO date (YYYY-MM-DD)");
  }

  const rows = await fetchSalesProduceRows(supabase, businessDate);
  const rawMessageIds = [...new Set(rows.map((row) => row.raw_message_id))];

  const [sourceByRawMessageId, sessionIssues, scopeBlockers, pricing] = await Promise.all([
    mapRawMessageSources(supabase, rawMessageIds),
    loadSessionIssues(supabase, rows),
    loadScopeBlockers(supabase, businessDate),
    // Central price resolution — including the BR-01 conflict scan — is reused
    // verbatim from the White Sheet loader so P1 can never price a sale through
    // a second, divergent pricing algorithm.
    resolveCentralPricesForDate(supabase, businessDate, rows),
  ]);

  return calculateSalesReport({
    businessDate,
    rows: adaptRows(rows, sourceByRawMessageId, sessionIssues),
    centralPrices: pricing.prices,
    priceConflicts: pricing.conflicts,
    scopeBlockers,
  });
}
