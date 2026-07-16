import { describe, expect, test } from "bun:test";
import { parseCorrectionRequestForm } from "@/lib/corrections/request-validation";

function validForm(): FormData {
  const data = new FormData();
  data.set("transactionId", "11111111-1111-4111-8111-111111111111");
  data.set("requestKey", "22222222-2222-4222-8222-222222222222");
  data.set("reasonType", "wrong_price");
  data.set("reasonDetail", "แก้ราคาตามหลักฐาน");
  data.set("priceAmount", "109");
  return data;
}

describe("correction request server boundary", () => {
  test("accepts only requested fields and converts numeric form values to JSON numbers", () => {
    const parsed = parseCorrectionRequestForm(validForm());
    expect(parsed.requestedChanges).toEqual({ priceAmount: 109 });
    expect(typeof parsed.requestedChanges.priceAmount).toBe("number");
  });

  test("ignores spoofed actors, timestamps, snapshots, status and total", () => {
    const data = validForm();
    data.set("requested_by", "attacker");
    data.set("requested_at", "1999-01-01T00:00:00Z");
    data.set("created_at", "1999-01-01T00:00:00Z");
    data.set("before_snapshot", JSON.stringify({ priceAmount: 1 }));
    data.set("after_snapshot", JSON.stringify({ totalAmount: 1 }));
    data.set("totalAmount", "1");
    data.set("status", "approved");
    const parsed = parseCorrectionRequestForm(data);
    expect(parsed).not.toHaveProperty("requested_by");
    expect(parsed).not.toHaveProperty("requested_at");
    expect(parsed).not.toHaveProperty("before_snapshot");
    expect(parsed.requestedChanges).toEqual({ priceAmount: 109 });
  });

  test.each(["NaN", "Infinity", "-Infinity", "x", "", "0", "-1"])(
    "rejects invalid quantity %s",
    (value) => {
      const data = validForm();
      data.delete("priceAmount");
      data.set("quantity", value);
      expect(() => parseCorrectionRequestForm(data)).toThrow();
    },
  );

  test("rejects negative price, zero price quantity and empty changed text", () => {
    for (const [key, value] of [
      ["priceAmount", "-0.01"],
      ["priceQuantity", "0"],
      ["productName", "   "],
      ["unit", "   "],
    ] as const) {
      const data = validForm();
      data.delete("priceAmount");
      data.set(key, value);
      expect(() => parseCorrectionRequestForm(data)).toThrow();
    }
  });

  test("rejects empty reason, malformed evidence and duplicate mixed with edits", () => {
    const noReason = validForm();
    noReason.set("reasonDetail", " ");
    expect(() => parseCorrectionRequestForm(noReason)).toThrow();

    const badEvidence = validForm();
    badEvidence.set("evidenceUrl", "javascript:alert(1)");
    expect(() => parseCorrectionRequestForm(badEvidence)).toThrow();

    const duplicate = validForm();
    duplicate.set("duplicate", "on");
    duplicate.set("reasonType", "duplicate");
    expect(() => parseCorrectionRequestForm(duplicate)).toThrow();
  });
});
