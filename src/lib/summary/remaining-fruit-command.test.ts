import { describe, expect, test } from "bun:test";
import { parseRemainingFruitCommand } from "./remaining-fruit-command";

describe("parseRemainingFruitCommand", () => {
  test("parses global command with date", () => {
    expect(parseRemainingFruitCommand("\u0E2A\u0E23\u0E38\u0E1B\u0E04\u0E07\u0E40\u0E2B\u0E25\u0E37\u0E2D 21/07/2569")).toEqual({
      businessDate: "2026-07-21",
      marketFilter: null,
    });
  });

  test("parses global command without date", () => {
    expect(parseRemainingFruitCommand("\u0E2A\u0E23\u0E38\u0E1B\u0E04\u0E07\u0E40\u0E2B\u0E25\u0E37\u0E2D")).toEqual({
      businessDate: null,
      marketFilter: null,
    });
  });

  test("parses market-specific command", () => {
    expect(parseRemainingFruitCommand("\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E2A\u0E23\u0E38\u0E1B\u0E04\u0E07\u0E40\u0E2B\u0E25\u0E37\u0E2D 21/07/2569")).toEqual({
      businessDate: "2026-07-21",
      marketFilter: "\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49",
    });
  });

  test("returns null for unrelated text", () => {
    expect(parseRemainingFruitCommand("\u0E2A\u0E23\u0E38\u0E1B\u0E22\u0E2D\u0E14 21/07/2569")).toBeNull();
  });

  test("returns null for invalid date", () => {
    expect(parseRemainingFruitCommand("\u0E2A\u0E23\u0E38\u0E1B\u0E04\u0E07\u0E40\u0E2B\u0E25\u0E37\u0E2D 99/99/2569")).toBeNull();
  });
});
