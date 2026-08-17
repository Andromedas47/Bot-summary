import { describe, expect, it } from "bun:test";
import {
  dailySummaryCategoryLedgers,
  dailySummaryRetryKey,
  groupDailySummariesBySource,
  resolveDailySummaryDate,
  type DailySummarySourceRow,
  type DailySummaryTransactionRow,
} from "./daily-summary-cron";
import type { CategoryLedgerEntry } from "@/lib/summary/produce-category-totals";
import { dailySummaryCategoryLedgerKey } from "./daily-summary-message";

describe("dailySummaryRetryKey", () => {
  it("is a valid UUID", () => {
    expect(dailySummaryRetryKey("2026-06-01", "group-abc")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is stable for the same date and target across retries", () => {
    expect(dailySummaryRetryKey("2026-06-01", "group-abc"))
      .toBe(dailySummaryRetryKey("2026-06-01", "group-abc"));
  });

  it("differs across dates and targets", () => {
    const key = dailySummaryRetryKey("2026-06-01", "group-abc");
    expect(dailySummaryRetryKey("2026-06-02", "group-abc")).not.toBe(key);
    expect(dailySummaryRetryKey("2026-06-01", "group-xyz")).not.toBe(key);
  });
});

describe("resolveDailySummaryDate", () => {
  it("uses the previous Bangkok calendar date at the intended 03:58 run", () => {
    const ts = Date.UTC(2026, 5, 1, 20, 58, 0); // 2026-06-02 03:58 Bangkok
    expect(resolveDailySummaryDate(null, ts)).toBe("2026-06-01");
  });

  it("still uses the previous Bangkok calendar date when Vercel invokes after 04:00", () => {
    const ts = Date.UTC(2026, 5, 1, 21, 30, 0); // 2026-06-02 04:30 Bangkok
    expect(resolveDailySummaryDate(null, ts)).toBe("2026-06-01");
  });

  it("allows manual date override for production verification", () => {
    const ts = Date.UTC(2026, 5, 1, 21, 30, 0);
    expect(resolveDailySummaryDate("2026-05-29", ts)).toBe("2026-05-29");
  });
});

describe("groupDailySummariesBySource", () => {
  const transactions: DailySummaryTransactionRow[] = [
    {
      raw_message_id: "raw-1",
      staff_name: "กี้",
      market_name: "ตลาด A",
      transaction_type: "เบิก",
      total_amount: 100,
      product_name: "หมอนทอง",
    },
    {
      raw_message_id: "raw-2",
      staff_name: "กี้",
      market_name: "ตลาด A",
      transaction_type: "คืน",
      total_amount: 30,
      product_name: "หมอนทอง",
    },
    {
      raw_message_id: "raw-3",
      staff_name: "ดำ",
      market_name: "ตลาด B",
      transaction_type: "คืนเสีย",
      total_amount: 10,
      product_name: "หมอนทอง",
    },
  ];

  const sources: DailySummarySourceRow[] = [
    { id: "raw-1", source_id: "group-1", source_type: "group" },
    { id: "raw-2", source_id: "group-1", source_type: "group" },
    { id: "raw-3", source_id: "group-2", source_type: "group" },
  ];

  it("returns grouped LINE push targets with source_id", () => {
    const grouped = groupDailySummariesBySource(transactions, sources, "2026-06-01");

    expect([...grouped.keys()]).toEqual(["group-1", "group-2"]);
    expect(grouped.get("group-1")).toEqual([
      {
        summary_date: "2026-06-01",
        staff_name: "กี้",
        market_name: "ตลาด A",
        borrow_total: 100,
        return_total: 30,
        bad_return_total: 0,
        net_sales: 70,
        transaction_count: 2,
      },
    ]);
  });

  it("skips transactions whose raw message has no valid source_id", () => {
    const grouped = groupDailySummariesBySource(
      transactions,
      [{ id: "raw-1", source_id: "unknown", source_type: "group" }],
      "2026-06-01",
    );

    expect(grouped.size).toBe(0);
  });
});

describe("dailySummaryCategoryLedgers", () => {
  function tx(overrides: Partial<DailySummaryTransactionRow> = {}): DailySummaryTransactionRow {
    return {
      raw_message_id: "raw-1",
      staff_name: "กี้",
      market_name: "ตลาด A",
      transaction_type: "เบิก",
      total_amount: 100,
      product_name: "หมอนทอง",
      ...overrides,
    };
  }

  const key = (staffName: string, marketName: string) => dailySummaryCategoryLedgerKey(staffName, marketName);

  const SOURCE = "C-source-a";

  /**
   * Ledgers for one LINE source. Ledger identity is (source, staff, market) —
   * the same identity groupDailySummariesBySource assigns the grand totals —
   * so these helpers build the source rows the same way the cron does.
   */
  function sourcesFor(
    rows: readonly DailySummaryTransactionRow[],
    sourceByMessage: Record<string, string> = {},
  ) {
    return [...new Set(rows.map((row) => row.raw_message_id))].map((id) => ({
      id,
      source_id: sourceByMessage[id] ?? SOURCE,
      source_type: "group",
    }));
  }

  function ledgersFor(
    rows: readonly DailySummaryTransactionRow[],
    sourceByMessage: Record<string, string> = {},
  ) {
    return dailySummaryCategoryLedgers(rows, sourcesFor(rows, sourceByMessage)).get(SOURCE)
      ?? new Map<string, CategoryLedgerEntry[]>();
  }

  /**
   * Bit-for-bit copy of DailySummaryService.recalculate's own bucketing loop
   * (src/lib/line/daily-summary-service.ts), so the parity assertions below
   * compare against an independently-replicated grand total rather than a
   * second hand-typed set of numbers.
   */
  function replicateRecalculate(rows: readonly DailySummaryTransactionRow[]) {
    let borrowTotal = 0;
    let returnTotal = 0;
    let badReturnTotal = 0;
    for (const row of rows) {
      const amount = Number(row.total_amount ?? 0);
      const type = row.transaction_type;
      if (type === "เบิก" || type === "เบิกเพิ่ม") borrowTotal += amount;
      else if (type === "คืน") returnTotal += amount;
      else if (type === "คืนเสีย" || type === "เสีย") badReturnTotal += amount;
    }
    return { borrowTotal, returnTotal, badReturnTotal, netSales: borrowTotal - returnTotal - badReturnTotal };
  }

  it("one seller/market/day, single session", () => {
    const ledgers = ledgersFor([
      tx({ transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
    ]);
    const entries = ledgers.get(key("กี้", "ตลาด A"))!;
    expect(entries).toEqual([
      {
        id: "ท",
        label: "ทุเรียน",
        heading: "🥭 ทุเรียน",
        withdrawnSatang: 100_000,
        goodReturnSatang: 0,
        badReturnSatang: 0,
        netSatang: 100_000,
      },
    ]);
  });

  it("main + additional withdrawal in different categories aggregate into ONE summary", () => {
    const rows = [
      tx({ raw_message_id: "raw-1", transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "raw-2", transaction_type: "เบิกเพิ่ม", total_amount: 300, product_name: "เห็ดนางฟ้า" }),
    ];
    const ledgers = ledgersFor(rows);
    const entries = ledgers.get(key("กี้", "ตลาด A"))!;
    expect(entries.map((e) => e.id)).toEqual(["ท", "ห"]);
    expect(entries.find((e) => e.id === "ท")!.withdrawnSatang).toBe(100_000);
    expect(entries.find((e) => e.id === "ห")!.withdrawnSatang).toBe(30_000);
  });

  it("withdrawal + good return + bad return, per-category net correct", () => {
    const rows = [
      tx({ transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ transaction_type: "คืน", total_amount: 200, product_name: "หมอนทอง" }),
      tx({ transaction_type: "คืนเสีย", total_amount: 50, product_name: "หมอนทอง" }),
    ];
    const entries = ledgersFor(rows).get(key("กี้", "ตลาด A"))!;
    expect(entries).toEqual([
      {
        id: "ท",
        label: "ทุเรียน",
        heading: "🥭 ทุเรียน",
        withdrawnSatang: 100_000,
        goodReturnSatang: 20_000,
        badReturnSatang: 5_000,
        netSatang: 75_000,
      },
    ]);
  });

  it("multiple sessions (distinct raw_message_id) for the same seller/market aggregate together", () => {
    const rows = [
      tx({ raw_message_id: "session-main", transaction_type: "เบิก", total_amount: 500, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "session-additional-1", transaction_type: "เบิกเพิ่ม", total_amount: 200, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "session-additional-2", transaction_type: "เบิกเพิ่ม", total_amount: 100, product_name: "หมอนทอง" }),
    ];
    const entries = ledgersFor(rows).get(key("กี้", "ตลาด A"))!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.withdrawnSatang).toBe(80_000);
  });

  it("decimal and basis-priced amounts are exact to the satang", () => {
    const rows = [
      tx({ transaction_type: "เบิก", total_amount: 14.5 * 50, product_name: "หมอนทอง" }), // 725.00
      tx({ transaction_type: "คืน", total_amount: 2.5 * 35, product_name: "หมอนทอง" }), // 87.50
    ];
    const entries = ledgersFor(rows).get(key("กี้", "ตลาด A"))!;
    expect(entries[0]!.withdrawnSatang).toBe(72_500);
    expect(entries[0]!.goodReturnSatang).toBe(8_750);
  });

  it("a reviewed alias resolves to the same category as its canonical name", () => {
    const canonical = ledgersFor([
      tx({ transaction_type: "เบิก", total_amount: 100, product_name: "หมอนทอง" }),
    ]).get(key("กี้", "ตลาด A"))!;
    const aliased = ledgersFor([
      tx({ transaction_type: "เบิก", total_amount: 100, product_name: "หมอน" }),
    ]).get(key("กี้", "ตลาด A"))!;
    expect(aliased.map((e) => e.id)).toEqual(canonical.map((e) => e.id));
    expect(aliased[0]!.id).toBe("ท");
  });

  it("uncategorized stays visible and its money is counted", () => {
    const rows = [
      tx({ transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ transaction_type: "เบิก", total_amount: 500, product_name: "มะม่วงต่างดาว" }),
    ];
    const entries = ledgersFor(rows).get(key("กี้", "ตลาด A"))!;
    const uncategorized = entries.find((e) => e.id === "uncategorized");
    expect(uncategorized).toBeDefined();
    expect(uncategorized!.withdrawnSatang).toBe(50_000);
  });

  it("SUM(category withdrawn/return/bad) === grand totals computed the same way DailySummaryService.recalculate computes them", () => {
    const rows = [
      tx({ raw_message_id: "raw-1", transaction_type: "เบิก", total_amount: 14.5 * 50, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "raw-2", transaction_type: "เบิกเพิ่ม", total_amount: 250.75, product_name: "เห็ดนางฟ้า" }),
      tx({ raw_message_id: "raw-3", transaction_type: "คืน", total_amount: 2.5 * 35, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "raw-4", transaction_type: "คืนเสีย", total_amount: 42.5, product_name: "มะม่วงต่างดาว" }),
      tx({ raw_message_id: "raw-5", transaction_type: "เสีย", total_amount: 10, product_name: "หมอนทอง" }),
    ];
    const entries = ledgersFor(rows).get(key("กี้", "ตลาด A"))!;
    const expected = replicateRecalculate(rows);

    const withdrawnSatang = entries.reduce((sum, e) => sum + e.withdrawnSatang, 0);
    const goodReturnSatang = entries.reduce((sum, e) => sum + e.goodReturnSatang, 0);
    const badReturnSatang = entries.reduce((sum, e) => sum + e.badReturnSatang, 0);

    expect(withdrawnSatang).toBe(Math.round(expected.borrowTotal * 100));
    expect(goodReturnSatang).toBe(Math.round(expected.returnTotal * 100));
    expect(badReturnSatang).toBe(Math.round(expected.badReturnTotal * 100));
  });

  it("SUM(per-category net) === grand net", () => {
    const rows = [
      tx({ raw_message_id: "raw-1", transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "raw-2", transaction_type: "เบิก", total_amount: 300, product_name: "เห็ดนางฟ้า" }),
      tx({ raw_message_id: "raw-3", transaction_type: "คืน", total_amount: 200, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "raw-4", transaction_type: "คืนเสีย", total_amount: 50, product_name: "เห็ดนางฟ้า" }),
    ];
    const entries = ledgersFor(rows).get(key("กี้", "ตลาด A"))!;
    const expected = replicateRecalculate(rows);

    const netSum = entries.reduce((sum, e) => sum + e.netSatang, 0);
    expect(netSum).toBe(Math.round(expected.netSales * 100));
  });

  it("different market, same seller, same date — NOT combined", () => {
    const rows = [
      tx({ raw_message_id: "raw-1", staff_name: "กี้", market_name: "ตลาด A", transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "raw-2", staff_name: "กี้", market_name: "ตลาด B", transaction_type: "เบิก", total_amount: 400, product_name: "หมอนทอง" }),
    ];
    const ledgers = ledgersFor(rows);
    expect(ledgers.get(key("กี้", "ตลาด A"))![0]!.withdrawnSatang).toBe(100_000);
    expect(ledgers.get(key("กี้", "ตลาด B"))![0]!.withdrawnSatang).toBe(40_000);
  });

  it("different seller, same market, same date — NOT combined", () => {
    const rows = [
      tx({ raw_message_id: "raw-1", staff_name: "กี้", market_name: "ตลาด A", transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "raw-2", staff_name: "ดำ", market_name: "ตลาด A", transaction_type: "เบิก", total_amount: 700, product_name: "หมอนทอง" }),
    ];
    const ledgers = ledgersFor(rows);
    expect(ledgers.get(key("กี้", "ตลาด A"))![0]!.withdrawnSatang).toBe(100_000);
    expect(ledgers.get(key("ดำ", "ตลาด A"))![0]!.withdrawnSatang).toBe(70_000);
  });

  it("uses knownNames built from the whole day so a เพิ่ม-prefixed name for one seller resolves like a sibling elsewhere on the same day", () => {
    const rows = [
      // Lone "เพิ่มหมอนทอง" for seller ดำ — with no context, this would land in ไม่จัดหมวด.
      tx({ raw_message_id: "raw-1", staff_name: "ดำ", market_name: "ตลาด B", transaction_type: "เบิก", total_amount: 100, product_name: "เพิ่มหมอนทอง" }),
      // A different seller's plain "หมอนทอง" row, same day — genuine day-wide context.
      tx({ raw_message_id: "raw-2", staff_name: "กี้", market_name: "ตลาด A", transaction_type: "เบิก", total_amount: 100, product_name: "หมอนทอง" }),
    ];
    const entries = ledgersFor(rows).get(key("ดำ", "ตลาด B"))!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("ท");
  });

  it("one seller/market posting through TWO LINE sources stays split per source", () => {
    // The grand totals are accumulated per (source, staff, market) and each
    // source gets its own pushed message. A ledger keyed on staff+market alone
    // would hand both messages one combined ทุเรียน 1,500 — money each
    // source's own total does not contain, and the other LINE group's business
    // shown to people who never sent it.
    const rows = [
      tx({ raw_message_id: "raw-1", transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "raw-2", transaction_type: "เบิก", total_amount: 500, product_name: "หมอนทอง" }),
    ];
    const bySource = dailySummaryCategoryLedgers(
      rows,
      [
        { id: "raw-1", source_id: "C-source-a", source_type: "group" },
        { id: "raw-2", source_id: "C-source-b", source_type: "group" },
      ],
    );
    expect(bySource.get("C-source-a")!.get(key("กี้", "ตลาด A"))![0]!.withdrawnSatang).toBe(100_000);
    expect(bySource.get("C-source-b")!.get(key("กี้", "ตลาด A"))![0]!.withdrawnSatang).toBe(50_000);

    // And each source's category total equals that source's own grand total.
    for (const [sourceId, ownRows] of [
      ["C-source-a", [rows[0]!]],
      ["C-source-b", [rows[1]!]],
    ] as const) {
      const entries = bySource.get(sourceId)!.get(key("กี้", "ตลาด A"))!;
      const categorySum = entries.reduce((sum, e) => sum + e.withdrawnSatang, 0);
      expect(categorySum).toBe(Math.round(replicateRecalculate(ownRows).borrowTotal * 100));
    }
  });

  it("a row whose raw message has no resolvable source is skipped, exactly as the grand totals skip it", () => {
    const rows = [
      tx({ raw_message_id: "raw-1", transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ raw_message_id: "orphan", transaction_type: "เบิก", total_amount: 999, product_name: "หมอนทอง" }),
    ];
    const bySource = dailySummaryCategoryLedgers(
      rows,
      [{ id: "raw-1", source_id: "C-source-a", source_type: "group" }],
    );
    expect(bySource.get("C-source-a")!.get(key("กี้", "ตลาด A"))![0]!.withdrawnSatang).toBe(100_000);
    expect([...bySource.keys()]).toEqual(["C-source-a"]);
  });

  it("a legacy ชั่งคืนเพิ่ม / คืนเสียเพิ่ม row is excluded, matching the grand totals beside it", () => {
    // transactions.ts is explicit that baseTransactionType's extra folding is
    // "not for existing report buckets". The grand totals printed under these
    // categories recognize only เบิก/เบิกเพิ่ม/คืน/คืนเสีย/เสีย, so counting a
    // legacy marker row here would show money the total below it omits.
    const rows = [
      tx({ transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ transaction_type: "ชั่งคืนเพิ่ม", total_amount: 400, product_name: "หมอนทอง" }),
      tx({ transaction_type: "คืนเสียเพิ่ม", total_amount: 200, product_name: "หมอนทอง" }),
    ];
    const entries = ledgersFor(rows).get(key("กี้", "ตลาด A"))!;
    const expected = replicateRecalculate(rows);
    expect(entries.reduce((sum, e) => sum + e.withdrawnSatang, 0))
      .toBe(Math.round(expected.borrowTotal * 100));
    expect(entries.reduce((sum, e) => sum + e.goodReturnSatang, 0))
      .toBe(Math.round(expected.returnTotal * 100));
    expect(entries.reduce((sum, e) => sum + e.badReturnSatang, 0))
      .toBe(Math.round(expected.badReturnTotal * 100));
    expect(entries.reduce((sum, e) => sum + e.netSatang, 0))
      .toBe(Math.round(expected.netSales * 100));
  });

  it("a legacy เสีย row IS counted, because the grand totals count it", () => {
    const rows = [
      tx({ transaction_type: "เบิก", total_amount: 1000, product_name: "หมอนทอง" }),
      tx({ transaction_type: "เสีย", total_amount: 250, product_name: "หมอนทอง" }),
    ];
    const entries = ledgersFor(rows).get(key("กี้", "ตลาด A"))!;
    const expected = replicateRecalculate(rows);
    expect(entries.reduce((sum, e) => sum + e.badReturnSatang, 0))
      .toBe(Math.round(expected.badReturnTotal * 100));
    expect(entries.reduce((sum, e) => sum + e.netSatang, 0))
      .toBe(Math.round(expected.netSales * 100));
  });
});
