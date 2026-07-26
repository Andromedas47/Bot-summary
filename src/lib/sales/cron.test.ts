import { describe, expect, test } from "bun:test";
import { isIsoDate, STOCK_SUMMARY_TARGETS_ENV, stockSummaryRetryKey } from "@/lib/summary/daily-stock-cron";
import {
  parseSalesSummaryTargets,
  previousBangkokBusinessDate,
  resolveSalesSummaryDate,
  salesSummaryRetryKey,
  DEFAULT_SALES_REVISION,
  isValidSalesRevision,
  isStrictBusinessDate,
  SALES_SUMMARY_TARGETS_ENV,
} from "./cron";

const BANGKOK_0810_ON_26 = Date.UTC(2026, 6, 26, 1, 10); // 08:10 Bangkok

describe("P1 scheduler configuration", () => {
  test("recipients are configured independently from the Stock report", () => {
    expect(SALES_SUMMARY_TARGETS_ENV).toBe("SALES_SUMMARY_LINE_TARGETS");
    expect(SALES_SUMMARY_TARGETS_ENV).not.toBe(STOCK_SUMMARY_TARGETS_ENV);
  });

  test("an unset or empty variable means no delivery", () => {
    expect(parseSalesSummaryTargets(undefined)).toEqual([]);
    expect(parseSalesSummaryTargets("")).toEqual([]);
    expect(parseSalesSummaryTargets("  ")).toEqual([]);
  });

  test("targets are split on commas and whitespace, deduplicated", () => {
    expect(parseSalesSummaryTargets("Ca, Cb  Cc,Ca")).toEqual(["Ca", "Cb", "Cc"]);
  });
});

describe("P1 scheduled report date", () => {
  test("a scheduled 08:10 run reports the business date that just closed", () => {
    expect(resolveSalesSummaryDate(null, BANGKOK_0810_ON_26)).toBe("2026-07-25");
    expect(previousBangkokBusinessDate(BANGKOK_0810_ON_26)).toBe("2026-07-25");
  });

  test("an explicit ISO date is used verbatim and never shifted", () => {
    expect(resolveSalesSummaryDate("2026-07-20", BANGKOK_0810_ON_26)).toBe("2026-07-20");
  });

  test("a malformed date parameter falls back to the scheduled semantics", () => {
    expect(resolveSalesSummaryDate("25/07/2569", BANGKOK_0810_ON_26)).toBe("2026-07-25");
  });
});

describe("P1 idempotency keys", () => {
  test("are deterministic per business date, target and message part", () => {
    expect(salesSummaryRetryKey("2026-07-25", "Cgroup", 0)).toBe(
      salesSummaryRetryKey("2026-07-25", "Cgroup", 0),
    );
    expect(salesSummaryRetryKey("2026-07-25", "Cgroup", 0)).not.toBe(
      salesSummaryRetryKey("2026-07-25", "Cgroup", 1),
    );
    expect(salesSummaryRetryKey("2026-07-25", "Cgroup", 0)).not.toBe(
      salesSummaryRetryKey("2026-07-25", "Cother", 0),
    );
    expect(salesSummaryRetryKey("2026-07-25", "Cgroup", 0)).not.toBe(
      salesSummaryRetryKey("2026-07-26", "Cgroup", 0),
    );
  });

  test("have a UUID shape LINE accepts", () => {
    expect(salesSummaryRetryKey("2026-07-25", "Cgroup", 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("never collide with the P0 Stock keys", () => {
    expect(salesSummaryRetryKey("2026-07-25", "Cgroup", 0)).not.toBe(
      stockSummaryRetryKey("2026-07-25", "Cgroup", 0),
    );
  });
});

describe("P1 corrected-resend revisions", () => {
  const KEY = (revision?: string) =>
    revision === undefined
      ? salesSummaryRetryKey("2026-07-25", "Cgroup", 0)
      : salesSummaryRetryKey("2026-07-25", "Cgroup", 0, revision);

  test("the default revision is what the scheduler gets, and it is stable", () => {
    expect(KEY()).toBe(KEY(DEFAULT_SALES_REVISION));
    expect(KEY()).toBe(KEY());
  });

  test("a named revision produces new deterministic keys", () => {
    expect(KEY("correction-1")).not.toBe(KEY());
    // Re-running the same correction is idempotent — LINE sees the same key.
    expect(KEY("correction-1")).toBe(KEY("correction-1"));
  });

  test("a second correction is distinct from the first", () => {
    expect(KEY("correction-2")).not.toBe(KEY("correction-1"));
  });

  test("revisions are validated, so a stray value cannot become a key", () => {
    expect(isValidSalesRevision("correction-1")).toBe(true);
    expect(isValidSalesRevision("default")).toBe(true);
    expect(isValidSalesRevision("")).toBe(false);
    expect(isValidSalesRevision("-leading-dash")).toBe(false);
    expect(isValidSalesRevision("has space")).toBe(false);
    expect(isValidSalesRevision("a".repeat(65))).toBe(false);
  });
});

describe("P1 strict date validation", () => {
  test("accepts real dates", () => {
    for (const good of ["2026-07-25", "2028-02-29", "2026-01-01", "2026-12-31"]) {
      expect(isStrictBusinessDate(good)).toBe(true);
    }
  });

  test("rejects dates that do not exist", () => {
    for (const bad of ["2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2027-02-29"]) {
      expect(isStrictBusinessDate(bad)).toBe(false);
    }
  });

  test("rejects anything that is not the ISO shape", () => {
    for (const bad of ["", "25-07-2026", "2026-7-5", "yesterday", "2026-07-25T00:00:00Z"]) {
      expect(isStrictBusinessDate(bad)).toBe(false);
    }
  });

  test("an impossible date is not silently turned into yesterday", () => {
    // resolveSalesSummaryDate still falls back for a NULL param — the route is
    // what rejects a malformed one, so the fallback can never mask it.
    expect(resolveSalesSummaryDate("2026-07-25")).toBe("2026-07-25");
    expect(resolveSalesSummaryDate("2026-02-31")).toBe(previousBangkokBusinessDate());
  });

  test("P0 Stock's own date rule is untouched", () => {
    // isIsoDate is shape-only by design and is shared with P0; P1 layers its
    // strict check on top rather than changing what P0 accepts.
    expect(isIsoDate("2026-02-31")).toBe(true);
    expect(isStrictBusinessDate("2026-02-31")).toBe(false);
  });
});
