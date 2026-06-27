import { describe, expect, it } from "bun:test";
import {
  PendingSessionService,
  accumulatedHasLegacyContent,
  isIngestLedgerSparse,
  rebuildFromAccumulatedText,
  rebuildPendingSessionFromIngest,
  rebuildPendingSessionText,
  type PendingSession,
} from "./pending-session-service";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

function rawRow(
  eventId: string,
  text: string,
  timestamp: number,
  createdOffset: number,
) {
  return {
    line_event_id: eventId,
    raw_text: text,
    payload: { timestamp },
    created_at: new Date(Date.UTC(2026, 5, 10, 8, 0, 0) + createdOffset).toISOString(),
  };
}

function total(items: ReturnType<typeof parseWeighSession>["items"]): number {
  return items.reduce(
    (sum, item) => sum + item.price_per_unit * (item.quantity ?? 0),
    0,
  );
}

describe("rebuildPendingSessionFromIngest", () => {
  const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";
  const closeText = "จบรายการชั่งคืน";
  const LO = "\u0E42\u0E25";

  function itemLine(n: number): string {
    return `${n}มังคุด35บาท\n1${LO}`;
  }

  function closingSession(closeTs: number): PendingSession {
    return {
      id: "ps-1",
      session_key: "group-1",
      session_generation: "gen-1",
      accumulated_text: `${header}\nscrambled`,
      latest_reply_token: null,
      line_user_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      close_event_timestamp_ms: closeTs,
      close_line_event_id: "close",
    };
  }

  it("orders ingest rows by LINE timestamp then event id regardless of insert order", () => {
    const closeTs = 1_700_000_000_100;
    const rows = [
      { line_event_id: "item-2", line_timestamp_ms: closeTs - 98, raw_text: itemLine(2) },
      { line_event_id: "item-1", line_timestamp_ms: closeTs - 99, raw_text: itemLine(1) },
      { line_event_id: "close", line_timestamp_ms: closeTs, raw_text: closeText },
      { line_event_id: "item-14", line_timestamp_ms: closeTs - 86, raw_text: itemLine(14) },
      { line_event_id: "hdr", line_timestamp_ms: closeTs - 100, raw_text: header },
      { line_event_id: "item-22", line_timestamp_ms: closeTs - 78, raw_text: itemLine(22) },
    ];

    const rebuilt = rebuildPendingSessionFromIngest(closingSession(closeTs), rows);
    const parsed = parseWeighSession(rebuilt, "2026-06-25");

    expect(parsed.items.map((item) => item.item_number)).toEqual([1, 2, 14, 22]);
    expect(rebuilt.split("\n").at(-1)).toBe(closeText);
    expect(parsed.parse_errors.some((e) => e.includes("#14"))).toBe(false);
  });

  it("places close after earlier timestamps even when ingested out of order", () => {
    const closeTs = 50;
    const rows = [
      { line_event_id: "close", line_timestamp_ms: closeTs, raw_text: closeText },
      { line_event_id: "item-2", line_timestamp_ms: 20, raw_text: itemLine(2) },
      { line_event_id: "hdr", line_timestamp_ms: 1, raw_text: header },
      { line_event_id: "item-1", line_timestamp_ms: 10, raw_text: itemLine(1) },
    ];

    const rebuilt = rebuildPendingSessionFromIngest(closingSession(closeTs), rows);
    expect(rebuilt).toBe([header, itemLine(1), itemLine(2), closeText].join("\n"));
  });

  it("starts from the latest session header when prior ingest rows remain", () => {
    const closeTs = 100;
    const rows = [
      { line_event_id: "old-hdr", line_timestamp_ms: 1, raw_text: header },
      { line_event_id: "old-close", line_timestamp_ms: 2, raw_text: "จบรายการเบิก" },
      { line_event_id: "hdr", line_timestamp_ms: 10, raw_text: header },
      { line_event_id: "item-1", line_timestamp_ms: 11, raw_text: itemLine(1) },
      { line_event_id: "close", line_timestamp_ms: closeTs, raw_text: closeText },
    ];

    const rebuilt = rebuildPendingSessionFromIngest(closingSession(closeTs), rows);
    const parsed = parseWeighSession(rebuilt, "2026-06-25");

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].item_number).toBe(1);
  });
});

describe("legacy pre-0042 finalization fallback", () => {
  const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";
  const closeText = "จบรายการชั่งคืน";
  const LO = "\u0E42\u0E25";

  function itemLine(n: number): string {
    return `${n}มังคุด35บาท\n1${LO}`;
  }

  function legacySession(itemCount: number, closeTs: number): PendingSession {
    const lines = [header, ...Array.from({ length: itemCount }, (_, i) => itemLine(i + 1)), closeText];
    return {
      id: "ps-legacy",
      session_key: "group-1",
      session_generation: "gen-pre-0042",
      accumulated_text: lines.join("\n"),
      latest_reply_token: null,
      line_user_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      close_event_timestamp_ms: closeTs,
      close_line_event_id: "close",
    };
  }

  it("detects sparse ingest when ledger only captured post-deploy close", () => {
    const closeTs = 1_700_000_000_100;
    const session = legacySession(3, closeTs);
    const rows = [{ line_event_id: "close", line_timestamp_ms: closeTs, raw_text: closeText }];
    const ingestText = rebuildPendingSessionFromIngest(session, rows);

    expect(isIngestLedgerSparse(session, rows, ingestText)).toBe(true);
    expect(rebuildFromAccumulatedText(session)).toContain(itemLine(1));
  });

  it("uses accumulated_text when ingest omits pre-deploy header and items", () => {
    const closeTs = 1_700_000_000_100;
    const session = legacySession(3, closeTs);
    const rows = [
      { line_event_id: "item-3", line_timestamp_ms: closeTs - 1, raw_text: itemLine(3) },
      { line_event_id: "close", line_timestamp_ms: closeTs, raw_text: closeText },
    ];
    const ingestText = rebuildPendingSessionFromIngest(session, rows);

    expect(isIngestLedgerSparse(session, rows, ingestText)).toBe(true);
    const rebuilt = rebuildFromAccumulatedText(session)!;
    expect(parseWeighSession(rebuilt, "2026-06-25").items.map((item) => item.item_number)).toEqual([1, 2, 3]);
  });

  it("trusts a complete ingest ledger that includes the session header", () => {
    const closeTs = 100;
    const rows = [
      { line_event_id: "hdr", line_timestamp_ms: 1, raw_text: header },
      { line_event_id: "item-1", line_timestamp_ms: 10, raw_text: itemLine(1) },
      { line_event_id: "close", line_timestamp_ms: closeTs, raw_text: closeText },
    ];
    const session = legacySession(1, closeTs);
    const ingestText = rebuildPendingSessionFromIngest(session, rows);

    expect(isIngestLedgerSparse(session, rows, ingestText)).toBe(false);
  });

  it("recognizes legacy accumulated content by line count", () => {
    expect(accumulatedHasLegacyContent([header, itemLine(1), closeText].join("\n"))).toBe(true);
    expect(accumulatedHasLegacyContent([header, closeText].join("\n"))).toBe(false);
  });
});

describe("checkPendingCloseReadyFromTables — generation scope", () => {
  const sessionKey = "group-scope";
  const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";
  const closeTs = 1_700_000_000_100;

  function closingSession(generation: string): PendingSession {
    return {
      id: "ps-scope",
      session_key: sessionKey,
      session_generation: generation,
      accumulated_text: header,
      latest_reply_token: null,
      line_user_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      close_event_timestamp_ms: closeTs,
      close_requested_at: new Date().toISOString(),
      close_line_event_id: "close",
    };
  }

  it("ignores admissions and ingests from a prior session generation", async () => {
    const { checkPendingCloseReadyFromTables } = await import("./pending-session-service");
    const { memSupabase } = await import("@/lib/test-utils/mem-supabase");

    const genA = "gen-a";
    const genB = "gen-b";
    const db = memSupabase({
      pending_sessions: [closingSession(genB)],
      pending_session_admission: [
        {
          session_key: sessionKey,
          session_generation: genA,
          line_event_id: "stale-item",
          line_timestamp_ms: closeTs - 1,
          admitted_at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          session_key: sessionKey,
          session_generation: genB,
          line_event_id: "hdr",
          line_timestamp_ms: closeTs - 10,
          admitted_at: new Date(Date.now() - 30_000).toISOString(),
        },
        {
          session_key: sessionKey,
          session_generation: genB,
          line_event_id: "close",
          line_timestamp_ms: closeTs,
          admitted_at: new Date(Date.now() - 20_000).toISOString(),
        },
      ],
      pending_session_ingest: [
        {
          session_key: sessionKey,
          session_generation: genA,
          line_event_id: "stale-item",
          line_timestamp_ms: closeTs - 1,
          raw_text: "1.มังคุด35บาท\n1โล",
        },
        {
          session_key: sessionKey,
          session_generation: genB,
          line_event_id: "hdr",
          line_timestamp_ms: closeTs - 10,
          raw_text: header,
        },
        {
          session_key: sessionKey,
          session_generation: genB,
          line_event_id: "close",
          line_timestamp_ms: closeTs,
          raw_text: "จบรายการชั่งคืน",
        },
      ],
    });

    const readiness = await checkPendingCloseReadyFromTables(db as never, sessionKey);

    expect(readiness.ready).toBe(true);
    expect(readiness.admissionCount).toBe(2);
    expect(readiness.ingestCount).toBe(2);
  });

  it("blocks close when current generation has admission without matching ingest", async () => {
    const { checkPendingCloseReadyFromTables } = await import("./pending-session-service");
    const { memSupabase } = await import("@/lib/test-utils/mem-supabase");

    const gen = "gen-current";
    const db = memSupabase({
      pending_sessions: [closingSession(gen)],
      pending_session_admission: [
        {
          session_key: sessionKey,
          session_generation: gen,
          line_event_id: "hdr",
          line_timestamp_ms: closeTs - 10,
          admitted_at: new Date(Date.now() - 30_000).toISOString(),
        },
        {
          session_key: sessionKey,
          session_generation: gen,
          line_event_id: "item-1",
          line_timestamp_ms: closeTs - 1,
          admitted_at: new Date(Date.now() - 25_000).toISOString(),
        },
        {
          session_key: sessionKey,
          session_generation: gen,
          line_event_id: "close",
          line_timestamp_ms: closeTs,
          admitted_at: new Date(Date.now() - 20_000).toISOString(),
        },
      ],
      pending_session_ingest: [
        {
          session_key: sessionKey,
          session_generation: gen,
          line_event_id: "hdr",
          line_timestamp_ms: closeTs - 10,
          raw_text: header,
        },
        {
          session_key: sessionKey,
          session_generation: gen,
          line_event_id: "close",
          line_timestamp_ms: closeTs,
          raw_text: "จบรายการชั่งคืน",
        },
      ],
    });

    const readiness = await checkPendingCloseReadyFromTables(db as never, sessionKey);

    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe("awaiting_ingest");
    expect(readiness.admissionCount).toBe(3);
    expect(readiness.ingestCount).toBe(2);
  });
});

describe("produce pending-session finalization ordering", () => {
  const header = "น้อย-วัดตะกล่ำ เบิก 10/6/2569";

  it("rebuilds header + 13 item messages + end into all 13 saved items", () => {
    const productNames = [
      "แตงโม",
      "มะละกอ",
      "ภูเขาไฟ",
      "แก้วแดง",
      "หมอนทอง",
      "ชะนี",
      "กระดุม",
      "ก้านยาว",
      "กระท้อน",
      "ส้ม",
      "แอปเปิ้ล",
      "แตงไทย",
    ];
    const itemMessages = Array.from({ length: 13 }, (_, index) => {
      const itemNumber = index + 1;
      if (itemNumber === 13) {
        return `${itemNumber}.แก้วแดง100บาท\n223.716โล`;
      }
      return `${itemNumber}.${productNames[index]}${itemNumber * 10}บาท\n${itemNumber}โล`;
    });
    const end = "จบรายการเบิก";
    const rows = [
      rawRow("end", end, 30, 30),
      ...itemMessages.map((text, index) =>
        rawRow(`item-${index + 1}`, text, index + 2, index + 2),
      ),
      rawRow("header", header, 1, 1),
    ];

    const rebuilt = rebuildPendingSessionText(header, rows, 30);
    const parsed = parseWeighSession(rebuilt, "2026-06-10");

    expect(parsed.items).toHaveLength(13);
    expect(total(parsed.items)).toBeCloseTo(28871.6, 6);
  });

  it("keeps slowly processed active-session messages available until explicit end", () => {
    const rows = [
      rawRow("header", header, 1, 1),
      rawRow("item-1", "1.แตงโม10บาท\n2โล", 2, 31 * 60 * 1000),
      rawRow("end", "จบรายการเบิก", 3, 32 * 60 * 1000),
    ];

    const rebuilt = rebuildPendingSessionText(header, rows, 3);
    const parsed = parseWeighSession(rebuilt, "2026-06-10");

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].product_name).toBe("แตงโม");
  });

  it("orders concurrent raw events by LINE timestamp without losing items", () => {
    const rows = [
      rawRow("item-3", "3.ภูเขาไฟ30บาท\n3โล", 4, 1),
      rawRow("item-1", "1.แตงโม10บาท\n1โล", 2, 4),
      rawRow("header", header, 1, 3),
      rawRow("item-2", "2.มะละกอ20บาท\n2โล", 3, 2),
      rawRow("end", "จบรายการเบิก", 5, 0),
    ];

    const parsed = parseWeighSession(
      rebuildPendingSessionText(header, rows, 5),
      "2026-06-10",
    );

    expect(parsed.items.map((item) => item.item_number)).toEqual([1, 2, 3]);
  });

  it("places the end command after all earlier events even when it arrives first", () => {
    const rows = [
      rawRow("end", "จบรายการเบิก", 4, 1),
      rawRow("item-2", "2.มะละกอ20บาท\n2โล", 3, 4),
      rawRow("header", header, 1, 3),
      rawRow("item-1", "1.แตงโม10บาท\n1โล", 2, 2),
    ];

    const rebuilt = rebuildPendingSessionText(header, rows, 4);

    expect(rebuilt.split("\n").at(-1)).toBe("จบรายการเบิก");
    expect(parseWeighSession(rebuilt).items).toHaveLength(2);
  });

  it("starts from the latest matching header when a prior session reused the same header", () => {
    const rows = [
      rawRow("old-header", header, 1, 1),
      rawRow("old-item", "1.ของเก่า10บาท\n99โล", 2, 2),
      rawRow("old-end", "จบรายการเบิก", 3, 3),
      rawRow("header", header, 4, 4),
      rawRow("item", "1.แตงโม10บาท\n1โล", 5, 5),
      rawRow("end", "จบรายการเบิก", 6, 6),
    ];

    const parsed = parseWeighSession(
      rebuildPendingSessionText(header, rows, 6),
      "2026-06-10",
    );

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].product_name).toBe("แตงโม");
  });

  it("reports an unrecognized raw line without dropping unrelated valid items", () => {
    const rows = [
      rawRow("header", header, 1, 1),
      rawRow("item-1", "1.แตงโม10บาท\n1โล", 2, 2),
      rawRow("bad", "ข้อความที่อ่านไม่ได้", 3, 3),
      rawRow("item-2", "2.มะละกอ20บาท\n2โล", 4, 4),
      rawRow("end", "จบรายการเบิก", 5, 5),
    ];

    const parsed = parseWeighSession(
      rebuildPendingSessionText(header, rows, 5),
      "2026-06-10",
    );

    expect(parsed.items).toHaveLength(2);
    expect(parsed.parse_errors).toContain(
      'unrecognized line: "ข้อความที่อ่านไม่ได้"',
    );
  });
});

describe("PendingSessionService.append", () => {
  it("fails visibly when append_pending_session RPC is unavailable", async () => {
    const writes: unknown[] = [];
    const service = new PendingSessionService({
      from() {
        writes.push("from-called");
        return {
          upsert() {
            writes.push("upsert-called");
            return Promise.resolve({ error: null });
          },
        };
      },
    } as never);

    await expect(service.append("group-1", "1.มะม่วง100บาท", "reply-1")).rejects.toThrow(
      "append_pending_session RPC unavailable",
    );
    expect(writes).toEqual([]);
  });

  it("does not fall back to read-modify-write when append_pending_session RPC fails", async () => {
    const writes: unknown[] = [];
    const service = new PendingSessionService({
      rpc: async () => ({ data: null, error: { message: "rpc down" } }),
      from() {
        writes.push("from-called");
        return {
          upsert() {
            writes.push("upsert-called");
            return Promise.resolve({ error: null });
          },
        };
      },
    } as never);

    await expect(service.append("group-1", "1.มะม่วง100บาท", "reply-1")).rejects.toThrow(
      "pending session append failed: rpc down",
    );
    expect(writes).toEqual([]);
  });
});
