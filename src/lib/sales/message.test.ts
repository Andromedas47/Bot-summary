import { describe, expect, test } from "bun:test";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";
import { calculateSalesReport, type SalesSourceRow } from "./calculate";
import {
  buildSalesAutoBlocks,
  buildSalesAutoMessages,
  buildSalesSummaryBlocks,
  buildSalesSummaryMessages,
  SALES_AUTO_TITLE,
  SALES_BLOCKED_HEADING,
  SALES_EMPTY_NOTICE,
  SALES_MANUAL_TITLE,
  SALES_OVERFLOW_NOTICE,
  SALES_PARTIAL_HEADING,
  SALES_QUANTITY_ONLY_NOTICE,
  SALES_TOTAL_HEADING,
} from "./message";

const DATE = "2026-07-25";
const SOURCE = "Csource000000aaaaaa";
const MARKET = "ตลาดกี้";

function row(overrides: Partial<SalesSourceRow> = {}): SalesSourceRow {
  return {
    sourceId: SOURCE,
    marketName: MARKET,
    sessionId: "session-main",
    sessionKind: "main",
    productName: "หมอนทอง",
    unit: "โล",
    quantity: 0,
    transactionType: "เบิก",
    ...overrides,
  };
}

const PRICES = new Map([[centralPriceMapKey("หมอนทอง", "โล"), 12_000]]);

function report(rows: readonly SalesSourceRow[], options = {}) {
  return calculateSalesReport({ businessDate: DATE, rows, centralPrices: PRICES, ...options });
}

const TRUSTED_ROWS = [
  row({ quantity: 10, transactionType: "เบิก" }),
  row({ quantity: 2, transactionType: "คืน" }),
  row({ quantity: 1, transactionType: "คืนเสีย" }),
];

describe("P1 manual message", () => {
  test("shows W / R / D / sold / central price / expected sales", () => {
    const text = buildSalesSummaryBlocks(report(TRUSTED_ROWS)).join("\n\n");

    expect(text).toContain(SALES_MANUAL_TITLE);
    expect(text).toContain("หมอนทอง (กิโล)");
    expect(text).toContain("เบิก 10 • คืน 2 • เสีย 1");
    expect(text).toContain("ขาย 7 กิโล");
    expect(text).toContain("ราคากลาง 120.00 → 840.00 บาท");
  });

  test("a fully verified day is labelled as a total", () => {
    const text = buildSalesSummaryBlocks(report(TRUSTED_ROWS)).join("\n\n");
    expect(text).toContain(SALES_TOTAL_HEADING);
    expect(text).not.toContain(SALES_PARTIAL_HEADING);
  });

  test("a partial day is never labelled as total sales", () => {
    const text = buildSalesSummaryBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).toContain(SALES_PARTIAL_HEADING);
    // The all-market figure must not carry the "total sales" heading …
    expect(text).not.toContain(`${SALES_TOTAL_HEADING}\n840.00`);
    // … and the blocked entry has to say why.
    expect(text).toContain(SALES_BLOCKED_HEADING);
    expect(text).toContain("ยังไม่มีข้อมูลชั่งคืน");
  });

  test("a blocked row shows no sold quantity and no value", () => {
    const text = buildSalesSummaryBlocks(
      report([row({ quantity: 5, transactionType: "เบิก" })]),
    ).join("\n\n");

    expect(text).toContain("ขาย — (ยังไม่มีข้อมูลชั่งคืน)");
    expect(text).not.toContain("ราคากลาง");
  });

  test("a value-blocked row shows the trusted quantity but no value", () => {
    const text = buildSalesSummaryBlocks(
      calculateSalesReport({
        businessDate: DATE,
        rows: [row({ quantity: 10 }), row({ quantity: 4, transactionType: "คืน" })],
      }),
    ).join("\n\n");

    expect(text).toContain("ขาย 6 กิโล");
    expect(text).toContain("ยอดขาย — (ไม่มีราคากลาง)");
  });

  test("a scope-level integrity problem is stated with its count", () => {
    const text = buildSalesSummaryBlocks(
      report(TRUSTED_ROWS, { scopeBlockers: [{ kind: "unresolved_pending_session", count: 2 }] }),
    ).join("\n\n");

    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด 2 ชุด");
    expect(text).toContain(SALES_PARTIAL_HEADING);
  });

  test("an empty day says so instead of reporting zero sales", () => {
    const text = buildSalesSummaryBlocks(report([])).join("\n\n");
    expect(text).toContain(SALES_EMPTY_NOTICE);
    expect(text).not.toContain(SALES_TOTAL_HEADING);
  });

  test("a market with an unresolved name is labelled, not dropped", () => {
    const text = buildSalesSummaryBlocks(
      report([row({ marketName: null, quantity: 5 })]),
    ).join("\n\n");
    expect(text).toContain("ไม่ระบุตลาด");
    expect(text).toContain("ระบุตลาดไม่ได้");
  });

  test("the reply is chunked and capped at the LINE reply limit", () => {
    const many: SalesSourceRow[] = [];
    for (let index = 0; index < 400; index += 1) {
      many.push(row({ productName: `สินค้า${index}`, unit: "กำ", quantity: 5 }));
    }

    const messages = buildSalesSummaryMessages(report(many));
    expect(messages.length).toBeLessThanOrEqual(5);
    for (const message of messages) expect([...message].length).toBeLessThanOrEqual(4000);
    // The answer and the blocked list lead, so a capped reply keeps what matters.
    expect(messages[0]).toContain(SALES_MANUAL_TITLE);
  });
});

describe("P1 automatic message", () => {
  test("carries the same numbers under the automatic title", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    expect(text).toContain(SALES_AUTO_TITLE);
    expect(text).toContain("840.00 บาท");
    expect(text).toContain("หมอนทอง (กิโล) — ขาย 7 • 840.00 บาท");
  });

  test("lists every blocked entry, never truncated", () => {
    const many: SalesSourceRow[] = [];
    for (let index = 0; index < 200; index += 1) {
      many.push(row({ productName: `สินค้า${index}`, unit: "กำ", quantity: 5 }));
    }

    const built = report(many);
    const text = buildSalesAutoMessages(built).join("\n");

    expect(built.blocked).toHaveLength(200);
    for (const blocked of built.blocked) expect(text).toContain(blocked.productName);
  });

  test("is not capped at five messages — a push may use as many parts as it needs", () => {
    const many: SalesSourceRow[] = [];
    for (let index = 0; index < 600; index += 1) {
      many.push(row({ productName: `สินค้า${index}`, unit: "กำ", quantity: 5 }));
    }

    const messages = buildSalesAutoMessages(report(many));
    expect(messages.length).toBeGreaterThan(5);
    for (const message of messages) expect([...message].length).toBeLessThanOrEqual(4000);
  });

  test("does not report cash, transfers, slips, cost or profit", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    for (const forbidden of ["เงินสด", "ยอดโอน", "สลิป", "ต้นทุน", "กำไร", "ขาดเกิน"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("P1 message wording", () => {
  test("a quantity-complete, value-partial day says exactly that", () => {
    // Sold quantity is proven for both products; only ชะอม lacks a price.
    const text = buildSalesSummaryBlocks(
      report([
        ...TRUSTED_ROWS,
        row({ productName: "ชะอม", unit: "กำ", quantity: 8 }),
        row({ productName: "ชะอม", unit: "กำ", quantity: 3, transactionType: "คืน" }),
      ]),
    ).join("\n\n");

    expect(text).toContain(SALES_PARTIAL_HEADING);
    expect(text).toContain(SALES_QUANTITY_ONLY_NOTICE);
    // The quantity is reported in full, the money is marked partial.
    expect(text).toContain("ชะอม (กำ) — ขาย 5 • 0.00 บาท (บางส่วน)");
  });

  test("a quantity-blocked day does not claim the quantity is complete", () => {
    const text = buildSalesSummaryBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).not.toContain(SALES_QUANTITY_ONLY_NOTICE);
  });

  test("the overflow notice never points at a Sales web page that does not exist", () => {
    const many: SalesSourceRow[] = [];
    for (let index = 0; index < 400; index += 1) {
      many.push(row({ productName: `สินค้า${index}`, unit: "กำ", quantity: 5 }));
    }

    const messages = buildSalesSummaryMessages(report(many));
    const last = messages[messages.length - 1];

    expect(messages).toHaveLength(5);
    expect(last).toContain(SALES_OVERFLOW_NOTICE.trim());
    expect(last).not.toContain("หน้าเว็บ");
  });
});
