import { describe, expect, test } from "bun:test";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";
import { LINE_MESSAGE_MAX_CODE_POINTS } from "@/lib/summary/line-chunking";
import { calculateSalesReport, type SalesSourceRow } from "./calculate";
import {
  salesAutoNeedsLatestDataHint,
  SALES_NO_DATA_PREFIX,
  SALES_NO_HISTORY_NOTICE,
  buildSalesAutoBlocks,
  buildSalesAutoMessages,
  buildSalesSummaryBlocks,
  buildSalesSummaryMessages,
  SALES_AUTO_TITLE,
  SALES_BLOCKED_HEADING,
  SALES_EMPTY_NOTICE,
  SALES_MANUAL_TITLE,
  SALES_OVERFLOW_NOTICE,
  SALES_NO_ROWS_BLOCKED_NOTICE,
  SALES_MARKET_SECTION_HEADING,
  SALES_PRODUCT_SECTION_HEADING,
  SALES_PARTIAL_HEADING,
  SALES_QUANTITY_ONLY_NOTICE,
  SALES_TOTAL_HEADING,
  SALES_VALUE_UNAVAILABLE,
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

    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ 2 ชุด");
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

describe("P1 automatic message — executive summary", () => {
  test("carries the same numbers under the automatic title", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    expect(text).toContain(SALES_AUTO_TITLE);
    expect(text).toContain("840.00 บาท");
  });

  test("states trusted and untrusted row counts", () => {
    const text = buildSalesAutoBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).toContain("✅ ยืนยันได้ 1 รายการ");
    expect(text).toContain("⚠️ ยืนยันไม่ได้ 1 รายการ");
  });

  test("gives per-market confirmed totals, marking partial ones", () => {
    const text = buildSalesAutoBlocks(
      report([
        ...TRUSTED_ROWS,
        row({ marketName: "ตลาดน้อย", sessionId: "s-b", productName: "ชะอม", unit: "กำ", quantity: 5 }),
      ]),
    ).join("\n\n");

    expect(text).toContain(SALES_MARKET_SECTION_HEADING);
    expect(text).toContain("ตลาดกี้ — 840.00 บาท");
    expect(text).toContain(`ตลาดน้อย — ${SALES_VALUE_UNAVAILABLE}`);
  });

  test("groups blocked entries by reason instead of listing every row", () => {
    const many: SalesSourceRow[] = [];
    for (let index = 0; index < 40; index += 1) {
      many.push(row({ productName: `สินค้า${index}`, unit: "กำ", quantity: 5 }));
    }

    const built = report(many);
    const text = buildSalesAutoBlocks(built).join("\n\n");

    expect(built.blocked).toHaveLength(40);
    expect(text).toContain(SALES_BLOCKED_HEADING);
    expect(text).toContain("1 รายการอาจพบมากกว่า 1 สาเหตุ");
    expect(text).toContain("• ยังไม่มีข้อมูลชั่งคืน — 40 รายการ");
    // The rows themselves are the manual command's job, not the morning push.
    expect(text).not.toContain("สินค้า0 (กำ)");
  });

  test("drops the full product dump", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    expect(text).not.toContain(SALES_PRODUCT_SECTION_HEADING);
    expect(text).not.toContain("หมอนทอง (กิโล) — ขาย 7");
  });

  test("a real production-shaped day fits in two LINE messages", () => {
    // 2026-07-25 shape: ~17 markets, ~130 products, ~160 blocked identities.
    const many: SalesSourceRow[] = [];
    for (let market = 0; market < 17; market += 1) {
      for (let product = 0; product < 8; product += 1) {
        const base = {
          marketName: `ตลาด${market}`,
          sessionId: `s-${market}`,
          productName: `สินค้า${product}`,
          unit: "กำ",
        };
        many.push(row({ ...base, quantity: 10 }));
        // Half the identities close properly, half stay blocked.
        if (product % 2 === 0) many.push(row({ ...base, quantity: 4, transactionType: "คืน" }));
      }
    }

    const messages = buildSalesAutoMessages(report(many));
    expect(messages.length).toBeLessThanOrEqual(2);
    for (const message of messages) expect([...message].length).toBeLessThanOrEqual(4000);
  });

  test("does not report cash, transfers, slips, cost or profit", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    for (const forbidden of ["เงินสด", "ยอดโอน", "สลิป", "ต้นทุน", "กำไร", "ขาดเกิน"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("scope blockers are still stated in full — fail-closed is not summarised away", () => {
    const text = buildSalesAutoBlocks(
      report(TRUSTED_ROWS, { scopeBlockers: [{ kind: "unresolved_pending_session", count: 2 }] }),
    ).join("\n\n");

    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ 2 ชุด");
    expect(text).toContain(SALES_PARTIAL_HEADING);
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
    expect(text).toContain("ชะอม (กำ) — ขาย 5 • ยอดเงินยังคำนวณไม่ได้");
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

describe("P1 empty day must not hide blockers", () => {
  const blockers = [{ kind: "unresolved_pending_session" as const, count: 1 }];

  test("manual: no rows and no blockers is a real 'no sales' answer", () => {
    const text = buildSalesSummaryBlocks(report([])).join("\n\n");
    expect(text).toContain(SALES_EMPTY_NOTICE);
    expect(text).not.toContain(SALES_NO_ROWS_BLOCKED_NOTICE);
  });

  test("manual: no rows WITH blockers is reported as incomplete, not as no sales", () => {
    const text = buildSalesSummaryBlocks(report([], { scopeBlockers: blockers })).join("\n\n");

    expect(text).not.toContain(SALES_EMPTY_NOTICE);
    expect(text).toContain(SALES_NO_ROWS_BLOCKED_NOTICE);
    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ 1 ชุด");
  });

  test("auto: no rows WITH blockers is reported as incomplete, not as no sales", () => {
    const text = buildSalesAutoBlocks(report([], { scopeBlockers: blockers })).join("\n\n");

    expect(text).not.toContain(SALES_EMPTY_NOTICE);
    expect(text).toContain(SALES_NO_ROWS_BLOCKED_NOTICE);
    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ 1 ชุด");
  });

  test("auto: no rows and no blockers asks for the latest-data hint", () => {
    expect(salesAutoNeedsLatestDataHint(report([]))).toBe(true);
    expect(salesAutoNeedsLatestDataHint(report([], { scopeBlockers: blockers }))).toBe(false);
    expect(salesAutoNeedsLatestDataHint(report(TRUSTED_ROWS))).toBe(false);
  });

  test("every scope blocker is listed, never summarised away", () => {
    const text = buildSalesAutoBlocks(
      report([], {
        scopeBlockers: [
          { kind: "unresolved_pending_session" as const, count: 2 },
          { kind: "message_parser_error" as const, count: 3 },
          { kind: "unattributable_session" as const, count: 1 },
        ],
      }),
    ).join("\n\n");

    expect(text).toContain("ยังไม่ปิด/ปิดไม่สำเร็จ 2 ชุด");
    expect(text).toContain("อ่านไม่สำเร็จ 3 ข้อความ");
    expect(text).toContain("ระบุตลาดไม่ได้ 1 ชุด");
  });
});

describe("P1 auto empty state", () => {
  test("names the requested date instead of a vague 'today'", () => {
    const text = buildSalesAutoBlocks(report([])).join("\n\n");

    expect(text).toContain(SALES_AUTO_TITLE);
    expect(text).toContain(`${SALES_NO_DATA_PREFIX} 25 กรกฎาคม 2569`);
    expect(text).not.toContain(SALES_EMPTY_NOTICE);
  });

  test("shows the latest date with sales as context, never as the day's total", () => {
    const text = buildSalesAutoBlocks(report([]), { date: "2026-07-24", marketCount: 10 })
      .join("\n\n");

    expect(text).toContain(`${SALES_NO_DATA_PREFIX} 25 กรกฎาคม 2569`);
    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 24 กรกฎาคม 2569");
    expect(text).toContain("พบข้อมูล 10 ตลาด");
    // The report's date stays the requested one and carries no revenue figure
    // borrowed from the prior day.
    expect(text).toContain("ข้อมูลวันที่ 25 กรกฎาคม 2569");
    expect(text).not.toContain("ข้อมูลวันที่ 24 กรกฎาคม 2569");
    expect(text).not.toContain(SALES_TOTAL_HEADING);
    expect(text).not.toContain("บาท");
  });

  test("says so plainly when no sales exist anywhere", () => {
    const text = buildSalesAutoBlocks(report([]), null).join("\n\n");

    expect(text).toContain(SALES_NO_HISTORY_NOTICE);
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
  });

  test("omits the market count when the latest date resolved no market", () => {
    const text = buildSalesAutoBlocks(report([]), { date: "2026-07-24", marketCount: 0 })
      .join("\n\n");

    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 24 กรกฎาคม 2569");
    expect(text).not.toContain("พบข้อมูล 0 ตลาด");
  });

  test("a day with sales ignores the hint entirely", () => {
    expect(buildSalesAutoBlocks(report(TRUSTED_ROWS), { date: "2026-07-24", marketCount: 10 }))
      .toEqual(buildSalesAutoBlocks(report(TRUSTED_ROWS)));
  });

  test("the empty state fits in a single LINE message", () => {
    const messages = buildSalesAutoMessages(report([]), {
      latest: { date: "2026-07-24", marketCount: 10 },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].length).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
  });
});

describe("P1 manual message keeps the full audit detail", () => {
  test("the manual reply still lists products and every blocked row", () => {
    const built = report([
      ...TRUSTED_ROWS,
      row({ productName: "ชะอม", unit: "กำ", quantity: 5 }),
    ]);
    const text = buildSalesSummaryBlocks(built).join("\n\n");

    expect(text).toContain(SALES_PRODUCT_SECTION_HEADING);
    expect(text).toContain("เบิก 10 • คืน 2 • เสีย 1");
    for (const blocked of built.blocked) expect(text).toContain(blocked.productName);
  });
});

describe("P1 unpriced value wording", () => {
  test("an unpriced day never prints a figure that reads as zero revenue", () => {
    const text = buildSalesSummaryBlocks(
      calculateSalesReport({
        businessDate: DATE,
        rows: [row({ quantity: 10 }), row({ quantity: 4, transactionType: "คืน" })],
      }),
    ).join("\n\n");

    expect(text).toContain(SALES_VALUE_UNAVAILABLE);
    expect(text).not.toContain("0.00 บาท");
  });

  test("a genuine trusted zero still prints 0.00, because that IS the revenue", () => {
    const text = buildSalesSummaryBlocks(
      report([row({ quantity: 10 }), row({ quantity: 10, transactionType: "คืน" })]),
    ).join("\n\n");

    expect(text).toContain("0.00 บาท");
    expect(text).not.toContain(SALES_VALUE_UNAVAILABLE);
  });

  test("a partial subtotal still shows the verified figure alongside the caveat", () => {
    const text = buildSalesSummaryBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).toContain(SALES_PARTIAL_HEADING);
    expect(text).toContain("840.00 บาท");
  });
});
