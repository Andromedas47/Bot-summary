import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  parsePhysicalInventoryDocument,
  acceptedPhysicalInventoryItems,
} from "./parse";
import {
  PhysicalInventoryAfterCloseError,
  PhysicalInventoryGenerationConflictError,
  PhysicalInventorySessionService,
  PHYSICAL_INVENTORY_VOID_SUPERSEDE_SLICE,
} from "./session-service";
import type { Database } from "@/types/database";

type Row = Record<string, unknown>;

/**
 * In-memory Supabase double for Slice B — tables + finalize RPC.
 * Intentionally has NO produce_sessions / produce_items / inventory tables.
 */
function makePhysicalInventoryDb() {
  const tables: Record<string, Row[]> = {
    physical_inventory_sessions: [],
    physical_inventory_session_ingests: [],
    physical_inventory_snapshots: [],
    physical_inventory_items: [],
    physical_inventory_lifecycle_events: [],
    // Sentinels: any write here fails the "no produce writes" assertion helpers
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

  function query(table: string) {
    const filters: Array<[string, unknown, string]> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
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
      if (limitN != null) list = list.slice(0, limitN);
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
              const created = items.map((p) => {
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
                  ...p,
                };
                // unique (session_id, line_event_id)
                if (table === "physical_inventory_session_ingests") {
                  const dup = rows(table).find(
                    (r) =>
                      r.session_id === row.session_id &&
                      r.line_event_id === row.line_event_id,
                  );
                  if (dup) {
                    return { data: null, error: { message: "duplicate", code: "23505" } };
                  }
                }
                if (table === "physical_inventory_sessions") {
                  const active = rows(table).find(
                    (r) =>
                      r.source_id === row.source_id &&
                      r.sender_line_user_id === row.sender_line_user_id &&
                      (r.status === "open" || r.status === "closing"),
                  );
                  if (active) {
                    return {
                      data: null,
                      error: { message: "one active session", code: "23505" },
                    };
                  }
                }
                rows(table).push(row);
                return row;
              });
              if (created[0] && "error" in (created[0] as object)) return created[0];
              return { data: created[0], error: null };
            },
            async then(resolve: (v: unknown) => void) {
              for (const p of items) {
                const row: Row = {
                  id: uuid(),
                  created_at: new Date().toISOString(),
                  ...p,
                };
                if (table === "physical_inventory_session_ingests") {
                  const dup = rows(table).find(
                    (r) =>
                      r.session_id === row.session_id &&
                      r.line_event_id === row.line_event_id,
                  );
                  if (dup) {
                    resolve({ data: null, error: { message: "duplicate", code: "23505" } });
                    return;
                  }
                }
                rows(table).push(row);
              }
              resolve({ data: null, error: null });
            },
          };
        },
        async then(resolve: (v: unknown) => void) {
          for (const p of items) {
            const row: Row = { id: uuid(), created_at: new Date().toISOString(), ...p };
            if (table === "physical_inventory_session_ingests") {
              const dup = rows(table).find(
                (r) =>
                  r.session_id === row.session_id &&
                  r.line_event_id === row.line_event_id,
              );
              if (dup) {
                resolve({ data: null, error: { message: "duplicate", code: "23505" } });
                return;
              }
            }
            rows(table).push(row);
          }
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
    api.limit = (n: number) => {
      limitN = n;
      return api;
    };
    api.maybeSingle = async () => {
      const list = runSelect();
      return { data: list[0] ?? null, error: null };
    };
    api.single = async () => {
      if (pendingUpdate) {
        const list = rows(table).filter((r) => matches(r, filters));
        if (list.length === 0) {
          return { data: null, error: { message: "not found" } };
        }
        Object.assign(list[0]!, pendingUpdate);
        return { data: list[0], error: null };
      }
      const list = runSelect();
      return { data: list[0] ?? null, error: list[0] ? null : { message: "not found" } };
    };
    api.then = async (resolve: (v: unknown) => void) => {
      if (pendingUpdate) {
        const list = rows(table).filter((r) => matches(r, filters));
        for (const r of list) Object.assign(r, pendingUpdate);
        resolve({ data: list, error: null });
        return;
      }
      resolve({ data: runSelect(), error: null });
    };

    return api;
  }

  async function finalizeRpc(args: Record<string, unknown>) {
    const sessionId = args.p_session_id as string;
    const gen = args.p_expected_generation as string;
    const rev = args.p_expected_ingest_revision as number;
    const failClosed = Boolean(args.p_fail_closed);
    const sessions = rows("physical_inventory_sessions");
    const session = sessions.find((s) => s.id === sessionId);
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

    if (failClosed) {
      Object.assign(session, {
        status: "failed_closed",
        failed_closed_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        fail_reason: args.p_fail_reason ?? "failed_closed",
        warnings: args.p_warnings ?? [],
        parser_version: args.p_parser_version,
        updated_at: new Date().toISOString(),
      });
      rows("physical_inventory_lifecycle_events").push({
        id: uuid(),
        session_id: session.id,
        event: "failed_closed",
        created_at: new Date().toISOString(),
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

    if (!args.p_business_date) {
      return { data: null, error: { message: "business_date_required" } };
    }
    const items = (args.p_items as Row[]) ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      return { data: null, error: { message: "items_required" } };
    }

    let accNorm = 0;
    let accRaw = 0;
    let rejected = 0;
    for (const it of items) {
      if (it.resolution_status === "ACCEPTED_NORMALIZED") accNorm++;
      else if (it.resolution_status === "ACCEPTED_RAW") accRaw++;
      else if (it.resolution_status === "REJECTED") rejected++;
      else return { data: null, error: { message: "invalid_resolution_status" } };
    }

    const snapshotId = uuid();
    const snapshot = {
      id: snapshotId,
      session_id: session.id,
      warehouse_code: "MAIN",
      source_type: session.source_type,
      source_id: session.source_id,
      sender_line_user_id: session.sender_line_user_id,
      business_date: args.p_business_date,
      counted_at: new Date().toISOString(),
      parser_version: args.p_parser_version,
      accepted_normalized_count: accNorm,
      accepted_raw_count: accRaw,
      rejected_count: rejected,
      item_count: items.length,
      warnings: args.p_warnings ?? [],
      status: "finalized",
      ingest_idempotency_key: key,
      finalized_at: new Date().toISOString(),
      voided_at: null,
      voided_by: null,
      void_reason: null,
      replacement_snapshot_id: null,
      created_at: new Date().toISOString(),
    };
    rows("physical_inventory_snapshots").push(snapshot);

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
        created_at: new Date().toISOString(),
      });
    });

    Object.assign(session, {
      status: "finalized",
      closed_at: new Date().toISOString(),
      business_date: args.p_business_date,
      parser_version: args.p_parser_version,
      snapshot_id: snapshotId,
      warnings: args.p_warnings ?? [],
      updated_at: new Date().toISOString(),
    });
    rows("physical_inventory_lifecycle_events").push({
      id: uuid(),
      session_id: session.id,
      snapshot_id: snapshotId,
      event: "finalized",
      created_at: new Date().toISOString(),
    });

    return {
      data: {
        ok: true,
        idempotent: false,
        status: "finalized",
        snapshot_id: snapshotId,
        session_id: session.id,
        item_count: items.length,
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
      if (name === "finalize_physical_inventory_session") return finalizeRpc(args);
      throw new Error(`Unexpected RPC ${name}`);
    },
    _tables: tables,
    _count(table: string) {
      return rows(table).length;
    },
  };

  return db as unknown as import("@supabase/supabase-js").SupabaseClient<Database> & {
    _tables: Record<string, Row[]>;
    _count: (t: string) => number;
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

async function openAndIngestAll(
  svc: PhysicalInventorySessionService,
  texts: string[],
  sender = "U-sender-a",
  source = "C-group-phys",
) {
  const opened = await svc.openSession({
    sourceType: "group",
    sourceId: source,
    senderLineUserId: sender,
  });
  expect(opened.opened).toBe(true);
  const session = opened.session;
  let rev = 0;
  for (let i = 0; i < texts.length; i++) {
    const kind = i === 0 ? "header" : i === texts.length - 1 ? "close" : "item";
    const r = await svc.registerIngest({
      sessionId: session.id,
      expectedGeneration: session.session_generation,
      lineEventId: `evt-${i}`,
      lineMessageId: `msg-${i}`,
      kind: kind as "header" | "item" | "close",
      rawText: texts[i]!,
    });
    rev = Number(r.session.ingest_revision);
  }
  const fresh = await svc.getSession(session.id);
  return { session: fresh!, revision: rev };
}

describe("PhysicalInventorySessionService — Slice B", () => {
  test("create/open physical session + source/sender isolation", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
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
    expect(again.reason).toBe("already_open");

    const otherSender = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U2",
    });
    expect(otherSender.opened).toBe(true);
    expect(otherSender.session.id).not.toBe(a.session.id);
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
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69",
    });
    expect(first.inserted).toBe(true);
    expect(first.session.ingest_revision).toBe(1);

    const dup = await svc.registerIngest({
      sessionId: session.id,
      expectedGeneration: session.session_generation,
      lineEventId: "evt-1",
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69",
    });
    expect(dup.inserted).toBe(false);
    expect(dup.session.ingest_revision).toBe(1);
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
        kind: "item",
        rawText: "1มะม่วง\n3โล",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryGenerationConflictError);
  });

  test("append multiple item messages + close boundary + duplicate close", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const { session, revision } = await openAndIngestAll(svc, [
      "สตอกผลไม้คงเหลือวันนี้\n27/7/69",
      "1แตงโม\n45.ลูก",
      "2มะละกอ\n15ลูก",
      "จบรายการผลไม้ที่เหลือในบ้าน",
    ]);
    expect(session.status).toBe("closing");
    expect(revision).toBe(4);

    const texts = await svc.listIngestTexts(session.id);
    expect(texts).toHaveLength(4);

    // duplicate close event
    const dupClose = await svc.registerIngest({
      sessionId: session.id,
      expectedGeneration: session.session_generation,
      lineEventId: "evt-3", // same as last
      kind: "close",
      rawText: "จบรายการผลไม้ที่เหลือในบ้าน",
    });
    expect(dupClose.inserted).toBe(false);
  });

  test("stale append after finalize raises", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const { session, revision } = await openAndIngestAll(svc, [
      FIXTURE_B.split("\n\n")[0] ?? FIXTURE_B,
    ].concat(["จบ"]));
    // Use full fixture via parse + finalize
    const parsed = parsePhysicalInventoryDocument(FIXTURE_B);
    // Need proper revision: reopen flow with full messages
    const db2 = makePhysicalInventoryDb();
    const svc2 = new PhysicalInventorySessionService(db2);
    const msgs = [
      "สตอกผลไม้คงเหลือวันนี้\n27/7/69",
      "1แตงโม\n45.ลูก",
      "จบ",
    ];
    const ctx = await openAndIngestAll(svc2, msgs);
    const parsed2 = parsePhysicalInventoryDocument(msgs.join("\n"));
    const fin = await svc2.finalize({
      sessionId: ctx.session.id,
      expectedGeneration: ctx.session.session_generation,
      expectedIngestRevision: ctx.revision,
      parsed: parsed2,
    });
    expect(fin.status).toBe("finalized");

    await expect(
      svc2.registerIngest({
        sessionId: ctx.session.id,
        expectedGeneration: ctx.session.session_generation,
        lineEventId: "evt-after",
        kind: "item",
        rawText: "9something",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryAfterCloseError);

    void session;
    void revision;
    void parsed;
  });

  test("atomic finalization + idempotent redelivery", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const msgs = [
      "สตอกผลไม้คงเหลือ\n26/7/69",
      "1มะม่วง\n3โล",
      "จบ",
    ];
    const ctx = await openAndIngestAll(svc, msgs);
    const parsed = parsePhysicalInventoryDocument(msgs.join("\n"));
    const first = await svc.finalize({
      sessionId: ctx.session.id,
      expectedGeneration: ctx.session.session_generation,
      expectedIngestRevision: ctx.revision,
      parsed,
    });
    expect(first.status).toBe("finalized");
    expect(first.idempotent).toBe(false);
    expect(first.snapshotId).toBeTruthy();

    const second = await svc.finalize({
      sessionId: ctx.session.id,
      expectedGeneration: ctx.session.session_generation,
      expectedIngestRevision: ctx.revision,
      parsed,
    });
    expect(second.idempotent).toBe(true);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(db._count("physical_inventory_snapshots")).toBe(1);
  });

  test("8-item 27/7 fixture persistence", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const parsed = parsePhysicalInventoryDocument(FIXTURE_B);
    expect(acceptedPhysicalInventoryItems(parsed)).toHaveLength(8);

    const msgs = FIXTURE_B.split(/\n(?=\d|จบ|สตอก)/).filter(Boolean);
    // Simpler: single ingest of full doc + close already inside
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-b",
      senderLineUserId: "U-b",
      businessDate: "2026-07-27",
    });
    const ing = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      lineEventId: "evt-full-b",
      kind: "header",
      rawText: FIXTURE_B,
    });
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      expectedIngestRevision: Number(ing.session.ingest_revision),
      parsed,
    });
    expect(fin.status).toBe("finalized");
    const items = await svc.listSnapshotItems(fin.snapshotId!);
    expect(items).toHaveLength(8);
    expect(items.filter((i) => i.resolution_status === "ACCEPTED_RAW")).toHaveLength(3);
    expect(items.find((i) => i.raw_unit === "ตะกร้า")?.normalized_unit).toBeNull();
    const snap = await svc.getSnapshot(fin.snapshotId!);
    expect(snap?.business_date).toBe("2026-07-27");
    expect(snap?.warehouse_code).toBe("MAIN");
    expect(snap?.item_count).toBe(8);
    void msgs;
  });

  test("11-item 26/7 fixture persistence", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const parsed = parsePhysicalInventoryDocument(FIXTURE_A);
    expect(acceptedPhysicalInventoryItems(parsed)).toHaveLength(11);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-a",
      senderLineUserId: "U-a",
    });
    const ing = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      lineEventId: "evt-full-a",
      kind: "header",
      rawText: FIXTURE_A,
    });
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      expectedIngestRevision: Number(ing.session.ingest_revision),
      parsed,
    });
    const items = await svc.listSnapshotItems(fin.snapshotId!);
    expect(items).toHaveLength(11);
    expect(items.map((i) => i.staff_sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test("duplicate sequence persists both rows", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const doc = `สตอกผลไม้คงเหลือ
27/7/69
7แตงโม
45ลูก
7มะละกอ
15ลูก
จบ`;
    const parsed = parsePhysicalInventoryDocument(doc);
    expect(acceptedPhysicalInventoryItems(parsed)).toHaveLength(2);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-dup",
      senderLineUserId: "U-dup",
    });
    const ing = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      lineEventId: "e1",
      kind: "header",
      rawText: doc,
    });
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      expectedIngestRevision: Number(ing.session.ingest_revision),
      parsed,
    });
    const items = await svc.listSnapshotItems(fin.snapshotId!);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.staff_sequence)).toEqual([7, 7]);
    expect(items.map((i) => i.raw_product_description)).toEqual(["แตงโม", "มะละกอ"]);
  });

  test("ACCEPTED_RAW and REJECTED both persist", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const doc = `สตอกผลไม้คงเหลือ
27/7/69
1พุทรา3ตะกร้า
2มะม่วง
จบ`;
    const parsed = parsePhysicalInventoryDocument(doc);
    expect(parsed.items.some((i) => i.resolutionStatus === "ACCEPTED_RAW")).toBe(true);
    expect(parsed.items.some((i) => i.resolutionStatus === "REJECTED")).toBe(true);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-raw",
      senderLineUserId: "U-raw",
    });
    const ing = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      lineEventId: "e1",
      kind: "header",
      rawText: doc,
    });
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      expectedIngestRevision: Number(ing.session.ingest_revision),
      parsed,
    });
    const items = await svc.listSnapshotItems(fin.snapshotId!);
    expect(items.some((i) => i.resolution_status === "ACCEPTED_RAW")).toBe(true);
    expect(items.some((i) => i.resolution_status === "REJECTED")).toBe(true);
  });

  test("failed close creates no partial finalized snapshot", async () => {
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
      kind: "header",
      rawText: "สตอกผลไม้คงเหลือ\nจบ",
    });
    const parsed = parsePhysicalInventoryDocument("สตอกผลไม้คงเหลือ\nจบ");
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      expectedIngestRevision: Number(ing.session.ingest_revision),
      parsed,
    });
    expect(fin.status).toBe("failed_closed");
    expect(fin.snapshotId).toBeNull();
    expect(db._count("physical_inventory_snapshots")).toBe(0);
    expect(db._count("physical_inventory_items")).toBe(0);
    const session = await svc.getSession(opened.session.id);
    expect(session?.status).toBe("failed_closed");
  });

  test("no produce_sessions / produce_items access from service path", async () => {
    const db = makePhysicalInventoryDb();
    expect(() => db.from("produce_sessions")).toThrow(/FORBIDDEN/);
    expect(() => db.from("produce_items")).toThrow(/FORBIDDEN/);
    expect(db._count("produce_sessions")).toBe(0);
    expect(db._count("produce_items")).toBe(0);
  });

  test("no inventory ledger table exists in Slice B surface", () => {
    expect(PHYSICAL_INVENTORY_VOID_SUPERSEDE_SLICE).toBe("E");
    const sql = readFileSync(
      "supabase/migrations/0047_physical_inventory_capture.sql",
      "utf8",
    );
    expect(sql).not.toMatch(/CREATE TABLE\s+public\.produce_/i);
    expect(sql).not.toMatch(/CREATE TABLE\s+public\.inventory_/i);
    expect(sql).toContain("physical_inventory_sessions");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("GRANT EXECUTE");
    expect(sql).toContain("service_role");
  });
});
