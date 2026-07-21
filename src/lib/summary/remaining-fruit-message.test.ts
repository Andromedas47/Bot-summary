import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { buildRemainingFruitMessageFromRows } from "./remaining-fruit-message";
import { fetchRemainingFruitRows } from "./remaining-fruit-data";

const LINE_TEXT_LIMIT = 5000;
const TRUNCATION_NOTICE = "\n\n(ข้อความยาวเกินไป — ดูเพิ่มเติมในเว็บ)";

const TX_WITHDRAW = "\u0E40\u0E1A\u0E34\u0E01";
const TX_RETURN = "\u0E04\u0E37\u0E19";
const TX_DAMAGED = "\u0E04\u0E37\u0E19\u0E40\u0E2A\u0E35\u0E22";
const WATERMELON = "\u0E41\u0E15\u0E07\u0E42\u0E21";
const MARKET_KEE = "\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49";
const MISSING_RETURN_NOTE = "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19";

describe("buildRemainingFruitMessageFromRows", () => {
  test("shows remaining first and missing return note when needed", () => {
    const message = buildRemainingFruitMessageFromRows("2026-07-21", [
      {
        market_name: MARKET_KEE,
        product_name: WATERMELON,
        quantity: 100,
        unit: "\u0E25\u0E39\u0E01",
        transaction_type: TX_WITHDRAW,
      },
      {
        market_name: MARKET_KEE,
        product_name: WATERMELON,
        quantity: 5,
        unit: "\u0E25\u0E39\u0E01",
        transaction_type: TX_DAMAGED,
      },
    ]);

    expect(message).toContain(MISSING_RETURN_NOTE);
    expect(message).not.toMatch(/\u0E40\u0E2B\u0E25\u0E37\u0E02\u0E02\u0E32\u0E22\u0E15\u0E48\u0E2D:\s*0/);
    expect(message).not.toContain("\u0E04\u0E27\u0E23\u0E02\u0E32\u0E22\u0E44\u0E14\u0E49");
  });

  test("includes overall section for multi-market data", () => {
    const message = buildRemainingFruitMessageFromRows("2026-07-21", [
      {
        market_name: MARKET_KEE,
        product_name: WATERMELON,
        quantity: 20,
        unit: "\u0E25\u0E39\u0E01",
        transaction_type: TX_RETURN,
      },
      {
        market_name: "\u0E15\u0E25\u0E32\u0E14\u0E19\u0E49\u0E2D\u0E22",
        product_name: WATERMELON,
        quantity: 15,
        unit: "\u0E25\u0E39\u0E01",
        transaction_type: TX_RETURN,
      },
    ]);

    expect(message).toContain("\u0E2A\u0E23\u0E38\u0E1B\u0E04\u0E07\u0E40\u0E2B\u0E25\u0E37\u0E2D\u0E23\u0E27\u0E21\u0E17\u0E38\u0E01\u0E15\u0E25\u0E32\u0E14");
    expect(message).toContain("35 \u0E25\u0E39\u0E01");
  });

  test("truncated all-market message stays within LINE text limit", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      market_name:
        i % 2 === 0
          ? "\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569"
          : "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01",
      product_name: `\u0E41\u0E15\u0E07\u0E42\u0E21${i}`,
      quantity: 10 + (i % 7),
      unit: i % 3 === 0 ? "\u0E25\u0E39\u0E01" : "\u0E42\u0E25",
      transaction_type: TX_RETURN,
    }));

    const message = buildRemainingFruitMessageFromRows("2026-06-23", rows, {
      includeOverall: true,
    });

    expect(message.length).toBeLessThanOrEqual(LINE_TEXT_LIMIT);
    expect(message.endsWith(TRUNCATION_NOTICE)).toBe(true);
  });

  test("market-filtered report stays complete without truncation", () => {
    const message = buildRemainingFruitMessageFromRows(
      "2026-06-23",
      [
        {
          market_name: "\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569",
          product_name: "\u0E41\u0E15\u0E07\u0E42\u0E21",
          quantity: 20,
          unit: "\u0E25\u0E39\u0E01",
          transaction_type: TX_RETURN,
        },
        {
          market_name: "\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569",
          product_name: "\u0E40\u0E07\u0E32\u0E30",
          quantity: 7.6,
          unit: "\u0E42\u0E25",
          transaction_type: TX_RETURN,
        },
      ],
      { marketFilter: "\u0E01\u0E35\u0E49", includeOverall: false },
    );

    expect(message.length).toBeLessThan(LINE_TEXT_LIMIT);
    expect(message).not.toContain("\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E22\u0E32\u0E27\u0E40\u0E01\u0E34\u0E19\u0E44\u0E1B");
  });

  test("2026-06-23 all-market production shape stays within LINE limit", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;

    const rows = await fetchRemainingFruitRows(createClient(url, key), "2026-06-23");
    expect(rows.length).toBeGreaterThan(100);

    const message = buildRemainingFruitMessageFromRows("2026-06-23", rows, {
      includeOverall: true,
    });

    expect(message.length).toBeLessThanOrEqual(LINE_TEXT_LIMIT);
    expect(message.endsWith(TRUNCATION_NOTICE)).toBe(true);
  });
});
