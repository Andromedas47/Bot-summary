import { describe, expect, test } from "bun:test";
import { formatBusinessDateThai } from "./business-date-display";

describe("formatBusinessDateThai", () => {
  test("formats canonical YYYY-MM-DD as Thai Buddhist calendar text", () => {
    const text = formatBusinessDateThai("2026-07-25");
    expect(text).toBeTruthy();
    expect(text).toContain("2569");
    expect(text).toMatch(/25/);
    expect(text).toMatch(/กรกฎาคม/);
  });

  test("does not shift the calendar day across timezones", () => {
    // Mid-month date — if TZ shifted ±1 day, day number would change.
    const text = formatBusinessDateThai("2026-01-15");
    expect(text).toMatch(/15/);
    expect(text).toContain("2569");
  });

  test("rejects non-canonical input", () => {
    expect(formatBusinessDateThai("25/07/2026")).toBeNull();
    expect(formatBusinessDateThai("")).toBeNull();
    expect(formatBusinessDateThai("2026-13-01")).toBeNull();
  });
});
