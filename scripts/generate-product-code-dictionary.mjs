/**
 * Regenerates the Product Code Dictionary artifacts from the approved CSV.
 *
 *   node scripts/generate-product-code-dictionary.mjs
 *
 * The CSV at src/lib/produce/product-code/dictionary.csv is the single approved
 * source of truth. This script never invents, renumbers, sorts or collapses
 * rows — it emits the CSV's own order verbatim into:
 *
 *   - src/lib/produce/product-code/dictionary.ts  (runtime resolver data)
 *   - stdout: the migration's VALUES block, for a one-time paste into a new
 *     migration file. Migrations are immutable once applied, so this script
 *     deliberately does not rewrite them; dictionary-source-parity.test.ts is
 *     what keeps the committed migration and the CSV honest.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "src", "lib", "produce", "product-code");

const rows = parseDictionaryCsv(readFileSync(join(DIR, "dictionary.csv"), "utf8"));

writeFileSync(join(DIR, "dictionary.ts"), renderModule(rows), "utf8");
process.stdout.write(renderSqlValues(rows));
process.stderr.write(`\n${rows.length} product codes written to dictionary.ts\n`);

/**
 * Minimal CSV reader for this file's shape: no quoted fields, no embedded
 * commas, a UTF-8 BOM, and a trailing newline. Anything else is a hard error
 * rather than a silent partial import.
 */
function parseDictionaryCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines.shift();
  const expected = "code,category_code,category,canonical_name,active_dictionary";
  if (header !== expected) throw new Error(`unexpected CSV header: ${header}`);

  const seen = new Set();
  return lines.map((line, index) => {
    const parts = line.split(",");
    if (parts.length !== 5) {
      throw new Error(`row ${index + 2} has ${parts.length} fields, expected 5: ${line}`);
    }
    const [code, categoryCode, category, canonicalName, active] = parts.map((p) => p.trim());
    if (active !== "True" && active !== "False") {
      throw new Error(`row ${index + 2} has a non-boolean active_dictionary: ${line}`);
    }
    if (!code.startsWith(categoryCode)) {
      throw new Error(`row ${index + 2} code ${code} does not carry its category prefix ${categoryCode}`);
    }
    if (!/^[มผปทหพ]\d+$/u.test(code)) {
      throw new Error(`row ${index + 2} code ${code} is not a recognizable product code`);
    }
    // A code is stable for life: a retired one keeps its row with
    // active_dictionary=False so it can never be reissued to another product.
    if (seen.has(code)) throw new Error(`row ${index + 2} duplicates code ${code}`);
    seen.add(code);
    return { code, categoryCode, category, canonicalName, enabled: active === "True" };
  });
}

function renderModule(rows) {
  const entries = rows
    .map((r) => `  ${JSON.stringify([r.code, r.categoryCode, r.category, r.canonicalName, r.enabled])},`)
    .join("\n");

  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: src/lib/produce/product-code/dictionary.csv (the approved dictionary)
 * Regenerate: node scripts/generate-product-code-dictionary.mjs
 *
 * Order, numbering and canonical spellings are the approved CSV's, verbatim.
 */

export interface ProductCodeEntry {
  /** e.g. "ม02". Stable for the life of the code — never reassigned. */
  readonly code: string;
  readonly categoryCode: string;
  readonly category: string;
  /** The product identity every downstream comparison actually uses. */
  readonly canonicalName: string;
  /**
   * false = this code no longer resolves and fails closed like an unregistered
   * one. It does NOT mean the product is invalid: canonicalName stays
   * enterable as ordinary text, exactly as it was before it ever had a code.
   * Retired rows are kept, never deleted, so a code is never reissued.
   */
  readonly enabled: boolean;
}

const RAW: ReadonlyArray<readonly [string, string, string, string, boolean]> = [
${entries}
];

export const PRODUCT_CODE_ENTRIES: ReadonlyArray<ProductCodeEntry> = RAW.map(
  ([code, categoryCode, category, canonicalName, enabled]) =>
    Object.freeze({ code, categoryCode, category, canonicalName, enabled }),
);

/** Every row in the approved dictionary, retired ones included. */
export const PRODUCT_CODE_COUNT = ${rows.length};

/** Rows that currently resolve. Equal to PRODUCT_CODE_COUNT until one retires. */
export const PRODUCT_CODE_ENABLED_COUNT = ${rows.filter((r) => r.enabled).length};
`;
}

function renderSqlValues(rows) {
  const literal = (s) => `'${s.replace(/'/g, "''")}'`;
  return rows
    .map((r) =>
      `  (${literal(r.code)}, ${literal(r.categoryCode)}, ${literal(r.category)}, ` +
      `${literal(r.canonicalName)}, ${r.enabled})`)
    .join(",\n") + "\n";
}
