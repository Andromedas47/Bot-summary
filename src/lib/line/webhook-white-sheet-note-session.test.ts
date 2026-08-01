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

function makeSupabase() {
  const notes: Row[] = [];
  const rawEventIds = new Set<string>();
  let idSeq = 0;

  function noteStub() {
    function queryChain(filtered: Row[]) {
      return {
        eq(col: string, val: unknown) { return queryChain(filtered.filter((r) => r[col] === val)); },
        async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
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
                  select() {
                    return {
                      async maybeSingle() {
                        const idx = notes.findIndex((r) => r[col] === val && r[col2] === val2);
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
    _notes: notes,
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
    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok2", "msg2")], "dest");

    expect(db._notes).toHaveLength(1);
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

  it("closes and replies with the stored summary — matches the example format", async () => {
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
    expect(summary).toContain("ยังไม่ได้ตรวจเทียบกับรายการสินค้า สลิป หรือยอดโอน");
  });

  it("closing with no open session replies clearly and mutates nothing", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    expect(db._notes).toHaveLength(0);
    expect(replies[0]).toMatch(/ยังไม่มีใบขาวมือ/);
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
