import { describe, expect, it } from "bun:test";
import {
  computeProduce,
  computeSettlement,
  computeSlipDiff,
  mapTransactionType,
  zeroCategoryAmounts,
  type SixCategoryAmounts,
  type FinanceInput,
} from "./core";

// ── helpers ───────────────────────────────────────────────────────────────────

function cats(over: Partial<SixCategoryAmounts> = {}): SixCategoryAmounts {
  return { ...zeroCategoryAmounts(), ...over };
}

// ── computeProduce: individual category contribution ─────────────────────────

describe("computeProduce — six individual categories", () => {
  it("เบิก adds to รวมเบิก and ยอดที่ต้องขายได้", () => {
    const r = computeProduce(cats({ เบิก: 1000 }));
    expect(r.รวมเบิก).toBe(1000);
    expect(r.รวมคืน).toBe(0);
    expect(r.รวมคืนเสีย).toBe(0);
    expect(r.ยอดที่ต้องขายได้).toBe(1000);
  });

  it("เบิกเพิ่ม adds to รวมเบิก", () => {
    const r = computeProduce(cats({ เบิก: 500, เบิกเพิ่ม: 300 }));
    expect(r.รวมเบิก).toBe(800);
    expect(r.ยอดที่ต้องขายได้).toBe(800);
  });

  it("คืน adds to รวมคืน and subtracts from ยอดที่ต้องขายได้", () => {
    const r = computeProduce(cats({ เบิก: 1000, คืน: 200 }));
    expect(r.รวมคืน).toBe(200);
    expect(r.ยอดที่ต้องขายได้).toBe(800);
  });

  it("คืนเพิ่ม adds to รวมคืน", () => {
    const r = computeProduce(cats({ เบิก: 1000, คืนเพิ่ม: 150 }));
    expect(r.รวมคืน).toBe(150);
    expect(r.ยอดที่ต้องขายได้).toBe(850);
  });

  it("คืนเสีย adds to รวมคืนเสีย and subtracts from ยอดที่ต้องขายได้", () => {
    const r = computeProduce(cats({ เบิก: 1000, คืนเสีย: 100 }));
    expect(r.รวมคืนเสีย).toBe(100);
    expect(r.ยอดที่ต้องขายได้).toBe(900);
  });

  it("คืนเสียเพิ่ม adds to รวมคืนเสีย", () => {
    const r = computeProduce(cats({ เบิก: 1000, คืนเสียเพิ่ม: 50 }));
    expect(r.รวมคืนเสีย).toBe(50);
    expect(r.ยอดที่ต้องขายได้).toBe(950);
  });
});

// ── computeProduce: rollup formulas ──────────────────────────────────────────

describe("computeProduce — three rollup groups", () => {
  it("รวมเบิก = เบิก + เบิกเพิ่ม", () => {
    const r = computeProduce(cats({ เบิก: 600, เบิกเพิ่ม: 400 }));
    expect(r.รวมเบิก).toBe(1000);
  });

  it("รวมคืน = คืน + คืนเพิ่ม", () => {
    const r = computeProduce(cats({ คืน: 300, คืนเพิ่ม: 200 }));
    expect(r.รวมคืน).toBe(500);
  });

  it("รวมคืนเสีย = คืนเสีย + คืนเสียเพิ่ม", () => {
    const r = computeProduce(cats({ คืนเสีย: 80, คืนเสียเพิ่ม: 20 }));
    expect(r.รวมคืนเสีย).toBe(100);
  });

  it("ยอดที่ต้องขายได้ = รวมเบิก - รวมคืน - รวมคืนเสีย", () => {
    const r = computeProduce(cats({
      เบิก: 1000, เบิกเพิ่ม: 200,       // รวมเบิก    = 1200
      คืน: 300,   คืนเพิ่ม: 100,        // รวมคืน     = 400
      คืนเสีย: 80, คืนเสียเพิ่ม: 20,   // รวมคืนเสีย = 100
    }));
    expect(r.รวมเบิก).toBe(1200);
    expect(r.รวมคืน).toBe(400);
    expect(r.รวมคืนเสีย).toBe(100);
    expect(r.ยอดที่ต้องขายได้).toBe(700);
  });

  it("all zeros → ยอดที่ต้องขายได้ = 0", () => {
    const r = computeProduce(zeroCategoryAmounts());
    expect(r.ยอดที่ต้องขายได้).toBe(0);
  });
});

// ── mapTransactionType ────────────────────────────────────────────────────────

describe("mapTransactionType — canonical category mapper", () => {
  it("maps all six canonical categories to themselves", () => {
    expect(mapTransactionType('เบิก')).toBe('เบิก');
    expect(mapTransactionType('เบิกเพิ่ม')).toBe('เบิกเพิ่ม');
    expect(mapTransactionType('คืน')).toBe('คืน');
    expect(mapTransactionType('คืนเพิ่ม')).toBe('คืนเพิ่ม');
    expect(mapTransactionType('คืนเสีย')).toBe('คืนเสีย');
    expect(mapTransactionType('คืนเสียเพิ่ม')).toBe('คืนเสียเพิ่ม');
  });

  it("maps legacy ชั่งคืนเพิ่ม to คืนเพิ่ม", () => {
    expect(mapTransactionType('ชั่งคืนเพิ่ม')).toBe('คืนเพิ่ม');
  });

  it("returns null for unrecognised types", () => {
    expect(mapTransactionType('unknown')).toBeNull();
    expect(mapTransactionType('')).toBeNull();
    expect(mapTransactionType('ชั่งคืน')).toBeNull();
    expect(mapTransactionType('BORROW')).toBeNull();
  });
});

// ── computeSettlement: ยอดขายในใบ formula ────────────────────────────────────

describe("computeSettlement — ยอดขายในใบ formula", () => {
  it("ยอดขายในใบ = เงินโอน + ค่าใช้จ่าย + ส่งเงินสด", () => {
    const r = computeSettlement(0, { เงินโอน: 1000, ค่าใช้จ่าย: 200, ส่งเงินสด: 300 });
    expect(r.ยอดขายในใบ).toBe(1500);
  });

  it("ค่าแรง and เงินสดเหลือ on FinanceInput are display-only — not included in ยอดขายในใบ", () => {
    const transfer = 1561, expenses = 60, cashSent = 2320;
    const withBreakdown = computeSettlement(5000, {
      เงินโอน: transfer, ค่าใช้จ่าย: expenses, ส่งเงินสด: cashSent,
      ค่าแรง: 99999, เงินสดเหลือ: 99999, // very large — would inflate if incorrectly added
    });
    const withoutBreakdown = computeSettlement(5000, {
      เงินโอน: transfer, ค่าใช้จ่าย: expenses, ส่งเงินสด: cashSent,
    });
    expect(withBreakdown.ยอดขายในใบ).toBe(transfer + expenses + cashSent);
    expect(withBreakdown.ยอดขายในใบ).toBe(withoutBreakdown.ยอดขายในใบ);
    expect(withBreakdown.ส่วนต่างเงิน).toBe(withoutBreakdown.ส่วนต่างเงิน);
  });

  it("labor breakdown (ค่าแรง / เงินสดเหลือ) NOT re-added when ส่งเงินสด is the total", () => {
    // ส่งเงินสด 2320 = ค่าแรง 500 + เงินสดเหลือ 1820
    const finance: FinanceInput = { เงินโอน: 1561, ค่าใช้จ่าย: 60, ส่งเงินสด: 2320 };
    const r = computeSettlement(0, finance);
    expect(r.ยอดขายในใบ).toBe(3941);
  });
});

// ── computeSettlement: sign / status cases ────────────────────────────────────

describe("computeSettlement — ส่วนต่างเงิน sign and status", () => {
  it("ส่วนต่างเงิน > 0 → ส่งเงินขาด", () => {
    const r = computeSettlement(1000, { เงินโอน: 800, ค่าใช้จ่าย: 0, ส่งเงินสด: 0 });
    expect(r.ส่วนต่างเงิน).toBe(200);
    expect(r.status).toBe('ส่งเงินขาด');
    expect(r.displayAmount).toBe(200);
  });

  it("ส่วนต่างเงิน = 0 → ส่งเงินครบ", () => {
    const r = computeSettlement(1000, { เงินโอน: 600, ค่าใช้จ่าย: 200, ส่งเงินสด: 200 });
    expect(r.ส่วนต่างเงิน).toBe(0);
    expect(r.status).toBe('ส่งเงินครบ');
    expect(r.displayAmount).toBe(0);
  });

  it("ส่วนต่างเงิน < 0 → ส่งเงินเกิน, displayAmount is absolute", () => {
    const r = computeSettlement(800, { เงินโอน: 1000, ค่าใช้จ่าย: 0, ส่งเงินสด: 0 });
    expect(r.ส่วนต่างเงิน).toBe(-200);
    expect(r.status).toBe('ส่งเงินเกิน');
    expect(r.displayAmount).toBe(200);
  });

  it("all amounts zero is ส่งเงินครบ — zero is a valid confirmed value", () => {
    const r = computeSettlement(0, { เงินโอน: 0, ค่าใช้จ่าย: 0, ส่งเงินสด: 0 });
    expect(r.status).toBe('ส่งเงินครบ');
    expect(r.ยอดขายในใบ).toBe(0);
    expect(r.ส่วนต่างเงิน).toBe(0);
  });
});

// ── computeSettlement: missing / incomplete finance state ─────────────────────

describe("computeSettlement — incomplete finance state", () => {
  it("null finance object → รอกรอกข้อมูลการเงิน, numeric fields are null not 0", () => {
    const r = computeSettlement(1234.56, null);
    expect(r.status).toBe('รอกรอกข้อมูลการเงิน');
    expect(r.ยอดขายในใบ).toBeNull();
    expect(r.ส่วนต่างเงิน).toBeNull();
    expect(r.displayAmount).toBeNull();
  });

  it("null เงินโอน (transfer) alone triggers รอกรอกข้อมูลการเงิน", () => {
    const r = computeSettlement(1000, { เงินโอน: null, ค่าใช้จ่าย: 60, ส่งเงินสด: 500 });
    expect(r.status).toBe('รอกรอกข้อมูลการเงิน');
    expect(r.ยอดขายในใบ).toBeNull();
    expect(r.ส่วนต่างเงิน).toBeNull();
    expect(r.displayAmount).toBeNull();
  });

  it("null ค่าใช้จ่าย (expenses) alone triggers รอกรอกข้อมูลการเงิน", () => {
    const r = computeSettlement(1000, { เงินโอน: 600, ค่าใช้จ่าย: null, ส่งเงินสด: 500 });
    expect(r.status).toBe('รอกรอกข้อมูลการเงิน');
    expect(r.ยอดขายในใบ).toBeNull();
    expect(r.ส่วนต่างเงิน).toBeNull();
    expect(r.displayAmount).toBeNull();
  });

  it("null ส่งเงินสด (cashSent) alone triggers รอกรอกข้อมูลการเงิน", () => {
    const r = computeSettlement(1000, { เงินโอน: 600, ค่าใช้จ่าย: 60, ส่งเงินสด: null });
    expect(r.status).toBe('รอกรอกข้อมูลการเงิน');
    expect(r.ยอดขายในใบ).toBeNull();
    expect(r.ส่วนต่างเงิน).toBeNull();
    expect(r.displayAmount).toBeNull();
  });

  it("zero is NOT treated as missing — 0 for all fields produces ส่งเงินครบ", () => {
    const r = computeSettlement(0, { เงินโอน: 0, ค่าใช้จ่าย: 0, ส่งเงินสด: 0 });
    expect(r.status).not.toBe('รอกรอกข้อมูลการเงิน');
    expect(r.ยอดขายในใบ).toBe(0);
  });

  it("zero transfer is distinguishable from null transfer", () => {
    const withNull = computeSettlement(500, { เงินโอน: null, ค่าใช้จ่าย: 0, ส่งเงินสด: 0 });
    const withZero = computeSettlement(500, { เงินโอน: 0, ค่าใช้จ่าย: 0, ส่งเงินสด: 0 });
    expect(withNull.status).toBe('รอกรอกข้อมูลการเงิน');
    expect(withNull.ยอดขายในใบ).toBeNull();
    expect(withZero.status).toBe('ส่งเงินขาด');
    expect(withZero.ยอดขายในใบ).toBe(0);
  });

  it("incomplete finance does not expose ยอดที่ต้องขายได้ in any result field", () => {
    const expected = 9999;
    const r = computeSettlement(expected, null);
    expect(r.ยอดขายในใบ).toBeNull();
    expect(r.ส่วนต่างเงิน).toBeNull();
    expect(r.displayAmount).toBeNull();
  });
});

// ── computeSlipDiff: status cases ────────────────────────────────────────────

describe("computeSlipDiff — slip status cases", () => {
  it("เงินโอน = null → รอยอดเงินโอน, ส่วนต่างสลิป is null not 0", () => {
    const r = computeSlipDiff(null, null);
    expect(r.status).toBe('รอยอดเงินโอน');
    expect(r.ส่วนต่างสลิป).toBeNull();
    expect(r.displayAmount).toBeNull();
  });

  it("เงินโอน set, ยอดสลิป = null → รอตรวจสลิป, ส่วนต่างสลิป is null not 0", () => {
    const r = computeSlipDiff(1000, null);
    expect(r.status).toBe('รอตรวจสลิป');
    expect(r.ส่วนต่างสลิป).toBeNull();
    expect(r.displayAmount).toBeNull();
  });

  it("matched transfer and slip amounts produce zero difference, distinguishable from null", () => {
    const withNull = computeSlipDiff(1000, null);
    const withZero = computeSlipDiff(1000, 1000); // transfer exactly matched by slips → diff = 0
    expect(withNull.ส่วนต่างสลิป).toBeNull();
    expect(withZero.ส่วนต่างสลิป).toBe(0);
    expect(withZero.status).toBe('สลิปตรงยอดโอน');
  });

  it("verified slip total = 0 (no slips found but check is complete) is a real known value", () => {
    // verifiedSlipTotal = 0 means the check ran and found nothing — not that it hasn't run yet
    const r = computeSlipDiff(500, 0);
    expect(r.ส่วนต่างสลิป).not.toBeNull();
    expect(r.ส่วนต่างสลิป).toBe(500);
    expect(r.status).toBe('ยอดโอนมากกว่าสลิปที่พบ');
    expect(r.displayAmount).toBe(500);
  });

  it("diff = 0 → สลิปตรงยอดโอน", () => {
    const r = computeSlipDiff(1000, 1000);
    expect(r.ส่วนต่างสลิป).toBe(0);
    expect(r.status).toBe('สลิปตรงยอดโอน');
    expect(r.displayAmount).toBe(0);
  });

  it("เงินโอน > สลิป → ยอดโอนมากกว่าสลิปที่พบ", () => {
    const r = computeSlipDiff(1200, 1000);
    expect(r.ส่วนต่างสลิป).toBe(200);
    expect(r.status).toBe('ยอดโอนมากกว่าสลิปที่พบ');
    expect(r.displayAmount).toBe(200);
  });

  it("สลิป > เงินโอน → ยอดสลิปมากกว่ายอดโอน, negative diff, positive displayAmount", () => {
    const r = computeSlipDiff(1000, 1200);
    expect(r.ส่วนต่างสลิป).toBe(-200);
    expect(r.status).toBe('ยอดสลิปมากกว่ายอดโอน');
    expect(r.displayAmount).toBe(200);
  });
});

// ── Non-interference: slip must never affect money result ─────────────────────

describe("slip / money non-interference", () => {
  const produce = computeProduce(cats({ เบิก: 1000, คืน: 200 }));
  const finance: FinanceInput = { เงินโอน: 500, ค่าใช้จ่าย: 100, ส่งเงินสด: 200 };

  it("changing slip amounts does not change settlement result", () => {
    const settle1 = computeSettlement(produce.ยอดที่ต้องขายได้, finance);
    computeSlipDiff(500, 400);
    computeSlipDiff(500, 600);
    const settle2 = computeSettlement(produce.ยอดที่ต้องขายได้, finance);
    expect(settle1).toEqual(settle2);
  });

  it("changing finance amounts does not change slip result", () => {
    const slip1 = computeSlipDiff(500, 480);
    computeSettlement(1500, finance);
    computeSettlement(500, { เงินโอน: 200, ค่าใช้จ่าย: 50, ส่งเงินสด: 100 });
    const slip2 = computeSlipDiff(500, 480);
    expect(slip1).toEqual(slip2);
  });

  it("slip status does not bleed into settlement status and vice versa", () => {
    const settle = computeSettlement(produce.ยอดที่ต้องขายได้, finance);
    const slip   = computeSlipDiff(500, 480);
    expect(['ส่งเงินขาด', 'ส่งเงินครบ', 'ส่งเงินเกิน', 'รอกรอกข้อมูลการเงิน']).toContain(settle.status);
    expect(['รอยอดเงินโอน', 'รอตรวจสลิป', 'สลิปตรงยอดโอน', 'ยอดโอนมากกว่าสลิปที่พบ', 'ยอดสลิปมากกว่ายอดโอน']).toContain(slip.status);
  });
});

// ── Golden fixture: MASTER.md worked example (section 7) ─────────────────────

describe("golden fixture — MASTER.md §7 worked example", () => {
  const produce = computeProduce(cats({
    เบิก: 19748.60,
    คืน:  15411.60,
    คืนเสีย: 2093.50,
  }));

  it("ยอดที่ต้องขายได้ = 2,243.50", () => {
    expect(produce.ยอดที่ต้องขายได้).toBeCloseTo(2243.50, 2);
  });

  it("รวมเบิก = 19,748.60", () => {
    expect(produce.รวมเบิก).toBeCloseTo(19748.60, 2);
  });

  it("รวมคืน = 15,411.60", () => {
    expect(produce.รวมคืน).toBeCloseTo(15411.60, 2);
  });

  it("รวมคืนเสีย = 2,093.50", () => {
    expect(produce.รวมคืนเสีย).toBeCloseTo(2093.50, 2);
  });

  it("เงินเกิน 1,697.50 บาท", () => {
    // ส่งเงินสด 2320 = ค่าแรง 500 + เงินสดเหลือ 1820 (display-only breakdown)
    const r = computeSettlement(produce.ยอดที่ต้องขายได้, {
      เงินโอน: 1561, ค่าใช้จ่าย: 60, ส่งเงินสด: 2320,
    });
    expect(r.ยอดขายในใบ).toBeCloseTo(3941, 2);
    expect(r.ส่วนต่างเงิน).toBeCloseTo(-1697.50, 2);
    expect(r.status).toBe('ส่งเงินเกิน');
    expect(r.displayAmount).toBeCloseTo(1697.50, 2);
  });
});

// ── Legacy mapping fixture ────────────────────────────────────────────────────

describe("legacy transaction_type mapping to six-category model", () => {
  it("mapTransactionType('ชั่งคืนเพิ่ม') === 'คืนเพิ่ม'", () => {
    expect(mapTransactionType('ชั่งคืนเพิ่ม')).toBe('คืนเพิ่ม');
  });

  it("computeProduce gives same result whether คืนเพิ่ม comes from legacy or direct", () => {
    const r = computeProduce(cats({ เบิก: 1000, คืนเพิ่ม: 300 }));
    expect(r.รวมคืน).toBe(300);
    expect(r.ยอดที่ต้องขายได้).toBe(700);
  });

  it('"เบิกเพิ่ม" transaction_type maps to เบิกเพิ่ม category', () => {
    expect(mapTransactionType('เบิกเพิ่ม')).toBe('เบิกเพิ่ม');
    const r = computeProduce(cats({ เบิก: 500, เบิกเพิ่ม: 200 }));
    expect(r.รวมเบิก).toBe(700);
  });
});
