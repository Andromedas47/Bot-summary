import { describe, expect, test } from "bun:test";
import { isQaMarketLabel, qaMarketLabels } from "./qa-scopes";

describe("isQaMarketLabel", () => {
  test("excludes the exact QA scope ทดสอบ", () => {
    expect(isQaMarketLabel("ทดสอบ")).toBe(true);
  });

  test("does not exclude a legitimate market merely because it shares a word", () => {
    expect(isQaMarketLabel("ตลาดทดสอบทองผาภูมิ")).toBe(false);
    expect(isQaMarketLabel("ทดสอบเงินโอนใหม่")).toBe(false);
  });

  test("no substring or regex matching — a legitimate market containing ทดสอบ stays counted", () => {
    for (const label of ["ตลาดใหม่ทดสอบ", "ทดสอบตลาดใหม่"]) {
      expect(isQaMarketLabel(label)).toBe(false);
    }
  });

  test("null/undefined/blank never match", () => {
    expect(isQaMarketLabel(null)).toBe(false);
    expect(isQaMarketLabel(undefined)).toBe(false);
    expect(isQaMarketLabel("")).toBe(false);
  });

  test("ทดสอบ is listed among the excluded labels", () => {
    expect(qaMarketLabels()).toContain("ทดสอบ");
  });
});
