import { describe, expect, it } from "bun:test";
import {
  parseSettlementCommand,
  parseSettlementAmounts,
  hasAnyAmount,
  SettlementIntakeService,
} from "./settlement-intake-service";
import type { WorkRound, SettlementDraft } from "@/lib/work-round/types";

// ── Pure function tests ────────────────────────────────────────────────────────

describe("parseSettlementCommand", () => {
  it("matches ส่งเงิน with date", () => {
    expect(parseSettlementCommand("ส่งเงิน 24/06/2569")).toBe("24/06/2569");
  });

  it("matches ปิดยอด with date", () => {
    expect(parseSettlementCommand("ปิดยอด 24/06/2569")).toBe("24/06/2569");
  });

  it("returns null for non-matching text", () => {
    expect(parseSettlementCommand("เบิก 24/06/2569")).toBeNull();
    expect(parseSettlementCommand("ส่งเงิน")).toBeNull();
    expect(parseSettlementCommand("โอน 730 สด 1420")).toBeNull();
  });

  it("accepts short Buddhist year", () => {
    expect(parseSettlementCommand("ส่งเงิน 24/06/69")).toBe("24/06/69");
  });
});

describe("parseSettlementAmounts", () => {
  it("parses all four amount fields", () => {
    const a = parseSettlementAmounts("โอน 730 สด 1420 ค่าใช้จ่าย 410 ค่าแรง 400");
    expect(a.transfer).toBe(730);
    expect(a.cash).toBe(1420);
    expect(a.expenses).toBe(410);
    expect(a.labor).toBe(400);
  });

  it("parses partial amounts gracefully", () => {
    const a = parseSettlementAmounts("โอน 1000");
    expect(a.transfer).toBe(1000);
    expect(a.cash).toBeNull();
    expect(a.expenses).toBeNull();
    expect(a.labor).toBeNull();
  });

  it("parses decimal amounts", () => {
    const a = parseSettlementAmounts("โอน 730.50");
    expect(a.transfer).toBe(730.5);
  });

  it("returns all null for non-amount text", () => {
    const a = parseSettlementAmounts("ขอบคุณครับ");
    expect(a.transfer).toBeNull();
    expect(a.cash).toBeNull();
  });
});

describe("hasAnyAmount", () => {
  it("returns true when โอน is present", () => {
    expect(hasAnyAmount("โอน 730")).toBe(true);
  });

  it("returns true when ค่าแรง is present", () => {
    expect(hasAnyAmount("ค่าแรง 400")).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(hasAnyAmount("ส่งเงิน 24/06/2569")).toBe(false);
  });
});

// ── Service tests with in-memory stub ─────────────────────────────────────────

type Row = Record<string, unknown>;

function makeDb(initialRounds: Row[] = [], initialDrafts: Row[] = []) {
  const rounds: Row[] = [...initialRounds];
  const drafts: Row[] = [...initialDrafts];
  const history: Row[] = [];
  let idSeq = 0;

  // Returns a chainable query object starting from `filtered`.
  function chain(filtered: Row[]) {
    const obj: Record<string, unknown> = {
      eq(col: string, val: unknown)        { return chain(filtered.filter(r => r[col] === val)); },
      in(col: string, vals: unknown[])     { return chain(filtered.filter(r => vals.includes(r[col]))); },
      not(col: string, op: string, val: unknown) {
        if (op === "in") {
          const vals = (val as string).replace(/[()]/g, "").split(",").map(v => v.trim().replace(/"/g, ""));
          return chain(filtered.filter(r => !vals.includes(String(r[col]))));
        }
        return chain(filtered);
      },
      order() { return obj; },
      limit(n: number) { return chain(filtered.slice(0, n)); },
      async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
      async single()      { return { data: filtered[0] ?? null, error: filtered.length === 0 ? { message: "no row" } : null }; },
      async then(resolve: (v: unknown) => void) {
        return resolve({ data: filtered, error: null });
      },
    };
    return obj;
  }

  // Top-level table stub — provides select/insert/update as first-call methods.
  function tableStub(arr: Row[]) {
    return {
      select(_cols = "*") { return chain(arr); },
    };
  }

  return {
    from(table: string) {
      if (table === "work_rounds") return tableStub(rounds);

      if (table === "settlement_draft_history") {
        return {
          insert(payload: Row) {
            return {
              async then(resolve: (v: unknown) => void) {
                history.push(payload);
                return resolve({ data: payload, error: null });
              },
            };
          },
        };
      }

      if (table === "settlement_drafts") {
        return {
          select(_cols = "*") { return chain(drafts); },
          insert(payload: Row) {
            return {
              select() {
                return {
                  async single() {
                    const row: Row = {
                      id: `draft-${++idSeq}`, status: "pending", version: 1,
                      declared_via: "line", ...payload,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    };
                    drafts.push(row);
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
                  select() {
                    return {
                      async single() {
                        const idx = drafts.findIndex(r => r[col] === val);
                        if (idx === -1) return { data: null, error: { message: "not found" } };
                        Object.assign(drafts[idx], patch);
                        return { data: drafts[idx], error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    _drafts:  () => drafts,
    _history: () => history,
  };
}

const makeRound = (overrides: Partial<WorkRound> = {}): Row => ({
  id: "wr-1", source_id: "grp1", business_date: "2026-06-24",
  seller_name: "กี้", market_name: "วัดทุ่งลานนา", round_seq: 1, status: "open",
  source_meta: null, created_at: "", updated_at: "", ...overrides,
});

describe("SettlementIntakeService", () => {
  it("findEligibleRounds returns open rounds for the group+date", async () => {
    const db  = makeDb([makeRound()]);
    const svc = new SettlementIntakeService(db as never);
    const res = await svc.findEligibleRounds("grp1", "2026-06-24");
    expect(res).toHaveLength(1);
    expect(res[0].seller_name).toBe("กี้");
  });

  it("findEligibleRounds returns empty when no rounds exist", async () => {
    const db  = makeDb();
    const svc = new SettlementIntakeService(db as never);
    const res = await svc.findEligibleRounds("grp1", "2026-06-24");
    expect(res).toHaveLength(0);
  });

  it("openDraft creates a new draft", async () => {
    const db  = makeDb([makeRound()]);
    const svc = new SettlementIntakeService(db as never);
    const { draft, created } = await svc.openDraft("wr-1", "u1");
    expect(created).toBe(true);
    expect(draft.work_round_id).toBe("wr-1");
    expect(draft.declared_via).toBe("line");
  });

  it("openDraft returns existing draft on second call", async () => {
    const existingDraft: Row = {
      id: "draft-existing", work_round_id: "wr-1", status: "pending",
      declared_via: "line", version: 1, created_at: "", updated_at: "",
    };
    const db  = makeDb([makeRound()], [existingDraft]);
    const svc = new SettlementIntakeService(db as never);
    const { draft, created } = await svc.openDraft("wr-1", "u1");
    expect(created).toBe(false);
    expect(draft.id).toBe("draft-existing");
  });

  it("recordDeclared updates draft and writes history", async () => {
    const existingDraft: Row = {
      id: "d1", work_round_id: "wr-1", status: "pending",
      declared_via: "line", version: 1, created_at: "", updated_at: "",
      declared_transfer: null, declared_cash: null, declared_expenses: null, declared_labor: null,
    };
    const db  = makeDb([makeRound()], [existingDraft]);
    const svc = new SettlementIntakeService(db as never);
    await svc.recordDeclared("d1", { transfer: 730, cash: 1420, expenses: 410, labor: 400 }, "u1");
    const drafts = db._drafts();
    expect(drafts[0].declared_transfer).toBe(730);
    expect(db._history()).toHaveLength(1);
    expect(db._history()[0].change_type).toBe("declared_update");
  });

  it("buildSelectionPrompt lists rounds when multiple exist", () => {
    const svc    = new SettlementIntakeService({} as never);
    const rounds = [
      makeRound({ seller_name: "กี้",   market_name: "วัดทุ่ง" }) as unknown as WorkRound,
      makeRound({ id: "wr-2", seller_name: "พี่ดำ", market_name: "วิหาร" }) as unknown as WorkRound,
    ];
    const prompt = svc.buildSelectionPrompt(rounds, "24/06/2569");
    expect(prompt).toContain("1.");
    expect(prompt).toContain("กี้");
    expect(prompt).toContain("พี่ดำ");
  });

  it("buildSelectionPrompt shows no-round message when empty", () => {
    const svc    = new SettlementIntakeService({} as never);
    const prompt = svc.buildSelectionPrompt([], "24/06/2569");
    expect(prompt).toContain("ไม่พบ");
  });

  it("buildSettlementConfirmReply shows correct totals", () => {
    const svc   = new SettlementIntakeService({} as never);
    const draft = {
      id: "d1", work_round_id: "wr-1", declared_transfer: 730, declared_cash: 1420,
      declared_expenses: 410, declared_labor: 400, status: "pending",
      declared_via: "line", version: 1, notes: null, white_bill_ref: null,
      approved_by: null, approved_at: null, declared_by_line_user_id: "u1",
      created_at: "", updated_at: "",
    } satisfies SettlementDraft;
    const round = makeRound() as unknown as WorkRound;
    const reply = svc.buildSettlementConfirmReply(draft, round);
    expect(reply).toContain("กี้");
    expect(reply).toContain("วัดทุ่งลานนา");
    // 730+1420+410+400 = 2960
    expect(reply).toContain("2,960");
  });
});
