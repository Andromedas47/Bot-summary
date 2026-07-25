import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  buildWhiteSheetMarketScopeOptions,
  listWhiteSheetMarketScopesForDate,
  resolveWhiteSheetMarketScopeSelection,
  whiteSheetMarketScopeKey,
} from "./market-scopes";

const SOURCE_A = "Ccfac33c4e435ae95c5eaa04dbebff209";
const SOURCE_B = "Cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VOIDED_MARKET = "ทดสอบราคาสอง";
const BUSINESS_DATE = "2026-07-25";

describe("buildWhiteSheetMarketScopeOptions", () => {
  test("resolves human-readable market options with correct source_id", () => {
    const options = buildWhiteSheetMarketScopeOptions(
      [
        { market_name: "ทดสอบเงินโอน", raw_message_id: "raw-1" },
        { market_name: "ทดสอบเงินโอน เบิก", raw_message_id: "raw-1" },
      ],
      new Map([["raw-1", SOURCE_A]]),
    );

    expect(options).toHaveLength(1);
    expect(options[0].sourceId).toBe(SOURCE_A);
    expect(options[0].marketLabel).toBe("ทดสอบเงินโอน");
    expect(options[0].displayLabel).toBe("ทดสอบเงินโอน");
  });

  test("different sources with different markets do not leak into each other", () => {
    const options = buildWhiteSheetMarketScopeOptions(
      [
        { market_name: "ตลาดกี้", raw_message_id: "raw-a" },
        { market_name: "ตลาดน้อย", raw_message_id: "raw-b" },
      ],
      new Map([
        ["raw-a", SOURCE_A],
        ["raw-b", SOURCE_B],
      ]),
    );

    expect(options).toHaveLength(2);
    const gee = options.find((o) => o.marketLabel === "ตลาดกี้");
    const noi = options.find((o) => o.marketLabel === "ตลาดน้อย");
    expect(gee?.sourceId).toBe(SOURCE_A);
    expect(noi?.sourceId).toBe(SOURCE_B);
  });

  test("same market label on two sources gets a disambiguating suffix", () => {
    const options = buildWhiteSheetMarketScopeOptions(
      [
        { market_name: "ตลาดกี้", raw_message_id: "raw-a" },
        { market_name: "ตลาดกี้", raw_message_id: "raw-b" },
      ],
      new Map([
        ["raw-a", SOURCE_A],
        ["raw-b", SOURCE_B],
      ]),
    );

    expect(options).toHaveLength(2);
    expect(options.every((o) => o.displayLabel.includes("…"))).toBe(true);
    expect(options.map((o) => o.sourceId).sort()).toEqual([SOURCE_A, SOURCE_B].sort());
  });

  test("skips rows with unresolvable market or missing source (fail closed)", () => {
    const options = buildWhiteSheetMarketScopeOptions(
      [
        { market_name: "เบิก", raw_message_id: "raw-1" },
        { market_name: "ตลาดกี้", raw_message_id: "raw-missing" },
        { market_name: null, raw_message_id: "raw-1" },
      ],
      new Map([["raw-1", SOURCE_A]]),
    );
    expect(options).toHaveLength(0);
  });
});

describe("resolveWhiteSheetMarketScopeSelection", () => {
  const options = buildWhiteSheetMarketScopeOptions(
    [
      { market_name: "ทดสอบเงินโอน", raw_message_id: "raw-1" },
      { market_name: "ตลาดน้อย", raw_message_id: "raw-2" },
    ],
    new Map([
      ["raw-1", SOURCE_A],
      ["raw-2", SOURCE_B],
    ]),
  );

  test("resolves the selected option to the correct source_id + market", () => {
    const key = whiteSheetMarketScopeKey(SOURCE_A, "ทดสอบเงินโอน");
    const result = resolveWhiteSheetMarketScopeSelection(options, key);
    expect(result).toEqual({
      ok: true,
      sourceId: SOURCE_A,
      marketLabel: "ทดสอบเงินโอน",
    });
  });

  test("fails visibly when unselected or unknown", () => {
    expect(resolveWhiteSheetMarketScopeSelection(options, "").ok).toBe(false);
    expect(
      resolveWhiteSheetMarketScopeSelection(
        options,
        whiteSheetMarketScopeKey("Cunknown", "ทดสอบเงินโอน"),
      ).ok,
    ).toBe(false);
  });

  test("does not return another market's source", () => {
    const key = whiteSheetMarketScopeKey(SOURCE_B, "ตลาดน้อย");
    const result = resolveWhiteSheetMarketScopeSelection(options, key);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceId).toBe(SOURCE_B);
      expect(result.marketLabel).toBe("ตลาดน้อย");
      expect(result.sourceId).not.toBe(SOURCE_A);
    }
  });
});

describe("scope discovery vs trusted financial load (void separation)", () => {
  /**
   * Production Void UAT: market ทดสอบราคาสอง / 2026-07-25 had one produce
   * session that was voided → produce_transactions empty, but
   * produce_transactions_all still holds audit identity. Selector must keep
   * the market discoverable; financial loader remains on produce_transactions.
   */
  test("voided-only market/date remains discoverable from audit identity", async () => {
    const tablesTouched: string[] = [];

    const database = {
      from(table: string) {
        tablesTouched.push(table);
        if (table === "produce_transactions") {
          throw new Error(
            "scope discovery must not read operational produce_transactions",
          );
        }
        if (table === "produce_transactions_all") {
          const rows = [
            {
              id: "item-void-1",
              market_name: VOIDED_MARKET,
              raw_message_id: "raw-void-1",
              base_transaction_type: "เบิก",
              item_created_at: "2026-07-25T01:00:00Z",
            },
          ];
          const builder = {
            select: () => builder,
            eq: () => builder,
            in: () => builder,
            order: () => builder,
            range: async () => ({
              data: rows,
              error: null,
              count: rows.length,
            }),
          };
          return builder;
        }
        if (table === "raw_messages") {
          return {
            select: () => ({
              in: async () => ({
                data: [{ id: "raw-void-1", source_id: SOURCE_A }],
                error: null,
              }),
            }),
          };
        }
        if (table === "digital_white_sheet_cash_entries") {
          return {
            select: () => ({
              eq: async () => ({ data: [], error: null }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient<Database>;

    const scopes = await listWhiteSheetMarketScopesForDate(database, BUSINESS_DATE);

    expect(tablesTouched).toContain("produce_transactions_all");
    expect(tablesTouched).not.toContain("produce_transactions");
    expect(scopes).toEqual([
      {
        sourceId: SOURCE_A,
        marketLabel: VOIDED_MARKET,
        displayLabel: VOIDED_MARKET,
      },
    ]);

    // Pure discovery builder also accepts the same audit rows that would be
    // invisible to produce_transactions after void.
    const fromAuditRows = buildWhiteSheetMarketScopeOptions(
      [{ market_name: VOIDED_MARKET, raw_message_id: "raw-void-1" }],
      new Map([["raw-void-1", SOURCE_A]]),
    );
    expect(fromAuditRows).toHaveLength(1);
    expect(fromAuditRows[0].sourceId).toBe(SOURCE_A);
    expect(fromAuditRows[0].marketLabel).toBe(VOIDED_MARKET);
  });

  test("saved cash-entry identity remains discoverable even with empty produce views", async () => {
    const database = {
      from(table: string) {
        if (table === "produce_transactions") {
          throw new Error("must not use operational produce_transactions");
        }
        if (table === "produce_transactions_all") {
          const builder = {
            select: () => builder,
            eq: () => builder,
            in: () => builder,
            order: () => builder,
            range: async () => ({ data: [], error: null, count: 0 }),
          };
          return builder;
        }
        if (table === "digital_white_sheet_cash_entries") {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  {
                    source_id: SOURCE_A,
                    market_label_normalized: VOIDED_MARKET,
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient<Database>;

    const scopes = await listWhiteSheetMarketScopesForDate(database, BUSINESS_DATE);
    expect(scopes).toEqual([
      {
        sourceId: SOURCE_A,
        marketLabel: VOIDED_MARKET,
        displayLabel: VOIDED_MARKET,
      },
    ]);
  });
});
