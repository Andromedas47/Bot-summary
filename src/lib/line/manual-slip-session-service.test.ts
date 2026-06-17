import { describe, expect, it } from "bun:test";
import { ManualSlipSessionService } from "./manual-slip-session-service";

// ── In-memory Supabase stub ───────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeDb(initial: Row[] = []) {
  const sessions: Row[] = [...initial];
  const entries:  Row[] = [];
  let idSeq = 0;

  function stubFor(table: string) {
    if (table === "manual_slip_sessions") return sessionStub();
    if (table === "manual_slip_entries")  return entryStub();
    throw new Error(`unknown table: ${table}`);
  }

  function sessionStub() {
    return {
      select: (_cols = "*") => ({
        eq: (col: string, val: unknown) => ({
          eq: (col2: string, val2: unknown) => ({
            maybeSingle: async () => {
              const row = sessions.find(r => r[col] === val && r[col2] === val2) ?? null;
              return { data: row, error: null };
            },
          }),
        }),
      }),
      insert: (payload: Row) => ({
        select: () => ({
          single: async () => {
            const row = { id: `sess-${++idSeq}`, status: "open", opened_at: new Date().toISOString(), closed_at: null, ...payload };
            sessions.push(row);
            return { data: row, error: null };
          },
        }),
      }),
      update: (patch: Row) => ({
        eq: (col: string, val: unknown) => ({
          eq: (col2: string, val2: unknown) => ({
            select: (_s: string) => ({
              async then(resolve: (v: unknown) => void) {
                const idx = sessions.findIndex(r => r[col] === val && r[col2] === val2);
                if (idx === -1) return resolve({ data: [], error: null });
                Object.assign(sessions[idx], patch);
                return resolve({ data: [sessions[idx]], error: null });
              },
            }),
          }),
        }),
      }),
    };
  }

  function entryStub() {
    function chain(filtered: Row[]) {
      return {
        eq: (col: string, val: unknown) => chain(filtered.filter(r => r[col] === val)),
        order: () => chain(filtered),
        limit: () => chain(filtered),
        async then(resolve: (v: unknown) => void) {
          return resolve({ data: filtered.slice(-1), error: null });
        },
      };
    }
    return {
      select: () => chain(entries),
      upsert: (rows: Row[], _opts: unknown) => ({
        async then(resolve: (v: unknown) => void) {
          for (const row of rows) {
            const exists = entries.some(
              e => e.line_message_id === row.line_message_id && e.sequence_no === row.sequence_no,
            );
            if (!exists) entries.push(row);
          }
          return resolve({ data: rows, error: null });
        },
      }),
    };
  }

  return { from: stubFor, _sessions: sessions, _entries: entries };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ManualSlipSessionService", () => {
  it("opens a new session", async () => {
    const db  = makeDb();
    const svc = new ManualSlipSessionService(db as never);
    const res = await svc.openSession({
      sourceId: "grp1", businessDate: "2026-06-17",
      lineUserId: "u1", lineMessageId: "msg1",
    });
    expect(res.opened).toBe(true);
    expect(res.session?.source_id).toBe("grp1");
  });

  it("blocks duplicate open for same source_id + business_date", async () => {
    const existing = {
      id: "s1", source_id: "grp1", business_date: "2026-06-17",
      status: "open", opened_at: new Date().toISOString(), closed_at: null,
    };
    const db  = makeDb([existing]);
    const svc = new ManualSlipSessionService(db as never);
    const res = await svc.openSession({
      sourceId: "grp1", businessDate: "2026-06-17",
      lineUserId: "u1", lineMessageId: "msg2",
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toBe("already_exists");
  });

  it("also blocks duplicate for closed session (same date)", async () => {
    const existing = {
      id: "s1", source_id: "grp1", business_date: "2026-06-17",
      status: "closed", opened_at: new Date().toISOString(), closed_at: new Date().toISOString(),
    };
    const db  = makeDb([existing]);
    const svc = new ManualSlipSessionService(db as never);
    const res = await svc.openSession({
      sourceId: "grp1", businessDate: "2026-06-17",
      lineUserId: "u1", lineMessageId: "msg3",
    });
    expect(res.opened).toBe(false);
  });

  it("appends entries with auto sequence_no", async () => {
    const db  = makeDb();
    const svc = new ManualSlipSessionService(db as never);

    await svc.appendEntries({
      sessionId: "s1",
      entries: [{ rawLine: "1. 100 บาท", amount: 100 }, { rawLine: "2. 300 บาท", amount: 300 }],
      lineMessageId: "msg-a",
      lineUserId: "u1",
    });

    expect(db._entries).toHaveLength(2);
    expect(db._entries[0].sequence_no).toBe(0);
    expect(db._entries[1].sequence_no).toBe(1);
  });

  it("is idempotent on re-delivered message (same line_message_id)", async () => {
    const db  = makeDb();
    const svc = new ManualSlipSessionService(db as never);

    const entries = [{ rawLine: "100 บาท", amount: 100 }];
    await svc.appendEntries({ sessionId: "s1", entries, lineMessageId: "msg-dup", lineUserId: null });
    await svc.appendEntries({ sessionId: "s1", entries, lineMessageId: "msg-dup", lineUserId: null });

    expect(db._entries).toHaveLength(1);
  });
});
