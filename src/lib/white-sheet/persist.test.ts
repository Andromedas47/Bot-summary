import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  finalizeWhiteSheetCashEntry,
  loadWhiteSheetCashEntry,
  reopenWhiteSheetCashEntry,
  saveWhiteSheetCashEntry,
  WhiteSheetPersistenceError,
} from "./persist";

type Row = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

const IDENTITY = {
  sourceId: "group-1",
  marketLabelNormalized: "ตลาดเอ",
  businessDate: "2026-07-24",
};

function rowKey(sourceId: string, marketLabelNormalized: string, businessDate: string): string {
  return `${sourceId}::${marketLabelNormalized}::${businessDate}`;
}

let nextId = 1;

/**
 * In-memory fake mirroring the real table. Supports every chain shape
 * persist.ts calls: select().eq().eq().eq().maybeSingle() for reads,
 * insert().select().single() for first-time saves,
 * update().eq().is().select().maybeSingle() for corrections/finalize/reopen.
 * Filters are matched generically (eq/is) against the full row, not just the
 * composite key, so the id-based update path used by finalize/reopen works
 * the same way the real table would.
 */
function makeFakeSupabase(seed: Array<Partial<Row> & Pick<Row, "source_id" | "market_label_normalized" | "business_date">> = []) {
  const rows = new Map<string, Row>(
    seed.map((row) => {
      const full: Row = {
        id: `seed-${rowKey(row.source_id, row.market_label_normalized, row.business_date)}`,
        labor: 0,
        location_fee: 0,
        bag: 0,
        snack: 0,
        other: 0,
        other_note: null,
        actual_cash_submitted: 0,
        created_at: "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T00:00:00Z",
        finalized_at: null,
        finalized_by: null,
        ...row,
      };
      return [full.id, full];
    }),
  );

  type Filter = { op: "eq" | "is" | "not"; column: string; value: unknown };

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every(({ op, column, value }) => {
      const actual = (row as Record<string, unknown>)[column];
      return op === "not" ? actual !== value : actual === value;
    });
  }

  const lifecycleEvents: Array<{ event: string; actor: string; reason?: string | null }> = [];

  const database = {
    from(table: string) {
      if (table === "white_sheet_lifecycle_events") {
        return {
          insert: (values: { event: string; actor: string; reason?: string | null }) => {
            lifecycleEvents.push(values);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table !== "digital_white_sheet_cash_entries") {
        throw new Error(`unexpected table: ${table}`);
      }

      return {
        select: () => {
          const filters: Filter[] = [];
          const builder = {
            eq: (column: string, value: unknown) => {
              filters.push({ op: "eq", column, value });
              return builder;
            },
            is: (column: string, value: unknown) => {
              filters.push({ op: "is", column, value });
              return builder;
            },
            maybeSingle: async () => {
              const found = [...rows.values()].find((row) => matches(row, filters));
              return { data: found ?? null, error: null };
            },
          };
          return builder;
        },
        insert: (values: Partial<Row>) => ({
          select: () => ({
            single: async () => {
              const id = `new-${nextId++}`;
              const merged: Row = {
                id,
                created_at: "2026-07-24T00:00:00Z",
                updated_at: "2026-07-24T00:00:00Z",
                other_note: null,
                finalized_at: null,
                finalized_by: null,
                ...values,
              } as Row;
              rows.set(id, merged);
              return { data: merged, error: null };
            },
          }),
        }),
        update: (values: Partial<Row>) => {
          const filters: Filter[] = [];
          const builder = {
            eq: (column: string, value: unknown) => {
              filters.push({ op: "eq", column, value });
              return builder;
            },
            is: (column: string, value: unknown) => {
              filters.push({ op: "is", column, value });
              return builder;
            },
            not: (column: string, _isOp: string, value: unknown) => {
              filters.push({ op: "not", column, value });
              return builder;
            },
            select: () => ({
              maybeSingle: async () => {
                const found = [...rows.entries()].find(([, row]) => matches(row, filters));
                if (!found) return { data: null, error: null };
                const [id, existing] = found;
                const merged: Row = { ...existing, ...values, updated_at: "2026-07-24T01:00:00Z" } as Row;
                rows.set(id, merged);
                return { data: merged, error: null };
              },
            }),
          };
          return builder;
        },
      };
    },
  };

  return { database: database as unknown as SupabaseClient<Database>, rows, lifecycleEvents };
}

// ── loadWhiteSheetCashEntry ─────────────────────────────────────────────────

describe("loadWhiteSheetCashEntry", () => {
  it("returns not_submitted when no row exists for the identity", async () => {
    const { database } = makeFakeSupabase();
    const result = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(result).toEqual({ status: "not_submitted" });
  });

  it("returns the submitted entry when a row exists", async () => {
    const { database } = makeFakeSupabase([
      {
        id: "row-1",
        source_id: IDENTITY.sourceId,
        market_label_normalized: IDENTITY.marketLabelNormalized,
        business_date: IDENTITY.businessDate,
        labor: 100,
        location_fee: 50,
        bag: 10,
        snack: 5,
        other: 20,
        other_note: "ค่าน้ำแข็ง",
        actual_cash_submitted: 1000,
        created_at: "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T01:00:00Z",
      },
    ]);

    const result = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(result).toEqual({
      status: "submitted",
      expenses: {
        labor: 100,
        locationFee: 50,
        bag: 10,
        snack: 5,
        other: 20,
        otherNote: "ค่าน้ำแข็ง",
      },
      actualCashSubmitted: 1000,
      updatedAt: "2026-07-24T01:00:00Z",
    });
  });

  it("does not confuse a different business date for the same source/market", async () => {
    const { database } = makeFakeSupabase([
      {
        id: "row-1",
        source_id: IDENTITY.sourceId,
        market_label_normalized: IDENTITY.marketLabelNormalized,
        business_date: "2026-07-23",
        labor: 100,
        location_fee: 0,
        bag: 0,
        snack: 0,
        other: 0,
        other_note: null,
        actual_cash_submitted: 500,
        created_at: "2026-07-23T00:00:00Z",
        updated_at: "2026-07-23T00:00:00Z",
      },
    ]);

    const result = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(result).toEqual({ status: "not_submitted" });
  });

  it("does not confuse a different market for the same source/date", async () => {
    const { database } = makeFakeSupabase([
      {
        id: "row-1",
        source_id: IDENTITY.sourceId,
        market_label_normalized: "ตลาดบี",
        business_date: IDENTITY.businessDate,
        labor: 100,
        location_fee: 0,
        bag: 0,
        snack: 0,
        other: 0,
        other_note: null,
        actual_cash_submitted: 500,
        created_at: "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T00:00:00Z",
      },
    ]);

    const result = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(result).toEqual({ status: "not_submitted" });
  });

  it("rejects an empty sourceId", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      loadWhiteSheetCashEntry(database, { ...IDENTITY, sourceId: "   " }),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });

  it("rejects a malformed businessDate", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      loadWhiteSheetCashEntry(database, { ...IDENTITY, businessDate: "24-07-2026" }),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });
});

// ── saveWhiteSheetCashEntry ──────────────────────────────────────────────────

const VALID_SAVE_INPUT = {
  ...IDENTITY,
  labor: 100,
  locationFee: 50,
  bag: 10,
  snack: 5,
  other: 20,
  otherNote: "ค่าน้ำแข็ง",
  actualCashSubmitted: 1000,
};

describe("saveWhiteSheetCashEntry", () => {
  it("upserts and returns the submitted state", async () => {
    const { database } = makeFakeSupabase();
    const result = await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    expect(result.status).toBe("submitted");
    if (result.status === "submitted") {
      expect(result.expenses).toEqual({
        labor: 100,
        locationFee: 50,
        bag: 10,
        snack: 5,
        other: 20,
        otherNote: "ค่าน้ำแข็ง",
      });
      expect(result.actualCashSubmitted).toBe(1000);
    }
  });

  it("last-write-wins: a second save overwrites the first for the same identity", async () => {
    const { database } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    const second = await saveWhiteSheetCashEntry(database, {
      ...VALID_SAVE_INPUT,
      labor: 200,
      actualCashSubmitted: 2000,
    });
    expect(second.status).toBe("submitted");
    if (second.status === "submitted") {
      expect(second.expenses.labor).toBe(200);
      expect(second.actualCashSubmitted).toBe(2000);
    }

    const reloaded = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(reloaded.status).toBe("submitted");
    if (reloaded.status === "submitted") {
      expect(reloaded.expenses.labor).toBe(200);
    }
  });

  it("a different market under the same source/date does not overwrite the original entry", async () => {
    const { database } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    await saveWhiteSheetCashEntry(database, {
      ...VALID_SAVE_INPUT,
      marketLabelNormalized: "ตลาดบี",
      labor: 999,
    });

    const original = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(original.status).toBe("submitted");
    if (original.status === "submitted") {
      expect(original.expenses.labor).toBe(100);
    }
  });

  it("a different business date under the same source/market does not overwrite the original entry", async () => {
    const { database } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    await saveWhiteSheetCashEntry(database, {
      ...VALID_SAVE_INPUT,
      businessDate: "2026-07-25",
      labor: 999,
    });

    const original = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(original.status).toBe("submitted");
    if (original.status === "submitted") {
      expect(original.expenses.labor).toBe(100);
    }
  });

  it("trims and clears a whitespace-only otherNote to null", async () => {
    const { database } = makeFakeSupabase();
    const result = await saveWhiteSheetCashEntry(database, {
      ...VALID_SAVE_INPUT,
      otherNote: "   ",
    });
    expect(result.status).toBe("submitted");
    if (result.status === "submitted") {
      expect(result.expenses.otherNote).toBeUndefined();
    }
  });

  it("rejects otherNote longer than 1000 characters", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      saveWhiteSheetCashEntry(database, {
        ...VALID_SAVE_INPUT,
        otherNote: "a".repeat(1001),
      }),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });

  it("rejects a negative money field", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      saveWhiteSheetCashEntry(database, { ...VALID_SAVE_INPUT, bag: -1 }),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });

  it("rejects a non-finite money field", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      saveWhiteSheetCashEntry(database, { ...VALID_SAVE_INPUT, other: Number.NaN }),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });

  it("rejects more than 2 decimal places", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      saveWhiteSheetCashEntry(database, { ...VALID_SAVE_INPUT, labor: 100.123 }),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });

  it("rejects a missing identity field", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      saveWhiteSheetCashEntry(database, { ...VALID_SAVE_INPUT, sourceId: "" }),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });

  it("rejects an invalid calendar date", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      saveWhiteSheetCashEntry(database, { ...VALID_SAVE_INPUT, businessDate: "2026-02-30" }),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });

  it("normalizes float noise to a clean 2-decimal value", async () => {
    const { database } = makeFakeSupabase();
    const result = await saveWhiteSheetCashEntry(database, {
      ...VALID_SAVE_INPUT,
      labor: 19.999999999999996,
    });
    expect(result.status).toBe("submitted");
    if (result.status === "submitted") {
      expect(result.expenses.labor).toBe(20);
    }
  });
});

// ── BR-06 lifecycle: SUBMITTED -> FINALIZED -> (reopen) -> SUBMITTED ────────

describe("White Sheet lifecycle (finalize/reopen)", () => {
  it("NOT_SUBMITTED -> SUBMITTED via normal save", async () => {
    const { database } = makeFakeSupabase();
    const submitted = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(submitted).toEqual({ status: "not_submitted" });

    const result = await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    expect(result.status).toBe("submitted");
  });

  it("allows normal correction while SUBMITTED", async () => {
    const { database } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    const corrected = await saveWhiteSheetCashEntry(database, { ...VALID_SAVE_INPUT, labor: 500 });
    expect(corrected.status).toBe("submitted");
    if (corrected.status === "submitted") {
      expect(corrected.expenses.labor).toBe(500);
    }
  });

  it("admin finalize transitions SUBMITTED -> FINALIZED and records an audit event", async () => {
    const { database, lifecycleEvents } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);

    const finalized = await finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-1");
    expect(finalized.status).toBe("finalized");
    if (finalized.status === "finalized") {
      expect(finalized.finalizedBy).toBe("admin-1");
    }
    expect(lifecycleEvents.map(({ event, actor }) => ({ event, actor }))).toEqual([
      { event: "finalized", actor: "admin-1" },
    ]);

    const reloaded = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(reloaded.status).toBe("finalized");
  });

  it("rejects finalize when there is no SUBMITTED entry", async () => {
    const { database } = makeFakeSupabase();
    await expect(finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-1")).rejects.toThrow(
      WhiteSheetPersistenceError,
    );
  });

  it("rejects finalize when already finalized", async () => {
    const { database } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    await finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-1");
    await expect(finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-2")).rejects.toThrow(
      WhiteSheetPersistenceError,
    );
  });

  it("normal resubmission is rejected after FINALIZED", async () => {
    const { database } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    await finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-1");

    await expect(
      saveWhiteSheetCashEntry(database, { ...VALID_SAVE_INPUT, labor: 999 }),
    ).rejects.toThrow(WhiteSheetPersistenceError);

    const stillFinalized = await loadWhiteSheetCashEntry(database, IDENTITY);
    expect(stillFinalized.status).toBe("finalized");
    if (stillFinalized.status === "finalized") {
      expect(stillFinalized.expenses.labor).toBe(100);
    }
  });

  it("explicit privileged reopen returns the entry to SUBMITTED and records a reason", async () => {
    const { database, lifecycleEvents } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    await finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-1");

    const reopened = await reopenWhiteSheetCashEntry(database, IDENTITY, "admin-2", "operator reported a typo");
    expect(reopened.status).toBe("submitted");
    expect(lifecycleEvents.map(({ event, actor, reason }) => ({ event, actor, reason }))).toEqual([
      { event: "finalized", actor: "admin-1", reason: undefined },
      { event: "reopened", actor: "admin-2", reason: "operator reported a typo" },
    ]);

    // Normal submission works again after reopen.
    const corrected = await saveWhiteSheetCashEntry(database, { ...VALID_SAVE_INPUT, labor: 700 });
    expect(corrected.status).toBe("submitted");
    if (corrected.status === "submitted") {
      expect(corrected.expenses.labor).toBe(700);
    }
  });

  it("rejects reopen with an empty reason", async () => {
    const { database } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    await finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-1");
    await expect(reopenWhiteSheetCashEntry(database, IDENTITY, "admin-2", "  ")).rejects.toThrow(
      WhiteSheetPersistenceError,
    );
  });

  it("rejects reopen when the entry is not finalized", async () => {
    const { database } = makeFakeSupabase();
    await saveWhiteSheetCashEntry(database, VALID_SAVE_INPUT);
    await expect(
      reopenWhiteSheetCashEntry(database, IDENTITY, "admin-2", "no reason needed"),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });
});
