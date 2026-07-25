import { describe, expect, test } from "bun:test";
import {
  isIsoDate,
  parseStockSummaryTargets,
  resolveStockSummaryDate,
  stockSummaryRetryKey,
} from "./daily-stock-cron";

/** Bangkok is UTC+7 with no DST, so a fixed offset is exact here. */
function bangkok(iso: string): number {
  return new Date(`${iso}+07:00`).getTime();
}

describe("resolveStockSummaryDate", () => {
  test("uses an explicit ISO date when supplied", () => {
    expect(resolveStockSummaryDate("2026-07-25", bangkok("2026-01-01T12:00:00"))).toBe("2026-07-25");
  });

  test("ignores a malformed date param and falls back to the business date", () => {
    expect(resolveStockSummaryDate("25/07/2569", bangkok("2026-07-25T20:00:00"))).toBe("2026-07-25");
    expect(resolveStockSummaryDate("", bangkok("2026-07-25T20:00:00"))).toBe("2026-07-25");
  });

  test("respects the Bangkok 04:00 business-day boundary", () => {
    // 23:59 on the 25th is still the 25th
    expect(resolveStockSummaryDate(null, bangkok("2026-07-25T23:59:00"))).toBe("2026-07-25");
    // 00:30 on the 26th still belongs to the 25th's business day
    expect(resolveStockSummaryDate(null, bangkok("2026-07-26T00:30:00"))).toBe("2026-07-25");
    // 03:59 is the last minute of the 25th
    expect(resolveStockSummaryDate(null, bangkok("2026-07-26T03:59:00"))).toBe("2026-07-25");
    // 04:00 rolls over to the 26th
    expect(resolveStockSummaryDate(null, bangkok("2026-07-26T04:00:00"))).toBe("2026-07-26");
  });

  test("handles month and year boundaries", () => {
    expect(resolveStockSummaryDate(null, bangkok("2026-08-01T02:00:00"))).toBe("2026-07-31");
    expect(resolveStockSummaryDate(null, bangkok("2027-01-01T01:00:00"))).toBe("2026-12-31");
  });

  test("isIsoDate accepts only YYYY-MM-DD", () => {
    expect(isIsoDate("2026-07-25")).toBe(true);
    expect(isIsoDate("2026-7-25")).toBe(false);
    expect(isIsoDate("25/07/2569")).toBe(false);
  });
});

describe("stockSummaryRetryKey", () => {
  test("is deterministic for the same date, target and part", () => {
    const a = stockSummaryRetryKey("2026-07-25", "Cabc", 0);
    const b = stockSummaryRetryKey("2026-07-25", "Cabc", 0);
    expect(a).toBe(b);
  });

  test("differs by date, by target and by message part", () => {
    const base = stockSummaryRetryKey("2026-07-25", "Cabc", 0);
    expect(stockSummaryRetryKey("2026-07-26", "Cabc", 0)).not.toBe(base);
    expect(stockSummaryRetryKey("2026-07-25", "Cxyz", 0)).not.toBe(base);
    expect(stockSummaryRetryKey("2026-07-25", "Cabc", 1)).not.toBe(base);
  });

  test("is a well-formed RFC 4122 UUID", () => {
    expect(stockSummaryRetryKey("2026-07-25", "Cabc", 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("does not collide with the existing daily-summary key namespace", async () => {
    const { dailySummaryRetryKey } = await import("@/lib/line/daily-summary-cron");
    expect(stockSummaryRetryKey("2026-07-25", "Cabc", 0)).not.toBe(
      dailySummaryRetryKey("2026-07-25", "Cabc"),
    );
  });
});

describe("parseStockSummaryTargets", () => {
  test("returns no targets when unset or blank — delivery stays inactive", () => {
    expect(parseStockSummaryTargets(undefined)).toEqual([]);
    expect(parseStockSummaryTargets("")).toEqual([]);
    expect(parseStockSummaryTargets("   ")).toEqual([]);
    expect(parseStockSummaryTargets(",,")).toEqual([]);
  });

  test("splits on commas and whitespace and drops duplicates", () => {
    expect(parseStockSummaryTargets("Cabc, Cxyz")).toEqual(["Cabc", "Cxyz"]);
    expect(parseStockSummaryTargets("Cabc\nCxyz")).toEqual(["Cabc", "Cxyz"]);
    expect(parseStockSummaryTargets("Cabc,Cabc,Cxyz")).toEqual(["Cabc", "Cxyz"]);
  });
});
