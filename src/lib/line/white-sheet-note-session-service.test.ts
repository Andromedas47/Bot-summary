import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  WhiteSheetNoteSessionService,
  WhiteSheetNoteSessionLookupError,
} from "./white-sheet-note-session-service";

type Supabase = SupabaseClient<Database>;

// ── In-memory Supabase stub ───────────────────────────────────────────────────
// rpc("close_manual_white_sheet_note_session", ...) mirrors the plpgsql RPC's
// outcome logic against the in-memory sessions/cashEntries arrays, so these
// are unit tests of the TS wrapper — the real transactional/locking behavior
// is proven separately in a real-PostgreSQL test.

type Row = Record<string, unknown>;

function makeDb(initial: Row[] = [], initialCashEntries: Row[] = []) {
  const rows: Row[] = [...initial];
  const cashEntries: Row[] = [...initialCashEntries];
  let idSeq = 0;
  let conflictWinner: Row | null = null;

  function queryChain(filtered: Row[]) {
    return {
      eq(col: string, val: unknown) { return queryChain(filtered.filter((r) => r[col] === val)); },
      order(_col: string, _opts?: unknown) { return queryChain(filtered); },
      limit(_n: number) { return queryChain(filtered); },
      async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
    };
  }

  function table() {
    return {
      select(_cols = "*") { return queryChain(rows); },
      insert(payload: Row) {
        return {
          select() {
            return {
              async single() {
                if (conflictWinner) {
                  rows.push(conflictWinner);
                  conflictWinner = null;
                  return { data: null, error: { code: "23505", message: "duplicate key" } };
                }
                const row: Row = {
                  id: `note-${++idSeq}`,
                  status: "open",
                  labor: null,
                  location_fee: null,
                  bag: null,
                  snack: null,
                  other_amount: null,
                  other_note: null,
                  actual_cash: null,
                  closed_at: null,
                  closed_by_line_user_id: null,
                  closed_line_event_id: null,
                  ...payload,
                };
                rows.push(row);
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
              eq(col2: string, val2: unknown) {
                return {
                  eq(col3: string, val3: unknown) {
                    return {
                      select() {
                        return {
                          async maybeSingle() {
                            const idx = rows.findIndex(
                              (r) => r[col] === val && r[col2] === val2 && r[col3] === val3,
                            );
                            if (idx === -1) return { data: null, error: null };
                            Object.assign(rows[idx], patch);
                            return { data: rows[idx], error: null };
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
    const session = rows.find((r) => r.id === args.p_session_id && r.source_id === args.p_source_id);
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

  return {
    rows,
    cashEntries,
    /** Next insert() fails with 23505; `winner` becomes visible only afterward. */
    forceNextInsertConflict(winner: Row) { conflictWinner = winner; },
    supabase: {
      from(_table: string) { return table(); },
      rpc,
    } as unknown as Supabase,
  };
}

describe("WhiteSheetNoteSessionService.openSession", () => {
  it("opens a new session when none is open", async () => {
    const { supabase } = makeDb();
    const svc = new WhiteSheetNoteSessionService(supabase);
    const result = await svc.openSession({
      sourceId: "src-1",
      marketLabel: "พาชิโอ้",
      marketLabelNormalized: "พาชิโอ้",
      businessDate: "2026-08-01",
      lineUserId: "u1",
      lineEventId: "ev1",
    });
    expect(result.opened).toBe(true);
    expect(result.session.status).toBe("open");
    expect(result.session.market_label).toBe("พาชิโอ้");
  });

  it("returns the existing open session instead of creating a duplicate", async () => {
    const { supabase } = makeDb([
      { id: "existing", source_id: "src-1", status: "open", market_label: "ตลาดเดิม", business_date: "2026-08-01" },
    ]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    const result = await svc.openSession({
      sourceId: "src-1",
      marketLabel: "ตลาดใหม่",
      marketLabelNormalized: "ตลาดใหม่",
      businessDate: "2026-08-02",
      lineUserId: "u1",
      lineEventId: "ev2",
    });
    expect(result.opened).toBe(false);
    expect(result.session.id).toBe("existing");
  });

  it("recovers from a concurrent-open unique-violation by returning the winner", async () => {
    // Simulates: this caller's own findOpenSession read raced and saw
    // nothing, but by the time it inserts, another caller has already won
    // (the partial one-open-per-source unique index rejects the insert).
    const db = makeDb();
    db.forceNextInsertConflict({
      id: "winner", source_id: "src-1", status: "open", market_label: "ผู้ชนะ", business_date: "2026-08-01",
    });
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.openSession({
      sourceId: "src-1",
      marketLabel: "ตลาดใหม่",
      marketLabelNormalized: "ตลาดใหม่",
      businessDate: "2026-08-02",
      lineUserId: "u1",
      lineEventId: "ev1",
    });
    expect(result.opened).toBe(false);
    expect(result.session.id).toBe("winner");
  });
});

describe("WhiteSheetNoteSessionService.applyField", () => {
  it("sets a field on the open session", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "open", labor: null }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.applyField(
      { id: "s1", source_id: "src-1", status: "open" } as never,
      { key: "labor", amount: 500, note: null },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.session.labor).toBe(500);
  });

  it("replaces a previously set value", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "open", labor: 500 }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.applyField(
      { id: "s1", source_id: "src-1", status: "open" } as never,
      { key: "labor", amount: 700, note: null },
    );
    expect(result.ok && result.session.labor).toBe(700);
  });

  it("accepts explicit zero", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "open", labor: 500 }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.applyField(
      { id: "s1", source_id: "src-1", status: "open" } as never,
      { key: "labor", amount: 0, note: null },
    );
    expect(result.ok && result.session.labor).toBe(0);
  });

  it("stores other_amount + other_note together", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "open" }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.applyField(
      { id: "s1", source_id: "src-1", status: "open" } as never,
      { key: "other", amount: 30, note: "ค่าน้ำ" },
    );
    expect(result.ok && result.session.other_amount).toBe(30);
    expect(result.ok && result.session.other_note).toBe("ค่าน้ำ");
  });

  it("returns a typed conflict when the session is no longer open", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "closed" }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.applyField(
      { id: "s1", source_id: "src-1", status: "open" } as never,
      { key: "labor", amount: 500, note: null },
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });
});

describe("WhiteSheetNoteSessionService.hasAnyValue", () => {
  const svc = new WhiteSheetNoteSessionService({} as unknown as Supabase);
  it("false when nothing entered", () => {
    expect(svc.hasAnyValue({
      labor: null, location_fee: null, bag: null, snack: null, other_amount: null, actual_cash: null,
    } as never)).toBe(false);
  });
  it("true when one field entered", () => {
    expect(svc.hasAnyValue({
      labor: 0, location_fee: null, bag: null, snack: null, other_amount: null, actual_cash: null,
    } as never)).toBe(true);
  });
});

describe("WhiteSheetNoteSessionService.closeSession", () => {
  it("closes, writes a canonical row, and stores closer identity", async () => {
    const db = makeDb([{
      id: "s1", source_id: "src-1", status: "open",
      market_label_normalized: "พาชิโอ้", business_date: "2026-08-01",
      labor: 500, location_fee: null, bag: null, snack: null, other_amount: null, actual_cash: 4850,
    }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.closeSession(
      { id: "s1", source_id: "src-1" } as never,
      { lineUserId: "u2", lineEventId: "ev-close" },
    );
    expect(result.outcome).toBe("closed");
    if (result.outcome !== "closed") throw new Error("unreachable");
    expect(result.session.status).toBe("closed");
    expect(result.session.closed_by_line_user_id).toBe("u2");
    expect(result.session.closed_line_event_id).toBe("ev-close");
    expect(result.cashEntry.labor).toBe(500);
    expect(result.cashEntry.actual_cash_submitted).toBe(4850);
    expect(db.cashEntries).toHaveLength(1);
  });

  it("empty session is rejected without mutation", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "open" }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.closeSession(
      { id: "s1", source_id: "src-1" } as never,
      { lineUserId: null, lineEventId: "ev-close" },
    );
    expect(result.outcome).toBe("empty");
    expect(db.rows[0]!.status).toBe("open");
  });

  it("a FINALIZED canonical row is rejected and the session stays open", async () => {
    const db = makeDb(
      [{
        id: "s1", source_id: "src-1", status: "open",
        market_label_normalized: "พาชิโอ้", business_date: "2026-08-01",
        labor: 500, location_fee: null, bag: null, snack: null, other_amount: null, actual_cash: null,
      }],
      [{
        source_id: "src-1", market_label_normalized: "พาชิโอ้", business_date: "2026-08-01",
        finalized_at: "2026-07-31T00:00:00.000Z",
      }],
    );
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.closeSession(
      { id: "s1", source_id: "src-1" } as never,
      { lineUserId: null, lineEventId: "ev-close" },
    );
    expect(result.outcome).toBe("finalized");
    expect(db.rows[0]!.status).toBe("open");
  });

  it("already-closed / already-cancelled report accurately", async () => {
    const closedDb = makeDb([{ id: "s1", source_id: "src-1", status: "closed" }]);
    const closedSvc = new WhiteSheetNoteSessionService(closedDb.supabase);
    expect((await closedSvc.closeSession({ id: "s1", source_id: "src-1" } as never, { lineUserId: null, lineEventId: "e" })).outcome)
      .toBe("already_closed");

    const cancelledDb = makeDb([{ id: "s1", source_id: "src-1", status: "cancelled" }]);
    const cancelledSvc = new WhiteSheetNoteSessionService(cancelledDb.supabase);
    expect((await cancelledSvc.closeSession({ id: "s1", source_id: "src-1" } as never, { lineUserId: null, lineEventId: "e" })).outcome)
      .toBe("already_cancelled");
  });
});

describe("WhiteSheetNoteSessionService.cancelSession", () => {
  it("marks status cancelled", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "open" }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.cancelSession(
      { id: "s1", source_id: "src-1", status: "open" } as never,
      { lineUserId: "u2", lineEventId: "ev-cancel" },
    );
    expect(result.ok && result.session.status).toBe("cancelled");
  });

  it("returns a typed conflict when the session is no longer open", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "closed" }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const result = await svc.cancelSession(
      { id: "s1", source_id: "src-1", status: "open" } as never,
      { lineUserId: "u2", lineEventId: "ev-cancel" },
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
  });
});

describe("WhiteSheetNoteSessionService.findOpenSession", () => {
  it("returns null when no open session for this source", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "closed" }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    expect(await svc.findOpenSession("src-1")).toBeNull();
  });

  it("returns the open session for this source", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "open" }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const found = await svc.findOpenSession("src-1");
    expect(found?.id).toBe("s1");
  });

  it("throws WhiteSheetNoteSessionLookupError on a query failure", async () => {
    const svc = new WhiteSheetNoteSessionService({
      from() {
        return { select() { return { eq() { return { eq() { return { async maybeSingle() { return { data: null, error: { message: "connection reset" } }; } }; } }; } }; } };
      },
    } as unknown as Supabase);
    await expect(svc.findOpenSession("src-1")).rejects.toBeInstanceOf(WhiteSheetNoteSessionLookupError);
  });
});

describe("WhiteSheetNoteSessionService.findLatestSessionForSource", () => {
  it("returns null when the source has no history", async () => {
    const db = makeDb();
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    expect(await svc.findLatestSessionForSource("src-1")).toBeNull();
  });

  it("returns the most recent session", async () => {
    const db = makeDb([{ id: "s1", source_id: "src-1", status: "closed" }]);
    const svc = new WhiteSheetNoteSessionService(db.supabase);
    const found = await svc.findLatestSessionForSource("src-1");
    expect(found?.id).toBe("s1");
  });
});
