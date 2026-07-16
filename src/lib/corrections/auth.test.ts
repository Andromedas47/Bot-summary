import { describe, expect, test } from "bun:test";
import { isCorrectionApprover } from "@/lib/corrections/auth";

describe("correction approval authorization", () => {
  test("fails closed for normal and missing users", () => {
    expect(isCorrectionApprover(undefined)).toBe(false);
    expect(isCorrectionApprover({ role: "user" })).toBe(false);
    expect(isCorrectionApprover({ correction_approver: false })).toBe(false);
  });
  test("allows only explicit app metadata", () => {
    expect(isCorrectionApprover({ role: "admin" })).toBe(true);
    expect(isCorrectionApprover({ correction_approver: true })).toBe(true);
  });
});
