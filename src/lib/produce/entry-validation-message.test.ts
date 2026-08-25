import { describe, expect, it } from "bun:test";
import {
  countCodePoints,
  LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";
import type {
  ProduceValidationResult,
  ProduceValidationReview,
} from "./entry-validation";
import {
  buildPlainTextReviewValidationReply,
  buildReviewValidationReply,
} from "./entry-validation-message";

function review(
  itemNumber: number,
  productName: string,
): ProduceValidationReview {
  return {
    kind: "unknown_product_vocabulary",
    severity: "review_required",
    itemNumber,
    productName,
    suggestions: [{ productCode: "ม63", canonicalName: "มะม่วงจิ้ว" }],
  };
}

function result(...reviews: ProduceValidationReview[]): ProduceValidationResult {
  return {
    status: "review_required",
    blocking: [],
    reviews,
    advisories: [],
    digest: "review-digest",
  };
}

describe("unknown-product review actions", () => {
  it("makes keep-and-save and correction choices explicit for one product", () => {
    const reply = buildPlainTextReviewValidationReply(
      result(review(4, "มะม่วง")),
      "จบรายการเบิก",
    );

    expect(reply).toContain("✅ ถ้าชื่อนี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("ส่ง “จบรายการเบิก” อีกครั้ง");
    expect(reply).toContain("✏️ ถ้าต้องการแก้ชื่อ");
    expect(reply).toContain("ส่ง “แก้ข้อ 4”");
    expect(reply).toContain("แล้วส่งข้อ 4 ใหม่ พร้อมราคาและจำนวน");
    expect(reply).toEndWith("รายการอื่นยังอยู่ครบ ไม่ต้องเริ่มใหม่");
  });

  it.each([
    "จบรายการเบิก",
    "จบรายการชั่งคืน",
    "จบรายการคืนเสีย",
    "จบรายการเบิกเพิ่ม 4 รายการ",
  ])("repeats the active plain-text close command exactly: %s", (closeCommand) => {
    const reply = buildPlainTextReviewValidationReply(
      result(review(4, "มะม่วง")),
      closeCommand,
    );
    expect(reply).toContain(`ส่ง “${closeCommand}” อีกครั้ง`);
  });

  it("keeps the structured-session confirmation button prominent", () => {
    const reply = buildReviewValidationReply(result(review(4, "มะม่วง")));
    expect(reply).toContain("✅ ถ้าชื่อนี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("กด “ยืนยัน” เพื่อบันทึกและจบรายการ");
    expect(reply).toContain("✏️ ถ้าต้องการแก้ชื่อ");
  });

  it("keeps multiple products readable with one concise correction pattern", () => {
    const reply = buildPlainTextReviewValidationReply(
      result(
        review(1, "ผลไม้หนึ่ง"),
        review(8, "ผลไม้แปด"),
        review(20, "ผลไม้ยี่สิบ"),
      ),
      "จบรายการเบิก",
    );

    expect(reply).toContain("ข้อ 1 — ผลไม้หนึ่ง");
    expect(reply).toContain("ข้อ 8 — ผลไม้แปด");
    expect(reply).toContain("ข้อ 20 — ผลไม้ยี่สิบ");
    expect(reply).toContain("✅ ถ้าชื่อเหล่านี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("ส่งคำสั่ง “แก้ข้อ <เลขข้อ>” ทีละข้อ");
  });

  it("truncates issue details before the required action block", () => {
    const reviews = Array.from({ length: 25 }, (_, index) =>
      review(index + 1, `สินค้ายาว${index + 1}${"ก".repeat(1_000)}`),
    );
    const reply = buildPlainTextReviewValidationReply(
      result(...reviews),
      "จบรายการเบิก",
    );

    expect(countCodePoints(reply)).toBeLessThanOrEqual(
      LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
    );
    expect(reply).toContain("และอีก");
    expect(reply).toContain("✅ ถ้าชื่อเหล่านี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("ส่ง “จบรายการเบิก” อีกครั้ง");
    expect(reply).toContain("✏️ ถ้าต้องการแก้ชื่อ");
    expect(reply).toEndWith("รายการอื่นยังอยู่ครบ ไม่ต้องเริ่มใหม่");
  });
});
