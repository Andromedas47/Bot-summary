import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  loadWhiteSheetCashEntry,
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

/**
 * In-memory fake mirroring the real table's uniqueness key. Supports the
 * exact chain shapes persist.ts calls: select().eq().eq().eq().maybeSingle()
 * for reads, upsert().select().single() for writes.
 */
function makeFakeSupabase(seed: Row[] = []) {
  const rows = new Map<string, Row>(
    seed.map((row) => [rowKey(row.source_id, row.market_label_normalized, row.business_date), row]),
  );

  const database = {
    from(table: string) {
      if (table !== "digital_white_sheet_cash_entries") {
        throw new Error(`unexpected table: ${table}`);
      }

      return {
        select: () => {
          const filters: Record<string, string> = {};
          const builder = {
            eq: (column: string, value: string) => {
              filters[column] = value;
              return builder;
            },
            maybeSingle: async () => {
              const key = rowKey(
                filters.source_id,
                filters.market_label_normalized,
                filters.business_date,
              );
              return { data: rows.get(key) ?? null, error: null };
            },
          };
          return builder;
        },
        upsert: (values: Partial<Row>) => ({
          select: () => ({
            single: async () => {
              const key = rowKey(
                values.source_id!,
                values.market_label_normalized!,
                values.business_date!,
              );
              const existing = rows.get(key);
              const merged: Row = {
                id: existing?.id ?? "new-id",
                created_at: existing?.created_at ?? "2026-07-24T00:00:00Z",
                ...values,
              } as Row;
              rows.set(key, merged);
              return { data: merged, error: null };
            },
          }),
        }),
      };
    },
  };

  return { database: database as unknown as SupabaseClient<Database>, rows };
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
