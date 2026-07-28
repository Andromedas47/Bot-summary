import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { findLatestSalesDataDate } from "./load";

/**
 * The latest-date lookup behind the empty sales report.
 *
 * The stub records which tables were read, because half the guarantee here is
 * what is NOT consulted: slips, settlements, cash, purchases and P2A snapshots
 * are all separate tables and must stay unreachable from this path.
 */

interface Row {
  transaction_date?: string;
  market_name?: string | null;
}

interface Call {
  table: string;
  filters: Record<string, unknown>;
}

/** `failOn` returns an error message for the query it wants to break. */
function client(
  rows: readonly Row[],
  failOn: (filters: Record<string, unknown>) => string | null = () => null,
) {
  const calls: Call[] = [];

  const supabase = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      calls.push({ table, filters });

      const node: Record<string, unknown> = {};
      const self = () => node;
      node.select = self;
      node.order = self;

      node.lt = (column: string, value: unknown) => {
        filters[`lt:${column}`] = value;
        return node;
      };
      node.eq = (column: string, value: unknown) => {
        filters[`eq:${column}`] = value;
        return node;
      };

      const matching = () => {
        let result = [...rows];
        const before = filters["lt:transaction_date"] as string | undefined;
        if (before) result = result.filter((row) => (row.transaction_date ?? "") < before);
        const on = filters["eq:transaction_date"] as string | undefined;
        if (on) result = result.filter((row) => row.transaction_date === on);
        return result.sort((a, b) =>
          (b.transaction_date ?? "").localeCompare(a.transaction_date ?? ""),
        );
      };

      const answer = (slice: () => Row[]) => {
        const failure = failOn(filters);
        return Promise.resolve(
          failure ? { data: null, error: { message: failure } } : { data: slice(), error: null },
        );
      };

      node.limit = (n: number) => {
        filters.limit = n;
        return answer(() => matching().slice(0, n));
      };
      node.range = (from: number, to: number) => answer(() => matching().slice(from, to + 1));

      return node;
    },
  };

  return { supabase: supabase as unknown as SupabaseClient<Database>, calls };
}

describe("findLatestSalesDataDate", () => {
  test("returns the closest prior date with sales evidence and its market count", async () => {
    const { supabase } = client([
      { transaction_date: "2026-07-18", market_name: "ตลาดกี้" },
      { transaction_date: "2026-07-24", market_name: "ตลาดกี้" },
      { transaction_date: "2026-07-24", market_name: "เฉลิม72 ผลไม้" },
      { transaction_date: "2026-07-24", market_name: "ตลาดกี้" },
    ]);

    expect(await findLatestSalesDataDate(supabase, "2026-07-25")).toEqual({
      status: "found",
      hint: { date: "2026-07-24", marketCount: 2 },
    });
  });

  test("searches strictly backwards — future data is never selected", async () => {
    const { supabase, calls } = client([
      { transaction_date: "2026-07-24", market_name: "ตลาดกี้" },
      { transaction_date: "2026-07-25", market_name: "ตลาดกี้" },
      { transaction_date: "2026-08-01", market_name: "ตลาดกี้" },
    ]);

    expect(await findLatestSalesDataDate(supabase, "2026-07-25")).toEqual({
      status: "found",
      hint: { date: "2026-07-24", marketCount: 1 },
    });
    expect(calls[0].filters["lt:transaction_date"]).toBe("2026-07-25");
  });

  test("reports a PROVEN empty history as 'none'", async () => {
    const { supabase } = client([{ transaction_date: "2026-07-26", market_name: "ตลาดกี้" }]);
    expect(await findLatestSalesDataDate(supabase, "2026-07-25")).toEqual({ status: "none" });
  });

  test("a failed date probe throws — it never degrades to 'none'", async () => {
    const { supabase } = client(
      [{ transaction_date: "2026-07-24", market_name: "ตลาดกี้" }],
      (filters) => (filters["lt:transaction_date"] ? "probe exploded" : null),
    );

    // "none" claims the business has never sold anything. A database error is
    // not evidence for that; throwing is what lets the caller say "unavailable".
    expect(findLatestSalesDataDate(supabase, "2026-07-25")).rejects.toThrow("probe exploded");
  });

  test("a failed market count throws even though the date was found", async () => {
    const { supabase } = client(
      [{ transaction_date: "2026-07-24", market_name: "ตลาดกี้" }],
      (filters) => (filters["eq:transaction_date"] ? "count exploded" : null),
    );

    expect(findLatestSalesDataDate(supabase, "2026-07-25")).rejects.toThrow("count exploded");
  });

  test("QA/test scopes are excluded from the market count, as in the report", async () => {
    const { supabase } = client([
      { transaction_date: "2026-07-24", market_name: "ตลาดกี้" },
      { transaction_date: "2026-07-24", market_name: "ทดสอบไวท์ชีท" },
      { transaction_date: "2026-07-24", market_name: "QAไวท์ชีท" },
    ]);

    expect(await findLatestSalesDataDate(supabase, "2026-07-25")).toEqual({
      status: "found",
      hint: { date: "2026-07-24", marketCount: 1 },
    });
  });

  test("reads produce_transactions only — no slips, cash or settlements", async () => {
    const { supabase, calls } = client([{ transaction_date: "2026-07-24", market_name: "ตลาดกี้" }]);
    await findLatestSalesDataDate(supabase, "2026-07-25");

    expect(calls.map((call) => call.table)).toEqual([
      "produce_transactions",
      "produce_transactions",
    ]);
  });

  test("the date comes from one ordered row, and the count from that date alone", async () => {
    const { supabase, calls } = client([{ transaction_date: "2026-07-24", market_name: "ตลาดกี้" }]);
    await findLatestSalesDataDate(supabase, "2026-07-25");

    expect(calls[0].filters.limit).toBe(1);
    expect(calls[1].filters["eq:transaction_date"]).toBe("2026-07-24");
  });

  test("rows whose market cannot be resolved are not counted as a market", async () => {
    const { supabase } = client([
      { transaction_date: "2026-07-24", market_name: "ตลาดกี้" },
      { transaction_date: "2026-07-24", market_name: null },
    ]);

    expect(await findLatestSalesDataDate(supabase, "2026-07-25")).toEqual({
      status: "found",
      hint: { date: "2026-07-24", marketCount: 1 },
    });
  });
});
