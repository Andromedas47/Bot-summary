import { describe, it, expect } from "bun:test";
import { buildWeighSessionSummary } from "./reply";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";

function makeSession(overrides: Partial<WeighSession> = {}): WeighSession {
  return {
    date: "2026-06-01",
    staff_name: "กี้",
    sender_name: null,
    transaction_time: null,
    session_title: null,
    items: [],
    parse_errors: [],
    ...overrides,
  };
}

const BORROW_ITEM = {
  item_number: 1,
  product_name: "ทุเรียน",
  price_per_unit: 100,
  quantity: 10,
  unit: "โล" as const,
  section: "",
  transaction_type: "เบิก" as const,
};

const BORROW_EXTRA_ITEM = {
  item_number: 2,
  product_name: "หมอนทอง",
  price_per_unit: 119,
  quantity: 5,
  unit: "โล" as const,
  section: "",
  transaction_type: "เบิกเพิ่ม" as const,
};

const RETURN_ITEM = {
  item_number: 1,
  product_name: "ชะนี",
  price_per_unit: 100,
  quantity: 8,
  unit: "โล" as const,
  section: "",
  transaction_type: "คืน" as const,
};

const BAD_RETURN_ITEM = {
  item_number: 1,
  product_name: "กระดุม",
  price_per_unit: 80,
  quantity: 3,
  unit: "โล" as const,
  section: "",
  transaction_type: "คืนเสีย" as const,
};

describe("buildWeighSessionSummary — ยอดส่ง must not appear", () => {
  it("session เบิกอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session คืนอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session คืนเสียอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BAD_RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session หลาย type ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });
});

describe("buildWeighSessionSummary — section subtotals", () => {
  it("session เบิกอย่างเดียว แสดง รวมเบิก", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM] }));
    expect(result).toContain("รวมเบิก:");
    expect(result).not.toContain("รวมคืน:");
    expect(result).not.toContain("รวมเสีย:");
  });

  it("session คืนอย่างเดียว แสดง รวมคืน", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [RETURN_ITEM] }));
    expect(result).toContain("รวมคืน:");
    expect(result).not.toContain("รวมเบิก:");
    expect(result).not.toContain("รวมเสีย:");
  });

  it("session คืนเสียอย่างเดียว แสดง รวมเสีย", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BAD_RETURN_ITEM] }));
    expect(result).toContain("รวมเสีย:");
    expect(result).not.toContain("รวมเบิก:");
    expect(result).not.toContain("รวมคืน:");
  });

  it("session มี เบิก+คืน แสดงทั้ง รวมเบิก และ รวมคืน แต่ไม่แสดงยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, RETURN_ITEM] }));
    expect(result).toContain("รวมเบิก:");
    expect(result).toContain("รวมคืน:");
    expect(result).not.toContain("ยอดส่ง");
  });

  it("เบิกเพิ่ม นับรวมใน section เบิก", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, BORROW_EXTRA_ITEM] }));
    expect(result).toContain("เบิก");
    expect(result).toContain("รวมเบิก:");
    // both items appear under one เบิก section — numbered 1 and 2
    expect(result).toContain("1. ทุเรียน");
    expect(result).toContain("2. หมอนทอง");
  });
});

describe("buildWeighSessionSummary — header", () => {
  it("แสดงชื่อ staff และวันที่ไทย", () => {
    const result = buildWeighSessionSummary(makeSession({ staff_name: "พี่ดำ", date: "2026-06-01" }));
    expect(result).toContain("บันทึกแล้ว ✅");
    expect(result).toContain("พี่ดำ");
    expect(result).toContain("2569"); // Buddhist era
  });

  it("session ที่ไม่มี items ยังแสดง header ได้", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [] }));
    expect(result).toContain("บันทึกแล้ว ✅");
  });
});
