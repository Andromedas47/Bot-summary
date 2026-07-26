import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizedMarketLabel } from "@/lib/market";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { isStrictBusinessDate } from "./cron";
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

/**
 * Pending finalization states that account for the produce: 'finalized' created
 * the produce_session, 'duplicate' proved one already existed. Everything else
 * ('pending', 'processing', 'failed_closed') is produce that never landed.
 */
const RESOLVED_PENDING_STATUSES = new Set(["finalized", "duplicate"]);

/** Safety stop for the undated scope scans — a short read must never pass silently. */
const SCOPE_SCAN_MAX_PAGES = 50;

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
  // No time window here: both scans are attributed by the produce business date
  // their own evidence names, not by when the row happened to be written.
  const blockers: SalesScopeBlocker[] = [];

  const unresolvedPending = await countUnresolvedPendingSessions(supabase, businessDate);
  if (unresolvedPending > 0) {
    blockers.push({ kind: "unresolved_pending_session", count: unresolvedPending });
  }

  const relevant = await countProduceParseErrors(supabase, businessDate);
  if (relevant > 0) {
    blockers.push({ kind: "message_parser_error", count: relevant });
  }

  return blockers;
}

/**
 * Pages through a narrow scope query with no date bound.
 *
 * Both scope scans (unresolved pending sessions, blocking parse errors) are
 * filtered server-side to states that are rare by construction, then attributed
 * client-side by their produce business date — the row's own timestamps cannot
 * do it, because backdated entry is normal. If such a scan ever exceeds
 * SCOPE_SCAN_MAX_PAGES the loader throws rather than returning a short read: a
 * truncated scope scan would silently under-report blockers.
 */
async function fetchAllScopeRows<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];

  for (let index = 0; index < SCOPE_SCAN_MAX_PAGES; index += 1) {
    const from = index * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new SalesDataError(`${label} query failed: ${error.message}`);

    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }

  throw new SalesDataError(`${label} scan exceeded ${SCOPE_SCAN_MAX_PAGES} pages`);
}

/**
 * The business date a produce message belongs to.
 *
 * The explicit header date wins — that is what the finalizer would persist as
 * session_date, and a message typed on the 26th whose header says 25/07/2569 is
 * evidence about the 25th. With no explicit date the deployed fallback applies:
 * the Bangkok business date of when the message arrived, exactly what
 * WeighSessionParser.parse passes as its fallbackDate. One parser, one rule.
 */
function produceBusinessDate(text: string | null | undefined, arrivedAt: string | null | undefined): string | null {
  const fallback = arrivedAt ? bangkokBusinessDateFromTimestamp(Date.parse(arrivedAt)) : null;
  if (!text || !text.trim()) return fallback;
  return parseWeighSession(text, fallback).date ?? fallback;
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
 * 2. created_at is NOT the business date, and nothing limits how late produce
 *    may be entered. The scan is therefore filtered by STATE, not by time: the
 *    unresolved rows are the ones that matter, however long ago they were
 *    created, and each is attributed by the business date its own text names.
 *    There is no locked rule capping backdating, so P1 imposes no ceiling.
 */
async function countUnresolvedPendingSessions(
  supabase: Supabase,
  businessDate: string,
): Promise<number> {
  // pending_sessions is not part of the generated Database types (it is
  // operational webhook state, never a report source), so this one read uses a
  // loosened client exactly as PendingSessionService does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looseClient = supabase as unknown as SupabaseClient<any>;

  const rows = await fetchAllScopeRows<{
    accumulated_text?: string | null;
    created_at?: string | null;
    finalization_status?: string | null;
  }>("pending session", (from, to) =>
    looseClient
      .from("pending_sessions")
      .select("id, accumulated_text, created_at, finalization_status")
      // Resolved rows are the overwhelming majority and can never be evidence
      // of missing produce, so they are excluded server-side; the client-side
      // check below is the authority either way.
      .not("finalization_status", "in", `(${[...RESOLVED_PENDING_STATUSES].join(",")})`)
      .range(from, to),
  );

  return rows.filter((row) => {
    const status = row.finalization_status ?? "pending";
    if (RESOLVED_PENDING_STATUSES.has(status)) return false;
    const date = produceBusinessDate(row.accumulated_text, row.created_at);
    // No date evidence at all: count it. Excluding an unresolved session
    // because its date is unknown is the one direction that loses evidence.
    return date === null || date === businessDate;
  }).length;
}

/**
 * How many of the day's parse failures could have swallowed produce evidence.
 * See PRODUCE_PARSER_NAMES for the rule; the raw-message lookup only runs for
 * rows an unrecognized parser produced.
 */
async function countProduceParseErrors(
  supabase: Supabase,
  businessDate: string,
): Promise<number> {
  const errors = await fetchAllScopeRows<{ parser_name: string; raw_message_id: string }>(
    "parse error",
    (from, to) =>
      supabase
        .from("parse_errors")
        .select("id, parser_name, raw_message_id")
        .in("error_type", [...BLOCKING_PARSE_ERROR_TYPES])
        .range(from, to),
  );

  // Distinct raw messages, not rows: a webhook retry can file the same failure
  // twice, and one lost message is one blocker however often it was recorded.
  const distinct = [...new Map(errors.map((row) => [row.raw_message_id, row])).values()];
  if (distinct.length === 0) return 0;

  // The raw message carries both pieces of evidence a parse error lacks: what
  // was said (is this produce at all?) and which business date it was about.
  const messages = new Map<string, { raw_text: string | null; created_at: string | null }>();
  for (const chunk of chunks(distinct.map((row) => row.raw_message_id), LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, raw_text, created_at")
      .in("id", chunk);
    if (error) throw new SalesDataError(`parse error message lookup failed: ${error.message}`);
    for (const row of data ?? []) {
      messages.set(row.id, { raw_text: row.raw_text, created_at: row.created_at });
    }
  }

  return distinct.filter((row) => {
    const message = messages.get(row.raw_message_id);
    // Unreadable evidence: cannot prove it was not this day's produce.
    if (!message) return true;

    const isProduce =
      PRODUCE_PARSER_NAMES.has(row.parser_name)
      || (typeof message.raw_text === "string" && RE.SESSION_START.test(message.raw_text));
    if (!isProduce) return false;

    // A crash on a message headed 25/07/2569 is a blocker for the 25th, even
    // when it arrived on the 26th — and it must NOT block the 26th.
    const date = produceBusinessDate(message.raw_text, message.created_at);
    return date === null || date === businessDate;
  }).length;
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
  // Strict: a day that never existed (2026-02-31) would silently return an
  // empty, apparently clean report for a date nothing can ever be filed under.
  if (!isStrictBusinessDate(businessDate)) {
    throw new SalesDataError("businessDate must be a real ISO date (YYYY-MM-DD)");
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
