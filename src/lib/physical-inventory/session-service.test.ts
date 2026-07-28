import { createHash } from "crypto";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parsePhysicalInventoryDocument } from "./parse";
import {
  PhysicalInventoryAfterCloseBoundaryError,
  PhysicalInventoryAfterCloseError,
  PhysicalInventoryCloseBoundaryRequiredError,
  PhysicalInventoryCloseQuietWindowError,
  PhysicalInventoryGenerationConflictError,
  PhysicalInventoryLineEventConflictError,
  PhysicalInventorySessionService,
  PhysicalInventoryStaleIngestHashError,
  PhysicalInventoryStaleRevisionError,
  PHYSICAL_INVENTORY_CLOSE_QUIET_MS,
  PHYSICAL_INVENTORY_VOID_SUPERSEDE_SLICE,
} from "./session-service";
import type { Database } from "@/types/database";

type Row = Record<string, unknown>;

/** Test-only clock — never exposed as Production RPC args. */
function makePhysicalInventoryDb(opts?: { nowMs?: number }) {
  let nowMs = opts?.nowMs ?? 1_000_000;
  const tables: Record<string, Row[]> = {
    physical_inventory_sessions: [],
    physical_inventory_session_ingests: [],
    physical_inventory_snapshots: [],
    physical_inventory_items: [],
    physical_inventory_lifecycle_events: [],
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

  function computeHash(sessionId: string): string {
    const list = rows("physical_inventory_session_ingests")
      .filter((r) => r.session_id === sessionId)
      .sort((a, b) => Number(a.ingest_revision) - Number(b.ingest_revision));
    const payload = list
      .map(
        (i) =>
          `${i.line_event_id}\x1f${i.line_timestamp_ms}\x1f${i.kind}\x1f${i.raw_text}`,
      )
      .join("\n");
    return createHash("sha256").update(payload).digest("hex");
  }

  function assertImmutable(table: string) {
    if (
      table === "physical_inventory_snapshots" ||
      table === "physical_inventory_items" ||
      table === "physical_inventory_lifecycle_events" ||
      table === "physical_inventory_session_ingests"
    ) {
      throw new Error(`physical inventory ${table} is immutable after write`);
    }
  }

  function query(table: string) {
    const filters: Array<[string, unknown, string]> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
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
      const list = runSelect();
      return { data: list[0] ?? null, error: list[0] ? null : { message: "not found" } };
    };
    api.then = async (resolve: (v: unknown) => void) => {
      resolve({ data: runSelect(), error: null });
    };
    return api;
  }

  async function openRpc(args: Record<string, unknown>) {
    const eventId = String(args.p_opened_line_event_id ?? "").trim();
    const sender = String(args.p_sender_line_user_id ?? "").trim();
    if (!eventId) return { data: null, error: { message: "opened_line_event_id required" } };
    if (!sender) return { data: null, error: { message: "sender_line_user_id required" } };

    const existingIngest = rows("physical_inventory_session_ingests").find(
      (r) => r.line_event_id === eventId,
    );
    if (existingIngest) {
      const session = rows("physical_inventory_sessions").find(
        (s) => s.id === existingIngest.session_id,
      )!;
      return {
        data: {
          opened: false,
          idempotent: true,
          reason: "duplicate_open_event",
          session_id: session.id,
          session_generation: session.session_generation,
          status: session.status,
          ingest_revision: session.ingest_revision,
        },
        error: null,
      };
    }

    const active = rows("physical_inventory_sessions").find(
      (r) =>
        r.source_id === args.p_source_id &&
        r.sender_line_user_id === sender &&
        (r.status === "open" || r.status === "closing"),
    );
    if (active) {
      return {
        data: {
          opened: false,
          idempotent: true,
          reason: "already_open_or_duplicate",
          session_id: active.id,
          session_generation: active.session_generation,
          status: active.status,
          ingest_revision: active.ingest_revision,
        },
        error: null,
      };
    }

    const session: Row = {
      id: uuid(),
      source_type: args.p_source_type,
      source_id: args.p_source_id,
      sender_line_user_id: sender,
      opened_line_event_id: eventId,
      session_generation: uuid(),
      business_date: args.p_business_date ?? null,
      warehouse_code: "MAIN",
      status: "open",
      parser_version: args.p_parser_version ?? null,
      opened_at: new Date(nowMs).toISOString(),
      close_requested_at: null,
      close_event_timestamp_ms: null,
      close_quiet_until: null,
      close_deadline_at: null,
      closed_at: null,
      failed_closed_at: null,
      fail_reason: null,
      ingest_revision: 1,
      snapshot_id: null,
      header_raw_message_id: args.p_raw_message_id ?? null,
      close_raw_message_id: null,
      close_line_event_id: null,
      warnings: [],
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };
    rows("physical_inventory_sessions").push(session);
    rows("physical_inventory_session_ingests").push({
      id: uuid(),
      session_id: session.id,
      line_event_id: eventId,
      line_message_id: args.p_line_message_id ?? null,
      line_timestamp_ms: args.p_line_timestamp_ms,
      raw_message_id: args.p_raw_message_id ?? null,
      kind: "header",
      raw_text: args.p_raw_text,
      ingest_revision: 1,
      created_at: new Date(nowMs).toISOString(),
    });
    return {
      data: {
        opened: true,
        idempotent: false,
        reason: "opened",
        session_id: session.id,
        session_generation: session.session_generation,
        status: session.status,
        ingest_revision: 1,
      },
      error: null,
    };
  }

  async function admitRpc(args: Record<string, unknown>) {
    const sessionId = args.p_session_id as string;
    const gen = args.p_expected_generation as string;
    const eventId = String(args.p_line_event_id ?? "").trim();
    const ts = Number(args.p_line_timestamp_ms);
    const kind = args.p_kind as string;

    const existing = rows("physical_inventory_session_ingests").find(
      (r) => r.line_event_id === eventId,
    );
    if (existing) {
      if (existing.session_id !== sessionId) {
        return { data: null, error: { message: "line_event_conflict" } };
      }
      const session = rows("physical_inventory_sessions").find((s) => s.id === sessionId)!;
      if (session.session_generation !== gen) {
        return { data: null, error: { message: "generation_conflict" } };
      }
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

    const session = rows("physical_inventory_sessions").find((s) => s.id === sessionId);
    if (!session) return { data: null, error: { message: "physical inventory session not found" } };
    if (session.session_generation !== gen) {
      return { data: null, error: { message: "generation_conflict" } };
    }
    if (["finalized", "failed_closed", "voided"].includes(String(session.status))) {
      return { data: null, error: { message: "session_closed" } };
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
      if (session.close_deadline_at && nowMs >= new Date(String(session.close_deadline_at)).getTime()) {
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
      created_at: new Date(nowMs).toISOString(),
    });
    Object.assign(session, {
      ingest_revision: nextRev,
      updated_at: new Date(nowMs).toISOString(),
    });
    if (kind === "close" && session.close_event_timestamp_ms == null) {
      Object.assign(session, {
        status: "closing",
        close_requested_at: new Date(nowMs).toISOString(),
        close_event_timestamp_ms: ts,
        close_quiet_until: new Date(nowMs + PHYSICAL_INVENTORY_CLOSE_QUIET_MS).toISOString(),
        close_deadline_at: new Date(nowMs + 30_000).toISOString(),
        close_line_event_id: eventId,
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

  async function candidateRpc(args: Record<string, unknown>) {
    const session = rows("physical_inventory_sessions").find(
      (s) => s.id === args.p_session_id,
    );
    if (!session) return { data: null, error: { message: "physical inventory session not found" } };
    if (session.session_generation !== args.p_expected_generation) {
      return { data: null, error: { message: "generation_conflict" } };
    }
    const ingests = rows("physical_inventory_session_ingests")
      .filter((r) => r.session_id === session.id)
      .sort((a, b) => Number(a.ingest_revision) - Number(b.ingest_revision))
      .map((i) => ({
        line_event_id: i.line_event_id,
        line_timestamp_ms: i.line_timestamp_ms,
        kind: i.kind,
        raw_text: i.raw_text,
        ingest_revision: i.ingest_revision,
        line_message_id: i.line_message_id ?? null,
        raw_message_id: i.raw_message_id ?? null,
      }));
    return {
      data: {
        session_id: session.id,
        session_generation: session.session_generation,
        status: session.status,
        ingest_revision: session.ingest_revision,
        ingest_set_hash: computeHash(String(session.id)),
        close_event_timestamp_ms: session.close_event_timestamp_ms,
        close_quiet_until: session.close_quiet_until,
        close_deadline_at: session.close_deadline_at,
        ingests,
      },
      error: null,
    };
  }

  async function finalizeRpc(args: Record<string, unknown>) {
    const sessionId = args.p_session_id as string;
    const gen = args.p_expected_generation as string;
    const rev = args.p_expected_ingest_revision as number;
    const hashIn = String(args.p_expected_ingest_hash ?? "");
    const failClosed = Boolean(args.p_fail_closed);
    const session = rows("physical_inventory_sessions").find((s) => s.id === sessionId);
    if (!session) return { data: null, error: { message: "physical inventory session not found" } };
    if (session.session_generation !== gen) {
      return { data: null, error: { message: "generation_conflict" } };
    }
    if (session.status === "finalized" && session.snapshot_id) {
      const snap = rows("physical_inventory_snapshots").find((s) => s.id === session.snapshot_id)!;
      return {
        data: {
          ok: true,
          idempotent: true,
          status: "finalized",
          snapshot_id: snap.id,
          session_id: session.id,
          finalized_ingest_revision: snap.finalized_ingest_revision,
          finalized_ingest_hash: snap.finalized_ingest_hash,
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
    if (session.status !== "closing") {
      return { data: null, error: { message: "close_boundary_required" } };
    }
    if (session.ingest_revision !== rev) {
      return { data: null, error: { message: "stale_ingest_revision" } };
    }
    const hash = computeHash(sessionId);
    if (hash !== hashIn) {
      return { data: null, error: { message: "stale_ingest_hash" } };
    }
    const quietOk =
      nowMs >= new Date(String(session.close_quiet_until)).getTime() ||
      nowMs >= new Date(String(session.close_deadline_at)).getTime();
    if (!quietOk) {
      return { data: null, error: { message: "close_quiet_window" } };
    }

    if (failClosed) {
      Object.assign(session, {
        status: "failed_closed",
        failed_closed_at: new Date(nowMs).toISOString(),
        closed_at: new Date(nowMs).toISOString(),
        fail_reason: args.p_fail_reason ?? "failed_closed",
        updated_at: new Date(nowMs).toISOString(),
      });
      rows("physical_inventory_lifecycle_events").push({
        id: uuid(),
        session_id: session.id,
        snapshot_id: null,
        event: "failed_closed",
        created_at: new Date(nowMs).toISOString(),
      });
      return {
        data: {
          ok: true,
          idempotent: false,
          status: "failed_closed",
          snapshot_id: null,
          session_id: session.id,
          fail_reason: session.fail_reason,
          finalized_ingest_revision: session.ingest_revision,
          finalized_ingest_hash: hash,
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
      ingest_idempotency_key: `${session.id}:${session.session_generation}`,
      finalized_ingest_revision: session.ingest_revision,
      finalized_ingest_hash: hash,
      finalized_at: new Date(nowMs).toISOString(),
      voided_at: null,
      created_at: new Date(nowMs).toISOString(),
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
        created_at: new Date(nowMs).toISOString(),
      });
    });
    Object.assign(session, {
      status: "finalized",
      closed_at: new Date(nowMs).toISOString(),
      business_date: args.p_business_date,
      snapshot_id: snapshotId,
      updated_at: new Date(nowMs).toISOString(),
    });
    rows("physical_inventory_lifecycle_events").push({
      id: uuid(),
      session_id: session.id,
      snapshot_id: snapshotId,
      event: "finalized",
      created_at: new Date(nowMs).toISOString(),
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
        finalized_ingest_revision: session.ingest_revision,
        finalized_ingest_hash: hash,
      },
      error: null,
    };
  }

  const db = {
    advanceMs(ms: number) {
      nowMs += ms;
    },
    from(table: string) {
      if (table === "produce_sessions" || table === "produce_items") {
        throw new Error(`FORBIDDEN write/read of ${table}`);
      }
      return query(table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "open_physical_inventory_session") return openRpc(args);
      if (name === "admit_physical_inventory_event") return admitRpc(args);
      if (name === "get_physical_inventory_finalize_candidate") return candidateRpc(args);
      if (name === "finalize_physical_inventory_session") return finalizeRpc(args);
      throw new Error(`Unexpected RPC ${name}`);
    },
    _count(table: string) {
      return rows(table).length;
    },
    _tryMutate(table: string) {
      assertImmutable(table);
    },
  };

  return db as unknown as import("@supabase/supabase-js").SupabaseClient<Database> & {
    advanceMs: (ms: number) => void;
    _count: (t: string) => number;
    _tryMutate: (t: string) => void;
  };
}

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

describe("PhysicalInventorySessionService — Slice B hardening", () => {
  test("open requires sender + opened event; blank rejected", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    await expect(
      svc.openSession({
        sourceType: "group",
        sourceId: "G1",
        senderLineUserId: "  ",
        openedLineEventId: "h1",
        lineTimestampMs: 1,
        rawText: "header",
      }),
    ).rejects.toThrow(/sender_line_user_id required/);
  });

  test("open idempotent on same header event", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const a = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
      openedLineEventId: "hdr-1",
      lineTimestampMs: 100,
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69",
    });
    expect(a.opened).toBe(true);
    const b = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
      openedLineEventId: "hdr-1",
      lineTimestampMs: 100,
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69",
    });
    expect(b.opened).toBe(false);
    expect(b.session.id).toBe(a.session.id);
    expect(db._count("physical_inventory_sessions")).toBe(1);
    expect(db._count("physical_inventory_session_ingests")).toBe(1);
  });

  test("global line_event conflict across sessions", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const a = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
      openedLineEventId: "h-a",
      lineTimestampMs: 1,
      rawText: "header a",
    });
    const b = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U2",
      openedLineEventId: "h-b",
      lineTimestampMs: 2,
      rawText: "header b",
    });
    await svc.registerIngest({
      sessionId: a.session.id,
      expectedGeneration: a.session.session_generation,
      lineEventId: "shared",
      lineTimestampMs: 3,
      kind: "item",
      rawText: "1มะม่วง\n3โล",
    });
    await expect(
      svc.registerIngest({
        sessionId: b.session.id,
        expectedGeneration: b.session.session_generation,
        lineEventId: "shared",
        lineTimestampMs: 4,
        kind: "item",
        rawText: "1มะม่วง\n3โล",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryLineEventConflictError);
  });

  test("failed_closed from OPEN without close is rejected", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-fail-open",
      senderLineUserId: "U",
      openedLineEventId: "h",
      lineTimestampMs: 1,
      rawText: "สตอกผลไม้คงเหลือ\nจบ",
    });
    const cand = await svc.getFinalizeCandidate({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
    });
    await expect(
      svc.finalize({
        sessionId: opened.session.id,
        expectedGeneration: opened.session.session_generation,
        expectedIngestRevision: cand.ingestRevision,
        expectedIngestHash: cand.ingestSetHash,
        parsed: parsePhysicalInventoryDocument("สตอกผลไม้คงเหลือ\nจบ"),
        failClosed: true,
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryCloseBoundaryRequiredError);
  });

  test("late pre-boundary item + fail_closed race requires matching hash", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-race",
      senderLineUserId: "U",
      openedLineEventId: "h",
      lineTimestampMs: 1_000,
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69\n7แตงโม\n45ลูก",
    });
    const gen = opened.session.session_generation;
    const closed = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "close",
      lineTimestampMs: 10_000,
      kind: "close",
      rawText: "จบ",
    });
    expect(closed.session.status).toBe("closing");
    const candAtClose = await svc.getFinalizeCandidate({
      sessionId: opened.session.id,
      expectedGeneration: gen,
    });
    await expect(
      svc.finalize({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        expectedIngestRevision: candAtClose.ingestRevision,
        expectedIngestHash: candAtClose.ingestSetHash,
        parsed: parsePhysicalInventoryDocument("x"),
        failClosed: true,
        failReason: "no_items",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryCloseQuietWindowError);

    const late = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "i8",
      lineTimestampMs: 9_000,
      kind: "item",
      rawText: "8มะละกอ\n15ลูก",
    });
    expect(late.inserted).toBe(true);

    await expect(
      svc.finalize({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        expectedIngestRevision: candAtClose.ingestRevision,
        expectedIngestHash: candAtClose.ingestSetHash,
        parsed: parsePhysicalInventoryDocument("x"),
        failClosed: true,
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryStaleRevisionError);

    db.advanceMs(PHYSICAL_INVENTORY_CLOSE_QUIET_MS + 1);
    const cand = await svc.getFinalizeCandidate({
      sessionId: opened.session.id,
      expectedGeneration: gen,
    });
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      expectedIngestRevision: cand.ingestRevision,
      expectedIngestHash: cand.ingestSetHash,
      parsed: parsePhysicalInventoryDocument("สตอกผลไม้คงเหลือ\nจบ"),
      failClosed: true,
      failReason: "no_items",
    });
    expect(fin.status).toBe("failed_closed");
    expect(db._count("physical_inventory_session_ingests")).toBe(3); // header+close+item8
    expect(db._count("physical_inventory_snapshots")).toBe(0);
  });

  test("A/B/C/D/E/F close-boundary + hash finalize", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-abc",
      senderLineUserId: "U",
      openedLineEventId: "h",
      lineTimestampMs: 1_000,
      rawText: "สตอกผลไม้คงเหลือ\n27/7/69\n7แตงโม\n45ลูก",
    });
    const gen = opened.session.session_generation;
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "close",
      lineTimestampMs: 10_000,
      kind: "close",
      rawText: "จบ",
    });
    const late = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "i8",
      lineTimestampMs: 9_000,
      kind: "item",
      rawText: "8มะละกอ\n15ลูก",
    });
    expect(late.inserted).toBe(true);

    await expect(
      svc.registerIngest({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        lineEventId: "post",
        lineTimestampMs: 11_000,
        kind: "item",
        rawText: "x",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryAfterCloseBoundaryError);

    const dupClose = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "close2",
      lineTimestampMs: 99_000,
      kind: "close",
      rawText: "จบ",
    });
    expect(dupClose.reason).toBe("close_already_requested");
    expect(dupClose.session.close_event_timestamp_ms).toBe(10_000);

    const lateDup = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "i8",
      lineTimestampMs: 9_000,
      kind: "item",
      rawText: "8มะละกอ\n15ลูก",
    });
    expect(lateDup.inserted).toBe(false);

    const staleCand = await svc.getFinalizeCandidate({
      sessionId: opened.session.id,
      expectedGeneration: gen,
    });
    db.advanceMs(PHYSICAL_INVENTORY_CLOSE_QUIET_MS + 1);
    await expect(
      svc.finalize({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        expectedIngestRevision: staleCand.ingestRevision,
        expectedIngestHash: "deadbeef",
        parsed: parsePhysicalInventoryDocument(
          "สตอกผลไม้คงเหลือ\n27/7/69\n7แตงโม\n45ลูก\n8มะละกอ\n15ลูก\nจบ",
        ),
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryStaleIngestHashError);

    const cand = await svc.getFinalizeCandidate({
      sessionId: opened.session.id,
      expectedGeneration: gen,
    });
    const doc = cand.ingests.map((i) => i.raw_text).join("\n");
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      expectedIngestRevision: cand.ingestRevision,
      expectedIngestHash: cand.ingestSetHash,
      parsed: parsePhysicalInventoryDocument(doc),
    });
    expect(fin.status).toBe("finalized");
    expect(fin.finalizedIngestHash).toBe(cand.ingestSetHash);
    const snap = await svc.getSnapshot(fin.snapshotId!);
    expect(snap?.finalized_ingest_hash).toBe(cand.ingestSetHash);
    expect(snap?.counted_at).toBe(new Date(10_000).toISOString());

    await expect(
      svc.registerIngest({
        sessionId: opened.session.id,
        expectedGeneration: gen,
        lineEventId: "after-fin",
        lineTimestampMs: 1,
        kind: "item",
        rawText: "x",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryAfterCloseError);

    // Redelivery of known event after finalize is idempotent, not session_closed
    const redelivery = await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: gen,
      lineEventId: "i8",
      lineTimestampMs: 9_000,
      kind: "item",
      rawText: "8มะละกอ\n15ลูก",
    });
    expect(redelivery.inserted).toBe(false);
    expect(redelivery.reason).toBe("duplicate_event");

    expect(() => db._tryMutate("physical_inventory_snapshots")).toThrow(/immutable/);
    expect(() => db._tryMutate("physical_inventory_session_ingests")).toThrow(/immutable/);
  });

  test("fixture finalize persists hash + 8 items; migration surface", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G-b",
      senderLineUserId: "U-b",
      openedLineEventId: "full",
      lineTimestampMs: 1_000,
      rawText: FIXTURE_B,
    });
    await svc.registerIngest({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      lineEventId: "close-b",
      lineTimestampMs: 2_000,
      kind: "close",
      rawText: "จบรายการผลไม้ที่เหลือในบ้าน",
    });
    db.advanceMs(PHYSICAL_INVENTORY_CLOSE_QUIET_MS + 1);
    const cand = await svc.getFinalizeCandidate({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
    });
    const fin = await svc.finalize({
      sessionId: opened.session.id,
      expectedGeneration: opened.session.session_generation,
      expectedIngestRevision: cand.ingestRevision,
      expectedIngestHash: cand.ingestSetHash,
      parsed: parsePhysicalInventoryDocument(FIXTURE_B),
    });
    expect(fin.status).toBe("finalized");
    expect(await svc.listSnapshotItems(fin.snapshotId!)).toHaveLength(8);

    const sql = readFileSync("supabase/migrations/0047_physical_inventory_capture.sql", "utf8");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("finalized_ingest_hash");
    expect(sql).toContain("open_physical_inventory_session");
    expect(sql).toContain("get_physical_inventory_finalize_candidate");
    expect(sql).not.toContain("p_as_of");
    expect(sql).not.toContain("p_quiet_ms");
    expect(sql).toContain("physical_inventory_session_ingests_immutable");
    expect(sql).toContain("UNIQUE (line_event_id)");
    expect(PHYSICAL_INVENTORY_VOID_SUPERSEDE_SLICE).toBe("E");
    expect(PHYSICAL_INVENTORY_CLOSE_QUIET_MS).toBe(8_000);
  });

  test("generation mismatch", async () => {
    const db = makePhysicalInventoryDb();
    const svc = new PhysicalInventorySessionService(db);
    const opened = await svc.openSession({
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
      openedLineEventId: "h",
      lineTimestampMs: 1,
      rawText: "header",
    });
    await expect(
      svc.registerIngest({
        sessionId: opened.session.id,
        expectedGeneration: "00000000-0000-4000-8000-999999999999",
        lineEventId: "x",
        lineTimestampMs: 2,
        kind: "item",
        rawText: "1มะม่วง\n3โล",
      }),
    ).rejects.toBeInstanceOf(PhysicalInventoryGenerationConflictError);
  });
});
