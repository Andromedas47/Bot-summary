import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import {
  buildRemainingFruitMessagesFromRows,
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
  OVERFLOW_NOTICE,
} from "./remaining-fruit-message";
import { fetchRemainingFruitRows } from "./remaining-fruit-data";
import { REMAINING_STOCK_REPORT_TITLE, UNIDENTIFIED_MARKET_SECTION } from "./remaining-fruit";

const TX_WITHDRAW = "\u0E40\u0E1A\u0E34\u0E01";
const TX_RETURN = "\u0E04\u0E37\u0E19";
const TX_DAMAGED = "\u0E04\u0E37\u0E19\u0E40\u0E2A\u0E35\u0E22";
const WATERMELON = "\u0E41\u0E15\u0E07\u0E42\u0E21";
const MARKET_KEE = "\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49";
const MISSING_RETURN_NOTE = "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19";
const OVERALL_HEADING = "\u0E2A\u0E23\u0E38\u0E1B\u0E04\u0E07\u0E40\u0E2B\u0E25\u0E37\u0E2D\u0E23\u0E27\u0E21\u0E17\u0E38\u0E01\u0E15\u0E25\u0E32\u0E14";

function assertWithinLineLimits(messages: string[]) {
  expect(messages.length).toBeGreaterThanOrEqual(1);
  expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
  for (const message of messages) {
    expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
  }
}

function assertNoMidFruitEntrySplit(messages: string[]) {
  for (const message of messages) {
    const trimmed = message.trimEnd();
    expect(trimmed.endsWith("เหลือขายต่อ:")).toBe(false);
    expect(trimmed.endsWith("เบิกทั้งหมด:")).toBe(false);
    expect(trimmed.endsWith("คืนเสีย:")).toBe(false);
    expect(trimmed.endsWith("เหลือขายต่อทั้งหมด:")).toBe(false);

    const lines = trimmed.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    expect(/^\d+\.\s[\u0E00-\u0E7F\w\s]+$/.test(lastLine)).toBe(false);
  }
}

function firstMarketDetailIndex(messages: string[]): number {
  return messages.findIndex(
    (message) => /^1\. /m.test(message) && message.includes("เหลือขายต่อ:"),
  );
}

describe("buildRemainingFruitMessagesFromRows", () => {
  test("shows remaining first and missing return note when needed", () => {
    const messages = buildRemainingFruitMessagesFromRows("2026-07-21", [
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

    const joined = messages.join("\n\n");
    expect(joined).toContain(MISSING_RETURN_NOTE);
    expect(joined).not.toMatch(/\u0E40\u0E2B\u0E25\u0E37\u0E02\u0E02\u0E32\u0E22\u0E15\u0E48\u0E2D:\s*0/);
    expect(joined).not.toContain("\u0E04\u0E27\u0E23\u0E02\u0E32\u0E22\u0E44\u0E14\u0E49");
    assertWithinLineLimits(messages);
  });

  test("includes overall section before market details for multi-market data", () => {
    const messages = buildRemainingFruitMessagesFromRows("2026-07-21", [
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

    const joined = messages.join("\n\n");
    expect(messages[0]).toContain(OVERALL_HEADING);
    expect(joined).toContain("35 \u0E25\u0E39\u0E01");

    const marketIdx = firstMarketDetailIndex(messages);
    expect(marketIdx).toBeGreaterThan(0);
    expect(messages[0].indexOf(OVERALL_HEADING)).toBeGreaterThan(-1);
    assertWithinLineLimits(messages);
  });

  test("market-filtered report stays in one message without overflow notice", () => {
    const messages = buildRemainingFruitMessagesFromRows(
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

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain(OVERFLOW_NOTICE);
    expect(messages[0]).toContain(MARKET_KEE);
    assertWithinLineLimits(messages);
  });

  test("separates confirmed and unidentified totals in all-market report", () => {
    const messages = buildRemainingFruitMessagesFromRows("2026-06-23", [
      {
        market_name: "\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569",
        product_name: WATERMELON,
        quantity: 20,
        unit: "\u0E25\u0E39\u0E01",
        transaction_type: TX_RETURN,
      },
      {
        market_name: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01",
        product_name: "\u0E40\u0E07\u0E32\u0E30",
        quantity: 12,
        unit: "\u0E42\u0E25",
        transaction_type: TX_RETURN,
      },
    ]);

    const joined = messages.join("\n\n");
    expect(joined).toContain(MARKET_KEE);
    expect(joined).toContain(UNIDENTIFIED_MARKET_SECTION);
    expect(joined).not.toContain("\u0E44\u0E21\u0E48\u0E23\u0E30\u0E1A\u0E38\u0E15\u0E25\u0E32\u0E14");
    expect(joined).not.toContain("\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07");
    expect(joined.indexOf(OVERALL_HEADING)).toBeLessThan(joined.indexOf(UNIDENTIFIED_MARKET_SECTION));
    assertWithinLineLimits(messages);
  });

  test("long market-filtered report uses safe chunking", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      market_name: "\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569",
      product_name: `\u0E41\u0E15\u0E07\u0E42\u0E21${i}`,
      quantity: 10 + (i % 7),
      unit: i % 3 === 0 ? "\u0E25\u0E39\u0E01" : "\u0E42\u0E25",
      transaction_type: TX_RETURN,
    }));

    const messages = buildRemainingFruitMessagesFromRows("2026-06-23", rows, {
      marketFilter: "\u0E01\u0E35\u0E49",
      includeOverall: false,
    });

    expect(messages.length).toBeGreaterThan(1);
    assertWithinLineLimits(messages);
    assertNoMidFruitEntrySplit(messages);
  });

  test("caps at 5 messages with web overflow notice when content exceeds reply limit", () => {
    const rows = Array.from({ length: 260 }, (_, i) => ({
      market_name:
        i % 2 === 0
          ? "\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569"
          : "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01",
      product_name: `\u0E41\u0E15\u0E07\u0E42\u0E21${i}`,
      quantity: 10 + (i % 7),
      unit: i % 3 === 0 ? "\u0E25\u0E39\u0E01" : "\u0E42\u0E25",
      transaction_type: TX_RETURN,
    }));

    const messages = buildRemainingFruitMessagesFromRows("2026-06-23", rows, {
      includeOverall: true,
    });

    expect(messages).toHaveLength(LINE_REPLY_MAX_MESSAGES);
    expect(messages[4]).toContain(OVERFLOW_NOTICE);
    assertWithinLineLimits(messages);
  });

  test("2026-06-23 all-market production shape splits safely for LINE", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;

    const rows = await fetchRemainingFruitRows(createClient(url, key), "2026-06-23");
    expect(rows.length).toBeGreaterThan(100);

    const messages = buildRemainingFruitMessagesFromRows("2026-06-23", rows, {
      includeOverall: true,
    });

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);

    assertWithinLineLimits(messages);
    assertNoMidFruitEntrySplit(messages);

    expect(messages[0]).toContain(REMAINING_STOCK_REPORT_TITLE);
    expect(messages[0]).toContain(OVERALL_HEADING);
    expect(messages.join("\n\n")).toContain("\u0E40\u0E2B\u0E25\u0E37\u0E02\u0E02\u0E32\u0E22\u0E15\u0E48\u0E2D\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14");
    expect(messages.join("\n\n")).not.toContain("\u0E44\u0E21\u0E48\u0E23\u0E30\u0E1A\u0E38\u0E15\u0E25\u0E32\u0E14");
    expect(messages.join("\n\n")).not.toMatch(/- \u0E0A\u0E31\u0E48\u0E07:/);
    expect(messages.join("\n\n")).not.toMatch(/- \u0E0A\u0E48\u0E32\u0E07:/);
    expect(messages.join("\n\n")).toContain(UNIDENTIFIED_MARKET_SECTION);

    const marketIdx = firstMarketDetailIndex(messages);
    expect(marketIdx).toBeGreaterThan(0);
    const overallText = messages.slice(0, marketIdx).join("\n\n");
    expect(overallText).toContain(OVERALL_HEADING);
    expect(overallText.indexOf(OVERALL_HEADING)).toBeLessThan(
      overallText.indexOf("\u0E40\u0E2B\u0E25\u0E37\u0E02\u0E02\u0E32\u0E22\u0E15\u0E48\u0E2D\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14"),
    );
    expect(messages[marketIdx]).toMatch(/^1\. /m);
  });
});
