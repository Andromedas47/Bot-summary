import { describe, it, expect } from "bun:test";
import { normalizeLine, normalizeText, hasSessionStart } from "./webhook-service";

describe("normalizeLine", () => {
  describe("colon format HH:MM", () => {
    it("strips HH:MM sender prefix", () => {
      expect(normalizeLine("21:35 เสือ 1.ชะนี100บาท")).toBe("1.ชะนี100บาท");
    });

    it("strips HH:MM sender prefix from session-end line", () => {
      expect(normalizeLine("21:35 เสือ จบรายการคืน")).toBe("จบรายการคืน");
    });

    it("strips single-digit hour with colon", () => {
      expect(normalizeLine("9:05 เสือ รายการชั่งคืน")).toBe("รายการชั่งคืน");
    });
  });

  describe("dot format HH.MM", () => {
    it("strips HH.MM sender prefix", () => {
      expect(normalizeLine("21.35 เสือ 1.ชะนี100บาท")).toBe("1.ชะนี100บาท");
    });

    it("strips HH.MM sender prefix from session-end line", () => {
      expect(normalizeLine("21.35 เสือ จบรายการคืน")).toBe("จบรายการคืน");
    });

    it("strips single-digit hour with dot", () => {
      expect(normalizeLine("9.05 เสือ รายการชั่งคืน")).toBe("รายการชั่งคืน");
    });
  });

  describe("bare lines (no prefix)", () => {
    it("leaves bare item line unchanged", () => {
      expect(normalizeLine("1.ชะนี100บาท")).toBe("1.ชะนี100บาท");
    });

    it("leaves bare quantity line unchanged", () => {
      expect(normalizeLine("21.1โล")).toBe("21.1โล");
    });

    it("leaves bare session-end unchanged", () => {
      expect(normalizeLine("จบรายการคืน")).toBe("จบรายการคืน");
    });

    it("leaves empty line unchanged", () => {
      expect(normalizeLine("")).toBe("");
    });
  });
});

describe("normalizeText", () => {
  it("strips colon prefixes from a multiline export", () => {
    const input = [
      "21:34 เสือ พี่ปลา-ราชพฤกษ์ คืน",
      "21:34 เสือ 1.ชะนี100บาท",
      "21:34 เสือ จบรายการคืน",
    ].join("\n");

    const expected = [
      "พี่ปลา-ราชพฤกษ์ คืน",
      "1.ชะนี100บาท",
      "จบรายการคืน",
    ].join("\n");

    expect(normalizeText(input)).toBe(expected);
  });

  it("strips dot prefixes from a multiline export", () => {
    const input = [
      "21.34 เสือ พี่ปลา-ราชพฤกษ์ คืน",
      "21.34 เสือ 1.ชะนี100บาท",
      "21.34 เสือ จบรายการคืน",
    ].join("\n");

    const expected = [
      "พี่ปลา-ราชพฤกษ์ คืน",
      "1.ชะนี100บาท",
      "จบรายการคืน",
    ].join("\n");

    expect(normalizeText(input)).toBe(expected);
  });

  it("leaves bare lines (direct typed) unchanged", () => {
    const input = [
      "พี่ปลา-ราชพฤกษ์ คืน 29/5/2569",
      "1.ชะนี100บาท",
      "21.1โล",
      "จบรายการคืน",
    ].join("\n");

    expect(normalizeText(input)).toBe(input);
  });
});

describe("hasSessionStart", () => {
  describe("must return true (real session headers)", () => {
    it("bare SELLER-MARKET คืน header", () => {
      expect(hasSessionStart("พี่ปลา-ราชพฤกษ์ คืน 29/5/2569")).toBe(true);
    });

    it("bare SELLER-MARKET เบิก header", () => {
      expect(hasSessionStart("น้อย-วัดตะกล่ำ เบิก 29/5/2569")).toBe(true);
    });

    it("bare SELLER-MARKET เสีย header", () => {
      expect(hasSessionStart("น้อย-วัดตะกล่ำ เสีย 29/5/2569")).toBe(true);
    });

    it("bare เบิก with date", () => {
      expect(hasSessionStart("เบิก 29/5/2569")).toBe(true);
    });

    it("รายการชั่ง prefix", () => {
      expect(hasSessionStart("รายการชั่งคืน")).toBe(true);
    });

    it("multiline message with header + items", () => {
      expect(hasSessionStart("พี่ปลา-ราชพฤกษ์ คืน 29/5/2569\n1.ชะนี100บาท\nจบรายการคืน")).toBe(true);
    });
  });

  describe("must return false (SESSION_END lines only)", () => {
    it("จบรายการคืน alone", () => {
      expect(hasSessionStart("จบรายการคืน")).toBe(false);
    });

    it("จบรายการเบิก alone", () => {
      expect(hasSessionStart("จบรายการเบิก")).toBe(false);
    });

    it("จบรายการเสีย alone", () => {
      expect(hasSessionStart("จบรายการเสีย")).toBe(false);
    });

    it("จบรายการคืนเสีย alone", () => {
      expect(hasSessionStart("จบรายการคืนเสีย")).toBe(false);
    });

    it("LINE export: HH.MM sender จบรายการคืน (after normalization)", () => {
      // normalizeLine strips the prefix first; hasSessionStart sees bare "จบรายการคืน"
      expect(hasSessionStart("จบรายการคืน")).toBe(false);
    });

    it("unrelated text", () => {
      expect(hasSessionStart("ดีครับ")).toBe(false);
    });
  });
});
