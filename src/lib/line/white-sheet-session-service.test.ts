import { describe, expect, it } from "bun:test";
import {
  buildWhiteSheetCloseCommandFromSession,
  WhiteSheetSessionService,
  type WhiteSheetSessionRow,
} from "./white-sheet-session-service";

// ── In-memory Supabase stub for manual_white_sheet_sessions ────────────────
// The claim RPC stub below mirrors claim_manual_white_sheet_session_close's
// logic (open -> closing, stale closing reclaim, fresh closing blocked) so
// the TS wrapper is exercised the same way the real RPC behaves. Real
// atomicity/concurrency against actual PostgreSQL is proven separately in
// supabase/migrations/0059's .pg.test.ts — this file proves the JS contract.

type Row = Record<string, unknown>;

function makeDb(initial: Row[] = [], cashEntries: Row[] = []) {
  const rows: Row[] = [...initial];
  let idSeq = 0;

  function matches(row: Row, filters: Array<{ op: "eq" | "in"; col: string; val: unknown }>) {
    return filters.every(({ op, col, val }) =>
      op === "eq" ? row[col] === val : (val as unknown[]).includes(row[col]),
    );
  }

  function selectChain(
    filters: Array<{ op: "eq" | "in"; col: string; val: unknown }> = [],
    order?: { col: string; ascending: boolean },
    limit?: number,
  ) {
    return {
      eq(col: string, val: unknown) {
        return selectChain([...filters, { op: "eq" as const, col, val }], order, limit);
      },
      in(col: string, val: unknown[]) {
        return selectChain([...filters, { op: "in" as const, col, val }], order, limit);
      },
      order(col: string, opts?: { ascending?: boolean }) {
        return selectChain(filters, { col, ascending: opts?.ascending ?? true }, limit);
      },
      limit(n: number) {
        return selectChain(filters, order, n);
      },
      async maybeSingle() {
        let found = rows.filter((r) => matches(r, filters));
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
      async single() {
        const found = rows.find((r) => matches(r, filters));
        return { data: found ?? null, error: found ? null : { message: "not found" } };
      },
    };
  }

  function updateChain(
    patch: Row,
    filters: Array<{ op: "eq" | "in"; col: string; val: unknown }> = [],
  ) {
    return {
      eq(col: string, val: unknown) {
        return updateChain(patch, [...filters, { op: "eq" as const, col, val }]);
      },
      in(col: string, val: unknown[]) {
        return updateChain(patch, [...filters, { op: "in" as const, col, val }]);
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
                  edited_fields: [],
                  closing_started_at: null,
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

  function selectChainCash(filters: Array<{ op: "eq"; col: string; val: unknown }> = []) {
    return {
      eq(col: string, val: unknown) {
        return selectChainCash([...filters, { op: "eq" as const, col, val }]);
      },
      async maybeSingle() {
        const found = cashEntries.find((r) => matches(r, filters));
        return { data: found ?? null, error: null };
      },
    };
  }

  function cashEntryStub() {
    return {
      select() {
        return selectChainCash();
      },
    };
  }

  /** Mirrors claim_manual_white_sheet_session_close (see 0059). */
  async function rpc(fnName: string, args: Record<string, unknown>) {
    if (fnName !== "claim_manual_white_sheet_session_close") {
      throw new Error(`unexpected rpc: ${fnName}`);
    }
    const sourceId = args.p_source_id as string;
    const leaseSeconds = (args.p_lease_seconds as number | undefined) ?? 120;
    const row = rows.find((r) => r.source_id === sourceId && (r.status === "open" || r.status === "closing"));
    if (!row) {
      return { data: { claimed: false, reason: "not_found", session: null }, error: null };
    }
    if (row.status === "closing") {
      const startedAt = row.closing_started_at ? new Date(row.closing_started_at as string).getTime() : null;
      const stale = startedAt !== null && startedAt <= Date.now() - leaseSeconds * 1000;
      if (stale) {
        row.closing_started_at = new Date().toISOString();
        return { data: { claimed: true, reason: null, session: { ...row } }, error: null };
      }
      return { data: { claimed: false, reason: "closing_in_progress", session: { ...row } }, error: null };
    }
    row.status = "closing";
    row.closing_started_at = new Date().toISOString();
    return { data: { claimed: true, reason: null, session: { ...row } }, error: null };
  }

  return {
    from(table: string) {
      if (table === "manual_white_sheet_sessions") return stub();
      if (table === "digital_white_sheet_cash_entries") return cashEntryStub();
      throw new Error(`unexpected table: ${table}`);
    },
    rpc,
    _rows: rows,
  };
}

function makeSvc(initial: Row[] = [], cashEntries: Row[] = []) {
  const db = makeDb(initial, cashEntries);
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

  it("blocks reopening a closed session when the canonical White Sheet is FINALIZED", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      market_label: "พาชิโอ้ผลไม้",
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      business_date_display: "31/07/2569",
      status: "closed",
    };
    const cashEntry = {
      source_id: SOURCE,
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      labor: 500,
      location_fee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      other_note: null,
      actual_cash_submitted: 4850,
      updated_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      finalized_by: "admin1",
    };
    const { svc } = makeSvc([existing], [cashEntry]);
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
    expect(res.reason).toBe("finalized_locked");
  });

  it("reopens a closed SUBMITTED session, seeding entered values from the canonical entry, with edited_fields reset", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      market_label: "พาชิโอ้ผลไม้",
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      business_date_display: "31/07/2569",
      status: "closed",
      labor: 999, // stale session value — must be overwritten by the seed, not trusted
      edited_fields: ["labor"], // stale from before close — must reset
    };
    const cashEntry = {
      source_id: SOURCE,
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      labor: 500,
      location_fee: 200,
      bag: 100,
      snack: 50,
      other: 30,
      other_note: "ค่าน้ำ",
      actual_cash_submitted: 4850,
      updated_at: new Date().toISOString(),
      finalized_at: null,
      finalized_by: null,
    };
    const { svc } = makeSvc([existing], [cashEntry]);
    const res = await svc.openSession({
      sourceId: SOURCE,
      marketLabel: "พาชิโอ้ผลไม้",
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      businessDateDisplay: "31/07/2569",
      lineUserId: "u1",
      lineEventId: "evt4",
    });
    expect(res.opened).toBe(true);
    if (!res.opened) throw new Error("expected opened");
    expect(res.session.status).toBe("open");
    expect(res.session.labor).toBe(500);
    expect(res.session.location_fee).toBe(200);
    expect(res.session.bag).toBe(100);
    expect(res.session.snack).toBe(50);
    expect(res.session.other_amount).toBe(30);
    expect(res.session.other_note).toBe("ค่าน้ำ");
    expect(res.session.actual_cash_submitted).toBe(4850);
    expect(res.session.closed_at).toBeNull();
    expect(res.session.closing_started_at).toBeNull();
    expect(res.session.edited_fields).toEqual([]);
  });

  it("reopens a closed session with no canonical row (edge case) with nulled values, same identity row", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      market_label: "พาชิโอ้ผลไม้",
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      business_date_display: "31/07/2569",
      status: "closed",
    };
    const { svc, db } = makeSvc([existing], []);
    const res = await svc.openSession({
      sourceId: SOURCE,
      marketLabel: "พาชิโอ้ผลไม้",
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      businessDateDisplay: "31/07/2569",
      lineUserId: "u1",
      lineEventId: "evt4",
    });
    expect(res.opened).toBe(true);
    if (!res.opened) throw new Error("expected opened");
    expect(res.session.labor).toBeNull();
    expect(db._rows).toHaveLength(1);
    expect(db._rows[0].id).toBe("s1");
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
  it("only updates provided fields, preserving the rest, and tracks edited_fields", async () => {
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
      edited_fields: [],
    };
    const { svc, db } = makeSvc([existing]);
    await svc.applyFields(existing as unknown as WhiteSheetSessionRow, {
      labor: undefined,
      locationFee: 200,
      bag: undefined,
      snack: undefined,
      other: undefined,
      actualCashSubmitted: undefined,
    });
    expect(db._rows[0].labor).toBe(500);
    expect(db._rows[0].location_fee).toBe(200);
    expect(db._rows[0].edited_fields).toEqual(["location_fee"]);
  });

  it("replaces a repeated field with the latest value and does not duplicate edited_fields entries", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "open", labor: 500, edited_fields: ["labor"] };
    const { svc, db } = makeSvc([existing]);
    await svc.applyFields(existing as unknown as WhiteSheetSessionRow, {
      labor: 700,
      locationFee: undefined,
      bag: undefined,
      snack: undefined,
      other: undefined,
      actualCashSubmitted: undefined,
    });
    expect(db._rows[0].labor).toBe(700);
    expect(db._rows[0].edited_fields).toEqual(["labor"]);
  });

  it("ค่าอื่น 0 with no note clears an old note", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      status: "open",
      other_amount: 30,
      other_note: "เก่า",
      edited_fields: [],
    };
    const { svc, db } = makeSvc([existing]);
    await svc.applyFields(existing as unknown as WhiteSheetSessionRow, {
      labor: undefined,
      locationFee: undefined,
      bag: undefined,
      snack: undefined,
      other: { amount: 0, note: null },
      actualCashSubmitted: undefined,
    });
    expect(db._rows[0].other_amount).toBe(0);
    expect(db._rows[0].other_note).toBeNull();
    expect(db._rows[0].edited_fields).toEqual(["other"]);
  });

  it("accumulates edited_fields across multiple messages", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "open", edited_fields: ["labor"] };
    const { svc, db } = makeSvc([existing]);
    await svc.applyFields(existing as unknown as WhiteSheetSessionRow, {
      labor: undefined,
      locationFee: 200,
      bag: undefined,
      snack: undefined,
      other: undefined,
      actualCashSubmitted: undefined,
    });
    expect(db._rows[0].edited_fields).toEqual(["labor", "location_fee"]);
  });
});

describe("WhiteSheetSessionService close lifecycle (lease)", () => {
  it("claims an open session atomically, and a fresh second claim sees closing_in_progress (cannot be stolen)", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "open" };
    const { svc, db } = makeSvc([existing]);
    const first = await svc.claimForClose(SOURCE);
    expect(first.claimed).toBe(true);
    expect(db._rows[0].closing_started_at).not.toBeNull();

    const second = await svc.claimForClose(SOURCE);
    expect(second.claimed).toBe(false);
    if (second.claimed) throw new Error("expected not claimed");
    expect(second.reason).toBe("closing_in_progress");
  });

  it("reclaims a stale closing lease (process-death recovery)", async () => {
    const staleStart = new Date(Date.now() - 200_000).toISOString(); // 200s ago
    const existing = { id: "s1", source_id: SOURCE, status: "closing", closing_started_at: staleStart };
    const { svc, db } = makeSvc([existing]);
    const claim = await svc.claimForClose(SOURCE, 120); // 120s lease, 200s old -> stale
    expect(claim.claimed).toBe(true);
    expect(db._rows[0].closing_started_at).not.toBe(staleStart);
  });

  it("does not reclaim a closing lease that has not expired yet", async () => {
    const freshStart = new Date(Date.now() - 5_000).toISOString(); // 5s ago
    const existing = { id: "s1", source_id: SOURCE, status: "closing", closing_started_at: freshStart };
    const { svc } = makeSvc([existing]);
    const claim = await svc.claimForClose(SOURCE, 120);
    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("expected not claimed");
    expect(claim.reason).toBe("closing_in_progress");
  });

  it("claimForClose on a not_found source with a closed history returns already_closed", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      status: "closed",
      opened_at: new Date().toISOString(),
    };
    const { svc } = makeSvc([existing]);
    const claim = await svc.claimForClose(SOURCE);
    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("expected not claimed");
    expect(claim.reason).toBe("already_closed");
  });

  it("claimForClose on a not_found source with a cancelled history returns cancelled", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      status: "cancelled",
      opened_at: new Date().toISOString(),
    };
    const { svc } = makeSvc([existing]);
    const claim = await svc.claimForClose(SOURCE);
    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("expected not claimed");
    expect(claim.reason).toBe("cancelled");
  });

  it("finalizeClosed transitions closing -> closed and clears the closing lease", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "closing", closing_started_at: new Date().toISOString() };
    const { svc, db } = makeSvc([existing]);
    await svc.finalizeClosed("s1", { lineUserId: "u1", lineEventId: "evt-close" });
    expect(db._rows[0].status).toBe("closed");
    expect(db._rows[0].closing_started_at).toBeNull();
  });

  it("revertToOpen transitions closing -> open and clears the closing lease", async () => {
    const existing = { id: "s1", source_id: SOURCE, status: "closing", closing_started_at: new Date().toISOString() };
    const { svc, db } = makeSvc([existing]);
    await svc.revertToOpen("s1");
    expect(db._rows[0].status).toBe("open");
    expect(db._rows[0].closing_started_at).toBeNull();
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

  it("no session at all -> not_found", async () => {
    const { svc } = makeSvc([]);
    const res = await svc.cancelSession(SOURCE, { lineUserId: "u1", lineEventId: "evt-cancel" });
    expect(res.cancelled).toBe(false);
    if (res.cancelled) throw new Error("expected not cancelled");
    expect(res.reason).toBe("not_found");
  });

  it("repeated cancel after a prior cancel returns a deterministic already_cancelled reply", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      status: "cancelled",
      opened_at: new Date().toISOString(),
    };
    const { svc } = makeSvc([existing]);
    const res = await svc.cancelSession(SOURCE, { lineUserId: "u1", lineEventId: "evt-cancel-2" });
    expect(res.cancelled).toBe(false);
    if (res.cancelled) throw new Error("expected not cancelled");
    expect(res.reason).toBe("already_cancelled");
  });

  it("cancel after the session already closed returns a deterministic already_closed reply", async () => {
    const existing = {
      id: "s1",
      source_id: SOURCE,
      status: "closed",
      opened_at: new Date().toISOString(),
    };
    const { svc } = makeSvc([existing]);
    const res = await svc.cancelSession(SOURCE, { lineUserId: "u1", lineEventId: "evt-cancel-3" });
    expect(res.cancelled).toBe(false);
    if (res.cancelled) throw new Error("expected not cancelled");
    expect(res.reason).toBe("already_closed");
  });
});

describe("buildWhiteSheetCloseCommandFromSession", () => {
  it("never returns null; with nothing edited this window, every field is undefined even if the row has seeded values", () => {
    const session = {
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      labor: 999, // seeded/displayed, but never edited this window
      location_fee: null,
      bag: null,
      snack: null,
      other_amount: null,
      other_note: null,
      actual_cash_submitted: 4850, // seeded, but never edited
      edited_fields: [],
    } as unknown as WhiteSheetSessionRow;
    expect(buildWhiteSheetCloseCommandFromSession(session)).toEqual({
      marketLabel: MARKET_NORM,
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      labor: undefined,
      locationFee: undefined,
      bag: undefined,
      snack: undefined,
      other: undefined,
      actualCashSubmitted: undefined,
    });
  });

  it("only overlays fields present in edited_fields; unedited fields stay undefined regardless of their stored value", () => {
    const session = {
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      labor: 500,
      location_fee: 200, // stored but not edited this window
      bag: 0,
      snack: null,
      other_amount: 30,
      other_note: "ค่าน้ำ",
      actual_cash_submitted: 4850,
      edited_fields: ["labor", "bag", "actual_cash_submitted"],
    } as unknown as WhiteSheetSessionRow;
    const command = buildWhiteSheetCloseCommandFromSession(session);
    expect(command).toEqual({
      marketLabel: MARKET_NORM,
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      labor: 500,
      locationFee: undefined, // stored value 200 not sent — was not edited this window
      bag: 0,
      snack: undefined,
      other: undefined, // "other" not in edited_fields even though other_amount is set
      actualCashSubmitted: 4850,
    });
  });

  it("first-submit (fresh session, everything edited) passes every entered value through", () => {
    const session = {
      market_label_normalized: MARKET_NORM,
      business_date: DATE,
      labor: 500,
      location_fee: 0,
      bag: 100,
      snack: 50,
      other_amount: 30,
      other_note: "ค่าน้ำ",
      actual_cash_submitted: 4850,
      edited_fields: ["labor", "location_fee", "bag", "snack", "other", "actual_cash_submitted"],
    } as unknown as WhiteSheetSessionRow;
    const command = buildWhiteSheetCloseCommandFromSession(session);
    expect(command).toEqual({
      marketLabel: MARKET_NORM,
      marketLabelNormalized: MARKET_NORM,
      businessDate: DATE,
      labor: 500,
      locationFee: 0,
      bag: 100,
      snack: 50,
      other: { amount: 30, note: "ค่าน้ำ" },
      actualCashSubmitted: 4850,
    });
  });
});
