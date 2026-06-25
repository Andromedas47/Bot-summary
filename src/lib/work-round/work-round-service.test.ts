import { describe, expect, it } from "bun:test";
import {
  WorkRoundService,
  PRODUCE_APPEND_ELIGIBLE_STATUSES,
  RETURN_APPEND_ELIGIBLE_STATUSES,
} from "./work-round-service";
import type { WorkRound, WorkRoundStatus } from "./types";

// Every status currently in the WorkRoundStatus enum. Kept here as a literal so a
// new enum member surfaces as a failing exhaustiveness check below.
const ALL_STATUSES: WorkRoundStatus[] = [
  "open", "produce_complete", "awaiting_settlement", "awaiting_slips",
  "variance_found", "ready_for_review", "approved", "needs_correction",
];

// ── In-memory Supabase stub ───────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeDb(initial: Row[] = []) {
  let rows: Row[] = [...initial];
  let idSeq        = 0;

  function queryChain(filtered: Row[]) {
    return {
      eq(col: string, val: unknown)       { return queryChain(filtered.filter(r => r[col] === val)); },
      not(col: string, op: string, val: unknown) {
        if (op === "in") {
          const vals = (val as string).replace(/[()]/g, "").split(",").map(v => v.trim().replace(/"/g, ""));
          return queryChain(filtered.filter(r => !vals.includes(String(r[col]))));
        }
        return queryChain(filtered);
      },
      in(col: string, vals: unknown[])    { return queryChain(filtered.filter(r => vals.includes(r[col]))); },
      order(col: string, opts?: { ascending?: boolean }) {
        const asc = opts?.ascending !== false;
        return queryChain([...filtered].sort((a, b) => {
          const av = a[col] as number, bv = b[col] as number;
          return asc ? av - bv : bv - av;
        }));
      },
      limit(n: number)  { return queryChain(filtered.slice(0, n)); },
      async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
      async then(resolve: (v: unknown) => void) {
        return resolve({ data: filtered, error: null });
      },
    };
  }

  return {
    from(table: string) {
      if (table !== "work_rounds") throw new Error(`unexpected table: ${table}`);
      return {
        select(_cols = "*") { return queryChain(rows); },
        insert(payload: Row) {
          return {
            select() {
              return {
                async single() {
                  const row: Row = {
                    id: `wr-${++idSeq}`,
                    status: "open",
                    source_meta: null,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    round_seq: 1,
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
                async then(resolve: (v: unknown) => void) {
                  rows = rows.map(r => r[col] === val ? { ...r, ...patch } : r);
                  return resolve({ data: null, error: null });
                },
              };
            },
          };
        },
      };
    },
    _rows: () => rows,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WorkRoundService", () => {
  it("creates a new Work Round for a new seller+market+date", async () => {
    const db  = makeDb();
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolve({
      sourceId:     "grp1",
      businessDate: "2026-06-24",
      sellerName:   "กี้",
      marketName:   "วัดทุ่งลานนา",
    });
    expect(res.created).toBe(true);
    expect(res.workRound.seller_name).toBe("กี้");
    expect(res.workRound.market_name).toBe("วัดทุ่งลานนา");
    expect(res.workRound.round_seq).toBe(1);
    expect(res.workRound.status).toBe("open");
  });

  it("returns the existing open Work Round on re-resolve", async () => {
    const existing: Row = {
      id: "wr-existing", source_id: "grp1", business_date: "2026-06-24",
      seller_name: "กี้", market_name: "วัดทุ่งลานนา", round_seq: 1, status: "open",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([existing]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolve({
      sourceId: "grp1", businessDate: "2026-06-24",
      sellerName: "กี้", marketName: "วัดทุ่งลานนา",
    });
    expect(res.created).toBe(false);
    expect(res.workRound.id).toBe("wr-existing");
  });

  it("supports two different sellers in the same group+date", async () => {
    const db  = makeDb();
    const svc = new WorkRoundService(db as never);
    await svc.resolve({ sourceId: "grp1", businessDate: "2026-06-24", sellerName: "กี้",   marketName: "วัดทุ่ง" });
    await svc.resolve({ sourceId: "grp1", businessDate: "2026-06-24", sellerName: "พี่ดำ", marketName: "วิหาร"  });
    const rounds = db._rows();
    expect(rounds).toHaveLength(2);
    expect(rounds.map(r => r.seller_name)).toContain("กี้");
    expect(rounds.map(r => r.seller_name)).toContain("พี่ดำ");
  });

  it("supports two different markets in the same group+date", async () => {
    const db  = makeDb();
    const svc = new WorkRoundService(db as never);
    await svc.resolve({ sourceId: "grp1", businessDate: "2026-06-24", sellerName: "กี้", marketName: "วัดทุ่งลานนา" });
    await svc.resolve({ sourceId: "grp1", businessDate: "2026-06-24", sellerName: "กี้", marketName: "อีกตลาด"      });
    expect(db._rows()).toHaveLength(2);
  });

  it("returns round_seq=2 when round 1 is not open", async () => {
    const closed: Row = {
      id: "wr-1", source_id: "grp1", business_date: "2026-06-24",
      seller_name: "กี้", market_name: "วัดทุ่งลานนา", round_seq: 1, status: "approved",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([closed]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolve({
      sourceId: "grp1", businessDate: "2026-06-24",
      sellerName: "กี้", marketName: "วัดทุ่งลานนา",
    });
    expect(res.created).toBe(true);
    expect(res.workRound.round_seq).toBe(2);
  });

  it("disambiguateGeneric returns 'none' when no open rounds", async () => {
    const db  = makeDb();
    const svc = new WorkRoundService(db as never);
    const res = await svc.disambiguateGeneric("grp1", "2026-06-24");
    expect(res.status).toBe("none");
  });

  it("disambiguateGeneric returns 'resolved' for exactly one open round", async () => {
    const round: Row = {
      id: "wr-1", source_id: "grp1", business_date: "2026-06-24",
      seller_name: "กี้", market_name: "วัดทุ่งลานนา", round_seq: 1, status: "open",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([round]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.disambiguateGeneric("grp1", "2026-06-24");
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.workRound.id).toBe("wr-1");
  });

  it("disambiguateGeneric returns 'ambiguous' for two open rounds", async () => {
    const rounds: Row[] = [
      { id: "wr-1", source_id: "grp1", business_date: "2026-06-24", seller_name: "กี้",   market_name: "A", round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "" },
      { id: "wr-2", source_id: "grp1", business_date: "2026-06-24", seller_name: "พี่ดำ", market_name: "B", round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "" },
    ];
    const db  = makeDb(rounds);
    const svc = new WorkRoundService(db as never);
    const res = await svc.disambiguateGeneric("grp1", "2026-06-24");
    expect(res.status).toBe("ambiguous");
    if (res.status === "ambiguous") expect(res.candidates).toHaveLength(2);
  });

  it("buildDisambiguationPrompt lists candidates with produce-append syntax", () => {
    const svc = new WorkRoundService({} as never);
    const candidates: WorkRound[] = [
      { id: "1", source_id: "g", business_date: "2026-06-24", seller_name: "กี้",   market_name: "วัดทุ่ง", round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "" },
      { id: "2", source_id: "g", business_date: "2026-06-24", seller_name: "พี่ดำ", market_name: "วิหาร",  round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "" },
    ];
    const prompt = svc.buildDisambiguationPrompt(candidates);
    expect(prompt).toContain("กี้-วัดทุ่ง รายการเบิกเพิ่ม 24/6/2569");
    expect(prompt).toContain("พี่ดำ-วิหาร รายการเบิกเพิ่ม 24/6/2569");
    expect(prompt).not.toContain(" เบิก");
  });

  it("resolveExplicitProduceAppend resolves by seller+market+date", async () => {
    const rounds: Row[] = [
      { id: "wr-1", source_id: "grp1", business_date: "2026-06-28", seller_name: "ทดลองใหม่", market_name: "ตลาดจำลอง", round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "" },
      { id: "wr-2", source_id: "grp1", business_date: "2026-06-28", seller_name: "ทดสอบ2",   market_name: "ตลาดทดสอบ", round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "" },
    ];
    const db  = makeDb(rounds);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveExplicitProduceAppend({
      sourceId: "grp1", businessDate: "2026-06-28",
      sellerName: "ทดลองใหม่", marketName: "ตลาดจำลอง",
    });
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.workRound.id).toBe("wr-1");
  });

  it("resolveExplicitProduceAppend returns none when date differs", async () => {
    const round: Row = {
      id: "wr-1", source_id: "grp1", business_date: "2026-06-28",
      seller_name: "ทดลองใหม่", market_name: "ตลาดจำลอง", round_seq: 1, status: "open",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([round]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveExplicitProduceAppend({
      sourceId: "grp1", businessDate: "2026-06-25",
      sellerName: "ทดลองใหม่", marketName: "ตลาดจำลอง",
    });
    expect(res.status).toBe("none");
  });

  it("resolveProduceAppendTarget finds round created by resolve()", async () => {
    const db  = makeDb();
    const svc = new WorkRoundService(db as never);
    await svc.resolve({
      sourceId: "grp1", businessDate: "2026-06-25",
      sellerName: "โอม", marketName: "ตลาดพาซิโอ้ผลไม้",
    });
    const res = await svc.resolveProduceAppendTarget("grp1", "2026-06-25");
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.workRound.seller_name).toBe("โอม");
  });

  it("resolveProduceAppendTarget accepts produce_complete status", async () => {
    const round: Row = {
      id: "wr-1", source_id: "grp1", business_date: "2026-06-25",
      seller_name: "โอม", market_name: "ตลาดพาซิโอ้ผลไม้", round_seq: 1, status: "produce_complete",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([round]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveProduceAppendTarget("grp1", "2026-06-25");
    expect(res.status).toBe("resolved");
  });

  it("resolveProduceAppendTarget rejects awaiting_settlement", async () => {
    const round: Row = {
      id: "wr-1", source_id: "grp1", business_date: "2026-06-25",
      seller_name: "โอม", market_name: "ตลาดพาซิโอ้ผลไม้", round_seq: 1, status: "awaiting_settlement",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([round]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveProduceAppendTarget("grp1", "2026-06-25");
    expect(res.status).toBe("none");
  });

  // V2: needs_correction occurs AFTER the round was closed / settled (e.g. a later
  // "คืนเพิ่ม"). A produce append must NOT attach there — it would change the locked
  // borrow total after the money/slip flow already started.
  it("resolveProduceAppendTarget rejects needs_correction", async () => {
    const round: Row = {
      id: "wr-1", source_id: "grp1", business_date: "2026-06-25",
      seller_name: "โอม", market_name: "ตลาดพาซิโอ้ผลไม้", round_seq: 1, status: "needs_correction",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([round]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveProduceAppendTarget("grp1", "2026-06-25");
    expect(res.status).toBe("none");
  });

  it("resolveProduceAppendTarget never crosses business_date", async () => {
    // An eligible round exists for the same group but a DIFFERENT business_date.
    const round: Row = {
      id: "wr-1", source_id: "grp1", business_date: "2026-06-24",
      seller_name: "โอม", market_name: "ตลาดพาซิโอ้ผลไม้", round_seq: 1, status: "open",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([round]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveProduceAppendTarget("grp1", "2026-06-25");
    expect(res.status).toBe("none");
  });

  it("resolveProduceAppendTarget requires seller_name and market_name", async () => {
    const round: Row = {
      id: "wr-1", source_id: "grp1", business_date: "2026-06-25",
      seller_name: "", market_name: "", round_seq: 1, status: "open",
      source_meta: null, created_at: "", updated_at: "",
    };
    const db  = makeDb([round]);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveProduceAppendTarget("grp1", "2026-06-25");
    expect(res.status).toBe("none");
  });

  it("RETURN_APPEND_ELIGIBLE_STATUSES is an explicit allowlist (not 'all except approved')", () => {
    // Intended lifecycle that may still receive a late return.
    const expectedEligible: WorkRoundStatus[] = [
      "awaiting_settlement", "awaiting_slips", "needs_correction", "open", "produce_complete",
    ];
    expect([...RETURN_APPEND_ELIGIBLE_STATUSES].sort()).toEqual(expectedEligible.sort());
    // approved is locked.
    expect(RETURN_APPEND_ELIGIBLE_STATUSES).not.toContain("approved");
    // Reconciliation states go through reviewer action, not a return append.
    expect(RETURN_APPEND_ELIGIBLE_STATUSES).not.toContain("variance_found");
    expect(RETURN_APPEND_ELIGIBLE_STATUSES).not.toContain("ready_for_review");
    // Guard against regressing back to a denylist: it must NOT cover every status.
    expect(RETURN_APPEND_ELIGIBLE_STATUSES.length).toBeLessThan(ALL_STATUSES.length);
  });

  it("PRODUCE_APPEND_ELIGIBLE_STATUSES stays open + produce_complete only", () => {
    const expectedProduce: WorkRoundStatus[] = ["open", "produce_complete"];
    expect([...PRODUCE_APPEND_ELIGIBLE_STATUSES].sort()).toEqual(expectedProduce.sort());
    expect(PRODUCE_APPEND_ELIGIBLE_STATUSES).not.toContain("needs_correction");
  });

  it("every WorkRoundStatus is explicitly classified for return append (no silent default)", () => {
    // Each enum status is either eligible or not — never undefined. If a new status
    // is added to the enum without updating ALL_STATUSES, this list desyncs and the
    // allowlist test above is no longer exhaustive.
    for (const status of ALL_STATUSES) {
      expect(typeof RETURN_APPEND_ELIGIBLE_STATUSES.includes(status)).toBe("boolean");
    }
    const nonEligible = ALL_STATUSES.filter((s) => !RETURN_APPEND_ELIGIBLE_STATUSES.includes(s));
    const expectedNonEligible: WorkRoundStatus[] = ["approved", "ready_for_review", "variance_found"];
    expect([...nonEligible].sort()).toEqual(expectedNonEligible.sort());
  });

  it("resolveProduceAppendTarget is 'ambiguous' for >1 eligible round (never silently picks latest)", async () => {
    const rounds: Row[] = [
      { id: "wr-1", source_id: "grp1", business_date: "2026-06-25", seller_name: "กี้",   market_name: "A", round_seq: 1, status: "open",             source_meta: null, created_at: "", updated_at: "" },
      { id: "wr-2", source_id: "grp1", business_date: "2026-06-25", seller_name: "พี่ดำ", market_name: "B", round_seq: 2, status: "produce_complete", source_meta: null, created_at: "", updated_at: "" },
    ];
    const db  = makeDb(rounds);
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveProduceAppendTarget("grp1", "2026-06-25");
    expect(res.status).toBe("ambiguous");
    if (res.status === "ambiguous") expect(res.candidates).toHaveLength(2);
  });
});
