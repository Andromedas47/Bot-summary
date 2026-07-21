import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { KNOWN_TX_TYPES } from "@/lib/summary/transactions";
import type { RemainingFruitSourceRow } from "@/lib/summary/remaining-fruit";
import { logger } from "@/lib/logger";

const PAGE = 1000;

export async function fetchRemainingFruitRows(
  supabase: SupabaseClient<Database>,
  date: string,
  marketFilter?: string | null,
): Promise<RemainingFruitSourceRow[]> {
  const rows: RemainingFruitSourceRow[] = [];
  let offset = 0;

  while (true) {
    let query = supabase
      .from("produce_transactions")
      .select("market_name, product_name, quantity, unit, transaction_type, session_id, sender_name")
      .eq("transaction_date", date)
      .in("transaction_type", [...KNOWN_TX_TYPES])
      .order("item_created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (marketFilter) {
      query = query.ilike("market_name", `%${marketFilter}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    rows.push(...((data ?? []) as RemainingFruitSourceRow[]));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }

  // Session-identity enrichment (source_id / session_time) is only used for optional
  // dedup — never let a failure here take down the whole report. Displaying possible
  // duplicates is safer than failing the report.
  try {
    await attachSessionIdentity(supabase, rows);
  } catch (err) {
    logger.warn("summary.remaining-fruit.enrichment-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return rows;
}

async function attachSessionIdentity(
  supabase: SupabaseClient<Database>,
  rows: RemainingFruitSourceRow[],
): Promise<void> {
  const sessionIds = [...new Set(rows.map((r) => r.session_id).filter((id): id is string => !!id))];
  if (sessionIds.length === 0) return;

  const { data: sessions, error: sessionsError } = await supabase
    .from("produce_sessions")
    .select("id, raw_message_id, finalized_at, created_at")
    .in("id", sessionIds);
  if (sessionsError) throw new Error(sessionsError.message);

  const sessionMeta = new Map<string, { rawMessageId: string; time: string | null }>();
  for (const s of sessions ?? []) {
    sessionMeta.set(s.id, {
      rawMessageId: s.raw_message_id,
      time: s.finalized_at ?? s.created_at ?? null,
    });
  }

  const rawMessageIds = [...new Set([...sessionMeta.values()].map((v) => v.rawMessageId))];
  const sourceIdByRawMessage = new Map<string, string | null>();
  if (rawMessageIds.length > 0) {
    const { data: messages, error: messagesError } = await supabase
      .from("raw_messages")
      .select("id, source_id")
      .in("id", rawMessageIds);
    if (messagesError) throw new Error(messagesError.message);

    for (const m of messages ?? []) sourceIdByRawMessage.set(m.id, m.source_id ?? null);
  }

  for (const row of rows) {
    if (!row.session_id) continue;
    const meta = sessionMeta.get(row.session_id);
    if (!meta) continue;
    row.source_id = sourceIdByRawMessage.get(meta.rawMessageId) ?? null;
    row.session_time = meta.time;
  }
}
