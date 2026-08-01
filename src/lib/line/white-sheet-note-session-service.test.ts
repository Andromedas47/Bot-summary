import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { WhiteSheetNoteSessionService } from "./white-sheet-note-session-service";

type Supabase = SupabaseClient<Database>;

// ── In-memory Supabase stub ───────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeDb(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let idSeq = 0;

  function queryChain(filtered: Row[]) {
    return {
      eq(col: string, val: unknown) { return queryChain(filtered.filter((r) => r[col] === val)); },
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
                  select() {
                    return {
                      async maybeSingle() {
                        const idx = rows.findIndex((r) => r[col] === val && r[col2] === val2);
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
  }

  return {
    rows,
    supabase: {
      from(_table: string) { return table(); },
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
});

describe("WhiteSheetNoteSessionService.applyField", () => {
  it("sets a field on the open session", async () => {
    const { supabase } = makeDb([{ id: "s1", status: "open", labor: null }]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    const updated = await svc.applyField(
      { id: "s1", status: "open" } as never,
      { key: "labor", amount: 500, note: null },
    );
    expect(updated.labor).toBe(500);
  });

  it("replaces a previously set value", async () => {
    const { supabase } = makeDb([{ id: "s1", status: "open", labor: 500 }]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    const updated = await svc.applyField(
      { id: "s1", status: "open" } as never,
      { key: "labor", amount: 700, note: null },
    );
    expect(updated.labor).toBe(700);
  });

  it("accepts explicit zero", async () => {
    const { supabase } = makeDb([{ id: "s1", status: "open", labor: 500 }]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    const updated = await svc.applyField(
      { id: "s1", status: "open" } as never,
      { key: "labor", amount: 0, note: null },
    );
    expect(updated.labor).toBe(0);
  });

  it("stores other_amount + other_note together", async () => {
    const { supabase } = makeDb([{ id: "s1", status: "open" }]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    const updated = await svc.applyField(
      { id: "s1", status: "open" } as never,
      { key: "other", amount: 30, note: "ค่าน้ำ" },
    );
    expect(updated.other_amount).toBe(30);
    expect(updated.other_note).toBe("ค่าน้ำ");
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

describe("WhiteSheetNoteSessionService.closeSession / cancelSession", () => {
  it("closeSession marks status closed and stores closer identity", async () => {
    const { supabase } = makeDb([{ id: "s1", status: "open" }]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    const closed = await svc.closeSession(
      { id: "s1", status: "open" } as never,
      { lineUserId: "u2", lineEventId: "ev-close" },
    );
    expect(closed.status).toBe("closed");
    expect(closed.closed_by_line_user_id).toBe("u2");
    expect(closed.closed_line_event_id).toBe("ev-close");
  });

  it("cancelSession marks status cancelled", async () => {
    const { supabase } = makeDb([{ id: "s1", status: "open" }]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    const cancelled = await svc.cancelSession(
      { id: "s1", status: "open" } as never,
      { lineUserId: "u2", lineEventId: "ev-cancel" },
    );
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("WhiteSheetNoteSessionService.findOpenSession", () => {
  it("returns null when no open session for this source", async () => {
    const { supabase } = makeDb([{ id: "s1", source_id: "src-1", status: "closed" }]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    expect(await svc.findOpenSession("src-1")).toBeNull();
  });

  it("returns the open session for this source", async () => {
    const { supabase } = makeDb([{ id: "s1", source_id: "src-1", status: "open" }]);
    const svc = new WhiteSheetNoteSessionService(supabase);
    const found = await svc.findOpenSession("src-1");
    expect(found?.id).toBe("s1");
  });
});
