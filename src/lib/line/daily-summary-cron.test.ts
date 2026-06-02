import { describe, expect, it } from "bun:test";
import {
  groupDailySummariesBySource,
  resolveDailySummaryDate,
  type DailySummarySourceRow,
  type DailySummaryTransactionRow,
} from "./daily-summary-cron";

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
    },
    {
      raw_message_id: "raw-2",
      staff_name: "กี้",
      market_name: "ตลาด A",
      transaction_type: "คืน",
      total_amount: 30,
    },
    {
      raw_message_id: "raw-3",
      staff_name: "ดำ",
      market_name: "ตลาด B",
      transaction_type: "คืนเสีย",
      total_amount: 10,
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
