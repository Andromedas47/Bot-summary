import { describe, expect, it } from "bun:test";
import { classifyHeader, hasExplicitProduceAppendStart, isExplicitProduceAppendHeader, isIncompleteProduceHeader, isProduceAppendLine } from "./work-round-header";

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

  // Regression: production sent a non-ASCII dash between seller and market, which
  // made SELLER_MARKET fail and the header fall through to "generic" → wrongly
  // rejected with "ไม่พบรายการที่เปิดอยู่". All dash look-alikes must classify
  // as the same explicit header.
  it.each([
    ["en dash U+2013",          "\u2013"],
    ["em dash U+2014",          "\u2014"],
    ["hyphen U+2010",           "\u2010"],
    ["non-breaking hyphen U+2011", "\u2011"],
    ["figure dash U+2012",      "\u2012"],
    ["horizontal bar U+2015",   "\u2015"],
    ["minus sign U+2212",       "\u2212"],
    ["fullwidth hyphen U+FF0D", "\uFF0D"],
  ])("classifies seller%s-market เบิก header as explicit (%s)", (_name, dash) => {
    const h = classifyHeader(`กี้${dash}วัดทุ่งลานนา เบิก 26/06/2569`);
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") {
      expect(h.sellerName).toBe("กี้");
      expect(h.marketName).toBe("วัดทุ่งลานนา");
      expect(h.txIntent).toBe("เบิก");
    }
  });

  it("does not treat an en-dash seller-market header as incomplete", () => {
    expect(isIncompleteProduceHeader("กี้\u2013วัดทุ่งลานนา เบิก 26/06/2569")).toBe(false);
  });

  it("strips LINE export TIME_PREFIX before classifying", () => {
    const h = classifyHeader("18:53 เสือ กี้-วัดทุ่งลานนา เบิก 24/06/2569");
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") {
      expect(h.sellerName).toBe("กี้");
      expect(h.marketName).toBe("วัดทุ่งลานนา");
    }
  });

  it("classifies seller-only ชั่งคืน headers for Work Round resolution", () => {
    const h = classifyHeader("กี้ ชั่งคืน 25/6/2569");
    expect(h?.type).toBe("seller_only");
    if (h?.type === "seller_only") {
      expect(h.sellerName).toBe("กี้");
      expect(h.txIntent).toBe("คืน");
    }
    expect(isIncompleteProduceHeader("กี้ ชั่งคืน 25/6/2569")).toBe(false);
  });

  it("classifies explicit seller-market ชั่งคืน headers", () => {
    const h = classifyHeader("กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569");
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") {
      expect(h.sellerName).toBe("กี้");
      expect(h.marketName).toBe("วัดทุ่งลานนา");
      expect(h.txIntent).toBe("คืน");
    }
  });

  it("classifies seller-only คืนเสีย headers for Work Round resolution", () => {
    const h = classifyHeader("กี้ คืนเสีย 25/6/2569");
    expect(h?.type).toBe("seller_only");
    if (h?.type === "seller_only") {
      expect(h.sellerName).toBe("กี้");
      expect(h.txIntent).toBe("คืนเสีย");
    }
    expect(isIncompleteProduceHeader("กี้ คืนเสีย 25/6/2569")).toBe(false);
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

  it("classifies explicit seller-market รายการเบิกเพิ่ม header", () => {
    const h = classifyHeader("ทดลองใหม่-ตลาดจำลอง รายการเบิกเพิ่ม 28/6/2569");
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") {
      expect(h.sellerName).toBe("ทดลองใหม่");
      expect(h.marketName).toBe("ตลาดจำลอง");
      expect(h.txIntent).toBe("เบิกเพิ่ม");
    }
  });

  it("classifies explicit seller-market เบิกเพิ่ม alias", () => {
    const h = classifyHeader("ทดลองใหม่-ตลาดจำลอง เบิกเพิ่ม 28/6/2569");
    expect(h?.type).toBe("explicit");
    if (h?.type === "explicit") expect(h.txIntent).toBe("เบิกเพิ่ม");
  });

  it("classifies standalone 'รายการเบิกเพิ่ม' as generic เบิกเพิ่ม", () => {
    const h = classifyHeader("รายการเบิกเพิ่ม");
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

describe("isProduceAppendLine", () => {
  it("matches standalone รายการเบิกเพิ่ม", () => {
    expect(isProduceAppendLine("รายการเบิกเพิ่ม")).toBe(true);
  });

  it("does not match explicit seller-market headers", () => {
    expect(isProduceAppendLine("โอม-ตลาดพาซิโอ้ผลไม้ เบิกเพิ่ม")).toBe(false);
    expect(isProduceAppendLine("ทดลองใหม่-ตลาดจำลอง รายการเบิกเพิ่ม 28/6/2569")).toBe(false);
  });
});

describe("isExplicitProduceAppendHeader", () => {
  it("matches explicit รายการเบิกเพิ่ม and เบิกเพิ่ม alias", () => {
    expect(isExplicitProduceAppendHeader("ทดลองใหม่-ตลาดจำลอง รายการเบิกเพิ่ม 28/6/2569")).toBe(true);
    expect(isExplicitProduceAppendHeader("ทดลองใหม่-ตลาดจำลอง เบิกเพิ่ม 28/6/2569")).toBe(true);
  });

  it("does not match standalone append marker", () => {
    expect(isExplicitProduceAppendHeader("รายการเบิกเพิ่ม")).toBe(false);
  });
});

describe("hasExplicitProduceAppendStart", () => {
  it("detects explicit append in multi-line message", () => {
    expect(hasExplicitProduceAppendStart("ทดลองใหม่-ตลาดจำลอง รายการเบิกเพิ่ม 28/6/2569\n1มังคุด35บาท")).toBe(true);
  });
});

describe("isIncompleteProduceHeader", () => {
  it("flags seller + tx type without market dash", () => {
    expect(isIncompleteProduceHeader("น้อย เบิก 25/6/2569")).toBe(true);
  });

  it("accepts explicit seller-market headers", () => {
    expect(isIncompleteProduceHeader("กี้-วัดทุ่งลานนา เบิก 24/06/2569")).toBe(false);
  });

  it("accepts generic standalone tx headers", () => {
    expect(isIncompleteProduceHeader("เบิก 29/5/2569")).toBe(false);
    expect(isIncompleteProduceHeader("รายการชั่งเบิก 24/06/2569")).toBe(false);
  });
});
