import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { Database } from "@/types/database";
import { stubManualSlipTables } from "@/lib/white-sheet/test-manual-slip-db";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
  text: string,
  opts?: { replyToken?: string; messageId?: string; source?: Record<string, unknown> },
): LineMessageEvent {
  const messageId = opts?.messageId ?? `msg-${Math.random()}`;
  return {
    type: "message",
    webhookEventId: `evt-${messageId}`,
    timestamp: Date.now(),
    replyToken: opts?.replyToken ?? `tok-${messageId}`,
    source: opts?.source ?? { type: "group", groupId: "group-ws-1", userId: "u1" },
    message: { type: "text", id: messageId, text },
  } as unknown as LineMessageEvent;
}

type Row = Record<string, unknown>;

const SOURCE_ID = "group-ws-1";
const MARKET = "พาชิโอ้ผลไม้";
const DATE_DISPLAY = "31/07/2569";
const DATE_ISO = "2026-07-31";

function makeDb() {
  const sessions: Row[] = [];
  let sessionSeq = 0;
  const seenLineEventIds = new Set<string>();
  // Test-only failure injection for the closing-recovery tests.
  const control = { throwOnFinalize: false, throwOnProduceRange: false };

  const produceRows: Row[] = [
    {
      id: "item-1",
      product_name: "มะม่วง",
      quantity: 20,
      unit: "ลูก",
      price_per_unit: 5,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-07-31T01:00:00Z",
      session_id: "main-1",
      transaction_date: DATE_ISO,
      market_name: MARKET,
      raw_message_id: "raw-produce-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
  ];
  const centralPrices: Row[] = [
    {
      product_key: "มะม่วง",
      unit_key: "ลูก",
      business_date: DATE_ISO,
      price_satang: 500,
      set_by: "admin",
      set_reason: null,
      created_at: "2026-07-31T00:00:00Z",
      updated_at: "2026-07-31T00:00:00Z",
    },
  ];
  const cashEntries = new Map<string, Row>();
  const cashKey = (sourceId: string, market: string, date: string) => `${sourceId}::${market}::${date}`;

  function sessionMatches(row: Row, filters: Array<{ op: string; col: string; val: unknown }>) {
    return filters.every(({ op, col, val }) =>
      op === "in" ? (val as unknown[]).includes(row[col]) : row[col] === val,
    );
  }

  function sessionSelectChain(
    filters: Array<{ op: string; col: string; val: unknown }> = [],
    order?: { col: string; ascending: boolean },
    limit?: number,
  ) {
    return {
      eq(col: string, val: unknown) {
        return sessionSelectChain([...filters, { op: "eq", col, val }], order, limit);
      },
      in(col: string, val: unknown[]) {
        return sessionSelectChain([...filters, { op: "in", col, val }], order, limit);
      },
      order(col: string, opts?: { ascending?: boolean }) {
        return sessionSelectChain(filters, { col, ascending: opts?.ascending ?? true }, limit);
      },
      limit(n: number) {
        return sessionSelectChain(filters, order, n);
      },
      async maybeSingle() {
        let found = sessions.filter((r) => sessionMatches(r, filters));
        if (order) {
          found = [...found].sort((a, b) => {
            const av = String(a[order.col] ?? "");
            const bv = String(b[order.col] ?? "");
            return order.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (limit !== undefined) found = found.slice(0, limit);
        return { data: found[0] ?? null, error: null };
      },
    };
  }

  function sessionUpdateChain(
    patch: Row,
    filters: Array<{ op: string; col: string; val: unknown }> = [],
  ) {
    return {
      eq(col: string, val: unknown) {
        return sessionUpdateChain(patch, [...filters, { op: "eq", col, val }]);
      },
      in(col: string, val: unknown[]) {
        return sessionUpdateChain(patch, [...filters, { op: "in", col, val }]);
      },
      select() {
        return {
          async maybeSingle() {
            const idx = sessions.findIndex((r) => sessionMatches(r, filters));
            if (idx === -1) return { data: null, error: null };
            if (patch.status === "closed" && control.throwOnFinalize) {
              throw new Error("simulated finalizeClosed infra failure");
            }
            Object.assign(sessions[idx], patch);
            return { data: sessions[idx], error: null };
          },
          async single() {
            const idx = sessions.findIndex((r) => sessionMatches(r, filters));
            if (idx === -1) return { data: null, error: { message: "not found" } };
            if (patch.status === "closed" && control.throwOnFinalize) {
              throw new Error("simulated finalizeClosed infra failure");
            }
            Object.assign(sessions[idx], patch);
            return { data: sessions[idx], error: null };
          },
        };
      },
      async then(resolve: (v: unknown) => void) {
        const idx = sessions.findIndex((r) => sessionMatches(r, filters));
        if (idx === -1) return resolve({ data: null, error: null });
        Object.assign(sessions[idx], patch);
        return resolve({ data: sessions[idx], error: null });
      },
    };
  }

  function sessionStub() {
    return {
      select: () => sessionSelectChain(),
      insert(payload: Row) {
        return {
          select() {
            return {
              async single() {
                const identityConflict = sessions.some(
                  (r) =>
                    r.source_id === payload.source_id &&
                    r.market_label_normalized === payload.market_label_normalized &&
                    r.business_date === payload.business_date,
                );
                const openConflict = sessions.some(
                  (r) => r.source_id === payload.source_id && (r.status === "open" || r.status === "closing"),
                );
                if (identityConflict || openConflict) {
                  return { data: null, error: { code: "23505", message: "unique_violation" } };
                }
                const row: Row = {
                  id: `sess-${++sessionSeq}`,
                  status: "open",
                  labor: null,
                  location_fee: null,
                  bag: null,
                  snack: null,
                  other_amount: null,
                  other_note: null,
                  actual_cash_submitted: null,
                  edited_fields: [],
                  closing_started_at: null,
                  closed_at: null,
                  closed_by_line_user_id: null,
                  closed_line_event_id: null,
                  opened_at: new Date().toISOString(),
                  ...payload,
                };
                sessions.push(row);
                return { data: row, error: null };
              },
            };
          },
        };
      },
      update: (patch: Row) => sessionUpdateChain(patch),
    };
  }

  const database = {
    from(table: string) {
      if (table === "raw_messages") {
        const rawRows = [{ id: "raw-produce-1", source_id: SOURCE_ID }];
        return {
          insert(payload: Row) {
            return {
              select: () => ({
                async single() {
                  const eventId = String(payload.line_event_id);
                  if (seenLineEventIds.has(eventId)) {
                    return { data: null, error: { code: "23505", message: "duplicate" } };
                  }
                  seenLineEventIds.add(eventId);
                  return { data: { id: `raw-${Math.random()}` }, error: null };
                },
              }),
            };
          },
          select: () => ({
            in: async (_col: string, ids: string[]) => ({
              data: rawRows.filter((r) => ids.includes(r.id)),
              error: null,
            }),
          }),
        };
      }
      if (table === "manual_white_sheet_sessions") return sessionStub();
      if (table === "produce_transactions") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          range: async () => {
            if (control.throwOnProduceRange) {
              throw new Error("simulated produce lookup infra failure");
            }
            return { data: produceRows, error: null, count: produceRows.length };
          },
        };
        return builder;
      }
      if (table === "central_selling_prices") {
        return { select: () => ({ eq: async () => ({ data: centralPrices, error: null }) }) };
      }
      if (table === "slip_evidences") {
        return { select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) };
      }
      if (table === "slip_checks") {
        return {
          select: () => {
            const b = { in: () => b, not: () => b, order: () => b, then: (r: (v: unknown) => void) => r({ data: [], error: null }) };
            return b;
          },
        };
      }
      if (table === "digital_white_sheet_cash_entries") {
        type Filter = { col: string; val: unknown };
        const matches = (row: Row, filters: Filter[]) => filters.every(({ col, val }) => row[col] === val);
        return {
          select: () => {
            const filters: Filter[] = [];
            const b = {
              eq: (col: string, val: unknown) => { filters.push({ col, val }); return b; },
              is: (col: string, val: unknown) => { filters.push({ col, val }); return b; },
              maybeSingle: async () => ({ data: [...cashEntries.values()].find((r) => matches(r, filters)) ?? null, error: null }),
            };
            return b;
          },
          insert: (values: Row) => ({
            select: () => ({
              single: async () => {
                const merged: Row = { id: `entry-${cashEntries.size + 1}`, created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z", other_note: null, finalized_at: null, finalized_by: null, ...values };
                cashEntries.set(cashKey(String(merged.source_id), String(merged.market_label_normalized), String(merged.business_date)), merged);
                return { data: merged, error: null };
              },
            }),
          }),
          update: (values: Row) => {
            const filters: Filter[] = [];
            const b = {
              eq: (col: string, val: unknown) => { filters.push({ col, val }); return b; },
              is: (col: string, val: unknown) => { filters.push({ col, val }); return b; },
              select: () => ({
                maybeSingle: async () => {
                  const found = [...cashEntries.entries()].find(([, row]) => matches(row, filters));
                  if (!found) return { data: null, error: null };
                  const [key, existing] = found;
                  const merged = { ...existing, ...values, updated_at: "2026-07-31T01:00:00Z" };
                  cashEntries.set(key, merged);
                  return { data: merged, error: null };
                },
              }),
            };
            return b;
          },
        };
      }
      if (table === "white_sheet_lifecycle_events") {
        throw new Error("lifecycle audit must go through finalize/reopen RPCs");
      }
      if (table === "pending_sessions") {
        return { select: () => ({ eq: () => ({ async maybeSingle() { return { data: null, error: null }; } }) }) };
      }
      const manualSlip = stubManualSlipTables()(table);
      if (manualSlip) return manualSlip;
      // Chainable no-op for every other table (guided-menu state, etc.) —
      // any depth of .eq()/.order()/.limit()/... resolves to an empty result.
      const noop: unknown = new Proxy(
        () => Promise.resolve({ data: [], error: null }),
        {
          get(target, prop) {
            if (prop === "then") {
              return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
            }
            if (prop === "maybeSingle" || prop === "single") {
              return async () => ({ data: null, error: null });
            }
            return () => noop;
          },
          apply: () => Promise.resolve({ data: [], error: null }),
        },
      );
      return {
        select: () => noop,
        insert: () => noop,
        update: () => noop,
      };
    },
    /** Mirrors claim_manual_white_sheet_session_close (see migration 0059). */
    rpc(fnName: string, args: Record<string, unknown>) {
      if (fnName !== "claim_manual_white_sheet_session_close") {
        return Promise.resolve({ data: null, error: { message: `unexpected rpc: ${fnName}` } });
      }
      const sourceId = args.p_source_id as string;
      const leaseSeconds = (args.p_lease_seconds as number | undefined) ?? 120;
      const row = sessions.find(
        (r) => r.source_id === sourceId && (r.status === "open" || r.status === "closing"),
      );
      if (!row) {
        return Promise.resolve({ data: { claimed: false, reason: "not_found", session: null }, error: null });
      }
      if (row.status === "closing") {
        const startedAt = row.closing_started_at ? new Date(row.closing_started_at as string).getTime() : null;
        const stale = startedAt !== null && startedAt <= Date.now() - leaseSeconds * 1000;
        if (stale) {
          row.closing_started_at = new Date().toISOString();
          return Promise.resolve({ data: { claimed: true, reason: null, session: { ...row } }, error: null });
        }
        return Promise.resolve({
          data: { claimed: false, reason: "closing_in_progress", session: { ...row } },
          error: null,
        });
      }
      row.status = "closing";
      row.closing_started_at = new Date().toISOString();
      return Promise.resolve({ data: { claimed: true, reason: null, session: { ...row } }, error: null });
    },
  };

  return {
    supabase: database as unknown as SupabaseClient<Database>,
    _sessions: sessions,
    _cashEntries: cashEntries,
    _control: control,
    _markFinalized(market: string, date: string) {
      const row = cashEntries.get(cashKey(SOURCE_ID, market, date));
      if (!row) throw new Error("no cash entry to finalize");
      row.finalized_at = "2026-08-01T00:00:00Z";
      row.finalized_by = "admin1";
    },
  };
}

function makeService(db: ReturnType<typeof makeDb>, replies: string[] = []) {
  return new WebhookService(db.supabase, {
    replyMessage: async (_tok, text) => { replies.push(text); },
    replyMessages: async (_tok, texts) => { replies.push(texts.join("\n")); },
    scheduleBackgroundTask: () => {},
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Manual White Sheet LINE session — opener", () => {
  it("opens a new session and greets with market/date", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    const [res] = await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");

    expect(res.status).toBe("saved");
    expect(db._sessions).toHaveLength(1);
    expect(db._sessions[0].status).toBe("open");
    expect(replies[0]).toContain("เปิดรับใบขาวมือแล้ว");
    expect(replies[0]).toContain(MARKET);
    expect(replies[0]).toContain(DATE_DISPLAY);
  });

  it("rejects a market with no produce data for that date", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`ไม่มีตลาดนี้ ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");

    expect(db._sessions).toHaveLength(0);
    expect(replies[0]).toContain("ไม่พบตลาด");
  });

  it("rejects an invalid date", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ 99/99/2569`)], "dest");

    expect(db._sessions).toHaveLength(0);
    expect(replies[0]).toContain("วันที่ไม่ถูกต้อง");
  });

  it("resumes the same source/market/date session and shows entered values", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500")], "dest");
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");

    expect(db._sessions).toHaveLength(1);
    expect(replies[2]).toContain("เปิดอยู่แล้ว");
    expect(replies[2]).toContain("ค่าแรง: 500.00");
  });

  it("blocks opening a different market/date while one is open", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent(`มะม่วงตลาดอื่น ส่งใบขาวมือ 01/08/2569`)], "dest");

    expect(db._sessions).toHaveLength(1);
    expect(replies[1]).toContain("ยังมีใบขาวมือ");
    expect(replies[1]).toContain(MARKET);
  });
});

describe("Manual White Sheet LINE session — field accumulation", () => {
  it("appends a single field per message", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500")], "dest");

    expect(db._sessions[0].labor).toBe(500);
    expect(replies[1]).toContain("รับข้อมูลใบขาวมือแล้ว");
  });

  it("accepts multiple fields in one message, any order", async () => {
    const db = makeDb();
    const svc = makeService(db);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents(
      [makeEvent("เงินสด 4850\nค่าแรง 500\nค่าที่ 200\nค่าถุง 100\nค่าขนม 50\nค่าอื่น 30 ค่าน้ำ")],
      "dest",
    );

    const row = db._sessions[0];
    expect(row.labor).toBe(500);
    expect(row.location_fee).toBe(200);
    expect(row.bag).toBe(100);
    expect(row.snack).toBe(50);
    expect(row.other_amount).toBe(30);
    expect(row.other_note).toBe("ค่าน้ำ");
    expect(row.actual_cash_submitted).toBe(4850);
  });

  it("a repeated field replaces the previous value", async () => {
    const db = makeDb();
    const svc = makeService(db);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 600")], "dest");

    expect(db._sessions[0].labor).toBe(600);
  });

  it("explicit zero is stored, not treated as omitted", async () => {
    const db = makeDb();
    const svc = makeService(db);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 0")], "dest");
    expect(db._sessions[0].labor).toBe(0);
  });

  it("ค่าอื่น 0 with no note clears a previously set note", async () => {
    const db = makeDb();
    const svc = makeService(db);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าอื่น 30 ค่าน้ำ")], "dest");
    await svc.processEvents([makeEvent("ค่าอื่น 0")], "dest");
    expect(db._sessions[0].other_amount).toBe(0);
    expect(db._sessions[0].other_note).toBeNull();
  });

  it("malformed money makes zero mutation, with the exact bad line in the reply", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง abc")], "dest");
    expect(db._sessions[0].labor).toBeNull();
    expect(replies[1]).toContain("ค่าแรง abc");
  });

  it("a mixed valid+invalid message makes zero mutation for the whole message", async () => {
    const db = makeDb();
    const svc = makeService(db);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500\nค่าที่ abc")], "dest");
    expect(db._sessions[0].labor).toBeNull();
    expect(db._sessions[0].location_fee).toBeNull();
  });

  it("a recognized field mixed with an unrelated command line fails closed — zero mutation, does not swallow the other command", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500\nจบสลิปมือ")], "dest");
    expect(db._sessions[0].labor).toBeNull();
    expect(replies[1]).toContain("จบสลิปมือ");
  });

  it("a field-shaped message with no open White Sheet session falls through unclaimed — no ยังไม่ได้เปิดใบขาวมือ reply, no DB query claimed it", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    const [res] = await svc.processEvents([makeEvent("ค่าแรง 500")], "dest");
    expect(db._sessions).toHaveLength(0);
    expect(res.status).toBe("saved");
    // Must not be swallowed by the Manual White Sheet handler.
    expect(replies.join("\n")).not.toContain("ยังไม่ได้เปิดใบขาวมือ");
  });

  it("a completely unrelated message falls through and is not swallowed", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    const [res] = await svc.processEvents([makeEvent("สวัสดีตอนเช้าครับ")], "dest");
    // Not claimed by the session field handler — falls through to default "saved" with no session reply.
    expect(res.status).toBe("saved");
    expect(db._sessions[0].labor).toBeNull();
  });
});

describe("Manual White Sheet LINE session — close", () => {
  async function openAndFillCash(svc: WebhookService, extra = "") {
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent(`เงินสด 100${extra}`)], "dest");
  }

  it("requires cash before closing", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");
    expect(db._sessions[0].status).toBe("open");
    expect(db._cashEntries.size).toBe(0);
    expect(replies[1]).toContain("เงินสดที่ส่งจริง");
  });

  it("closes successfully: White Sheet persisted once, session terminal, receipt + summary", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await openAndFillCash(svc);
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    expect(db._sessions[0].status).toBe("closed");
    expect(db._cashEntries.size).toBe(1);
    expect(replies[2]).toContain("จบใบขาวมือแล้ว");
    expect(replies[2]).toContain("สรุปปิดยอด");
  });

  it("duplicate close event (same webhookEventId) does not double-submit", async () => {
    const db = makeDb();
    const svc = makeService(db);
    await openAndFillCash(svc);
    const closeEvent = makeEvent("จบใบขาวมือ", { messageId: "close-1" });
    await svc.processEvents([closeEvent], "dest");
    await svc.processEvents([closeEvent], "dest");

    expect(db._cashEntries.size).toBe(1);
  });

  it("closing again after already closed is a safe deterministic idempotent reply (terminal history, not a generic no-session message)", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await openAndFillCash(svc);
    await svc.processEvents([makeEvent("จบใบขาวมือ", { messageId: "c1" })], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", { messageId: "c2" })], "dest");

    expect(db._cashEntries.size).toBe(1);
    expect(replies[3]).toContain("จบไปแล้ว");
  });
});

describe("Manual White Sheet LINE session — cancel", () => {
  it("cancels without writing White Sheet data", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500")], "dest");
    await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ")], "dest");

    expect(db._sessions[0].status).toBe("cancelled");
    expect(db._cashEntries.size).toBe(0);
  });

  it("re-typing cancel after it already applied is a safe no-op (no crash, no re-mutation)", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    const [first] = await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ", { messageId: "cancel-1" })], "dest");
    const [second] = await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ", { messageId: "cancel-2" })], "dest");

    expect(first.status).toBe("saved");
    expect(second.status).toBe("saved");
    expect(db._sessions[0].status).toBe("cancelled");
    expect(replies[1]).toContain("ยกเลิกใบขาวมือแล้ว");
  });

  it("duplicate delivery of the same cancel LINE event does not re-process (top-level event dedup)", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    const cancelEvent = makeEvent("ยกเลิกใบขาวมือ", { messageId: "cancel-dup" });
    await svc.processEvents([cancelEvent], "dest");
    const [redelivered] = await svc.processEvents([cancelEvent], "dest");

    expect(redelivered.status).toBe("duplicate");
    expect(db._sessions[0].status).toBe("cancelled");
    expect(replies).toHaveLength(2); // open + first cancel only
  });

  it("does not delete an unrelated existing closed White Sheet on cancel", async () => {
    const db = makeDb();
    const svc = makeService(db);
    // First market closes normally.
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("เงินสด 100")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");
    expect(db._cashEntries.size).toBe(1);

    // A cancel with no open session must not touch the already-closed entry.
    await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ")], "dest");
    expect(db._cashEntries.size).toBe(1);
  });
});

describe("Manual White Sheet LINE session — closed session correction", () => {
  it("reopens a closed SUBMITTED session, seeded from the persisted White Sheet, and a corrected close updates the same row", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500\nเงินสด 100")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");
    expect(db._sessions[0].status).toBe("closed");
    expect(db._cashEntries.size).toBe(1);

    // Operator reopens the same identity to correct a mistake.
    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    expect(db._sessions).toHaveLength(1); // same identity row, no duplicate
    expect(db._sessions[0].status).toBe("open");
    expect(db._sessions[0].labor).toBe(500); // seeded from the persisted entry, not lost
    expect(replies[3]).toContain("ค่าแรง: 500.00");

    // Correction: change labor, close again.
    await svc.processEvents([makeEvent("ค่าแรง 700")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    expect(db._sessions[0].status).toBe("closed");
    expect(db._cashEntries.size).toBe(1); // same row updated, not duplicated
    const entry = db._cashEntries.get(`${SOURCE_ID}::${MARKET}::${DATE_ISO}`);
    expect(Number(entry?.labor)).toBe(700);
  });

  it("blocks reopening when the canonical White Sheet is FINALIZED", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("เงินสด 100")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");
    db._markFinalized(MARKET, DATE_ISO);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");

    expect(db._sessions).toHaveLength(1);
    expect(db._sessions[0].status).toBe("closed"); // never reopened
    expect(replies[3]).toContain("FINALIZED");
  });
});

describe("Manual White Sheet LINE session — closing recovery", () => {
  it("persistence success followed by session-finalization failure: session recovers to open, retry succeeds without duplicating the White Sheet", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("เงินสด 100")], "dest");

    db._control.throwOnFinalize = true;
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    // Not stuck in "closing" — reverted to "open" for a safe retry.
    expect(db._sessions[0].status).toBe("open");
    expect(db._cashEntries.size).toBe(1); // White Sheet was persisted before finalize failed
    expect(replies[2]).toContain('พิมพ์ "จบใบขาวมือ" อีกครั้ง');

    db._control.throwOnFinalize = false;
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    expect(db._sessions[0].status).toBe("closed");
    expect(db._cashEntries.size).toBe(1); // still exactly one row — no duplicate
  });

  it("an exception thrown from the White Sheet close service reverts the session to open for a safe retry", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent(`${MARKET} ส่งใบขาวมือ ${DATE_DISPLAY}`)], "dest");
    await svc.processEvents([makeEvent("เงินสด 100")], "dest");

    db._control.throwOnProduceRange = true;
    const [res] = await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    expect(res.status).toBe("error");
    expect(db._sessions[0].status).toBe("open"); // reverted, not stuck in "closing"
    expect(db._cashEntries.size).toBe(0); // nothing persisted before the throw

    db._control.throwOnProduceRange = false;
    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    expect(db._sessions[0].status).toBe("closed");
    expect(db._cashEntries.size).toBe(1);
  });
});

describe("Manual White Sheet LINE session — regression: does not break existing flows", () => {
  it("the existing one-message White Sheet close command still works unchanged", async () => {
    const db = makeDb();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    const text = [`${MARKET} ปิดยอด ${DATE_DISPLAY}`, "เงินสด 100", "จบปิดยอด"].join("\n");
    // No userId: keeps this a plain legacy (non-guided) submission — guided-menu
    // journey interaction with the old close command is covered elsewhere
    // (webhook-pending-boundary.test.ts, guided-menu/*.test.ts), not here.
    await svc.processEvents(
      [makeEvent(text, { source: { type: "group", groupId: SOURCE_ID } })],
      "dest",
    );

    expect(db._sessions).toHaveLength(0);
    expect(db._cashEntries.size).toBe(1);
    expect(replies[0]).toContain("สรุปปิดยอด");
  });
});
