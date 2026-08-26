import { describe, expect, it } from "bun:test";
import { buildSettlementLineMessage } from "./settlement-message";

describe("buildSettlementLineMessage", () => {
  it("formats settlement notification with two decimal places and shortage", () => {
    const result = buildSettlementLineMessage({
      date: "2026-06-01",
      staffName: "มีน",
      marketName: "วัดทุ่งลานนา",
      transactions: {
        เบิก: 9000,
        คืน: 1000,
        คืนเสีย: 568.5,
        ยอดส่ง: 7431.5,
      },
      produceValueStatus: "complete",
      settlement: {
        ยอดโอน: 2680,
        เงินสด: 3145,
        ค่าใช้จ่าย: 107,
        ค่าแรง: 1200,
        ยอดขาย: 7132,
        เงินสดต้องส่งเจ๊: 3444.5,
        ขาดเกิน: -299.5,
      },
    });

    expect(result).toContain("รายการส่งเงิน ✅");
    expect(result).toContain("มีน — วัดทุ่งลานนา — 1 มิถุนายน 2569");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: 7,431.50 บาท");
    expect(result).toContain("ยอดเบิก: 9,000.00 บาท");
    expect(result).toContain("ยอดชั่งคืน: 1,000.00 บาท");
    expect(result).toContain("ยอดคืนเสีย: 568.50 บาท");
    expect(result).toContain("เงินโอน: 2,680.00 บาท");
    expect(result).toContain("เงินสด: 3,145.00 บาท");
    expect(result).toContain("ค่าใช้จ่าย: 107.00 บาท");
    expect(result).toContain("ค่าแรง: 1,200.00 บาท");
    expect(result).toContain("ยอดขายจากรายการส่งเงิน: 7,132.00 บาท");
    expect(result).toContain("ผลตรวจ: ขาด 299.50 บาท");
    expect(result).toContain("เงินสดที่ควรเหลือส่งเจ๊: 3,444.50 บาท");
  });

  it.each(["partial", "blocked", "missing"] as const)(
    "does not present %s Produce values as authoritative zeroes",
    (produceValueStatus) => {
      const result = buildSettlementLineMessage({
        date: "2026-06-01",
        staffName: "มีน",
        marketName: "วัดทุ่งลานนา",
        transactions: { เบิก: 9000, คืน: 0, คืนเสีย: 0, ยอดส่ง: 9000 },
        produceValueStatus,
        settlement: {
          ยอดโอน: 10,
          เงินสด: 20,
          ค่าใช้จ่าย: 3,
          ค่าแรง: 4,
          ยอดขาย: 33,
          เงินสดต้องส่งเจ๊: 8987,
          ขาดเกิน: -8967,
        },
      });

      expect(result).toContain("ยอดคืนเสีย: ⚠️ ยังยืนยันไม่ได้");
      expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: ⚠️ ยังยืนยันไม่ได้");
      expect(result).not.toContain("ยอดคืนเสีย: 0.00 บาท");
      expect(result).toContain("เงินโอน: 10.00 บาท");
      expect(result).toContain("เงินสด: 20.00 บาท");
      expect(result).toContain("ค่าใช้จ่าย: 3.00 บาท");
      expect(result).toContain("ค่าแรง: 4.00 บาท");
      expect(result).toContain("ยอดขายจากรายการส่งเงิน: 33.00 บาท");
    },
  );
});
