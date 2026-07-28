import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { findLatestStockDataDate } from "./remaining-fruit-data";

/**
 * The latest-date lookup behind the empty stock report.
 *
 * The stub records every filter the query applied, because the guarantees that
 * matter here are the filters themselves: strictly-before, ชั่งคืน only, and a
 * single ordered row rather than a scan of history.
 */

interface Row {
  transaction_date?: string;
  market_name?: string | null;
}

interface Call {
  table: string;
  filters: Record<string, unknown>;
}

const TX_RETURN = "คืน";
const TX_WITHDRAW = "เบิก";
const TX_DAMAGED = "คืนเสีย";

/** `failOn` returns an error message for the query it wants to break. */
function client(
  rows: readonly (Row & { transaction_type?: string })[],
  failOn: (filters: Record<string, unknown>) => string | null = () => null,
  calls: Call[] = [],
) {
  const supabase = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const call: Call = { table, filters };
      calls.push(call);

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
      node.in = (column: string, values: unknown) => {
        filters[`in:${column}`] = values;
        return node;
      };

      const matching = () => {
        let result = [...rows];
        const before = filters["lt:transaction_date"] as string | undefined;
        if (before) result = result.filter((row) => (row.transaction_date ?? "") < before);
        const on = filters["eq:transaction_date"] as string | undefined;
        if (on) result = result.filter((row) => row.transaction_date === on);
        const types = filters["in:transaction_type"] as string[] | undefined;
        if (types) result = result.filter((row) => types.includes(row.transaction_type ?? ""));
        // The route orders by transaction_date descending for the date probe.
        return result.sort((a, b) => (b.transaction_date ?? "").localeCompare(a.transaction_date ?? ""));
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

function returnRow(date: string, market: string | null): Row & { transaction_type: string } {
  return { transaction_date: date, market_name: market, transaction_type: TX_RETURN };
}

describe("findLatestStockDataDate", () => {
  test("returns the closest prior date with ชั่งคืน and its market count", async () => {
    const { supabase } = client([
      returnRow("2026-07-20", "ตลาดกี้"),
      returnRow("2026-07-24", "ตลาดกี้"),
      returnRow("2026-07-24", "เฉลิม72 ผลไม้"),
      // Same market twice on the latest date counts once.
      returnRow("2026-07-24", "ตลาดกี้"),
    ]);

    expect(await findLatestStockDataDate(supabase, "2026-07-25")).toEqual({
      status: "found",
      hint: { date: "2026-07-24", marketCount: 2 },
    });
  });

  test("never selects the requested date itself or anything after it", async () => {
    const { supabase, calls } = client([
      returnRow("2026-07-24", "ตลาดกี้"),
      returnRow("2026-07-25", "ตลาดกี้"),
      returnRow("2026-07-26", "ตลาดกี้"),
    ]);

    const latest = await findLatestStockDataDate(supabase, "2026-07-25");

    expect(latest).toEqual({ status: "found", hint: { date: "2026-07-24", marketCount: 1 } });
    expect(calls[0].filters["lt:transaction_date"]).toBe("2026-07-25");
  });

  test("reports a PROVEN empty history as 'none'", async () => {
    const { supabase } = client([returnRow("2026-07-26", "ตลาดกี้")]);
    expect(await findLatestStockDataDate(supabase, "2026-07-25")).toEqual({ status: "none" });
  });

  test("a failed date probe throws — it never degrades to 'none'", async () => {
    const { supabase } = client(
      [returnRow("2026-07-24", "ตลาดกี้")],
      (filters) => (filters["lt:transaction_date"] ? "probe exploded" : null),
    );

    // "none" is a claim about the business's records; a database error is not
    // evidence for it. Throwing is what lets the caller say "unavailable".
    expect(findLatestStockDataDate(supabase, "2026-07-25")).rejects.toThrow("probe exploded");
  });

  test("a failed market count throws even though the date was found", async () => {
    const { supabase } = client(
      [returnRow("2026-07-24", "ตลาดกี้")],
      (filters) => (filters["eq:transaction_date"] ? "count exploded" : null),
    );

    // Half an answer is not an answer: the count is part of what the reader is
    // being told, so a date without it must not be presented at all.
    expect(findLatestStockDataDate(supabase, "2026-07-25")).rejects.toThrow("count exploded");
  });

  test("เบิก and คืนเสีย never make a date count as having stock data", async () => {
    const { supabase, calls } = client([
      { transaction_date: "2026-07-24", market_name: "ตลาดกี้", transaction_type: TX_WITHDRAW },
      { transaction_date: "2026-07-24", market_name: "ตลาดกี้", transaction_type: TX_DAMAGED },
      returnRow("2026-07-20", "ตลาดกี้"),
    ]);

    // Remaining stock means good return only — never เบิก − คืนเสีย.
    expect(await findLatestStockDataDate(supabase, "2026-07-25")).toEqual({
      status: "found",
      hint: { date: "2026-07-20", marketCount: 1 },
    });
    expect(calls[0].filters["in:transaction_type"]).toEqual([TX_RETURN]);
  });

  test("reads produce_transactions only — never a Physical Inventory table", async () => {
    const { supabase, calls } = client([returnRow("2026-07-24", "ตลาดกี้")]);
    await findLatestStockDataDate(supabase, "2026-07-25");

    expect(calls.map((call) => call.table)).toEqual([
      "produce_transactions",
      "produce_transactions",
    ]);
  });

  test("the date comes from one ordered row, not from scanning history", async () => {
    const { supabase, calls } = client([returnRow("2026-07-24", "ตลาดกี้")]);
    await findLatestStockDataDate(supabase, "2026-07-25");

    expect(calls[0].filters.limit).toBe(1);
    // The count query is bounded to that single business date.
    expect(calls[1].filters["eq:transaction_date"]).toBe("2026-07-24");
  });

  test("rows whose market cannot be resolved are not counted as a market", async () => {
    const { supabase } = client([
      returnRow("2026-07-24", "ตลาดกี้"),
      returnRow("2026-07-24", "รายการชั่งเบิก"),
      returnRow("2026-07-24", null),
    ]);

    expect(await findLatestStockDataDate(supabase, "2026-07-25")).toEqual({
      status: "found",
      hint: { date: "2026-07-24", marketCount: 1 },
    });
  });
});
