import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const MANIFEST = join(ROOT, "supabase", "migration-history-manifest.json");

type MigrationManifest = { migrations: string[] };

function filenames() {
  return readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
}

describe("Production migration-history manifest", () => {
  it("matches the audited Production ledger exactly", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as MigrationManifest;
    const expected = [...manifest.migrations].sort();

    expect(expected).toHaveLength(95);
    expect(new Set(expected).size).toBe(95);
    expect(filenames()).toEqual(expected);
  });
});
