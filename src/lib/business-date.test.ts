import { describe, expect, it } from "bun:test";
import { bangkokBusinessDateFromTimestamp } from "./business-date";

describe("bangkokBusinessDateFromTimestamp", () => {
  it("counts 03:58 Bangkok as the previous business date", () => {
    const ts = Date.UTC(2026, 5, 1, 20, 58, 0); // 2026-06-02 03:58 Bangkok
    expect(bangkokBusinessDateFromTimestamp(ts)).toBe("2026-06-01");
  });

  it("counts 04:00 Bangkok as the current business date", () => {
    const ts = Date.UTC(2026, 5, 1, 21, 0, 0); // 2026-06-02 04:00 Bangkok
    expect(bangkokBusinessDateFromTimestamp(ts)).toBe("2026-06-02");
  });

  it("counts normal daytime as the current business date", () => {
    const ts = Date.UTC(2026, 5, 1, 11, 0, 0); // 2026-06-01 18:00 Bangkok
    expect(bangkokBusinessDateFromTimestamp(ts)).toBe("2026-06-01");
  });

  it("handles month boundaries", () => {
    const ts = Date.UTC(2026, 5, 30, 20, 30, 0); // 2026-07-01 03:30 Bangkok
    expect(bangkokBusinessDateFromTimestamp(ts)).toBe("2026-06-30");
  });

  it("returns null for invalid input", () => {
    expect(bangkokBusinessDateFromTimestamp(undefined)).toBeNull();
    expect(bangkokBusinessDateFromTimestamp(NaN)).toBeNull();
  });
});
