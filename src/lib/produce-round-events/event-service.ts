import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import type { ProduceRoundEventDraft, ProduceRoundEvent, EventKind, EventStatus } from "./types";

type Row = Record<string, unknown>;

function toRow(d: ProduceRoundEventDraft): Row {
  return {
    raw_message_id:    d.rawMessageId,
    line_event_id:     d.lineEventId,
    seq_in_message:    d.seqInMessage,
    line_timestamp_ms: d.lineTimestampMs,
    event_kind:        d.eventKind,
    event_status:      d.eventStatus,
    raw_line:          d.rawLine,
    normalized_line:   d.normalizedLine,
    category:          d.category ?? null,
    parsed_payload:    d.parsedPayload,
    work_round_id:     d.workRoundId ?? null,
  };
}

function fromRow(r: Row): ProduceRoundEvent {
  return {
    id:              r.id as string,
    rawMessageId:    r.raw_message_id as string,
    lineEventId:     r.line_event_id as string,
    seqInMessage:    r.seq_in_message as number,
    lineTimestampMs: r.line_timestamp_ms as number,
    eventKind:       r.event_kind as EventKind,
    eventStatus:     r.event_status as EventStatus,
    rawLine:         r.raw_line as string,
    normalizedLine:  r.normalized_line as string,
    category:        (r.category as string | null) ?? null,
    parsedPayload:   (r.parsed_payload as Record<string, unknown>) ?? {},
    workRoundId:     (r.work_round_id as string | null) ?? null,
    createdAt:       r.created_at as string,
  };
}

function deterministicSort(events: ProduceRoundEvent[]): ProduceRoundEvent[] {
  return [...events].sort((a, b) => {
    if (a.lineTimestampMs !== b.lineTimestampMs) return a.lineTimestampMs - b.lineTimestampMs;
    if (a.seqInMessage    !== b.seqInMessage)    return a.seqInMessage    - b.seqInMessage;
    return a.lineEventId < b.lineEventId ? -1 : a.lineEventId > b.lineEventId ? 1 : 0;
  });
}

export class ProduceRoundEventService {
  constructor(private readonly db: SupabaseClient<Database>) {}

  /**
   * Idempotent bulk insert via DB RPC. Conflicts on either unique constraint are
   * silently skipped; existing rows are never updated. Returns only newly inserted events.
   */
  async bulkInsert(drafts: ProduceRoundEventDraft[]): Promise<ProduceRoundEvent[]> {
    if (drafts.length === 0) return [];

    const { data, error } = await this.db.rpc("insert_produce_round_events_ignore", {
      events: drafts.map(toRow) as Json,
    });

    if (error) throw new Error(`bulkInsert failed: ${error.message}`);
    return deterministicSort(((data as Row[]) ?? []).map(fromRow));
  }

  /** Events for one message, ordered by seq_in_message. */
  async listByMessage(rawMessageId: string): Promise<ProduceRoundEvent[]> {
    const { data, error } = await (this.db as any)
      .from("produce_round_events")
      .select("*")
      .eq("raw_message_id", rawMessageId);

    if (error) throw new Error(`listByMessage failed: ${error.message}`);
    const events = ((data as Row[]) ?? []).map(fromRow);
    return events.sort((a, b) => a.seqInMessage - b.seqInMessage);
  }

  /** Events across all messages in a LINE source, deterministically ordered. */
  async listBySource(
    sourceId: string,
    opts?: { workRoundId?: string },
  ): Promise<ProduceRoundEvent[]> {
    const { data: messages, error: msgErr } = await (this.db as any)
      .from("raw_messages")
      .select("id")
      .eq("source_id", sourceId);

    if (msgErr) throw new Error(`listBySource message lookup failed: ${msgErr.message}`);

    const msgIds = ((messages as Row[]) ?? []).map((r) => r.id as string);
    if (msgIds.length === 0) return [];

    let q = (this.db as any)
      .from("produce_round_events")
      .select("*")
      .in("raw_message_id", msgIds);

    if (opts?.workRoundId != null) {
      q = q.eq("work_round_id", opts.workRoundId);
    }

    const { data, error } = await q;
    if (error) throw new Error(`listBySource failed: ${error.message}`);

    return deterministicSort(((data as Row[]) ?? []).map(fromRow));
  }
}
