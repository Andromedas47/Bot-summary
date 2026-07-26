import { describe, expect, test } from "bun:test";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";
import {
  calculateSalesReport,
  salesMarketKey,
  satangToBahtText,
  type SalesIdentityRow,
  type SalesReport,
  type SalesSourceRow,
} from "./calculate";

const DATE = "2026-07-25";
const SOURCE_A = "Csource000000aaaaaa";
const SOURCE_B = "Csource000000bbbbbb";
const MARKET_A = "ตลาดกี้";
const MARKET_B = "ตลาดน้อย";

const TX_WITHDRAW = "เบิก";
const TX_WITHDRAW_MORE = "เบิกเพิ่ม";
const TX_RETURN = "คืน";
const TX_RETURN_MORE = "ชั่งคืนเพิ่ม";
const TX_DAMAGED = "คืนเสีย";
const TX_DAMAGED_LEGACY = "เสีย";

function row(overrides: Partial<SalesSourceRow> = {}): SalesSourceRow {
  return {
    sourceId: SOURCE_A,
    marketName: MARKET_A,
    sessionId: "session-main",
    sessionKind: "main",
    productName: "หมอนทอง",
    unit: "โล",
    quantity: 0,
    transactionType: TX_WITHDRAW,
    ...overrides,
  };
}

function prices(entries: Array<[string, string, number]>): Map<string, number> {
  return new Map(entries.map(([product, unit, satang]) => [centralPriceMapKey(product, unit), satang]));
}

function build(
  rows: readonly SalesSourceRow[],
  options: Partial<Parameters<typeof calculateSalesReport>[0]> = {},
): SalesReport {
  return calculateSalesReport({ businessDate: DATE, rows, ...options });
}

function onlyRow(report: SalesReport): SalesIdentityRow {
  const rows = report.markets.flatMap((market) => market.rows);
  expect(rows).toHaveLength(1);
  return rows[0];
}

const DURIAN_PRICE = prices([["หมอนทอง", "โล", 12_000]]);

// ── Core formula ────────────────────────────────────────────────────────────

describe("P1 sold quantity — W − R − D", () => {
  test("sold quantity is withdrawal minus good return minus damage", () => {
    const report = build(
      [
        row({ quantity: 100, transactionType: TX_WITHDRAW }),
        row({ quantity: 20, transactionType: TX_RETURN }),
        row({ quantity: 5, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.withdrawnQuantity).toBe(100);
    expect(result.goodReturnQuantity).toBe(20);
    expect(result.damagedReturnQuantity).toBe(5);
    expect(result.soldQuantity).toBe(75);
    expect(result.status).toBe("TRUSTED");
  });

  test("a good return alone reduces sold quantity", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).soldQuantity).toBe(6);
  });

  test("a damaged return reduces sold quantity and never counts as sellable", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        row({ quantity: 3, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).soldQuantity).toBe(3);
  });

  test("the legacy เสีย spelling is damage, not an unknown type", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        row({ quantity: 1, transactionType: TX_DAMAGED_LEGACY }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.damagedReturnQuantity).toBe(1);
    expect(result.soldQuantity).toBe(5);
    expect(result.status).toBe("TRUSTED");
  });

  test("everything returned is a trusted zero, not a missing result", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 10, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.soldQuantity).toBe(0);
    expect(result.expectedSalesSatang).toBe(0);
    expect(result.status).toBe("TRUSTED");
    expect(report.allMarkets.authoritative).toBe(true);
  });

  test("a recorded zero good return is evidence, not missing evidence", () => {
    // "We weighed the return and nothing came back" is a closed day. It is the
    // ABSENCE of any ชั่งคืน row that blocks, never a ชั่งคืน row of zero.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 0, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(10);
  });

  test("a VALUE_BLOCKED quantity is kept out of the product roll-up but still shown", () => {
    const report = build([
      row({ quantity: 10, transactionType: TX_WITHDRAW }),
      row({ quantity: 4, transactionType: TX_RETURN }),
    ]);

    // No central price → the value is blocked, so the roll-up claims nothing …
    expect(report.products[0].soldQuantity).toBe(0);
    expect(report.products[0].total.authoritative).toBe(false);
    // … while the identity itself still reports its trustworthy quantity.
    expect(report.blocked[0].soldQuantity).toBe(6);
  });

  test("fractional quantities keep 3-decimal precision without float drift", () => {
    const report = build(
      [
        row({ quantity: 0.1, transactionType: TX_WITHDRAW }),
        row({ quantity: 0.2, transactionType: TX_WITHDRAW }),
        row({ quantity: 0.123, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.withdrawnQuantity).toBe(0.3);
    expect(result.soldQuantity).toBe(0.177);
  });
});

// ── Fail-closed quantity rules ──────────────────────────────────────────────

describe("P1 quantity blocking — never assume", () => {
  test("a withdrawal with no good return is QUANTITY_BLOCKED, never sold out", () => {
    const report = build([row({ quantity: 10, transactionType: TX_WITHDRAW })], {
      centralPrices: DURIAN_PRICE,
    });

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("missing_return_evidence");
    expect(result.soldQuantity).toBeNull();
    expect(result.expectedSalesSatang).toBeNull();
  });

  test("damage alone does not close the loop for a withdrawal", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("missing_return_evidence");
  });

  test("a good return with no withdrawal is QUANTITY_BLOCKED", () => {
    const report = build([row({ quantity: 4, transactionType: TX_RETURN })], {
      centralPrices: DURIAN_PRICE,
    });

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("return_without_withdrawal");
  });

  test("damage with no withdrawal is QUANTITY_BLOCKED", () => {
    const report = build([row({ quantity: 2, transactionType: TX_DAMAGED })], {
      centralPrices: DURIAN_PRICE,
    });
    expect(onlyRow(report).reasons).toContain("return_without_withdrawal");
  });

  test("returns exceeding the withdrawal never produce a negative sold quantity", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 8, transactionType: TX_RETURN }),
        row({ quantity: 5, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("returns_exceed_withdrawal");
    expect(result.soldQuantity).toBeNull();
  });

  test("a missing quantity blocks the identity instead of counting as zero", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: null, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).reasons).toContain("invalid_quantity");
  });

  test("a missing unit blocks the identity", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, unit: null }),
        row({ quantity: 2, transactionType: TX_RETURN, unit: null }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).reasons).toContain("invalid_identity");
  });

  test("an unknown transaction type blocks its identity rather than disappearing", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
        row({ quantity: 3, transactionType: "โยนทิ้ง" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("unknown_transaction_type");
  });
});

// ── Session integrity ───────────────────────────────────────────────────────

describe("P1 session integrity", () => {
  test("an additional session is additive, not a duplicate", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({
          quantity: 5,
          transactionType: TX_WITHDRAW_MORE,
          sessionId: "session-additional",
          sessionKind: "additional",
        }),
        row({ quantity: 3, transactionType: TX_RETURN }),
        row({
          quantity: 2,
          transactionType: TX_RETURN_MORE,
          sessionId: "session-additional-return",
          sessionKind: "additional",
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.withdrawnQuantity).toBe(15);
    expect(result.goodReturnQuantity).toBe(5);
    expect(result.soldQuantity).toBe(10);
    expect(result.status).toBe("TRUSTED");
  });

  test("two active main sessions of the same type block the whole market", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "session-1" }),
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "session-2" }),
        row({ quantity: 3, transactionType: TX_RETURN, sessionId: "session-3" }),
        row({
          quantity: 1,
          transactionType: TX_RETURN,
          sessionId: "session-3",
          productName: "ชะอม",
          unit: "กำ",
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.blocked).toHaveLength(2);
    for (const blocked of report.blocked) {
      expect(blocked.status).toBe("QUANTITY_BLOCKED");
      expect(blocked.reasons).toContain("duplicate_main_session");
    }
    expect(report.allMarkets.authoritative).toBe(false);
  });

  test("a duplicate main session in one market does not block another market", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "dup-1" }),
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "dup-2" }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionId: "dup-1" }),
        row({
          marketName: MARKET_B,
          sessionId: "clean-1",
          quantity: 8,
          transactionType: TX_WITHDRAW,
        }),
        row({
          marketName: MARKET_B,
          sessionId: "clean-1",
          quantity: 3,
          transactionType: TX_RETURN,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const clean = report.markets.find((market) => market.marketLabel === MARKET_B);
    expect(clean?.rows[0].status).toBe("TRUSTED");
    expect(clean?.total.authoritative).toBe(true);

    const dirty = report.markets.find((market) => market.marketLabel === MARKET_A);
    expect(dirty?.total.authoritative).toBe(false);
  });

  test("a session with parser errors blocks every identity in its market", () => {
    // The failure mode is a line that never landed at all, so a sibling product
    // can look complete while its real return was larger. The market is the
    // smallest scope that provably contains the damage.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionIssues: ["session_parser_errors"] }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionId: "session-clean" }),
        row({
          quantity: 5,
          transactionType: TX_WITHDRAW,
          sessionId: "session-clean",
          productName: "ชะอม",
          unit: "กำ",
        }),
        row({
          quantity: 1,
          transactionType: TX_RETURN,
          sessionId: "session-clean",
          productName: "ชะอม",
          unit: "กำ",
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.blocked).toHaveLength(2);
    for (const blocked of report.blocked) {
      expect(blocked.reasons).toContain("session_parser_errors");
    }
  });

  test("a broken session in one market does not block another market", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionIssues: ["session_parser_errors"] }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionIssues: ["session_parser_errors"] }),
        row({
          marketName: MARKET_B,
          sessionId: "clean-1",
          quantity: 8,
          transactionType: TX_WITHDRAW,
        }),
        row({
          marketName: MARKET_B,
          sessionId: "clean-1",
          quantity: 3,
          transactionType: TX_RETURN,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const clean = report.markets.find((market) => market.marketLabel === MARKET_B);
    expect(clean?.total.authoritative).toBe(true);
    expect(report.blocked).toHaveLength(1);
  });

  test("a session with parser errors blocks its identities", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionIssues: ["session_parser_errors"] }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionIssues: ["session_parser_errors"] }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("session_parser_errors");
  });

  test("a persisted item-count mismatch blocks its identities", () => {
    const report = build(
      [
        row({
          quantity: 10,
          transactionType: TX_WITHDRAW,
          sessionIssues: ["session_item_count_mismatch"],
        }),
        row({
          quantity: 2,
          transactionType: TX_RETURN,
          sessionIssues: ["session_item_count_mismatch"],
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).reasons).toContain("session_item_count_mismatch");
  });

  test("an unresolved pending session demotes every total in the scope", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        scopeBlockers: [{ kind: "unresolved_pending_session", count: 1 }],
      },
    );

    // The row itself is still individually trusted …
    expect(onlyRow(report).status).toBe("TRUSTED");
    // … but nothing derived from an incomplete day may be called a total.
    expect(report.allMarkets.authoritative).toBe(false);
    expect(report.markets[0].total.authoritative).toBe(false);
    expect(report.products[0].total.authoritative).toBe(false);
    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });

  test("a crashed message parse demotes every total in the scope", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        scopeBlockers: [{ kind: "message_parser_error", count: 3 }],
      },
    );
    expect(report.allMarkets.authoritative).toBe(false);
  });
});

// ── Product and unit identity ───────────────────────────────────────────────

describe("P1 product and unit identity", () => {
  test("an explicit product alias merges into one identity", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, productName: "หมอนทอง" }),
        row({ quantity: 4, transactionType: TX_RETURN, productName: "หมอน" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.productName).toBe("หมอนทอง");
    expect(result.soldQuantity).toBe(6);
  });

  test("an unrelated product is never fuzzy-merged", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, productName: "หมอนทอง" }),
        row({ quantity: 4, transactionType: TX_RETURN, productName: "ชะนี" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.blocked).toHaveLength(2);
    expect(report.blocked.map((blocked) => blocked.reasons).flat()).toContain(
      "missing_return_evidence",
    );
    expect(report.blocked.map((blocked) => blocked.reasons).flat()).toContain(
      "return_without_withdrawal",
    );
  });

  test("a verified unit conversion lands both sides in one identity", () => {
    // ขีด → โล ×0.1 is an explicit, shop-verified conversion.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, unit: "โล" }),
        row({ quantity: 25, transactionType: TX_RETURN, unit: "ขีด" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.unit).toBe("โล");
    expect(result.goodReturnQuantity).toBe(2.5);
    expect(result.soldQuantity).toBe(7.5);
  });

  test("a unit with no known conversion is never merged with another unit", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, unit: "โล" }),
        row({ quantity: 3, transactionType: TX_RETURN, unit: "ลูก" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(report.blocked).toHaveLength(2);
  });

  test("a spelling alias for a unit normalizes without rescaling", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, unit: "กก." }),
        row({ quantity: 4, transactionType: TX_RETURN, unit: "โล" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).soldQuantity).toBe(6);
  });
});

// ── Market identity ─────────────────────────────────────────────────────────

describe("P1 market identity", () => {
  test("the same label under two LINE sources stays two markets", () => {
    const report = build(
      [
        row({ sourceId: SOURCE_A, quantity: 10, transactionType: TX_WITHDRAW }),
        row({ sourceId: SOURCE_A, quantity: 4, transactionType: TX_RETURN }),
        row({ sourceId: SOURCE_B, sessionId: "s-b", quantity: 6, transactionType: TX_WITHDRAW }),
        row({ sourceId: SOURCE_B, sessionId: "s-b", quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.markets).toHaveLength(2);
    expect(report.markets.map((market) => market.marketKey)).toEqual([
      salesMarketKey(SOURCE_A, MARKET_A),
      salesMarketKey(SOURCE_B, MARKET_A),
    ]);
    // The display label disambiguates so a human can tell them apart.
    for (const market of report.markets) {
      expect(market.marketLabel.startsWith(`${MARKET_A} · …`)).toBe(true);
    }
  });

  test("a row with no resolvable market is blocked, never merged into one", () => {
    const report = build(
      [
        row({ marketName: null, quantity: 10, transactionType: TX_WITHDRAW }),
        row({ marketName: null, quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].reasons).toContain("market_unresolved");
    expect(report.allMarkets.authoritative).toBe(false);
  });

  test("unresolved-market rows from different sessions never merge with each other", () => {
    const report = build(
      [
        row({ marketName: null, sessionId: "s1", quantity: 10, transactionType: TX_WITHDRAW }),
        row({ marketName: null, sessionId: "s2", quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(report.blocked).toHaveLength(2);
  });

  test("a row with no resolvable LINE source is blocked", () => {
    const report = build(
      [
        row({ sourceId: null, quantity: 10, transactionType: TX_WITHDRAW }),
        row({ sourceId: null, quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(report.blocked[0].reasons).toContain("market_unresolved");
  });
});

// ── Central price ───────────────────────────────────────────────────────────

describe("P1 expected sales value", () => {
  test("expected sales is sold quantity × central price", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2.5, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 12_050]]) },
    );

    const result = onlyRow(report);
    expect(result.soldQuantity).toBe(7.5);
    expect(result.centralPriceSatang).toBe(12_050);
    expect(result.expectedSalesSatang).toBe(90_375);
    expect(satangToBahtText(result.expectedSalesSatang as number)).toBe("903.75");
  });

  test("a trusted quantity with no central price is VALUE_BLOCKED", () => {
    const report = build([
      row({ quantity: 10, transactionType: TX_WITHDRAW }),
      row({ quantity: 4, transactionType: TX_RETURN }),
    ]);

    const result = onlyRow(report);
    expect(result.status).toBe("VALUE_BLOCKED");
    expect(result.reasons).toContain("missing_central_price");
    expect(result.soldQuantity).toBe(6);
    expect(result.expectedSalesSatang).toBeNull();
  });

  test("an unresolved central-price conflict blocks value even when a price exists", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        priceConflicts: new Set([centralPriceMapKey("หมอนทอง", "โล")]),
      },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("VALUE_BLOCKED");
    expect(result.reasons).toContain("central_price_conflict");
    expect(result.expectedSalesSatang).toBeNull();
  });

  test("an admin-corrected central price is used verbatim", () => {
    // BR-04: once an admin sets the price it is authoritative, and the
    // withdrawal-row price is never substituted for it.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 0, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 9_900]]) },
    );

    const result = onlyRow(report);
    expect(result.centralPriceSatang).toBe(9_900);
    expect(result.expectedSalesSatang).toBe(99_000);
  });

  test("a quantity-blocked row never reports a value", () => {
    const report = build([row({ quantity: 10, transactionType: TX_WITHDRAW })], {
      centralPrices: DURIAN_PRICE,
    });

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.centralPriceSatang).toBeNull();
    expect(result.expectedSalesSatang).toBeNull();
  });
});

// ── Money rounding ──────────────────────────────────────────────────────────

describe("P1 money rounding", () => {
  test("each row rounds half-up to satang exactly once", () => {
    // 0.001 kg × 12.005 baht = 0.012005 baht = 1.2005 satang → 1 satang.
    const report = build(
      [
        row({ quantity: 1.001, transactionType: TX_WITHDRAW }),
        row({ quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 1_200]]) },
    );
    // 0.001 × 1200 satang = 1.2 satang → 1
    expect(onlyRow(report).expectedSalesSatang).toBe(1);
  });

  test("a half satang rounds up, not to even", () => {
    // 0.005 kg × 1.00 baht = 0.5 satang → 1 satang (half-up).
    const report = build(
      [
        row({ quantity: 1.005, transactionType: TX_WITHDRAW }),
        row({ quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 100]]) },
    );
    expect(onlyRow(report).expectedSalesSatang).toBe(1);
  });

  test("every displayed total is the exact integer sum of its rows", () => {
    const report = build(
      [
        row({ quantity: 1.001, transactionType: TX_WITHDRAW }),
        row({ quantity: 1, transactionType: TX_RETURN }),
        row({
          marketName: MARKET_B,
          sessionId: "s-b",
          quantity: 1.001,
          transactionType: TX_WITHDRAW,
        }),
        row({ marketName: MARKET_B, sessionId: "s-b", quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 1_200]]) },
    );

    const rowSum = report.markets
      .flatMap((market) => market.rows)
      .reduce((sum, current) => sum + (current.expectedSalesSatang ?? 0), 0);

    expect(report.allMarkets.expectedSalesSatang).toBe(rowSum);
    expect(report.products[0].total.expectedSalesSatang).toBe(rowSum);
    expect(
      report.markets.reduce((sum, market) => sum + market.total.expectedSalesSatang, 0),
    ).toBe(rowSum);
  });

  test("satang formatting keeps two decimals and thousands separators", () => {
    expect(satangToBahtText(0)).toBe("0.00");
    expect(satangToBahtText(5)).toBe("0.05");
    expect(satangToBahtText(1_234_567)).toBe("12,345.67");
  });
});

// ── Aggregation authority ───────────────────────────────────────────────────

describe("P1 aggregation authority", () => {
  test("a market total is authoritative only when every identity is trusted", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        row({ quantity: 5, transactionType: TX_WITHDRAW, productName: "ชะอม", unit: "กำ" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const market = report.markets[0];
    expect(market.total.authoritative).toBe(false);
    expect(market.total.trustedRowCount).toBe(1);
    expect(market.total.blockedRowCount).toBe(1);
    // The partial figure is still the sum of what IS verified.
    expect(market.total.expectedSalesSatang).toBe(72_000);
  });

  test("a product total across markets is authoritative only when every contributor is", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        row({
          marketName: MARKET_B,
          sessionId: "s-b",
          quantity: 5,
          transactionType: TX_WITHDRAW,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const product = report.products[0];
    expect(product.total.authoritative).toBe(false);
    expect(product.soldQuantity).toBe(6);
    expect(product.markets).toHaveLength(1);
  });

  test("the all-market total is authoritative only when the whole scope is trusted", () => {
    const trusted = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(trusted.allMarkets.authoritative).toBe(true);

    const partial = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        row({
          marketName: MARKET_B,
          sessionId: "s-b",
          quantity: 5,
          transactionType: TX_WITHDRAW,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(partial.allMarkets.authoritative).toBe(false);
  });

  test("a VALUE_BLOCKED row demotes its totals and contributes no value", () => {
    const report = build([
      row({ quantity: 10, transactionType: TX_WITHDRAW }),
      row({ quantity: 4, transactionType: TX_RETURN }),
    ]);

    expect(report.allMarkets.authoritative).toBe(false);
    expect(report.allMarkets.expectedSalesSatang).toBe(0);
    expect(report.blocked).toHaveLength(1);
  });

  test("every blocked identity is listed, never sampled", () => {
    const report = build(
      [
        row({ quantity: 1, transactionType: TX_WITHDRAW, productName: "หมอนทอง" }),
        row({ quantity: 1, transactionType: TX_WITHDRAW, productName: "ชะอม", unit: "กำ" }),
        row({ quantity: 1, transactionType: TX_WITHDRAW, productName: "คะน้า", unit: "กำ" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(report.blocked).toHaveLength(3);
  });
});
