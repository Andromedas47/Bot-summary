import { describe, expect, it } from "bun:test";
import { reconcile } from "./reconciliation";

// ── Stub builder ──────────────────────────────────────────────────────────────
function makeFullSupabase(cfg: {
  openSession:     boolean;
  transferAmounts: number[];
  closedSessions:  string[];
  entryAmounts:    number[];
  transferRefs?:   (string | null)[]; // aligned with transferAmounts by index
}) {
  let manualSessionCallCount = 0;

  return {
    from(table: string) {
      if (table === "manual_slip_sessions") {
        manualSessionCallCount++;
        const callNum = manualSessionCallCount;
        return {
          select: () => ({
            eq: (_c: string, _v: unknown) => ({
              eq: (_c2: string, _v2: unknown) => ({
                eq: (_c3: string, _v3: unknown) => ({
                  maybeSingle: async () => ({
                    data: (cfg.openSession && callNum === 1) ? { id: "open-sess" } : null,
                    error: null,
                  }),
                  async then(resolve: (v: unknown) => void) {
                    return resolve({
                      data: cfg.closedSessions.map(id => ({ id })),
                      error: null,
                    });
                  },
                }),
              }),
            }),
          }),
        };
      }

      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({
                  data: ["ev1"].map(id => ({ id })),
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "slip_checks") {
        return {
          select: () => ({
            in: () => ({
              in: () => ({
                not: async () => ({
                  data: cfg.transferAmounts.map((a, i) => ({
                    transfer_amount: a,
                    reference_id: cfg.transferRefs?.[i] ?? null,
                  })),
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "manual_slip_entries") {
        return {
          select: () => ({
            in: async () => ({
              data: cfg.entryAmounts.map(a => ({ amount: a })),
              error: null,
            }),
          }),
        };
      }

      if (table === "transfer_reconciliations") {
        return {
          upsert: (row: unknown, _opts: unknown) => ({
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          }),
        };
      }

      throw new Error(`unexpected table: ${table}`);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reconcile", () => {
  it("blocks when there is an open manual session", async () => {
    const db = makeFullSupabase({
      openSession: true, transferAmounts: [], closedSessions: [], entryAmounts: [],
    });
    const result = await reconcile(db as never, "grp1", "2026-06-17", 1000);
    expect(result.blocked).toBe(true);
  });

  it("returns matched=true when submitted equals checked total", async () => {
    const db = makeFullSupabase({
      openSession:     false,
      transferAmounts: [500, 300],   // ai verified = 800
      closedSessions:  ["sess1"],
      entryAmounts:    [200],        // manual = 200
    });
    const result = await reconcile(db as never, "grp1", "2026-06-17", 1000);
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.result.ai_verified_total).toBe(800);
      expect(result.result.manual_slip_total).toBe(200);
      expect(result.result.checked_slip_total).toBe(1000);
      expect(result.result.matched).toBe(true);
      expect(result.result.difference).toBe(0);
    }
  });

  it("returns matched=false and correct difference when amounts differ", async () => {
    const db = makeFullSupabase({
      openSession:     false,
      transferAmounts: [500],   // ai = 500
      closedSessions:  [],
      entryAmounts:    [],      // manual = 0
    });
    const result = await reconcile(db as never, "grp1", "2026-06-17", 600);
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.result.matched).toBe(false);
      expect(result.result.difference).toBe(100);  // 600 - 500
    }
  });

  it("counts a duplicated reference_id only once in the AI total", async () => {
    const db = makeFullSupabase({
      openSession:     false,
      transferAmounts: [500, 500, 300],           // same slip sent twice + one distinct
      transferRefs:    ["REF-001", "REF-001", null],
      closedSessions:  [],
      entryAmounts:    [],
    });
    const result = await reconcile(db as never, "grp1", "2026-06-17", 800);
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.result.ai_verified_total).toBe(800); // 500 + 300, duplicate skipped
      expect(result.result.matched).toBe(true);
    }
  });

  it("sums satang decimals without float drift (0.1 + 0.2 matches 0.3)", async () => {
    const db = makeFullSupabase({
      openSession:     false,
      transferAmounts: [100.1, 200.2],
      closedSessions:  [],
      entryAmounts:    [],
    });
    const result = await reconcile(db as never, "grp1", "2026-06-17", 300.3);
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.result.matched).toBe(true);
      expect(result.result.difference).toBe(0);
    }
  });

  it("handles zero AI and zero manual totals", async () => {
    const db = makeFullSupabase({
      openSession: false, transferAmounts: [], closedSessions: [], entryAmounts: [],
    });
    // Override slip_evidences to return empty so evidenceIds = [] and checks are skipped
    const result = await reconcile(
      { ...db, from: (t: string) => t === "slip_evidences"
        ? { select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }
        : db.from(t)
      } as never,
      "grp1", "2026-06-17", 0,
    );
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.result.checked_slip_total).toBe(0);
      expect(result.result.matched).toBe(true);
    }
  });
});
