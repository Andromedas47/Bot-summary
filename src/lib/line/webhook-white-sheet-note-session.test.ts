import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { Database } from "@/types/database";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(text: string, replyToken = "tok1", messageId = "msg1"): LineMessageEvent {
  return {
    type:           "message",
    webhookEventId: `evt-${messageId}`,
    timestamp:      Date.now(),
    replyToken,
    source:         { type: "user", userId: "u1" },
    message:        { type: "text", id: messageId, text },
  } as unknown as LineMessageEvent;
}

type Row = Record<string, unknown>;

// rpc("close_manual_white_sheet_note_session", ...) mirrors the plpgsql RPC's
// outcome logic against the in-memory notes/cashEntries arrays. The real
// transactional/locking behavior is proven separately in the real-PostgreSQL
// test (migration-0059.pg.test.ts) — this stub only proves the TS wiring.
function makeSupabase(seedCashEntries: Row[] = []) {
  const notes: Row[] = [];
  const cashEntries: Row[] = [...seedCashEntries];
  const rawEventIds = new Set<string>();
  let idSeq = 0;
  let forceOpenLookupError = false;
  let forceNextUpdateMiss = false;
  let updateCount = 0;

  function noteStub() {
    function queryChain(filtered: Row[]) {
      return {
        eq(col: string, val: unknown) { return queryChain(filtered.filter((r) => r[col] === val)); },
        order(_col: string, _opts?: unknown) { return queryChain(filtered); },
        limit(_n: number) { return queryChain(filtered); },
        async maybeSingle() {
          if (forceOpenLookupError) {
            forceOpenLookupError = false;
            return { data: null, error: { message: "connection reset" } };
          }
          return { data: filtered[0] ?? null, error: null };
        },
      };
    }
    return {
      select(_cols = "*") { return queryChain(notes); },
      insert(payload: Row) {
        return {
          select() {
            return {
              single() {
                const row: Row = {
                  id: `note-${++idSeq}`,
                  status: "open",
                  labor: null, location_fee: null, bag: null, snack: null,
                  other_amount: null, other_note: null, actual_cash: null,
                  closed_at: null, closed_by_line_user_id: null, closed_line_event_id: null,
                  created_at: new Date(Date.now() + idSeq).toISOString(),
                  ...payload,
                };
                notes.push(row);
                return Promise.resolve({ data: row, error: null });
              },
            };
          },
        };
      },
      update(patch: Row) {
        return {
          eq(col: string, val: unknown) {
            return {
              eq(col2: string, val2: unknown) {
                return {
                  eq(col3: string, val3: unknown) {
                    return {
                      select() {
                        return {
                          async maybeSingle() {
                            updateCount += 1;
                            if (forceNextUpdateMiss) {
                              forceNextUpdateMiss = false;
                              // Concurrent close won the row between lookup and UPDATE.
                              const raced = notes.find(
                                (r) => r[col] === val && r[col2] === val2,
                              );
                              if (raced) {
                                raced.status = "closed";
                                raced.closed_at = new Date().toISOString();
                                raced.closed_line_event_id = "evt-race-close";
                              }
                              return { data: null, error: null };
                            }
                            const idx = notes.findIndex(
                              (r) => r[col] === val && r[col2] === val2 && r[col3] === val3,
                            );
                            if (idx === -1) return { data: null, error: null };
                            Object.assign(notes[idx], patch);
                            return { data: notes[idx], error: null };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  async function rpc(fnName: string, args: Record<string, unknown>) {
    if (fnName !== "close_manual_white_sheet_note_session") {
      throw new Error(`unexpected rpc: ${fnName}`);
    }
    const session = notes.find((r) => r.id === args.p_session_id && r.source_id === args.p_source_id);
    if (!session) return { data: { outcome: "not_found", session: null, cash_entry: null }, error: null };
    if (session.status === "closed") {
      return { data: { outcome: "already_closed", session, cash_entry: null }, error: null };
    }
    if (session.status === "cancelled") {
      return { data: { outcome: "already_cancelled", session, cash_entry: null }, error: null };
    }
    const empty = ["labor", "location_fee", "bag", "snack", "other_amount", "actual_cash"]
      .every((k) => session[k] === null || session[k] === undefined);
    if (empty) return { data: { outcome: "empty", session, cash_entry: null }, error: null };

    let cash = cashEntries.find(
      (c) => c.source_id === session.source_id
        && c.market_label_normalized === session.market_label_normalized
        && c.business_date === session.business_date,
    );
    if (cash?.finalized_at) {
      return { data: { outcome: "finalized", session, cash_entry: null }, error: null };
    }
    if (!cash) {
      cash = {
        id: `cash-${++idSeq}`,
        source_id: session.source_id,
        market_label_normalized: session.market_label_normalized,
        business_date: session.business_date,
        labor: session.labor ?? 0,
        location_fee: session.location_fee ?? 0,
        bag: session.bag ?? 0,
        snack: session.snack ?? 0,
        other: session.other_amount ?? 0,
        other_note: session.other_note ?? null,
        actual_cash_submitted: session.actual_cash ?? 0,
        finalized_at: null,
      };
      cashEntries.push(cash);
    } else {
      if (session.labor !== null) cash.labor = session.labor;
      if (session.location_fee !== null) cash.location_fee = session.location_fee;
      if (session.bag !== null) cash.bag = session.bag;
      if (session.snack !== null) cash.snack = session.snack;
      if (session.other_amount !== null) {
        cash.other = session.other_amount;
        cash.other_note = session.other_note;
      }
      if (session.actual_cash !== null) cash.actual_cash_submitted = session.actual_cash;
    }
    session.status = "closed";
    session.closed_at = new Date().toISOString();
    session.closed_by_line_user_id = args.p_closed_by_line_user_id;
    session.closed_line_event_id = args.p_closed_line_event_id;
    return { data: { outcome: "closed", session, cash_entry: cash }, error: null };
  }

  function nullStub() {
    const noop: unknown = new Proxy({}, { get: () => noop });
    return {
      select() { return { eq() { return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } }; } }; },
      insert() { return { select() { return { single() { return Promise.resolve({ data: { id: "noop" }, error: null }); } }; } }; },
      update() { return noop; },
    };
  }

  return {
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert(payload: Row) {
            return {
              select() {
                return {
                  single() {
                    const eventId = payload.line_event_id as string;
                    if (rawEventIds.has(eventId)) {
                      return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
                    }
                    rawEventIds.add(eventId);
                    return Promise.resolve({ data: { id: `raw-${++idSeq}` }, error: null });
                  },
                };
              },
            };
          },
        };
      }
      if (table === "manual_white_sheet_note_sessions") return noteStub();
      if (table === "pending_sessions") {
        return { select() { return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } }; } };
      }
      return nullStub();
    },
    rpc,
    _notes: notes,
    _cashEntries: cashEntries,
    get _updateCount() { return updateCount; },
    forceNextOpenLookupError() { forceOpenLookupError = true; },
    forceNextUpdateMiss() { forceNextUpdateMiss = true; },
  };
}

function makeService(db: ReturnType<typeof makeSupabase>, replies: string[] = []) {
  return new WebhookService(db as unknown as SupabaseClient<Database>, {
    replyMessage: async (_tok, text) => { replies.push(text); },
    scheduleBackgroundTask: () => {},
  });
}

// ── Open ──────────────────────────────────────────────────────────────────────

describe("white sheet note session — open", () => {
  it("opens a session", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    const [res] = await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569")], "dest");

    expect(res.status).toBe("saved");
    expect(db._notes).toHaveLength(1);
    expect(db._notes[0].status).toBe("open");
    expect(db._notes[0].market_label).toBe("พาชิโอ้");
    expect(db._notes[0].business_date).toBe("2026-08-01");
    expect(replies[0]).toMatch(/เปิดใบขาวมือแล้ว/);
  });

  it("resuming the same market/date shows current values instead of creating a duplicate", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok3", "msg3")], "dest");

    expect(db._notes).toHaveLength(1);
  });

  it("resume reply is exact — never claims closed or saved", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok3", "msg3")], "dest");

    expect(replies[2]).toBe(
      [
        "ใบขาวมือยังเปิดอยู่",
        "",
        "ตลาด: พาชิโอ้",
        "วันที่: 01/08/2569",
        "ค่าแรง: 500 บาท",
        "",
        "ส่งข้อมูลต่อได้เลย",
        "พิมพ์ จบใบขาวมือ เมื่อกรอกครบ",
      ].join("\n"),
    );
    expect(replies[2]).not.toContain("จบใบขาวมือแล้ว");
    expect(replies[2]).not.toContain("บันทึกข้อมูลใบขาวแล้ว");
  });

  it("opening a different market/date while one is open is blocked", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ตลาดใหม่ ส่งใบขาวมือ 02/08/2569", "tok2", "msg2")], "dest");

    expect(db._notes).toHaveLength(1);
    expect(replies[1]).toMatch(/พาชิโอ้/);
    expect(replies[1]).toMatch(/ยังไม่จบ/);
  });
});

// ── Fields ────────────────────────────────────────────────────────────────────

describe("white sheet note session — fields", () => {
  it("a field-shaped message with no open session falls through unchanged (no reply)", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    const [res] = await svc.processEvents([makeEvent("ค่าแรง 500")], "dest");

    expect(res.status).toBe("saved");
    expect(db._notes).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it("the same field-shaped message while a session IS open is captured", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");

    expect(db._notes[0].labor).toBe(500);
    expect(replies[1]).toMatch(/ค่าแรง/);
    expect(replies[1]).toMatch(/500/);
  });

  it("repeated field replaces the previous value", async () => {
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 700", "tok3", "msg3")], "dest");

    expect(db._notes[0].labor).toBe(700);
  });

  it("ค่าอื่น stores amount + note", async () => {
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าอื่น 30 ค่าน้ำ", "tok2", "msg2")], "dest");

    expect(db._notes[0].other_amount).toBe(30);
    expect(db._notes[0].other_note).toBe("ค่าน้ำ");
  });

  it("invalid field message makes zero mutation", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง abc", "tok2", "msg2")], "dest");

    expect(db._notes[0].labor).toBeNull();
    expect(replies[1]).toMatch(/ไม่ถูกต้อง/);
  });

  it("multi-line two fields apply atomically with one reply", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าที่ 200\nค่าถุง 100", "tok2", "msg2")], "dest");

    expect(db._notes[0].location_fee).toBe(200);
    expect(db._notes[0].bag).toBe(100);
    expect(db._updateCount).toBe(1);
    expect(replies[1]).toBe(
      ["บันทึกแล้ว:", "- ค่าที่ 200 บาท", "- ค่าถุง 100 บาท"].join("\n"),
    );
  });

  it("multi-line three fields including ค่าอื่น note", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าขนม 50\nค่าอื่น 30 ค่าน้ำ\nเงินสด 4850", "tok2", "msg2")], "dest");

    expect(db._notes[0].snack).toBe(50);
    expect(db._notes[0].other_amount).toBe(30);
    expect(db._notes[0].other_note).toBe("ค่าน้ำ");
    expect(db._notes[0].actual_cash).toBe(4850);
    expect(db._updateCount).toBe(1);
    expect(replies[1]).toBe(
      ["บันทึกแล้ว:", "- ค่าขนม 50 บาท", "- ค่าอื่น 30 บาท — ค่าน้ำ", "- เงินสด 4,850 บาท"].join("\n"),
    );
  });

  it("mixed valid + invalid multi-line makes zero mutation", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500\nค่าที่ abc", "tok2", "msg2")], "dest");

    expect(db._notes[0].labor).toBeNull();
    expect(db._notes[0].location_fee).toBeNull();
    expect(db._updateCount).toBe(0);
    expect(replies[1]).toMatch(/ไม่ถูกต้อง/);
  });

  it("unrelated multi-line text falls through unchanged", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("สวัสดีครับ\nวันนี้อากาศดี", "tok2", "msg2")], "dest");

    expect(db._notes[0].labor).toBeNull();
    expect(db._updateCount).toBe(0);
    // only the opener reply
    expect(replies).toHaveLength(1);
  });

  it("multi-line repeated field — last wins in one update", async () => {
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500\nค่าแรง 0", "tok2", "msg2")], "dest");

    expect(db._notes[0].labor).toBe(0);
    expect(db._updateCount).toBe(1);
  });

  it("exact local UAT original multi-line scenario closes with full canonical values", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("ตลาดทดสอบ ส่งใบขาวมือ 31/12/2599", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("ค่าที่ 200\nค่าถุง 100", "tok3", "msg3")], "dest");
    await svc.processEvents([makeEvent("ค่าขนม 50\nค่าอื่น 30 ค่าน้ำ\nเงินสด 4850", "tok4", "msg4")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok5", "msg5")], "dest");

    expect(db._notes).toHaveLength(1);
    expect(db._notes[0].status).toBe("closed");
    expect(db._cashEntries).toHaveLength(1);
    const cash = db._cashEntries[0];
    expect(cash.labor).toBe(500);
    expect(cash.location_fee).toBe(200);
    expect(cash.bag).toBe(100);
    expect(cash.snack).toBe(50);
    expect(cash.other).toBe(30);
    expect(cash.other_note).toBe("ค่าน้ำ");
    expect(cash.actual_cash_submitted).toBe(4850);
    expect(cash.business_date).toBe("2056-12-31");
    expect(replies[2]).toBe(
      ["บันทึกแล้ว:", "- ค่าที่ 200 บาท", "- ค่าถุง 100 บาท"].join("\n"),
    );
    expect(replies[3]).toBe(
      ["บันทึกแล้ว:", "- ค่าขนม 50 บาท", "- ค่าอื่น 30 บาท — ค่าน้ำ", "- เงินสด 4,850 บาท"].join("\n"),
    );
  });

  it("close race on multi-line apply returns conflict — no false success reply", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    // Lookup still sees open; conditional UPDATE matches zero rows (close won).
    db.forceNextUpdateMiss();

    await svc.processEvents([makeEvent("ค่าที่ 200\nค่าถุง 100", "tok2", "msg2")], "dest");

    expect(db._notes[0].location_fee ?? null).toBeNull();
    expect(db._notes[0].bag ?? null).toBeNull();
    expect(db._notes[0].status).toBe("closed");
    expect(replies[1]).not.toMatch(/บันทึกแล้ว/);
    expect(replies[1]).toBe("ใบขาวมือนี้ปิดแล้ว");
  });

  // A field message that races a concurrent close (both read the row while
  // still open, close wins the row lock first) cannot be reproduced through
  // this sequential single-connection harness — findOpenSession here would
  // simply see the already-closed row and fall through. That exact race
  // (field's UPDATE matching zero rows because close already committed) is
  // proven at the service layer in white-sheet-note-session-service.test.ts
  // ("returns a typed conflict when the session is no longer open") and with
  // real concurrent connections in migration-0059.pg.test.ts.
});

// ── Close ─────────────────────────────────────────────────────────────────────

describe("white sheet note session — close", () => {
  it("requires at least one entered value", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok2", "msg2")], "dest");

    expect(db._notes[0].status).toBe("open");
    expect(replies[1]).toMatch(/อย่างน้อย 1 รายการ/);
  });

  it("closes, writes one canonical row, and replies with the stored summary — matches the example format", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("ค่าที่ 200", "tok3", "msg3")], "dest");
    await svc.processEvents([makeEvent("ค่าถุง 100", "tok4", "msg4")], "dest");
    await svc.processEvents([makeEvent("ค่าขนม 50", "tok5", "msg5")], "dest");
    await svc.processEvents([makeEvent("ค่าอื่น 30 ค่าน้ำ", "tok6", "msg6")], "dest");
    await svc.processEvents([makeEvent("เงินสด 4850", "tok7", "msg7")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok8", "msg8")], "dest");

    expect(db._notes[0].status).toBe("closed");
    expect(db._cashEntries).toHaveLength(1);
    expect(db._cashEntries[0].source_id).toBe("u1");
    expect(db._cashEntries[0].market_label_normalized).toBe("พาชิโอ้");
    expect(db._cashEntries[0].business_date).toBe("2026-08-01");
    expect(db._cashEntries[0].labor).toBe(500);
    expect(db._cashEntries[0].location_fee).toBe(200);
    expect(db._cashEntries[0].bag).toBe(100);
    expect(db._cashEntries[0].snack).toBe(50);
    expect(db._cashEntries[0].other).toBe(30);
    expect(db._cashEntries[0].other_note).toBe("ค่าน้ำ");
    expect(db._cashEntries[0].actual_cash_submitted).toBe(4850);

    const summary = replies[replies.length - 1];
    expect(summary).toContain("จบใบขาวมือแล้ว");
    expect(summary).toContain("ตลาด: พาชิโอ้");
    expect(summary).toContain("วันที่: 01/08/2569");
    expect(summary).toContain("ค่าแรง: 500 บาท");
    expect(summary).toContain("ค่าที่: 200 บาท");
    expect(summary).toContain("ค่าถุง: 100 บาท");
    expect(summary).toContain("ค่าขนม: 50 บาท");
    expect(summary).toContain("ค่าอื่น: 30 บาท — ค่าน้ำ");
    expect(summary).toContain("เงินสด: 4,850 บาท");
    expect(summary).toContain("บันทึกข้อมูลใบขาวแล้ว");
    expect(summary).not.toMatch(/ยอดขาย|สลิป|ยอดโอน|ผลต่าง|ตรงกัน|ปิดวัน/);
  });

  it("same identity on a later close updates the existing row instead of creating a duplicate", async () => {
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("เงินสด 4850", "tok3", "msg3")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok4", "msg4")], "dest");

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok5", "msg5")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 900", "tok6", "msg6")], "dest");
    await svc.processEvents([makeEvent("เงินสด 5000", "tok7", "msg7")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok8", "msg8")], "dest");

    expect(db._cashEntries).toHaveLength(1);
    expect(db._cashEntries[0].labor).toBe(900);
    expect(db._cashEntries[0].actual_cash_submitted).toBe(5000);
  });

  it("explicit zero updates the canonical field; untouched fields preserve the latest DB value", async () => {
    const db = makeSupabase([
      {
        source_id: "u1",
        market_label_normalized: "พาชิโอ้",
        business_date: "2026-08-01",
        labor: 999, location_fee: 200, bag: 100, snack: 50, other: 30, other_note: "เดิม",
        actual_cash_submitted: 4850,
        finalized_at: null,
      },
    ]);
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 0", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok3", "msg3")], "dest");

    expect(db._cashEntries).toHaveLength(1);
    expect(db._cashEntries[0].labor).toBe(0);
    expect(db._cashEntries[0].location_fee).toBe(200);
    expect(db._cashEntries[0].actual_cash_submitted).toBe(4850);
  });

  it("a FINALIZED canonical row rejects the close transaction and leaves the LINE session open", async () => {
    const db = makeSupabase([
      {
        source_id: "u1",
        market_label_normalized: "พาชิโอ้",
        business_date: "2026-08-01",
        labor: 500, location_fee: 200, bag: 100, snack: 50, other: 30, other_note: null,
        actual_cash_submitted: 4850,
        finalized_at: "2026-07-31T00:00:00.000Z",
      },
    ]);
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 700", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok3", "msg3")], "dest");

    expect(db._notes[0].status).toBe("open");
    expect(db._cashEntries[0].labor).toBe(500);
    expect(replies[replies.length - 1]).toBe(
      "ใบขาวมือนี้ถูกปิดสรุปแล้ว (FINALIZED) แก้ไขผ่านข้อความไม่ได้ กรุณาติดต่อผู้ดูแลระบบ",
    );
  });

  it("a cancelled session writes no canonical row", async () => {
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ", "tok3", "msg3")], "dest");

    expect(db._cashEntries).toHaveLength(0);
  });

  it("close requires no produce, slip, or settlement data to exist", async () => {
    // nullStub() fallback returns empty/null for every other table
    // (produce_sessions, manual_slip_sessions, transfer_reconciliations,
    // settlement, etc.) — closing must still succeed with zero coupling.
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("เงินสด 100", "tok2", "msg2")], "dest");
    const [res] = await svc.processEvents([makeEvent("จบใบขาวมือ", "tok3", "msg3")], "dest");

    expect(res.status).toBe("saved");
    expect(db._cashEntries).toHaveLength(1);
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────────

describe("white sheet note session — cancel", () => {
  it("cancels an open session and writes nothing elsewhere", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ", "tok2", "msg2")], "dest");

    expect(db._notes[0].status).toBe("cancelled");
    expect(replies[1]).toMatch(/ยกเลิกใบขาวมือแล้ว/);
  });

  it("a cancelled session may be reopened cleanly", async () => {
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok3", "msg3")], "dest");

    expect(db._notes).toHaveLength(2);
    expect(db._notes[1].status).toBe("open");
  });

  it("cancelling an already-closed session reports accurately and mutates nothing", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("เงินสด 100", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok3", "msg3")], "dest");
    await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ", "tok4", "msg4")], "dest");

    expect(replies[replies.length - 1]).toBe("ใบขาวมือนี้ปิดแล้ว");
    expect(db._notes[0].status).toBe("closed");
  });
});

// ── Repeated close/cancel with no open session ──────────────────────────────

describe("white sheet note session — repeated close/cancel", () => {
  it("closing with no history ever replies with 'no open session'", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    expect(db._notes).toHaveLength(0);
    expect(db._cashEntries).toHaveLength(0);
    expect(replies[0]).toBe("ยังไม่มีใบขาวมือที่เปิดอยู่");
  });

  it("closing again after already closed replies 'already closed'", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("เงินสด 100", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok3", "msg3")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok4", "msg4")], "dest");

    expect(replies[replies.length - 1]).toBe("ใบขาวมือนี้ปิดแล้ว");
    expect(db._cashEntries).toHaveLength(1); // no rewrite of canonical data
  });

  it("closing after cancel replies 'already cancelled'", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok3", "msg3")], "dest");

    expect(replies[replies.length - 1]).toBe("ใบขาวมือนี้ยกเลิกแล้ว");
    expect(db._cashEntries).toHaveLength(0);
  });
});

// ── Lookup errors ────────────────────────────────────────────────────────────

describe("white sheet note session — lookup failure", () => {
  it("does not fall through to any other routing and mutates nothing downstream", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);
    db.forceNextOpenLookupError();

    // "ค่าแรง 500" is field-shaped; on a healthy lookup with no open session
    // it falls through silently. On a lookup FAILURE it must instead report
    // an error and must never reach produce/manual-slip/other routing.
    const [res] = await svc.processEvents([makeEvent("ค่าแรง 500")], "dest");

    expect(res.status).toBe("error");
    expect(db._notes).toHaveLength(0);
    expect(db._cashEntries).toHaveLength(0);
  });
});

// ── Dedup ─────────────────────────────────────────────────────────────────────

describe("white sheet note session — duplicate LINE events", () => {
  it("a redelivered field message does not apply twice", async () => {
    const db = makeSupabase();
    const svc = makeService(db);
    const event = makeEvent("ค่าแรง 500", "tok2", "msg2");

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    const [first] = await svc.processEvents([event], "dest");
    const [dup] = await svc.processEvents([event], "dest");

    expect(first.status).toBe("saved");
    expect(dup.status).toBe("duplicate");
    expect(db._notes[0].labor).toBe(500);
  });
});
