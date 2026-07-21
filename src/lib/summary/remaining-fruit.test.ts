import { describe, expect, test } from "bun:test";
import {
  buildRemainingFruitReport,
  type RemainingFruitSourceRow,
} from "./remaining-fruit";

const TX_WITHDRAW = "\u0E40\u0E1A\u0E34\u0E01";
const TX_RETURN = "\u0E04\u0E37\u0E19";
const TX_DAMAGED = "\u0E04\u0E37\u0E19\u0E40\u0E2A\u0E35\u0E22";
const UNIT_PIECE = "\u0E25\u0E39\u0E01";
const UNIT_KG = "\u0E42\u0E25";
const WATERMELON = "\u0E41\u0E15\u0E07\u0E42\u0E21";
const MARKET_KEE = "\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49";
const MARKET_NOI = "\u0E15\u0E25\u0E32\u0E14\u0E19\u0E49\u0E2D\u0E22";

function row(
  overrides: Partial<RemainingFruitSourceRow> & Pick<RemainingFruitSourceRow, "product_name">,
): RemainingFruitSourceRow {
  return {
    market_name: MARKET_KEE,
    quantity: 0,
    unit: UNIT_PIECE,
    transaction_type: TX_WITHDRAW,
    ...overrides,
  };
}

describe("buildRemainingFruitReport", () => {
  test("one fruit: remaining equals \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 only (20), not 75 or 80", () => {
    const source = [
      row({ product_name: WATERMELON, quantity: 100, transaction_type: TX_WITHDRAW }),
      row({ product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
      row({ product_name: WATERMELON, quantity: 5, transaction_type: TX_DAMAGED }),
    ];
    const { markets } = buildRemainingFruitReport(source);
    const item = markets[0]?.items[0];

    expect(item?.remainingForResaleQuantity).toBe(20);
    expect(item?.returnGoodQuantity).toBe(20);
    expect(item?.remainingForResaleQuantity).toBe(item?.returnGoodQuantity);
    expect(item?.remainingForResaleQuantity).not.toBe(75);
    expect(item?.remainingForResaleQuantity).not.toBe(80);
    expect(item?.withdrawnQuantity).toBe(100);
    expect(item?.damagedQuantity).toBe(5);
  });

  test("multiple entries for same fruit, market, date, and unit sum correctly", () => {
    const source = [
      row({ product_name: WATERMELON, quantity: 60, transaction_type: TX_WITHDRAW }),
      row({ product_name: WATERMELON, quantity: 40, transaction_type: TX_WITHDRAW }),
      row({ product_name: WATERMELON, quantity: 12, transaction_type: TX_RETURN }),
      row({ product_name: WATERMELON, quantity: 8, transaction_type: TX_RETURN }),
      row({ product_name: WATERMELON, quantity: 2, transaction_type: TX_DAMAGED }),
      row({ product_name: WATERMELON, quantity: 3, transaction_type: TX_DAMAGED }),
    ];
    const item = buildRemainingFruitReport(source).markets[0]?.items[0];

    expect(item?.withdrawnQuantity).toBe(100);
    expect(item?.remainingForResaleQuantity).toBe(20);
    expect(item?.damagedQuantity).toBe(5);
  });

  test("same fruit from multiple markets sums in overall summary", () => {
    const source = [
      row({ market_name: MARKET_KEE, product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_NOI, product_name: WATERMELON, quantity: 15, transaction_type: TX_RETURN }),
    ];
    const report = buildRemainingFruitReport(source);

    expect(report.markets).toHaveLength(2);
    expect(report.markets.find((m) => m.marketName === MARKET_KEE)?.items[0]?.remainingForResaleQuantity).toBe(20);
    expect(report.markets.find((m) => m.marketName === MARKET_NOI)?.items[0]?.remainingForResaleQuantity).toBe(15);

    const overall = report.overall.find((r) => r.fruitName === WATERMELON && r.unit === UNIT_PIECE);
    expect(overall?.totalRemainingForResale).toBe(35);
    expect(overall?.marketBreakdown).toEqual([
      { marketName: MARKET_KEE, quantity: 20 },
      { marketName: MARKET_NOI, quantity: 15 },
    ]);
  });

  test("overall breakdown lists each market contribution", () => {
    const source = [
      row({ market_name: MARKET_KEE, product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_NOI, product_name: WATERMELON, quantity: 15, transaction_type: TX_RETURN }),
    ];
    const overall = buildRemainingFruitReport(source).overall[0];

    expect(overall.totalRemainingForResale).toBe(35);
    expect(overall.marketBreakdown.map((b) => b.marketName)).toEqual([MARKET_KEE, MARKET_NOI]);
  });

  test("same fruit with different units stays on separate rows", () => {
    const source = [
      row({ market_name: MARKET_KEE, product_name: WATERMELON, unit: UNIT_PIECE, quantity: 10, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_KEE, product_name: WATERMELON, unit: UNIT_KG, quantity: 4, transaction_type: TX_RETURN }),
    ];
    const items = buildRemainingFruitReport(source).markets[0]?.items ?? [];

    expect(items).toHaveLength(2);
    expect(items.find((i) => i.unit === UNIT_PIECE)?.remainingForResaleQuantity).toBe(10);
    expect(items.find((i) => i.unit === UNIT_KG)?.remainingForResaleQuantity).toBe(4);
    expect(buildRemainingFruitReport(source).overall).toHaveLength(2);
  });

  test("different units across markets create separate overall rows", () => {
    const source = [
      row({ market_name: MARKET_KEE, product_name: WATERMELON, unit: UNIT_PIECE, quantity: 20, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_NOI, product_name: WATERMELON, unit: UNIT_KG, quantity: 5, transaction_type: TX_RETURN }),
    ];

    const overall = buildRemainingFruitReport(source).overall;
    expect(overall).toHaveLength(2);
    expect(overall.find((r) => r.unit === UNIT_PIECE)?.totalRemainingForResale).toBe(20);
    expect(overall.find((r) => r.unit === UNIT_KG)?.totalRemainingForResale).toBe(5);
  });

  test("missing \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 is not reported as confirmed zero", () => {
    const item = buildRemainingFruitReport([
      row({ product_name: WATERMELON, quantity: 100, transaction_type: TX_WITHDRAW }),
      row({ product_name: WATERMELON, quantity: 5, transaction_type: TX_DAMAGED }),
    ]).markets[0]?.items[0];

    expect(item?.hasReturnGoodData).toBe(false);
    expect(item?.remainingForResaleQuantity).toBe(0);
    expect(item?.withdrawnQuantity).toBe(100);
  });

  test("market with \u0E40\u0E1A\u0E34\u0E01 but no \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 does not add zero to overall total", () => {
    const overall = buildRemainingFruitReport([
      row({ market_name: MARKET_KEE, product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_NOI, product_name: WATERMELON, quantity: 100, transaction_type: TX_WITHDRAW }),
    ]).overall[0];

    expect(overall.totalRemainingForResale).toBe(20);
    expect(overall.marketBreakdown).toEqual([{ marketName: MARKET_KEE, quantity: 20 }]);
  });

  test("market filter limits sections", () => {
    const report = buildRemainingFruitReport(
      [
        row({ market_name: MARKET_KEE, product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
        row({ market_name: MARKET_NOI, product_name: WATERMELON, quantity: 15, transaction_type: TX_RETURN }),
      ],
      { marketFilter: "\u0E01\u0E35\u0E49" },
    );

    expect(report.markets).toHaveLength(1);
    expect(report.markets[0].marketName).toBe(MARKET_KEE);
    expect(report.overall[0]?.totalRemainingForResale).toBe(20);
  });
});
