import { describe, expect, test } from "bun:test";
import {
  buildPhysicalInventoryFailedMessage,
  buildPhysicalInventorySuccessMessage,
  finalizePhysicalInventorySession,
} from "./finalizer";
import {
  PhysicalInventoryStaleRevisionError,
  type PhysicalInventoryFinalizeCandidate,
  type PhysicalInventorySessionRow,
  type PhysicalInventorySnapshotRow,
} from "./session-service";
import type { PhysicalInventoryParsedSession } from "./types";

const SESSION_ID = "40000000-0000-4000-8000-000000000001";
const GENERATION = "50000000-0000-4000-8000-000000000001";
const CLOSE_RAW_ID = "60000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "70000000-0000-4000-8000-000000000001";

const FIXTURE_27_MESSAGES = [
  "สตอกผลไม้คงเหลือวันนี้\n27/7/69",
  "1แตงโม\n45.ลูก",
  "2มะละกอ\n15ลูก",
  "3พุทรานม\n2ตะกร้า",
  "4มะม่วงโชคอนัน\n15.โล",
  "5แอปเปิ้ล\n314.ลูก",
  "6สาลี่น้ำผึ้ง\n236.ลูก",
  "7องุ่นเขียวตะกร้าแดง\n12.ตะกร้า",
  "8องุ่นไชมัสแต่งตะกร้าดำ\n10.ตะกร้า",
  "จบรายการผลไม้ที่เหลือในบ้าน",
];

const FIXTURE_26_MESSAGES = [
  "สตอกผลไม้คงเหลือ\n26/7/69",
  "1พุทรา3ตะกร้า",
  "2แก้วมังกร\n15โล",
  "3มะละกอ\n90.ลูก",
  "4แตงโม\n80.ลูก",
  "5สาลี\n432.ลูก",
  "6แอปเปิ้ล\n440.ลูก",
  "7องุ่นเขียวเลก\n16.ตะกร้า",
  "8โชคอนัน\n1ตะกร้า",
  "9องุ่นไชมัสตะกร้าขาว\n12.ตะกร้า",
  "10องุ่นไชมัสตะกร้าดำ\n6ตะกร้า",
  "11องุ่นไชมัสตะกร้าดำยังไม่แต่ง\n13.ตะกร้า",
  "จบ",
];

function rawMessageDb() {
  const raw = { id: CLOSE_RAW_ID, is_processed: false };
  function query() {
    let update: { is_processed?: boolean } | null = null;
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.update = (value: { is_processed?: boolean }) => {
      update = value;
      return api;
    };
    api.eq = () => api;
    api.maybeSingle = async () => ({ data: { ...raw }, error: null });
    api.then = (resolve: (value: unknown) => void) => {
      if (update) Object.assign(raw, update);
      resolve({ data: null, error: null });
    };
    return api;
  }
  return {
    from(table: string) {
      if (table !== "raw_messages") throw new Error(`unexpected table ${table}`);
      return query();
    },
    raw,
  };
}

function makeCandidate(messages: string[]): PhysicalInventoryFinalizeCandidate {
  return {
    sessionId: SESSION_ID,
    sessionGeneration: GENERATION,
    status: "closing",
    ingestRevision: messages.length,
    ingestSetHash: `hash-${messages.length}`,
    closeEventTimestampMs: 2_000,
    closeQuietUntil: "2026-07-28T00:00:00.000Z",
    closeDeadlineAt: "2026-07-28T00:00:22.000Z",
    ingests: messages.map((rawText, index) => ({
      line_event_id: `event-${index + 1}`,
      line_timestamp_ms: 1_000 + index,
      kind: index === 0 ? "header" : index === messages.length - 1 ? "close" : "item",
      raw_text: rawText,
      ingest_revision: index + 1,
      line_message_id: `message-${index + 1}`,
      raw_message_id: index === messages.length - 1 ? CLOSE_RAW_ID : null,
    })),
  };
}

function terminalSession(
  status: "finalized" | "failed_closed",
): PhysicalInventorySessionRow {
  return {
    id: SESSION_ID,
    source_type: "group",
    source_id: "C1d96954d298d99f65912a5f1e96edffc",
    sender_line_user_id: "U-sender",
    opened_line_event_id: "event-1",
    session_generation: GENERATION,
    business_date: status === "finalized" ? "2026-07-27" : null,
    warehouse_code: "MAIN",
    status,
    parser_version: "p2a-physical-1.0.0",
    opened_at: "2026-07-28T00:00:00.000Z",
    close_requested_at: "2026-07-28T00:00:01.000Z",
    close_event_timestamp_ms: 2_000,
    close_quiet_until: "2026-07-28T00:00:09.000Z",
    close_deadline_at: "2026-07-28T00:00:31.000Z",
    closed_at: "2026-07-28T00:00:09.000Z",
    failed_closed_at: status === "failed_closed" ? "2026-07-28T00:00:09.000Z" : null,
    fail_reason: status === "failed_closed" ? "missing_or_invalid_date" : null,
    ingest_revision: 10,
    snapshot_id: status === "finalized" ? SNAPSHOT_ID : null,
    header_raw_message_id: "header-raw",
    close_raw_message_id: CLOSE_RAW_ID,
    close_line_event_id: "event-close",
    warnings: [],
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:09.000Z",
  };
}

function snapshot(itemCount: number, rejectedCount = 0): PhysicalInventorySnapshotRow {
  return {
    id: SNAPSHOT_ID,
    session_id: SESSION_ID,
    warehouse_code: "MAIN",
    source_type: "group",
    source_id: "C1d96954d298d99f65912a5f1e96edffc",
    sender_line_user_id: "U-sender",
    business_date: "2026-07-27",
    counted_at: "2026-07-28T00:00:02.000Z",
    parser_version: "p2a-physical-1.0.0",
    accepted_normalized_count: itemCount - rejectedCount,
    accepted_raw_count: 0,
    rejected_count: rejectedCount,
    item_count: itemCount,
    warnings: [],
    status: "finalized",
    ingest_idempotency_key: `${SESSION_ID}:${GENERATION}`,
    finalized_ingest_revision: 10,
    finalized_ingest_hash: "hash",
    finalized_at: "2026-07-28T00:00:09.000Z",
    voided_at: null,
    voided_by: null,
    void_reason: null,
    replacement_snapshot_id: null,
    created_at: "2026-07-28T00:00:09.000Z",
  };
}

function gatewayFor(messages: string[], options?: {
  staleOnce?: boolean;
  forceFailed?: boolean;
}) {
  let status: "closing" | "finalized" | "failed_closed" = "closing";
  let stale = options?.staleOnce === true;
  let candidateCalls = 0;
  let finalizeCalls = 0;
  let parsed: PhysicalInventoryParsedSession | null = null;

  const gateway = {
    async getFinalizeCandidate() {
      candidateCalls += 1;
      return { ...makeCandidate(messages), status };
    },
    async finalize(params: { parsed: PhysicalInventoryParsedSession }) {
      finalizeCalls += 1;
      parsed = params.parsed;
      if (stale) {
        stale = false;
        throw new PhysicalInventoryStaleRevisionError();
      }
      status = options?.forceFailed ? "failed_closed" : "finalized";
      return {
        ok: true,
        idempotent: false,
        status,
        snapshotId: status === "finalized" ? SNAPSHOT_ID : null,
        sessionId: SESSION_ID,
      };
    },
    async getSession() {
      return status === "closing" ? null : terminalSession(status);
    },
    async getSnapshot() {
      return status === "finalized" ? snapshot(parsed?.items.length ?? 0) : null;
    },
    stats() {
      return { candidateCalls, finalizeCalls, parsed };
    },
  };
  return gateway;
}

describe("P2A Slice C finalizer", () => {
  test("parses the coherent 27/7 candidate into 8 observations", async () => {
    const db = rawMessageDb();
    const gateway = gatewayFor(FIXTURE_27_MESSAGES);
    const pushes: Array<{ text: string; retryKey?: string }> = [];

    await finalizePhysicalInventorySession(
      db as never,
      { sessionId: SESSION_ID, expectedGeneration: GENERATION },
      async (_to, text, retryKey) => pushes.push({ text, retryKey }),
      gateway as never,
    );

    expect(gateway.stats().parsed?.items).toHaveLength(8);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.text).toContain("รับทั้งหมด 8 รายการ");
    expect(pushes[0]?.retryKey).toBe(GENERATION);
  });

  test("parses the coherent 26/7 candidate into 11 observations", async () => {
    const db = rawMessageDb();
    const gateway = gatewayFor(FIXTURE_26_MESSAGES);

    await finalizePhysicalInventorySession(
      db as never,
      { sessionId: SESSION_ID, expectedGeneration: GENERATION },
      async () => undefined,
      gateway as never,
    );

    expect(gateway.stats().parsed?.items).toHaveLength(11);
    expect(gateway.stats().parsed?.businessDate).toBe("2026-07-26");
  });

  test("stale candidate retries with a fresh candidate and then finalizes", async () => {
    const db = rawMessageDb();
    const gateway = gatewayFor(FIXTURE_27_MESSAGES, { staleOnce: true });

    const result = await finalizePhysicalInventorySession(
      db as never,
      { sessionId: SESSION_ID, expectedGeneration: GENERATION },
      async () => undefined,
      gateway as never,
    );

    expect(result.status).toBe("finalized");
    expect(gateway.stats().candidateCalls).toBe(2);
    expect(gateway.stats().finalizeCalls).toBe(2);
  });

  test("duplicate finalizer emits the terminal success push exactly once", async () => {
    const db = rawMessageDb();
    const gateway = gatewayFor(FIXTURE_27_MESSAGES);
    const pushes: string[] = [];
    const push = async (_to: string, text: string) => {
      pushes.push(text);
    };

    await finalizePhysicalInventorySession(
      db as never,
      { sessionId: SESSION_ID, expectedGeneration: GENERATION },
      push,
      gateway as never,
    );
    await finalizePhysicalInventorySession(
      db as never,
      { sessionId: SESSION_ID, expectedGeneration: GENERATION },
      push,
      gateway as never,
    );

    expect(pushes).toHaveLength(1);
    expect(db.raw.is_processed).toBe(true);
  });

  test("failed close creates no snapshot and sends a safe reason", async () => {
    const db = rawMessageDb();
    const gateway = gatewayFor(
      ["สตอกผลไม้คงเหลือ", "จบ"],
      { forceFailed: true },
    );
    const pushes: string[] = [];

    const result = await finalizePhysicalInventorySession(
      db as never,
      { sessionId: SESSION_ID, expectedGeneration: GENERATION },
      async (_to, text) => pushes.push(text),
      gateway as never,
    );

    expect(result.status).toBe("failed_closed");
    expect(await gateway.getSnapshot()).toBeNull();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("ปิดรายการสต๊อกผลไม้ไม่สำเร็จ");
    expect(pushes[0]).not.toContain("SQL");
  });

  test("reply builders distinguish rejected observations", () => {
    const success = buildPhysicalInventorySuccessMessage({
      businessDate: "2026-07-28",
      itemCount: 5,
      rejectedCount: 2,
    });
    expect(success).toContain("รับทั้งหมด 5 รายการ");
    expect(success).toContain("2 รายการที่อ่านไม่สมบูรณ์");
    expect(buildPhysicalInventoryFailedMessage("no_items")).toContain(
      "ไม่พบรายการผลไม้",
    );
  });
});
