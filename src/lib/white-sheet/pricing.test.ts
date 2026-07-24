import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  centralPriceKey,
  centralPriceMapKey,
  CentralPriceError,
  getCentralPrice,
  getCentralPriceHistory,
  loadCentralPricesForDate,
  setCentralPrice,
} from "./pricing";

type PriceRow = Database["public"]["Tables"]["central_selling_prices"]["Row"];
type CorrectionRow = Database["public"]["Tables"]["central_selling_price_corrections"]["Row"];

describe("centralPriceKey", () => {
  it("matches the same canonical identity calculate.ts uses (normalizeProductName + resolveUnitQuantity(...).unit)", () => {
    expect(centralPriceKey({ productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" })).toEqual({
      productKey: "แตงโม",
      unitKey: "โล",
      businessDate: "2026-07-24",
    });
  });

  it("resolves a conversion-source unit to its canonical target (ขีด -> โล)", () => {
    expect(centralPriceKey({ productName: "แตงโม", unit: "ขีด", businessDate: "2026-07-24" }).unitKey).toBe("โล");
  });

  it("rejects an invalid business date", () => {
    expect(() =>
      centralPriceKey({ productName: "แตงโม", unit: "โล", businessDate: "2026-02-30" }),
    ).toThrow(CentralPriceError);
  });

  it("rejects an empty product name", () => {
    expect(() =>
      centralPriceKey({ productName: "  ", unit: "โล", businessDate: "2026-07-24" }),
    ).toThrow(CentralPriceError);
  });
});

function makeFakeSupabase(options?: { prices?: PriceRow[]; corrections?: CorrectionRow[] }) {
  const prices = options?.prices ?? [];
  const corrections = options?.corrections ?? [];
  const rpcCalls: unknown[] = [];

  const database = {
    from(table: string) {
      if (table === "central_selling_prices") {
        return {
          select: () => {
            const filters: Array<{ column: string; value: unknown }> = [];
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.push({ column, value });
                return builder;
              },
              maybeSingle: async () => ({
                data: prices.find((p) => filters.every((f) => (p as Record<string, unknown>)[f.column] === f.value)) ?? null,
                error: null,
              }),
            };
            return {
              ...builder,
              then: undefined,
            };
          },
        };
      }
      if (table === "central_selling_price_corrections") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  order: async () => ({ data: corrections, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn !== "set_central_selling_price") return { data: null, error: { message: "unexpected rpc" } };
      const a = args as { p_product_key: string; p_unit_key: string; p_business_date: string; p_price_satang: number; p_actor: string; p_reason: string | null };
      const existing = prices.find((p) => p.product_key === a.p_product_key && p.unit_key === a.p_unit_key && p.business_date === a.p_business_date);
      const row: PriceRow = {
        id: existing?.id ?? "new-price-id",
        product_key: a.p_product_key,
        unit_key: a.p_unit_key,
        business_date: a.p_business_date,
        price_satang: a.p_price_satang,
        set_by: a.p_actor,
        set_reason: a.p_reason,
        created_at: existing?.created_at ?? "2026-07-24T00:00:00Z",
        updated_at: "2026-07-24T01:00:00Z",
      };
      if (existing) Object.assign(existing, row);
      else prices.push(row);
      return { data: row, error: null };
    },
  };

  return { database: database as unknown as SupabaseClient<Database>, prices, corrections, rpcCalls };
}

describe("getCentralPrice / setCentralPrice", () => {
  it("returns null when no price has been set", async () => {
    const { database } = makeFakeSupabase();
    const result = await getCentralPrice(database, { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" });
    expect(result).toBeNull();
  });

  it("sets an initial price via the atomic RPC and returns it in baht", async () => {
    const { database, rpcCalls } = makeFakeSupabase();
    const record = await setCentralPrice(database, {
      identity: { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" },
      priceBaht: 20,
      actor: "admin-1",
    });
    expect(record.priceBaht).toBe(20);
    expect(record.setBy).toBe("admin-1");
    expect(rpcCalls).toHaveLength(1);
  });

  it("never trusts a client-calculated total — only priceBaht/actor/reason are accepted", async () => {
    const { database } = makeFakeSupabase();
    const record = await setCentralPrice(database, {
      identity: { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" },
      priceBaht: 20,
      actor: "admin-1",
      // @ts-expect-error extra fields on the input object are structurally
      // ignored — setCentralPrice never reads anything but priceBaht/actor/reason.
      expectedSales: 999999,
    });
    expect(record.priceBaht).toBe(20);
  });

  it("rejects a negative price", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      setCentralPrice(database, {
        identity: { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" },
        priceBaht: -1,
        actor: "admin-1",
      }),
    ).rejects.toBeInstanceOf(CentralPriceError);
  });

  it("rejects a price with more than 2 decimal places", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      setCentralPrice(database, {
        identity: { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" },
        priceBaht: 20.999,
        actor: "admin-1",
      }),
    ).rejects.toBeInstanceOf(CentralPriceError);
  });

  it("rejects an empty actor", async () => {
    const { database } = makeFakeSupabase();
    await expect(
      setCentralPrice(database, {
        identity: { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" },
        priceBaht: 20,
        actor: "  ",
      }),
    ).rejects.toBeInstanceOf(CentralPriceError);
  });

  it("BR-04: a correction changes the effective price for the whole identity", async () => {
    const { database } = makeFakeSupabase();
    await setCentralPrice(database, {
      identity: { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" },
      priceBaht: 40,
      actor: "admin-1",
    });
    const corrected = await setCentralPrice(database, {
      identity: { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" },
      priceBaht: 45,
      actor: "admin-2",
      reason: "typo in initial entry",
    });
    expect(corrected.priceBaht).toBe(45);

    const reloaded = await getCentralPrice(database, { productName: "แตงโม", unit: "โล", businessDate: "2026-07-24" });
    expect(reloaded?.priceBaht).toBe(45);
  });
});

describe("getCentralPriceHistory", () => {
  it("returns the previous/new value, actor, and reason for each correction", async () => {
    const { database } = makeFakeSupabase({
      corrections: [
        {
          id: "c-1",
          price_id: "p-1",
          product_key: "แตงโม",
          unit_key: "โล",
          business_date: "2026-07-24",
          previous_price_satang: null,
          new_price_satang: 4000,
          actor: "admin-1",
          reason: null,
          created_at: "2026-07-24T00:00:00Z",
        },
        {
          id: "c-2",
          price_id: "p-1",
          product_key: "แตงโม",
          unit_key: "โล",
          business_date: "2026-07-24",
          previous_price_satang: 4000,
          new_price_satang: 4500,
          actor: "admin-2",
          reason: "typo in initial entry",
          created_at: "2026-07-24T01:00:00Z",
        },
      ],
    });

    const history = await getCentralPriceHistory(database, {
      productName: "แตงโม",
      unit: "โล",
      businessDate: "2026-07-24",
    });

    expect(history).toEqual([
      { previousPriceBaht: null, newPriceBaht: 40, actor: "admin-1", reason: null, createdAt: "2026-07-24T00:00:00Z" },
      { previousPriceBaht: 40, newPriceBaht: 45, actor: "admin-2", reason: "typo in initial entry", createdAt: "2026-07-24T01:00:00Z" },
    ]);
  });
});

describe("loadCentralPricesForDate / centralPriceMapKey", () => {
  it("loads every price for a date keyed by centralPriceMapKey", async () => {
    // loadCentralPricesForDate uses .eq("business_date", ...) only (no
    // maybeSingle chain), unlike the select() shape makeFakeSupabase's
    // central_selling_prices stub above supports — a dedicated fake matches
    // that shape directly.
    const patched = {
      from: (table: string) => {
        if (table === "central_selling_prices") {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  { product_key: "แตงโม", unit_key: "โล", price_satang: 2000 },
                  { product_key: "มะม่วง", unit_key: "ลูก", price_satang: 500 },
                ],
                error: null,
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient<Database>;

    const map = await loadCentralPricesForDate(patched, "2026-07-24");
    expect(map.get(centralPriceMapKey("แตงโม", "โล"))).toBe(2000);
    expect(map.get(centralPriceMapKey("มะม่วง", "ลูก"))).toBe(500);
  });

  it("fails closed on a duplicate product/unit key for the same date", async () => {
    const patched = {
      from: (table: string) => {
        if (table === "central_selling_prices") {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  { product_key: "แตงโม", unit_key: "โล", price_satang: 2000 },
                  { product_key: "แตงโม", unit_key: "โล", price_satang: 2500 },
                ],
                error: null,
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient<Database>;

    await expect(loadCentralPricesForDate(patched, "2026-07-24")).rejects.toBeInstanceOf(CentralPriceError);
  });
});
