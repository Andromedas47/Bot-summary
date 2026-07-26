import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizedMarketLabel } from "@/lib/market";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { resolveCentralPricesForDate } from "@/lib/white-sheet/load";
import type { Database } from "@/types/database";
import {
  calculateSalesReport,
  type SalesBlockReason,
  type SalesReport,
  type SalesScopeBlocker,
  type SalesSessionAudit,
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
 * parse_errors rows that mean data may be missing. "unsupported_type" is
 * excluded on purpose — a sticker or an image is not lost produce data, and
 * treating it as one would block every business date forever.
 */
const BLOCKING_PARSE_ERROR_TYPES = ["parser_crash", "timeout", "validation_error"] as const;

/** How far after a business date a backdated pending session is still looked for. */
const PENDING_BACKDATE_DAYS = 7;

/**
 * parse_errors is a generic table: any parser that throws lands in it, and the
 * webhook also files "registry" rows for message types nothing handles. Only a
 * failure that could have swallowed produce evidence (เบิก / คืน / คืนเสีย) may
 * demote a Sales report, so relevance is decided per row rather than per day.
 *
 * Two pieces of evidence, in order:
 *   1. parser_name — the crash handler stores the parser that was running, and
 *      the weigh-session parser is the one that produces P1's evidence.
 *   2. the raw message text — a crash from an unrecognized parser still blocks
 *      when the message itself looks like a weighing session, which is the same
 *      RE.SESSION_START test the parser uses to claim a message. That keeps a
 *      future produce parser fail-closed without P1 having to know its name.
 *
 * A non-text message (raw_text null) carries no produce lines by construction,
 * so an unrelated crash on one does not demote the day. A parse error whose raw
 * message cannot be read at all is treated as relevant — fail closed.
 */
const PRODUCE_PARSER_NAMES = new Set(["weigh-session"]);

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
 * A pending session that never produced a produce_session, or a message whose
 * parse crashed, may hold produce lines for ANY market — so neither can be
 * attributed, and both demote every total in the scope.
 */
async function loadScopeBlockers(
  supabase: Supabase,
  businessDate: string,
): Promise<SalesScopeBlocker[]> {
  const window = bangkokBusinessDateWindow(businessDate);
  const blockers: SalesScopeBlocker[] = [];

  const unresolvedPending = await countUnresolvedPendingSessions(supabase, businessDate);
  if (unresolvedPending > 0) {
    blockers.push({ kind: "unresolved_pending_session", count: unresolvedPending });
  }

  const { data: parseErrors, error: parseErrorsError } = await supabase
    .from("parse_errors")
    .select("id, parser_name, raw_message_id")
    .in("error_type", [...BLOCKING_PARSE_ERROR_TYPES])
    .gte("created_at", window.start)
    .lt("created_at", window.end);
  if (parseErrorsError) {
    throw new SalesDataError(`parse error query failed: ${parseErrorsError.message}`);
  }

  const relevant = await countProduceParseErrors(supabase, parseErrors ?? []);
  if (relevant > 0) {
    blockers.push({ kind: "message_parser_error", count: relevant });
  }

  return blockers;
}

/**
 * Pending produce sessions that never became a produce_session for this
 * business date.
 *
 * TWO deployed facts drive this (see 0036_additional_produce_entries.sql):
 *
 * 1. A row is NOT resolved just because finalized_at is set. finalize_* stamps
 *    finalized_at together with finalization_status = 'failed_closed' when items
 *    are missing or validation fails — the produce never landed. Only
 *    'finalized' and 'duplicate' mean the evidence is accounted for; every other
 *    status ('pending', 'processing', 'failed_closed') is missing evidence.
 *
 * 2. created_at is NOT the business date. Backdated input is normal: a session
 *    typed on the 5th whose header says 04/07/2569 belongs to the 4th. The
 *    business date comes from the accumulated text through the SAME parser the
 *    finalizer uses, so P1 can never disagree with what would have been
 *    persisted. With no explicit date the parser's own deployed fallback
 *    applies — the Bangkok business date of the row's creation.
 *
 * ponytail: the created_at scan is bounded to PENDING_BACKDATE_DAYS after the
 * business date. A session backdated by longer than that is not seen; widen the
 * window if real data ever needs it.
 */
async function countUnresolvedPendingSessions(
  supabase: Supabase,
  businessDate: string,
): Promise<number> {
  const window = bangkokBusinessDateWindow(businessDate);
  const scanEnd = new Date(
    Date.parse(window.end) + PENDING_BACKDATE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // pending_sessions is not part of the generated Database types (it is
  // operational webhook state, never a report source), so this one read uses a
  // loosened client exactly as PendingSessionService does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looseClient = supabase as unknown as SupabaseClient<any>;
  const { data, error } = await looseClient
    .from("pending_sessions")
    .select("id, accumulated_text, created_at, finalization_status")
    .gte("created_at", window.start)
    .lt("created_at", scanEnd);
  if (error) throw new SalesDataError(`pending session query failed: ${error.message}`);

  return (data ?? []).filter(
    (row: { accumulated_text?: string | null; created_at?: string | null; finalization_status?: string | null }) => {
      const status = row.finalization_status ?? "pending";
      if (status === "finalized" || status === "duplicate") return false;
      const date = pendingSessionBusinessDate(row);
      // No date evidence at all: count it. Excluding an unresolved session
      // because its date is unknown is the one direction that loses evidence.
      return date === null || date === businessDate;
    },
  ).length;
}

/**
 * The business date a pending session's produce belongs to: the explicit header
 * date when the text carries one, otherwise the deployed fallback (the Bangkok
 * business date of when it was created). Both come from existing helpers — no
 * second Buddhist-date parser exists in P1.
 */
function pendingSessionBusinessDate(row: {
  accumulated_text?: string | null;
  created_at?: string | null;
}): string | null {
  const createdFallback = row.created_at
    ? bangkokBusinessDateFromTimestamp(Date.parse(row.created_at))
    : null;
  const text = row.accumulated_text ?? "";
  if (!text.trim()) return createdFallback;
  return parseWeighSession(text, createdFallback).date ?? createdFallback;
}

/**
 * How many of the day's parse failures could have swallowed produce evidence.
 * See PRODUCE_PARSER_NAMES for the rule; the raw-message lookup only runs for
 * rows an unrecognized parser produced.
 */
async function countProduceParseErrors(
  supabase: Supabase,
  errors: readonly { parser_name: string; raw_message_id: string }[],
): Promise<number> {
  // Distinct raw messages, not rows: a webhook retry can file the same failure
  // twice, and one lost message is one blocker however often it was recorded.
  const distinct = [...new Map(errors.map((row) => [row.raw_message_id, row])).values()];
  const byParser = distinct.filter((row) => PRODUCE_PARSER_NAMES.has(row.parser_name));
  const unknown = distinct.filter((row) => !PRODUCE_PARSER_NAMES.has(row.parser_name));
  if (unknown.length === 0) return byParser.length;

  const texts = new Map<string, string | null>();
  for (const chunk of chunks([...new Set(unknown.map((row) => row.raw_message_id))], LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, raw_text")
      .in("id", chunk);
    if (error) throw new SalesDataError(`parse error message lookup failed: ${error.message}`);
    for (const row of data ?? []) texts.set(row.id, row.raw_text);
  }

  const relevantUnknown = unknown.filter((row) => {
    if (!texts.has(row.raw_message_id)) return true; // unreadable → fail closed
    const text = texts.get(row.raw_message_id);
    return typeof text === "string" && RE.SESSION_START.test(text);
  }).length;

  return byParser.length + relevantUnknown;
}

/**
 * Sessions the transaction rows cannot reveal.
 *
 * loadSessionIssues starts from produce_transactions, so a session that
 * persisted NO rows is invisible to it — total_items says produce was weighed
 * and nothing landed. This audits produce_sessions for the business date
 * independently, and only reports sessions the row-based path did not already
 * catch, so a broken session is never counted twice.
 *
 * Voided sessions are excluded (produce_transactions is already void-filtered;
 * a voided session's absence of rows is correct, not a failure). total_items = 0
 * claims nothing and is left alone.
 */
async function loadSessionAudits(
  supabase: Supabase,
  businessDate: string,
  rows: readonly ProduceTransactionRow[],
  sourceByRawMessageId: ReadonlyMap<string, string>,
): Promise<SalesSessionAudit[]> {
  const { data, error } = await supabase
    .from("produce_sessions")
    .select("id, session_title, total_items, raw_message_id, voided_at")
    .eq("session_date", businessDate)
    .is("voided_at", null);
  if (error) throw new SalesDataError(`produce session audit query failed: ${error.message}`);

  const sessionsWithRows = new Set(rows.map((row) => row.session_id));
  const audits: SalesSessionAudit[] = [];
  const missingSources: string[] = [];

  for (const session of data ?? []) {
    if (sessionsWithRows.has(session.id)) continue; // already audited through its rows
    if ((session.total_items ?? 0) <= 0) continue; // claimed nothing, lost nothing
    if (session.raw_message_id && !sourceByRawMessageId.has(session.raw_message_id)) {
      missingSources.push(session.raw_message_id);
    }
    audits.push({
      sessionId: session.id,
      sourceId: sourceByRawMessageId.get(session.raw_message_id) ?? null,
      marketName: normalizedMarketLabel(session.session_title) || null,
      reasons: ["session_rows_missing"],
    });
  }

  // A broken session's raw message is usually not among the day's transaction
  // rows, so its source has to be looked up before the market can be attributed.
  if (missingSources.length > 0) {
    const extra = await mapRawMessageSources(supabase, [...new Set(missingSources)]);
    for (const audit of audits) {
      if (audit.sourceId) continue;
      const session = (data ?? []).find((row) => row.id === audit.sessionId);
      if (session?.raw_message_id) audit.sourceId = extra.get(session.raw_message_id) ?? null;
    }
  }

  return audits;
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

  const sessionAudits = await loadSessionAudits(
    supabase,
    businessDate,
    rows,
    sourceByRawMessageId,
  );

  return calculateSalesReport({
    businessDate,
    rows: adaptRows(rows, sourceByRawMessageId, sessionIssues),
    centralPrices: pricing.prices,
    priceConflicts: pricing.conflicts,
    scopeBlockers,
    sessionAudits,
  });
}
