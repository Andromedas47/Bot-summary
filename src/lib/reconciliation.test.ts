import { describe, expect, it } from "bun:test";
import { loadAiVerifiedTransferTotal, reconcile } from "./reconciliation";

// ── Stub builder ──────────────────────────────────────────────────────────────
function makeFullSupabase(cfg: {
  openSession:     boolean;
  transferAmounts: number[];
  closedSessions:  string[];
  entryAmounts:    number[];
  transferRefs?:   (string | null)[]; // aligned with transferAmounts by index
  // Overrides the globally-earliest-winner rows returned for the cross-source
  // dedupe lookup. Defaults to each in-scope check winning its own reference
  // (i.e. no cross-source exclusion), preserving prior same-scope-only behavior.
  globalWinners?:  Array<{ id: string; reference_id: string; created_at: string }>;
  scopedOrder?:    number[];
  globalError?:    { message: string } | null;
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
                  data: [{ id: "ev1", market_label: null }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "slip_checks") {
        const allScopedChecks = cfg.transferAmounts.map((a, i) => ({
          id: `check-${i}`,
          evidence_id: "ev1",
          transfer_amount: a,
          reference_id: cfg.transferRefs?.[i] ?? null,
          created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        }));
        const scopedChecks = (cfg.scopedOrder ?? allScopedChecks.map((_, index) => index))
          .map((index) => allScopedChecks[index]);
        const defaultGlobalWinners = allScopedChecks
          .filter((c) => c.reference_id !== null)
          .map((c, i) => ({ id: c.id, reference_id: c.reference_id as string, created_at: `2026-01-01T00:00:0${i}Z` }));

        return {
          select: (columns: string) => {
            const isScopedQuery = columns.includes("transfer_amount");
            const builder = {
              in: () => builder,
              not: () => builder,
              order: () => builder,
              then: (resolve: (value: unknown) => void) => resolve({
                data: isScopedQuery
                  ? scopedChecks
                  : (cfg.globalWinners ?? defaultGlobalWinners),
                error: isScopedQuery ? null : (cfg.globalError ?? null),
              }),
            };
            return builder;
          },
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

describe("loadAiVerifiedTransferTotal", () => {
  for (const [label, scopedOrder] of [
    ["winner row first", [0, 1]],
    ["duplicate row first", [1, 0]],
  ] as const) {
    it(`counts the global winner exactly once with ${label}`, async () => {
      const db = makeFullSupabase({
        openSession: false,
        transferAmounts: [400, 400],
        transferRefs: ["REF-ORDER", "REF-ORDER"],
        scopedOrder: [...scopedOrder],
        closedSessions: [],
        entryAmounts: [],
        globalWinners: [
          {
            id: "check-0",
            reference_id: "REF-ORDER",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });

      await expect(
        loadAiVerifiedTransferTotal(db as never, "grp1", "2026-06-17"),
      ).resolves.toBe(400);
    });
  }

  it("keeps checks without reference ids independently countable", async () => {
    const db = makeFullSupabase({
      openSession: false,
      transferAmounts: [125, 275],
      transferRefs: [null, null],
      closedSessions: [],
      entryAmounts: [],
    });

    await expect(
      loadAiVerifiedTransferTotal(db as never, "grp1", "2026-06-17"),
    ).resolves.toBe(400);
  });

  it("fails closed when global reference resolution fails", async () => {
    const db = makeFullSupabase({
      openSession: false,
      transferAmounts: [400],
      transferRefs: ["REF-FAIL"],
      closedSessions: [],
      entryAmounts: [],
      globalError: { message: "resolver unavailable" },
    });

    await expect(
      loadAiVerifiedTransferTotal(db as never, "grp1", "2026-06-17"),
    ).rejects.toThrow("resolver unavailable");
  });

  it("fails closed when global resolution returns no winner for a scoped reference", async () => {
    const db = makeFullSupabase({
      openSession: false,
      transferAmounts: [400],
      transferRefs: ["REF-MISSING"],
      closedSessions: [],
      entryAmounts: [],
      globalWinners: [],
    });

    await expect(
      loadAiVerifiedTransferTotal(db as never, "grp1", "2026-06-17"),
    ).rejects.toThrow("global reference resolution incomplete");
  });
});

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

  it("excludes a reference_id already accepted earlier under a different source/market", async () => {
    const db = makeFullSupabase({
      openSession:     false,
      transferAmounts: [500, 300],           // REF-001 belongs to another source, 300 is untouched
      transferRefs:    ["REF-001", null],
      closedSessions:  [],
      entryAmounts:    [],
      // The globally-earliest accepted check for REF-001 is a different
      // record (from another source/business date), not this scope's check-0.
      globalWinners:   [{ id: "check-from-other-market", reference_id: "REF-001", created_at: "2020-01-01T00:00:00Z" }],
    });
    const result = await reconcile(db as never, "grp1", "2026-06-17", 300);
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.result.ai_verified_total).toBe(300); // 500 excluded, already claimed elsewhere
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
