import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MODULE_DIRECTORY = import.meta.dir;
const PRODUCTION_FILES = readdirSync(MODULE_DIRECTORY)
  .filter(
    (name) =>
      name.endsWith(".ts")
      && !name.endsWith(".test.ts")
      && name !== "test-helpers.ts",
  )
  .sort();

function source(name: string): string {
  return readFileSync(join(MODULE_DIRECTORY, name), "utf8");
}

describe("P2B Slice A architecture boundaries", () => {
  test("production modules import only sibling pure purchase modules", () => {
    const importTarget =
      /(?:from|export\s+\*)\s+["']([^"']+)["']/gu;
    for (const file of PRODUCTION_FILES) {
      const contents = source(file);
      const targets = [...contents.matchAll(importTarget)].map(
        (match) => match[1],
      );
      expect(
        targets.every((target) => target?.startsWith("./")),
        `${file}: ${targets.join(", ")}`,
      ).toBe(true);
    }
  });

  test("has no database, Supabase, route, webhook, Produce, P0/P1/P2A, or unit-conversion dependency", () => {
    const forbidden = [
      /supabase/iu,
      /database/iu,
      /route(?:s|r)?\//iu,
      /webhook/iu,
      /physical-inventory/iu,
      /weigh-session/iu,
      /produce/iu,
      /resolveUnitQuantity/u,
      /normalizeUnitAlias/u,
      /parsers\/(?:base|registry)/u,
    ];

    for (const file of PRODUCTION_FILES) {
      const importLines = source(file)
        .split(/\r?\n/u)
        .filter((line) => /^\s*(?:import|export\s+\*)/u.test(line))
        .join("\n");
      for (const pattern of forbidden) {
        expect(importLines, `${file} matched ${pattern.toString()}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  test("exact decimal implementation never routes input through Number or float parsers", () => {
    const contents = source("exact-decimal.ts");
    expect(contents).not.toMatch(/\bNumber\s*\(/u);
    expect(contents).not.toMatch(/\bparseFloat\s*\(/u);
    expect(contents).not.toMatch(/\bparseInt\s*\(/u);
  });

  test("guided command boundary cannot call or import a text parser", () => {
    const contents = source("commands.ts");
    expect(contents).not.toMatch(/from\s+["']\.\/(?:parse|text-adapter)/u);
    expect(contents).not.toMatch(/[\u0E00-\u0E7F]/u);
    expect(source("parse.ts")).toContain("validatePurchaseCommand");
  });

  test("assembler has no dependency path back to text parsing", () => {
    const contents = source("assemble.ts");
    expect(contents).not.toMatch(
      /from\s+["']\.\/(?:parse|classify|segment|text-adapter|text-chunks)/u,
    );
  });

  test("production domain does not expose receipt or stock-posting fields", () => {
    const contents = source("types.ts");
    expect(contents).toContain("intendedWarehouseCode");
    expect(contents).not.toContain("MAIN_SELLABLE");
    expect(contents).not.toContain("MAIN_DAMAGED");
    expect(contents).not.toMatch(/\breceipt(?:Id|Status|Confirmed)/u);
    expect(contents).not.toMatch(/\bstockMovement/u);
  });
});
