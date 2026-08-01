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

function makeSupabase(seedCashEntries: Row[] = []) {
  const notes: Row[] = [];
  const cashEntries: Row[] = [...seedCashEntries];
  const rawEventIds = new Set<string>();
  let idSeq = 0;

  // Mirrors the exact query chains used by src/lib/white-sheet/persist.ts.
  function cashEntryStub() {
    function filterChain(filtered: Row[]) {
      return {
        eq(col: string, val: unknown) { return filterChain(filtered.filter((r) => r[col] === val)); },
        async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
      };
    }
    return {
      select(_cols = "*") { return filterChain(cashEntries); },
      insert(payload: Row) {
        return {
          select(_cols = "*") {
            return {
              async single() {
                const row: Row = { id: `cash-${++idSeq}`, finalized_at: null, finalized_by: null, ...payload };
                cashEntries.push(row);
                return { data: row, error: null };
              },
            };
          },
        };
      },
      update(patch: Row) {
        return {
          eq(col: string, val: unknown) {
            return {
              is(col2: string, val2: unknown) {
                const matched = cashEntries.filter(
                  (r) => r[col] === val && (val2 === null ? r[col2] === null : r[col2] === val2),
                );
                return {
                  select(_cols = "*") {
                    return {
                      async maybeSingle() {
                        if (matched.length === 0) return { data: null, error: null };
                        Object.assign(matched[0], patch);
                        return { data: matched[0], error: null };
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
      if (table === "digital_white_sheet_cash_entries") return cashEntryStub();
      if (table === "pending_sessions") {
        return { select() { return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } }; } };
      }
      return nullStub();
    },
    _notes: notes,
    _cashEntries: cashEntries,
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
    // no operational/production-derived content leaks into the receipt
    expect(summary).not.toMatch(/ยอดขาย|สลิป|ยอดโอน|ผลต่าง|ตรงกัน|ปิดวัน/);
  });

  it("same identity on a later close updates the existing row instead of creating a duplicate", async () => {
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("เงินสด 4850", "tok3", "msg3")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok4", "msg4")], "dest");

    // reopen the same market/date and close again with a different labor value
    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok5", "msg5")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 900", "tok6", "msg6")], "dest");
    await svc.processEvents([makeEvent("เงินสด 5000", "tok7", "msg7")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok8", "msg8")], "dest");

    expect(db._cashEntries).toHaveLength(1);
    expect(db._cashEntries[0].labor).toBe(900);
    expect(db._cashEntries[0].actual_cash_submitted).toBe(5000);
  });

  it("explicit zero updates the canonical field correctly", async () => {
    const db = makeSupabase([
      {
        id: "cash-seed",
        source_id: "u1",
        market_label_normalized: "พาชิโอ้",
        business_date: "2026-08-01",
        labor: 999, location_fee: 200, bag: 100, snack: 50, other: 30, other_note: "เดิม",
        actual_cash_submitted: 4850,
        finalized_at: null, finalized_by: null,
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    ]);
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 0", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok3", "msg3")], "dest");

    expect(db._cashEntries).toHaveLength(1);
    expect(db._cashEntries[0].labor).toBe(0);
    // fields not touched this session keep their existing canonical values
    expect(db._cashEntries[0].location_fee).toBe(200);
    expect(db._cashEntries[0].actual_cash_submitted).toBe(4850);
  });

  it("a FINALIZED canonical row rejects the update and leaves the LINE session open", async () => {
    const db = makeSupabase([
      {
        id: "cash-final",
        source_id: "u1",
        market_label_normalized: "พาชิโอ้",
        business_date: "2026-08-01",
        labor: 500, location_fee: 200, bag: 100, snack: 50, other: 30, other_note: null,
        actual_cash_submitted: 4850,
        finalized_at: "2026-07-31T00:00:00.000Z", finalized_by: "admin-1",
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    ]);
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 700", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("จบใบขาวมือ", "tok3", "msg3")], "dest");

    expect(db._notes[0].status).toBe("open"); // session left open, not closed
    expect(db._cashEntries[0].labor).toBe(500); // canonical row untouched
    expect(replies[replies.length - 1]).toMatch(/finalized/i);
  });

  it("a cancelled session writes no canonical row", async () => {
    const db = makeSupabase();
    const svc = makeService(db);

    await svc.processEvents([makeEvent("พาชิโอ้ ส่งใบขาวมือ 01/08/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("ค่าแรง 500", "tok2", "msg2")], "dest");
    await svc.processEvents([makeEvent("ยกเลิกใบขาวมือ", "tok3", "msg3")], "dest");

    expect(db._cashEntries).toHaveLength(0);
  });

  it("closing with no open session replies clearly and mutates nothing", async () => {
    const db = makeSupabase();
    const replies: string[] = [];
    const svc = makeService(db, replies);

    await svc.processEvents([makeEvent("จบใบขาวมือ")], "dest");

    expect(db._notes).toHaveLength(0);
    expect(db._cashEntries).toHaveLength(0);
    expect(replies[0]).toMatch(/ยังไม่มีใบขาวมือ/);
  });

  it("close requires no produce, slip, or settlement data to exist", async () => {
    // The stub's nullStub() fallback returns empty/null for every other
    // table (produce_sessions, manual_slip_sessions, transfer_reconciliations,
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
