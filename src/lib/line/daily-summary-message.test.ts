import { describe, expect, it } from "bun:test";
import { buildDailySummaryMessage } from "./daily-summary-message";

describe("buildDailySummaryMessage", () => {
  it("builds end-of-day summary with net sales", () => {
    const result = buildDailySummaryMessage("2026-06-01", [
      {
        summary_date: "2026-06-01",
        staff_name: "กี้",
        market_name: "กี้-ตลาด72 เบิก 1/6/2569",
        borrow_total: 14446.2,
        return_total: 2300,
        bad_return_total: 500,
        net_sales: 11646.2,
        transaction_count: 19,
      },
    ]);

    expect(result).toContain("สรุปยอดประจำวันที่ 1 มิถุนายน 2569");
    expect(result).toContain("กี้ — ตลาด72");
    expect(result).toContain("เบิกรวม: 14,446.2 บาท");
    expect(result).toContain("คืนรวม: 2,300 บาท");
    expect(result).toContain("คืนเสียรวม: 500 บาท");
    expect(result).toContain("ยอดส่ง: 11,646.2 บาท");
  });

  it("supports multiple staff/market rows", () => {
    const result = buildDailySummaryMessage("2026-06-01", [
      {
        summary_date: "2026-06-01",
        staff_name: "กี้",
        market_name: "ตลาด72",
        borrow_total: 1000,
        return_total: 100,
        bad_return_total: 50,
        net_sales: 850,
        transaction_count: 3,
      },
      {
        summary_date: "2026-06-01",
        staff_name: "พี่ดำ",
        market_name: "ตลาด80",
        borrow_total: 2000,
        return_total: 0,
        bad_return_total: 0,
        net_sales: 2000,
        transaction_count: 4,
      },
    ]);

    expect(result).toContain("กี้ — ตลาด72");
    expect(result).toContain("ยอดส่ง: 850 บาท");
    expect(result).toContain("พี่ดำ — ตลาด80");
    expect(result).toContain("ยอดส่ง: 2,000 บาท");
  });
});
