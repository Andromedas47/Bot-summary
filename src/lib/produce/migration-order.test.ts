/**
 * Migration ordering is the rollout contract, encoded in filenames.
 *
 * The application calls `try_finalize_pending_generation` with
 * `p_compatibility_hashes`. Production's function has eight arguments and no
 * defaults, so "new app + old schema" is not a state the system can be in — the
 * call does not resolve at all. The schema has to move first, and the
 * fingerprint compatibility migration has to be the part that moves first.
 *
 * Market identity activation goes last for the opposite reason: landing the
 * catalog rows early would give the database alias-aware round binding while
 * instances are still fingerprinting the aliases apart.
 *
 * Nothing here should depend on a human reading a runbook in the right order,
 * so the guarantee lives in the sort order of `supabase/migrations`.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "supabase", "migrations");

const COMPATIBILITY = "produce_fingerprint_compatibility";
const MARKET_IDENTITY = "produce_market_identity_guard";

/** Exactly how the CLI orders them: lexicographic on filename. */
function sortedMigrations(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
}

function indexOfMigration(slug: string): number {
  const files = sortedMigrations();
  const index = files.findIndex((f) => f.includes(slug));
  expect(index, `${slug} is missing from supabase/migrations`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("PR A migration ordering", () => {
  it("applies fingerprint compatibility BEFORE market identity activation", () => {
    expect(indexOfMigration(COMPATIBILITY)).toBeLessThan(indexOfMigration(MARKET_IDENTITY));
  });

  it("puts both after every migration Production has already applied", () => {
    // The newest version Production tracks, read-only, at review time.
    const PRODUCTION_MAX_VERSION = "20260815094931";
    for (const slug of [COMPATIBILITY, MARKET_IDENTITY]) {
      const file = sortedMigrations().find((f) => f.includes(slug))!;
      const version = file.slice(0, 14);
      expect(version > PRODUCTION_MAX_VERSION, `${file} must sort after Production's tip`).toBe(true);
    }
  });

  it("gives every migration a distinct version prefix", () => {
    const versions = sortedMigrations().map((f) => f.slice(0, f.indexOf("_")));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("keeps the two as the last two migrations in the repository", () => {
    // If something later is ever added, it must consciously decide where it
    // sits relative to the rollout, rather than silently landing in between.
    const files = sortedMigrations();
    expect(files[files.length - 2]).toContain(COMPATIBILITY);
    expect(files[files.length - 1]).toContain(MARKET_IDENTITY);
  });
});
