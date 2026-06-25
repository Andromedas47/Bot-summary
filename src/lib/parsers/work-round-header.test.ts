import { describe, expect, it } from "bun:test";
import { classifyHeader } from "./work-round-header";

describe("classifyHeader", () => {
  // ── Explicit headers ───────────────────────────────────────────────────────

  it("classifies an explicit seller-market เบิก header", () => {
    const h = classifyHeader("กี้-วัดทุ่งลานนา เบิก 24/06/2569");
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") {
      expect(h.sellerName).toBe("กี้");
      expect(h.marketName).toBe("วัดทุ่งลานนา");
      expect(h.txIntent).toBe("เบิก");
    }
  });

  it("classifies an explicit header with คืน transaction type", () => {
    const h = classifyHeader("พี่ดำ-วิหาร คืน 24/06/2569");
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") {
      expect(h.sellerName).toBe("พี่ดำ");
      expect(h.marketName).toBe("วิหาร");
      expect(h.txIntent).toBe("คืน");
    }
  });

  it("classifies an explicit header with คืนเสีย", () => {
    const h = classifyHeader("กี้-วัดทุ่งลานนา คืนเสีย");
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") expect(h.txIntent).toBe("คืนเสีย");
  });

  it("strips LINE export TIME_PREFIX before classifying", () => {
    const h = classifyHeader("18:53 เสือ กี้-วัดทุ่งลานนา เบิก 24/06/2569");
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") {
      expect(h.sellerName).toBe("กี้");
      expect(h.marketName).toBe("วัดทุ่งลานนา");
    }
  });

  // ── Generic headers ────────────────────────────────────────────────────────

  it("classifies 'รายการชั่งเบิก 24/06/2569' as generic เบิก", () => {
    const h = classifyHeader("รายการชั่งเบิก 24/06/2569");
    expect(h?.type).toBe("generic");
    if (h?.type === "generic") expect(h.txIntent).toBe("เบิก");
  });

  it("classifies bare 'เบิก' as generic", () => {
    const h = classifyHeader("เบิก");
    expect(h?.type).toBe("generic");
    if (h?.type === "generic") expect(h.txIntent).toBe("เบิก");
  });

  it("classifies 'คืน' as generic", () => {
    const h = classifyHeader("คืน");
    expect(h?.type).toBe("generic");
    if (h?.type === "generic") expect(h.txIntent).toBe("คืน");
  });

  it("classifies 'คืนเสีย' as generic", () => {
    const h = classifyHeader("คืนเสีย");
    expect(h?.type).toBe("generic");
    if (h?.type === "generic") expect(h.txIntent).toBe("คืนเสีย");
  });

  it("classifies 'ชั่งคืน' (contain คืน) as generic", () => {
    const h = classifyHeader("รายการชั่งคืน");
    expect(h?.type).toBe("generic");
    if (h?.type === "generic") expect(h.txIntent).toBe("คืน");
  });

  it("classifies 'ชั่งคืนเพิ่ม' as generic ชั่งคืนเพิ่ม", () => {
    const h = classifyHeader("ชั่งคืนเพิ่ม");
    expect(h?.type).toBe("generic");
    if (h?.type === "generic") expect(h.txIntent).toBe("ชั่งคืนเพิ่ม");
  });

  it("classifies 'คืนเพิ่ม' as generic ชั่งคืนเพิ่ม (alias)", () => {
    const h = classifyHeader("คืนเพิ่ม");
    expect(h?.type).toBe("generic");
    if (h?.type === "generic") expect(h.txIntent).toBe("ชั่งคืนเพิ่ม");
  });

  it("classifies 'เบิกเพิ่ม' as generic เบิกเพิ่ม", () => {
    const h = classifyHeader("เบิกเพิ่ม");
    expect(h?.type).toBe("generic");
    if (h?.type === "generic") expect(h.txIntent).toBe("เบิกเพิ่ม");
  });

  // ── Non-headers ────────────────────────────────────────────────────────────

  it("returns null for a plain item line", () => {
    expect(classifyHeader("1.มะม่วง100บาท")).toBeNull();
  });

  it("returns null for a quantity line", () => {
    expect(classifyHeader("38โล")).toBeNull();
  });

  it("returns null for an unrelated Thai text", () => {
    expect(classifyHeader("ขอบคุณครับ")).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(classifyHeader("")).toBeNull();
  });
});
