import { describe, expect, it } from "bun:test";
import {
  buildWhiteSheetCloseCommandFromSession,
  WhiteSheetSessionService,
  type WhiteSheetSessionRow,
} from "./white-sheet-session-service";

// ── In-memory Supabase stub for manual_white_sheet_sessions ────────────────

type Row = Record<string, unknown>;

function makeDb(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let idSeq = 0;

  function matches(row: Row, filters: Array<{ op: "eq" | "in"; col: string; val: unknown }>) {
    return filters.every(({ op, col, val }) =>
      op === "eq" ? row[col] === val : (val as unknown[]).includes(row[col]),
    );
  }

  function selectChain(filters: Array<{ op: "eq" | "in"; col: string; val: unknown }> = []) {
    return {
      eq(col: string, val: unknown) {
        return selectChain([...filters, { op: "eq" as const, col, val }]);
      },
      in(col: string, val: unknown[]) {
        return selectChain([...filters, { op: "in" as const, col, val }]);
      },
      async maybeSingle() {
        const found = rows.find((r) => matches(r, filters));
        return { data: found ?? null, error: null };
      },
      async single() {
        const found = rows.find((r) => matches(r, filters));
        return { data: found ?? null, error: found ? null : { message: "not found" } };
      },
    };
  }

  function updateChain(patch: Row, filters: Array<{ op: "eq"; col: string; val: unknown }> = []) {
    return {
      eq(col: string, val: unknown) {
        return updateChain(patch, [...filters, { op: "eq" as const, col, val }]);
      },
      select() {
        return {
          async maybeSingle() {
            const idx = rows.findIndex((r) => matches(r, filters));
            if (idx === -1) return { data: null, error: null };
            Object.assign(rows[idx], patch);
            return { data: rows[idx], error: null };
          },
          async single() {
            const idx = rows.findIndex((r) => matches(r, filters));
            if (idx === -1) return { data: null, error: { message: "not found" } };
            Object.assign(rows[idx], patch);
            return { data: rows[idx], error: null };
          },
        };
      },
      async then(resolve: (v: unknown) => void) {
        const idx = rows.findIndex((r) => matches(r, filters));
        if (idx === -1) return resolve({ data: null, error: null });
        Object.assign(rows[idx], patch);
        return resolve({ data: rows[idx], error: null });
      },
    };
  }

  function stub() {
    return {
      select() {
        return selectChain();
      },
      insert(payload: Row) {
        return {
          select() {
            return {
              async single() {
                const identityConflict = rows.some(
                  (r) =>
                    r.source_id === payload.source_id &&
                    r.market_label_normalized === payload.market_label_normalized &&
                    r.business_date === payload.business_date,
                );
                const openConflict = rows.some(
                  (r) => r.source_id === payload.source_id && (r.status === "open" || r.status === "closing"),
                );
                if (identityConflict || openConflict) {
                  return { data: null, error: { code: "23505", message: "unique_violation" } };
                }
                const row: Row = {
                  id: `sess-${++idSeq}`,
                  opened_at: new Date().toISOString(),
                  status: "open",
                  labor: null,
                  location_fee: null,
                  bag: null,
                  snack: null,
                  other_amount: null,
                  other_note: null,
                  actual_cash_submitted: null,
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
        return updateChain(patch);
      },
    };
  }

  return {
    from(table: string) {
      if (table !== "manual_white_sheet_sessions") throw new Error(`unexpected table: ${table}`);
      return stub();
    },
    _rows: rows,
  };
}

function makeSvc(initial: Row[] = []) {
  const db = makeDb(initial);
  return { db, svc: new WhiteSheetSessionService(db as never) };
}

const SOURCE = "grp1";
const MARKET_NORM = "พาชิโอ้ผลไม้";
const DATE = "2026-07-31";

describe("WhiteSheetSessionService.openSession", () => {
  it("opens a new session", async () => {
    const { svc, db } = makeSvc();
    const res = await svc.openSession({
      sourceId: SOURCE,
      marketLabel: "พาชิโอ้ผลไม้",
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      businessDateDisplay: "31/07/2569",
      lineUserId: "u1",
      lineEventId: "evt1",
    });
    expect(res.opened).toBe(true);
    expect(db._rows).toHaveLength(1);
  });

  it("resumes the same source/market/date session", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      market_label: "พาชิโอ้ผลไม้",
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      business_date_display: "31/07/2569",
      status: "open",
      labor: 500,
      location_fee: null,
      bag: null,
      snack: null,
      other_amount: null,
      other_note: null,
      actual_cash_submitted: null,
    };
    const { svc } = makeSvc([existing]);
    const res = await svc.openSession({
      sourceId: SOURCE,
      marketLabel: "พาชิโอ้ผลไม้",
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      businessDateDisplay: "31/07/2569",
      lineUserId: "u1",
      lineEventId: "evt2",
    });
    expect(res.opened).toBe(false);
    if (res.opened) throw new Error("expected not opened");
    expect(res.reason).toBe("resumed");
    expect((res.session as WhiteSheetSessionRow).labor).toBe(500);
  });

  it("rejects opening a different market/date while one is open", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      market_label: "ตลาดเก่า",
      market_label_normalized: "ตลาดเก่า",
      business_date: "2026-07-30",
      business_date_display: "30/07/2569",
      status: "open",
    };
    const { svc } = makeSvc([existing]);
    const res = await svc.openSession({
      sourceId: SOURCE,
      marketLabel: "พาชิโอ้ผลไม้",
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      businessDateDisplay: "31/07/2569",
      lineUserId: "u1",
      lineEventId: "evt3",
    });
    expect(res.opened).toBe(false);
    if (res.opened) throw new Error("expected not opened");
    expect(res.reason).toBe("other_open");
  });

  it("blocks reopening a closed session on the same identity", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      market_label: "พาชิโอ้ผลไม้",
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      business_date_display: "31/07/2569",
      status: "closed",
    };
    const { svc } = makeSvc([existing]);
    const res = await svc.openSession({
      sourceId: SOURCE,
      marketLabel: "พาชิโอ้ผลไม้",
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      businessDateDisplay: "31/07/2569",
      lineUserId: "u1",
      lineEventId: "evt4",
    });
    expect(res.opened).toBe(false);
    if (res.opened) throw new Error("expected not opened");
    expect(res.reason).toBe("closed_exists");
  });

  it("allows a fresh open after cancellation, resetting entered values", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      market_label: "พาชิโอ้ผลไม้",
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      business_date_display: "31/07/2569",
      status: "cancelled",
      labor: 999,
    };
    const { svc } = makeSvc([existing]);
    const res = await svc.openSession({
      sourceId: SOURCE,
      marketLabel: "พาชิโอ้ผลไม้",
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      businessDateDisplay: "31/07/2569",
      lineUserId: "u1",
      lineEventId: "evt5",
    });
    expect(res.opened).toBe(true);
    if (!res.opened) throw new Error("expected opened");
    expect(res.session.status).toBe("open");
    expect(res.session.labor).toBeNull();
  });
});

describe("WhiteSheetSessionService.applyFields", () => {
  it("only updates provided fields, preserving the rest", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      status: "open",
      labor: 500,
      location_fee: null,
      bag: null,
      snack: null,
      other_amount: null,
      other_note: null,
      actual_cash_submitted: null,
    };
    const { svc, db } = makeSvc([existing]);
    await svc.applyFields("s1", {
      labor: undefined,
      locationFee: 200,
      bag: undefined,
      snack: undefined,
      other: undefined,
      actualCashSubmitted: undefined,
    });
    expect(db._rows[0].labor).toBe(500);
    expect(db._rows[0].location_fee).toBe(200);
  });

  it("replaces a repeated field with the latest value", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "open", labor: 500 };
    const { svc, db } = makeSvc([existing]);
    await svc.applyFields("s1", {
      labor: 700,
      locationFee: undefined,
      bag: undefined,
      snack: undefined,
      other: undefined,
      actualCashSubmitted: undefined,
    });
    expect(db._rows[0].labor).toBe(700);
  });

  it("ค่าอื่น 0 with no note clears an old note", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "open", other_amount: 30, other_note: "เก่า" };
    const { svc, db } = makeSvc([existing]);
    await svc.applyFields("s1", {
      labor: undefined,
      locationFee: undefined,
      bag: undefined,
      snack: undefined,
      other: { amount: 0, note: null },
      actualCashSubmitted: undefined,
    });
    expect(db._rows[0].other_amount).toBe(0);
    expect(db._rows[0].other_note).toBeNull();
  });
});

describe("WhiteSheetSessionService close lifecycle", () => {
  it("claims an open session atomically, and a second claim sees closing_in_progress", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "open" };
    const { svc } = makeSvc([existing]);
    const first = await svc.claimForClose(SOURCE);
    expect(first.claimed).toBe(true);

    const second = await svc.claimForClose(SOURCE);
    expect(second.claimed).toBe(false);
    if (second.claimed) throw new Error("expected not claimed");
    expect(second.reason).toBe("closing_in_progress");
  });

  it("finalizeClosed transitions closing -> closed", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "closing" };
    const { svc, db } = makeSvc([existing]);
    await svc.finalizeClosed("s1", { lineUserId: "u1", lineEventId: "evt-close" });
    expect(db._rows[0].status).toBe("closed");
  });

  it("revertToOpen transitions closing -> open", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "closing" };
    const { svc, db } = makeSvc([existing]);
    await svc.revertToOpen("s1");
    expect(db._rows[0].status).toBe("open");
  });
});

describe("WhiteSheetSessionService.cancelSession", () => {
  it("cancels an open session", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "open" };
    const { svc, db } = makeSvc([existing]);
    const res = await svc.cancelSession(SOURCE, { lineUserId: "u1", lineEventId: "evt-cancel" });
    expect(res.cancelled).toBe(true);
    expect(db._rows[0].status).toBe("cancelled");
  });

  it("no open session -> not_found", async () => {
    const { svc } = makeSvc([]);
    const res = await svc.cancelSession(SOURCE, { lineUserId: "u1", lineEventId: "evt-cancel" });
    expect(res.cancelled).toBe(false);
    if (res.cancelled) throw new Error("expected not cancelled");
    expect(res.reason).toBe("not_found");
  });
});

describe("buildWhiteSheetCloseCommandFromSession", () => {
  it("returns null when cash was never submitted", () => {
    const session = {
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      labor: null,
      location_fee: null,
      bag: null,
      snack: null,
      other_amount: null,
      other_note: null,
      actual_cash_submitted: null,
    } as unknown as WhiteSheetSessionRow;
    expect(buildWhiteSheetCloseCommandFromSession(session)).toBeNull();
  });

  it("maps null expense fields to undefined (first-submit semantics) and passes explicit values through", () => {
    const session = {
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      labor: 500,
      location_fee: null,
      bag: 0,
      snack: null,
      other_amount: 30,
      other_note: "ค่าน้ำ",
      actual_cash_submitted: 4850,
    } as unknown as WhiteSheetSessionRow;
    const command = buildWhiteSheetCloseCommandFromSession(session);
    expect(command).toEqual({
      marketLabel: MARKET_NORM,
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      labor: 500,
      locationFee: undefined,
      bag: 0,
      snack: undefined,
      other: { amount: 30, note: "ค่าน้ำ" },
      actualCashSubmitted: 4850,
    });
  });
});
