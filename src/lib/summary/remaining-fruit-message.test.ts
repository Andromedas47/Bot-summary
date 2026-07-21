import { describe, expect, test } from "bun:test";
import { buildRemainingFruitMessageFromRows } from "./remaining-fruit-message";

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
});
