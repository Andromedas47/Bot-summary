import { describe, expect, it } from "bun:test";
import { hasHardStopWarning, isHardStopWarning, splitWhiteSheetWarnings } from "./warnings";

const HARD_STOP_WARNING =
  "Multiple completed main produce sessions (2) exist for this market and business date; " +
  "current schema has no void/supersede marker, so duplicate business data may still be included.";
const SOFT_WARNING = "Uncategorized product: มะม่วง (โล)";

describe("isHardStopWarning", () => {
  it("matches the multiple-main-session warning", () => {
    expect(isHardStopWarning(HARD_STOP_WARNING)).toBe(true);
  });

  it("does not match an ordinary warning", () => {
    expect(isHardStopWarning(SOFT_WARNING)).toBe(false);
  });
});

describe("hasHardStopWarning", () => {
  it("is false for an empty warning list", () => {
    expect(hasHardStopWarning([])).toBe(false);
  });

  it("is false when only soft warnings are present", () => {
    expect(hasHardStopWarning([SOFT_WARNING])).toBe(false);
  });

  it("is true when the hard-stop warning is present alongside others", () => {
    expect(hasHardStopWarning([SOFT_WARNING, HARD_STOP_WARNING])).toBe(true);
  });
});

describe("splitWhiteSheetWarnings", () => {
  it("separates hard-stop warnings from ordinary ones", () => {
    const result = splitWhiteSheetWarnings([SOFT_WARNING, HARD_STOP_WARNING]);
    expect(result.hardStopWarnings).toEqual([HARD_STOP_WARNING]);
    expect(result.otherWarnings).toEqual([SOFT_WARNING]);
  });

  it("returns empty arrays for no warnings", () => {
    expect(splitWhiteSheetWarnings([])).toEqual({ hardStopWarnings: [], otherWarnings: [] });
  });
});
