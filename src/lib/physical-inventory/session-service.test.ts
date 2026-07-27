import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  parsePhysicalInventoryDocument,
} from "./parse";
import {
  PhysicalInventoryAfterCloseBoundaryError,
  PhysicalInventoryAfterCloseError,
  PhysicalInventoryCloseQuietWindowError,
  PhysicalInventoryGenerationConflictError,
  PhysicalInventorySessionService,
  PHYSICAL_INVENTORY_CLOSE_QUIET_MS,
  PHYSICAL_INVENTORY_VOID_SUPERSEDE_SLICE,
} from "./session-service";
import type { Database } from "@/types/database";

type Row = Record<string, unknown>;

function makePhysicalInventoryDb() {
  const tables: Record<string, Row[]> = {
    physical_inventory_sessions: [],
    physical_inventory_session_ingests: [],
    physical_inventory_snapshots: [],
    physical_inventory_items: [],
    physical_inventory_lifecycle_events: [],
    produce_sessions: [],
    produce_items: [],
  };
  let idSeq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;

  function rows(name: string): Row[] {
    if (!(name in tables)) tables[name] = [];
    return tables[name]!;
  }

  function matches(row: Row, filters: Array<[string, unknown, string]>): boolean {
    return filters.every(([col, val, op]) => {
      if (op === "eq") return row[col] === val;
      if (op === "in") return Array.isArray(val) && val.includes(row[col]);
      return false;
    });
  }

  /** Simulate immutability triggers. */
  function assertMutable(table: string, op: "update" | "delete", row?: Row) {
    if (
      table === "physical_inventory_snapshots" ||
      table === "physical_inventory_items" ||
      table === "physical_inventory_lifecycle_events"
    ) {
      throw new Error(`physical inventory ${table} is immutable after write`);
    }
    if (table === "physical_inventory_sessions") {
      if (op === "delete") throw new Error("physical_inventory_sessions rows must not be deleted");
      if (row && ["finalized", "failed_closed", "voided"].includes(String(row.status))) {
        throw new Error(`physical_inventory_sessions status=${row.status} is terminal and immutable`);
      }
    }
  }

  function query(table: string) {
    const filters: Array<[string, unknown, string]> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let pendingUpdate: Row | null = null;

    const api: Record<string, unknown> = {};
    const runSelect = () => {
      let list = rows(table).filter((r) => matches(r, filters));
      if (orderCol) {
        list = [...list].sort((a, b) => {
          const av = a[orderCol!] as number | string;
          const bv = b[orderCol!] as number | string;
          if (av < bv) return orderAsc ? -1 : 1;
          if (av > bv) return orderAsc ? 1 : -1;
          return 0;
        });
      }
      return list;
    };

    api.select = (_cols?: string) => {
      void _cols;
      return api;
    };
    api.insert = (payload: Row | Row[]) => {
      const items = Array.isArray(payload) ? payload : [payload];
      return {
        select() {
          return {
            async single() {
              const p = items[0]!;
              if (table === "physical_inventory_sessions") {
                const sender = String(p.sender_line_user_id ?? "").trim();
                if (!sender) {
                  return { data: null, error: { message: "sender check failed" } };
                }
                const active = rows(table).find(
                  (r) =>
                    r.source_id === p.source_id &&
                    r.sender_line_user_id === sender &&
                    (r.status === "open" || r.status === "closing"),
                );
                if (active) {
                  return { data: null, error: { message: "one active", code: "23505" } };
                }
              }
              const row: Row = {
                id: uuid(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                opened_at: new Date().toISOString(),
                ingest_revision: 0,
                session_generation: uuid(),
                warehouse_code: "MAIN",
                status: "open",
                warnings: [],
                snapshot_id: null,
                business_date: null,
                close_event_timestamp_ms: null,
                close_quiet_until: null,
                close_deadline_at: null,
                close_requested_at: null,
                ...p,
                sender_line_user_id: String(p.sender_line_user_id ?? "").trim(),
              };
              rows(table).push(row);
              return { data: row, error: null };
            },
          };
        },
        async then(resolve: (v: unknown) => void) {
          resolve({ data: null, error: null });
        },
      };
    };
    api.update = (patch: Row) => {
      pendingUpdate = patch;
      return api;
    };
    api.eq = (col: string, val: unknown) => {
      filters.push([col, val, "eq"]);
      return api;
    };
    api.in = (col: string, val: unknown[]) => {
      filters.push([col, val, "in"]);
      return api;
    };
    api.order = (col: string, opts?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return api;
    };
    api.maybeSingle = async () => ({ data: runSelect()[0] ?? null, error: null });
    api.single = async () => {
      if (pendingUpdate) {
        const list = rows(table).filter((r) => matches(r, filters));
        if (!list[0]) return { data: null, error: { message: "not found" } };
        assertMutable(table, "update", list[0]);
        if (
          table === "physical_inventory_sessions" &&
          list[0].close_event_timestamp_ms != null &&
          pendingUpdate.close_event_timestamp_ms != null &&
          pendingUpdate.close_event_timestamp_ms !== list[0].close_event_timestamp_ms
        ) {
          throw new Error("close_event_timestamp_ms is immutable once set");
        }
        Object.assign(list[0], pendingUpdate);
        return { data: list[0], error: null };
      }
      const list = runSelect();
      return { data: list[0] ?? null, error: list[0] ? null : { message: "not found" } };
    };
    api.then = async (resolve: (v: unknown) => void) => {
      if (pendingUpdate) {
        const list = rows(table).filter((r) => matches(r, filters));
        for (const r of list) {
          assertMutable(table, "update", r);
          Object.assign(r, pendingUpdate);
        }
        resolve({ data: list, error: null });
        return;
      }
      resolve({ data: runSelect(), error: null });
    };
    return api;
  }

  async function admitRpc(args: Record<string, unknown>) {
    const sessionId = args.p_session_id as string;
    const gen = args.p_expected_generation as string;
    const eventId = args.p_line_event_id as string;
    const ts = args.p_line_timestamp_ms as number;
    const kind = args.p_kind as string;
    const asOf = new Date(String(args.p_as_of ?? new Date().toISOString()));
    const quietMs = Number(args.p_quiet_ms ?? 8000);
    const deadMs = Number(args.p_deadline_ms ?? 30000);

    const session = rows("physical_inventory_sessions").find((s) => s.id === sessionId);
    if (!session) return { data: null, error: { message: "physical inventory session not found" } };
    if (session.session_generation !== gen) {
      return { data: null, error: { message: "generation_conflict" } };
    }
    if (["finalized", "failed_closed", "voided"].includes(String(session.status))) {
      return { data: null, error: { message: "session_closed" } };
    }

    const existing = rows("physical_inventory_session_ingests").find(
      (r) => r.session_id === sessionId && r.line_event_id === eventId,
    );
    if (existing) {
      return {
        data: {
          accepted: true,
          inserted: false,
          reason: "duplicate_event",
          session_id: session.id,
          ingest_revision: session.ingest_revision,
          status: session.status,
          close_event_timestamp_ms: session.close_event_timestamp_ms,
        },
        error: null,
      };
    }

    if (session.close_event_timestamp_ms != null && kind === "close") {
      return {
        data: {
          accepted: true,
          inserted: false,
          reason: "close_already_requested",
          session_id: session.id,
          ingest_revision: session.ingest_revision,
          status: session.status,
          close_event_timestamp_ms: session.close_event_timestamp_ms,
        },
        error: null,
      };
    }

    if (session.close_event_timestamp_ms != null) {
      if (session.close_deadline_at && asOf >= new Date(String(session.close_deadline_at))) {
        return { data: null, error: { message: "deadline_elapsed" } };
      }
      if (ts > Number(session.close_event_timestamp_ms)) {
        return { data: null, error: { message: "after_close_boundary" } };
      }
    }

    const nextRev = Number(session.ingest_revision) + 1;
    rows("physical_inventory_session_ingests").push({
      id: uuid(),
      session_id: sessionId,
      line_event_id: eventId,
      line_message_id: args.p_line_message_id ?? null,
      line_timestamp_ms: ts,
      raw_message_id: args.p_raw_message_id ?? null,
      kind,
      raw_text: args.p_raw_text,
      ingest_revision: nextRev,
      created_at: asOf.toISOString(),
    });

    Object.assign(session, {
      ingest_revision: nextRev,
      updated_at: asOf.toISOString(),
    });
    if (kind === "close" && session.close_event_timestamp_ms == null) {
      Object.assign(session, {
        status: "closing",
        close_requested_at: asOf.toISOString(),
        close_event_timestamp_ms: ts,
        close_quiet_until: new Date(asOf.getTime() + quietMs).toISOString(),
        close_deadline_at: new Date(asOf.getTime() + deadMs).toISOString(),
        close_line_event_id: eventId,
        close_raw_message_id: args.p_raw_message_id ?? null,
      });
    }

    return {
      data: {
        accepted: true,
        inserted: true,
        reason: "admitted",
        session_id: session.id,
        ingest_revision: session.ingest_revision,
        status: session.status,
        close_event_timestamp_ms: session.close_event_timestamp_ms,
      },
      error: null,
    };
  }

  async function finalizeRpc(args: Record<string, unknown>) {
    const sessionId = args.p_session_id as string;
    const gen = args.p_expected_generation as string;
    const rev = args.p_expected_ingest_revision as number;
    const failClosed = Boolean(args.p_fail_closed);
    const asOf = new Date(String(args.p_as_of ?? new Date().toISOString()));
    const session = rows("physical_inventory_sessions").find((s) => s.id === sessionId);
    if (!session) return { data: null, error: { message: "physical inventory session not found" } };
    if (session.session_generation !== gen) {
      return { data: null, error: { message: "generation_conflict" } };
    }
    const key = `${session.id}:${session.session_generation}`;

    if (session.status === "finalized" && session.snapshot_id) {
      return {
        data: {
          ok: true,
          idempotent: true,
          status: "finalized",
          snapshot_id: session.snapshot_id,
          session_id: session.id,
        },
        error: null,
      };
    }
    if (session.status === "failed_closed") {
      return {
        data: {
          ok: true,
          idempotent: true,
          status: "failed_closed",
          snapshot_id: null,
          session_id: session.id,
          fail_reason: session.fail_reason,
        },
        error: null,
      };
    }
    if (session.status !== "open" && session.status !== "closing") {
      return { data: null, error: { message: `session_not_finalizable status=${session.status}` } };
    }
    if (session.ingest_revision !== rev) {
      return { data: null, error: { message: "stale_ingest_revision" } };
    }

    if (!failClosed) {
      if (session.close_event_timestamp_ms == null) {
        return { data: null, error: { message: "close_boundary_required" } };
      }
      if (session.close_quiet_until && asOf < new Date(String(session.close_quiet_until))) {
        return { data: null, error: { message: "close_quiet_window" } };
      }
    }

    if (failClosed) {
      assertMutable("physical_inventory_sessions", "update", session);
      Object.assign(session, {
        status: "failed_closed",
        failed_closed_at: asOf.toISOString(),
        closed_at: asOf.toISOString(),
        fail_reason: args.p_fail_reason ?? "failed_closed",
        updated_at: asOf.toISOString(),
      });
      rows("physical_inventory_lifecycle_events").push({
        id: uuid(),
        session_id: session.id,
        event: "failed_closed",
        created_at: asOf.toISOString(),
      });
      return {
        data: {
          ok: true,
          idempotent: false,
          status: "failed_closed",
          snapshot_id: null,
          session_id: session.id,
          fail_reason: session.fail_reason,
        },
        error: null,
      };
    }

    const items = (args.p_items as Row[]) ?? [];
    if (!args.p_business_date || !items.length) {
      return { data: null, error: { message: "items_required" } };
    }

    let accNorm = 0;
    let accRaw = 0;
    let rejected = 0;
    for (const it of items) {
      if (it.resolution_status === "ACCEPTED_NORMALIZED") accNorm++;
      else if (it.resolution_status === "ACCEPTED_RAW") accRaw++;
      else if (it.resolution_status === "REJECTED") rejected++;
    }

    const countedAt = new Date(Number(session.close_event_timestamp_ms)).toISOString();
    const snapshotId = uuid();
    rows("physical_inventory_snapshots").push({
      id: snapshotId,
      session_id: session.id,
      warehouse_code: "MAIN",
      source_type: session.source_type,
      source_id: session.source_id,
      sender_line_user_id: session.sender_line_user_id,
      business_date: args.p_business_date,
      counted_at: countedAt,
      parser_version: args.p_parser_version,
      accepted_normalized_count: accNorm,
      accepted_raw_count: accRaw,
      rejected_count: rejected,
      item_count: items.length,
      warnings: args.p_warnings ?? [],
      status: "finalized",
      ingest_idempotency_key: key,
      finalized_at: asOf.toISOString(),
      voided_at: null,
      created_at: asOf.toISOString(),
    });
    items.forEach((it, idx) => {
      rows("physical_inventory_items").push({
        id: uuid(),
        snapshot_id: snapshotId,
        item_ordinal: idx + 1,
        staff_sequence: it.staff_sequence ?? null,
        raw_text: it.raw_text ?? "",
        raw_product_description: it.raw_product_description ?? null,
        normalized_product: it.normalized_product ?? null,
        quantity: it.quantity ?? null,
        raw_unit: it.raw_unit ?? null,
        normalized_unit: it.normalized_unit ?? null,
        resolution_status: it.resolution_status,
        reason: it.reason ?? null,
        created_at: asOf.toISOString(),
      });
    });

    assertMutable("physical_inventory_sessions", "update", session);
    Object.assign(session, {
      status: "finalized",
      closed_at: asOf.toISOString(),
      business_date: args.p_business_date,
      snapshot_id: snapshotId,
      updated_at: asOf.toISOString(),
    });
    rows("physical_inventory_lifecycle_events").push({
      id: uuid(),
      session_id: session.id,
      snapshot_id: snapshotId,
      event: "finalized",
      created_at: asOf.toISOString(),
    });

    return {
      data: {
        ok: true,
        idempotent: false,
        status: "finalized",
        snapshot_id: snapshotId,
        session_id: session.id,
        item_count: items.length,
        counted_at: countedAt,
      },
      error: null,
    };
  }

  const db = {
    from(table: string) {
      if (table === "produce_sessions" || table === "produce_items") {
        throw new Error(`FORBIDDEN write/read of ${table} from physical inventory service tests`);
      }
      return query(table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "admit_physical_inventory_event") return admitRpc(args);
      if (name === "finalize_physical_inventory_session") return finalizeRpc(args);
      throw new Error(`Unexpected RPC ${name}`);
    },
    _tables: tables,
    _count(table: string) {
      return rows(table).length;
    },
    _tryMutateSnapshot(snapshotId: string) {
      const snap = rows("physical_inventory_snapshots").find((s) => s.id === snapshotId);
      assertMutable("physical_inventory_snapshots", "update", snap);
    },
    _tryDeleteItem(itemId: string) {
      const item = rows("physical_inventory_items").find((s) => s.id === itemId);
      assertMutable("physical_inventory_items", "delete", item);
    },
  };

  return db as unknown as import("@supabase/supabase-js").SupabaseClient<Database> & {
    _tables: Record<string, Row[]>;
    _count: (t: string) => number;
    _tryMutateSnapshot: (id: string) => void;
    _tryDeleteItem: (id: string) => void;
  };
}

const FIXTURE_A = `สตอกผลไม้คงเหลือ
26/7/69
1พุทรา3ตะกร้า
2แก้วมังกร
15โล
3มะละกอ
90.ลูก
4แตงโม
80.ลูก
5สาลี
432.ลูก
6แอปเปิ้ล
440.ลูก
7องุ่นเขียวเลก
16.ตะกร้า
8โชคอนัน
1ตะกร้า
9องุ่นไชมัสตะกร้าขาว
12.ตะกร้า
10องุ่นไชมัสตะกร้าดำ
6ตะกร้า
11องุ่นไชมัสตะกร้าดำยังไม่แต่ง
13.ตะกร้า
จบ`;

const FIXTURE_B = `สตอกผลไม้คงเหลือวันนี้
27/7/69
1แตงโม
45.ลูก
2มะละกอ
15ลูก
3พุทรานม
2ตะกร้า
4มะม่วงโชคอนัน
15.โล
5แอปเปิ้ล
314.ลูก
6สาลี่น้ำผึ้ง
236.ลูก
7องุ่นเขียวตะกร้าแดง
12.ตะกร้า
8องุ่นไชมัสแต่งตะกร้าดำ
10.ตะกร้า
จบรายการผลไม้ที่เหลือในบ้าน`;

describe("PhysicalInventorySessionService — Slice B", () => {
  test("create/open + sender blank rejected + isolation", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    await expect(
      svc.openSession({ sourceType: "group", sourceId: "G1", senderLineUserId: "  " }),
    ).rejects.toThrow(/sender_line_user_id required/);

    const a = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
    });
    expect(a.opened).toBe(true);
    const again = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
    });
    expect(again.opened).toBe(false);
    const other = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U2",
    });
    expect(other.opened).toBe(true);
  });

  test("duplicate LINE event idempotency", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const { session } = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
    });
    const first = await svc.registerIngest({
      sessionId: session.id,
      expectedGeneration: session.session_generation,
      lineEventId: "evt-1",
      lineTimestampMs: 1_000,
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69",
    });
    expect(first.inserted).toBe(true);
    const dup = await svc.registerIngest({
      sessionId: session.id,
      expectedGeneration: session.session_generation,
      lineEventId: "evt-1",
      lineTimestampMs: 1_000,
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69",
    });
    expect(dup.inserted).toBe(false);
    expect(dup.reason).toBe("duplicate_event");
    expect(db._count("physical_inventory_session_ingests")).toBe(1);
  });

  test("generation mismatch", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const { session } = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
    });
    await expect(
      svc.registerIngest({
        sessionId: session.id,
        expectedGeneration: "00000000-0000-4000-8000-999999999999",
        lineEventId: "evt-x",
        lineTimestampMs: 1,
        kind: "item",
        rawText: "1มะม่วง\n3โล",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryGenerationConflictError);
  });

  test("fixtures persist 8 and 11 items; counted_at = close LINE time", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const closeTs = 1_700_000_000_8000;
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-b",
      senderLineUserId: "U-b",
    });
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      lineEventId: "full",
      lineTimestampMs: closeTs - 1000,
      kind: "header",
      rawText: FIXTURE_B,
      asOf: new Date(closeTs - 1000).toISOString(),
    });
    const closed = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      lineEventId: "close-b",
      lineTimestampMs: closeTs,
      kind: "close",
      rawText: "จบรายการผลไม้ที่เหลือในบ้าน",
      asOf: new Date(closeTs).toISOString(),
      quietMs: 100,
    });
    const parsed = parsePhysicalInventoryDocument(FIXTURE_B);
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      expectedIngestRevision: Number(closed.session.ingest_revision),
      parsed,
      asOf: new Date(closeTs + 200).toISOString(),
    });
    expect(fin.status).toBe("finalized");
    expect(fin.countedAt).toBe(new Date(closeTs).toISOString());
    const snap = await svc.getSnapshot(fin.snapshotId!);
    expect(snap?.counted_at).toBe(new Date(closeTs).toISOString());
    expect(await svc.listSnapshotItems(fin.snapshotId!)).toHaveLength(8);

    const db2 = makePhysicalInventoryDb();
    const svc2 = new PhysicalInventorySessionService(db2);
    const o2 = await svc2.openSession({
      sourceType: "group",
      sourceId: "G-a",
      senderLineUserId: "U-a",
    });
    await svc2.registerIngest({
      sessionId: o2.session.id,
      expectedGeneration: o2.session.session_generation,
      lineEventId: "a1",
      lineTimestampMs: 100,
      kind: "header",
      rawText: FIXTURE_A,
      asOf: new Date(100).toISOString(),
    });
    const c2 = await svc2.registerIngest({
      sessionId: o2.session.id,
      expectedGeneration: o2.session.session_generation,
      lineEventId: "a-close",
      lineTimestampMs: 200,
      kind: "close",
      rawText: "จบ",
      asOf: new Date(200).toISOString(),
      quietMs: 50,
    });
    const fin2 = await svc2.finalize({
      sessionId: o2.session.id,
      expectedGeneration: o2.session.session_generation,
      expectedIngestRevision: Number(c2.session.ingest_revision),
      parsed: parsePhysicalInventoryDocument(FIXTURE_A),
      asOf: new Date(300).toISOString(),
    });
    expect(await svc2.listSnapshotItems(fin2.snapshotId!)).toHaveLength(11);
  });

  test("failed close + no produce writes + migration surface", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-fail",
      senderLineUserId: "U-fail",
    });
    const ing = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      lineEventId: "e1",
      lineTimestampMs: 1,
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\nจบ",
    });
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      expectedIngestRevision: Number(ing.session.ingest_revision),
      parsed: parsePhysicalInventoryDocument("สตอกผลไม้คงเหลือ\nจบ"),
    });
    expect(fin.status).toBe("failed_closed");
    expect(db._count("physical_inventory_snapshots")).toBe(0);
    expect(() => db.from("produce_sessions")).toThrow(/FORBIDDEN/);
    expect(PHYSICAL_INVENTORY_VOID_SUPERSEDE_SLICE).toBe("E");
    const sql = readFileSync("supabase/migrations/0047_physical_inventory_capture.sql", "utf8");
    expect(sql).toContain("physical_inventory_forbid_mutation");
    expect(sql).toContain("admit_physical_inventory_event");
    expect(sql).toContain("close_event_timestamp_ms");
    expect(sql).not.toMatch(/CREATE TABLE\s+public\.inventory_/i);
  });
});

describe("adversarial close-boundary + immutability", () => {
  test("A: late item with LINE ts < close ts is admitted and finalized", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-race",
      senderLineUserId: "U-race",
    });
    const gen = opened.session.session_generation;
    const tClose = 10_000;
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "i7",
      lineTimestampMs: 7_000,
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69\n7แตงโม\n45ลูก",
      asOf: new Date(7_000).toISOString(),
    });
    const close = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "close",
      lineTimestampMs: tClose,
      kind: "close",
      rawText: "จบ",
      asOf: new Date(tClose).toISOString(),
      quietMs: 500,
    });
    expect(close.session.status).toBe("closing");
    expect(close.session.close_event_timestamp_ms).toBe(tClose);

    const late = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "i8",
      lineTimestampMs: 9_000, // before close boundary
      kind: "item",
      rawText: "8มะละกอ\n15ลูก",
      asOf: new Date(tClose + 100).toISOString(), // arrives after close on server
      quietMs: 500,
    });
    expect(late.inserted).toBe(true);

    const doc = `สตอกผลไม้คงเหลือ
27/7/69
7แตงโม
45ลูก
8มะละกอ
15ลูก
จบ`;
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      expectedIngestRevision: Number(late.session.ingest_revision),
      parsed: parsePhysicalInventoryDocument(doc),
      asOf: new Date(tClose + 600).toISOString(),
    });
    const items = await svc.listSnapshotItems(fin.snapshotId!);
    expect(items.map((i) => i.raw_product_description)).toEqual(["แตงโม", "มะละกอ"]);
  });

  test("B: item with LINE ts > close ts rejected", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-b",
      senderLineUserId: "U-b",
    });
    const gen = opened.session.session_generation;
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "i1",
      lineTimestampMs: 1_000,
      kind: "item",
      rawText: "1มะม่วง\n3โล",
    });
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "close",
      lineTimestampMs: 2_000,
      kind: "close",
      rawText: "จบ",
      quietMs: 1_000,
    });
    await expect(
      svc.registerIngest({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        lineEventId: "late",
        lineTimestampMs: 2_500,
        kind: "item",
        rawText: "2ทุเรียน\n1โล",
        asOf: new Date(2_100).toISOString(),
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryAfterCloseBoundaryError);
  });

  test("C: duplicate close does not move boundary", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-c",
      senderLineUserId: "U-c",
    });
    const gen = opened.session.session_generation;
    const first = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "c1",
      lineTimestampMs: 5_000,
      kind: "close",
      rawText: "จบ",
      asOf: new Date(5_000).toISOString(),
      quietMs: 100,
    });
    const boundary = first.session.close_event_timestamp_ms;
    const quiet = first.session.close_quiet_until;
    const dup = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "c2",
      lineTimestampMs: 9_999,
      kind: "close",
      rawText: "จบ",
      asOf: new Date(5_050).toISOString(),
    });
    expect(dup.reason).toBe("close_already_requested");
    expect(dup.session.close_event_timestamp_ms).toBe(boundary);
    expect(dup.session.close_quiet_until).toBe(quiet);
  });

  test("D: late duplicate event is idempotent", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-d",
      senderLineUserId: "U-d",
    });
    const gen = opened.session.session_generation;
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "same",
      lineTimestampMs: 1_000,
      kind: "item",
      rawText: "1มะม่วง\n3โล",
    });
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "close",
      lineTimestampMs: 2_000,
      kind: "close",
      rawText: "จบ",
      quietMs: 500,
    });
    const lateDup = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "same",
      lineTimestampMs: 1_000,
      kind: "item",
      rawText: "1มะม่วง\n3โล",
      asOf: new Date(2_100).toISOString(),
    });
    expect(lateDup.inserted).toBe(false);
    expect(lateDup.reason).toBe("duplicate_event");
    expect(db._count("physical_inventory_session_ingests")).toBe(2);
  });

  test("E: finalize during quiet window fails; after quiet + matching rev succeeds", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-e",
      senderLineUserId: "U-e",
    });
    const gen = opened.session.session_generation;
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "h",
      lineTimestampMs: 1_000,
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69\n1มะม่วง\n3โล",
    });
    const closed = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "c",
      lineTimestampMs: 2_000,
      kind: "close",
      rawText: "จบ",
      asOf: new Date(2_000).toISOString(),
      quietMs: 1_000,
    });
    const revAtClose = Number(closed.session.ingest_revision);
    const parsed = parsePhysicalInventoryDocument(
      "สตอกผลไม้คงเหลือ\n27/7/69\n1มะม่วง\n3โล\nจบ",
    );
    await expect(
      svc.finalize({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        expectedIngestRevision: revAtClose,
        parsed,
        asOf: new Date(2_100).toISOString(), // still in quiet
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryCloseQuietWindowError);

    // Late pre-boundary event bumps revision — old finalize rev would be stale
    const late = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "late-ok",
      lineTimestampMs: 1_500,
      kind: "item",
      rawText: "2ทุเรียน\n1โล",
      asOf: new Date(2_200).toISOString(),
      quietMs: 1_000,
    });
    await expect(
      svc.finalize({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        expectedIngestRevision: revAtClose, // stale after late admit
        parsed,
        asOf: new Date(3_100).toISOString(),
      }),
    ).rejects.toThrow(/stale_ingest_revision/);

    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      expectedIngestRevision: Number(late.session.ingest_revision),
      parsed: parsePhysicalInventoryDocument(
        "สตอกผลไม้คงเหลือ\n27/7/69\n1มะม่วง\n3โล\n2ทุเรียน\n1โล\nจบ",
      ),
      asOf: new Date(3_100).toISOString(),
    });
    expect(fin.status).toBe("finalized");
    expect(db._count("physical_inventory_snapshots")).toBe(1);
    expect(PHYSICAL_INVENTORY_CLOSE_QUIET_MS).toBe(8_000);
  });

  test("F: finalized session append hard-rejects; snapshot immutable", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-f",
      senderLineUserId: "U-f",
    });
    const gen = opened.session.session_generation;
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "h",
      lineTimestampMs: 1,
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69\n1มะม่วง\n3โล",
      asOf: new Date(1).toISOString(),
    });
    const closed = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "c",
      lineTimestampMs: 2,
      kind: "close",
      rawText: "จบ",
      asOf: new Date(2).toISOString(),
      quietMs: 10,
    });
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      expectedIngestRevision: Number(closed.session.ingest_revision),
      parsed: parsePhysicalInventoryDocument(
        "สตอกผลไม้คงเหลือ\n27/7/69\n1มะม่วง\n3โล\nจบ",
      ),
      asOf: new Date(20).toISOString(),
    });
    await expect(
      svc.registerIngest({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        lineEventId: "after",
        lineTimestampMs: 1,
        kind: "item",
        rawText: "x",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryAfterCloseError);

    expect(() => db._tryMutateSnapshot(fin.snapshotId!)).toThrow(/immutable/);
    const items = await svc.listSnapshotItems(fin.snapshotId!);
    expect(() => db._tryDeleteItem(items[0]!.id)).toThrow(/immutable/);
  });
});
