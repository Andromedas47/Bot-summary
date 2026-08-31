import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const MANIFEST = join(ROOT, "supabase", "migration-history-manifest.json");

type MigrationManifest = { source: string; migrations: string[] };

/**
 * HISTORICAL_PRODUCTION_BASELINE = the migrations recorded in Production's
 * supabase_migrations.schema_migrations ledger at the audited cutoff. These are
 * immutable: Production has already run them, so their filenames and SQL must
 * never change and their versions must never be reused.
 *
 * PENDING_FORWARD_MIGRATIONS = migrations that exist in the repository but have
 * not been applied to Production yet. They are legitimate, not drift — but they
 * must sort strictly after the audited cutoff so they can never collide with, or
 * silently re-run before, an already-applied historical migration.
 */
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as MigrationManifest;
const HISTORICAL = [...manifest.migrations].sort();
const CUTOFF = HISTORICAL[HISTORICAL.length - 1].split("_")[0];

function repoMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

// Version is the filename prefix before the first underscore: "0001" or
// "20260827065840". All are digit-only, so lexicographic order equals
// chronological order (any 4-digit legacy version sorts before any 14-digit
// timestamp version).
function versionOf(filename: string): string {
  return filename.split("_")[0];
}

const repoFiles = repoMigrationFiles();
const historicalSet = new Set(HISTORICAL);
const pendingForward = repoFiles.filter((file) => !historicalSet.has(file));

describe("Production migration-history baseline", () => {
  it("is exactly the 95 audited Production migrations", () => {
    expect(HISTORICAL).toHaveLength(95);
    expect(new Set(HISTORICAL).size).toBe(95);
  });

  it("still exists in the repository under its exact reconciled filenames", () => {
    const present = repoFiles.filter((file) => historicalSet.has(file));
    expect(present).toEqual(HISTORICAL);
  });

  it("has one unique version per historical migration", () => {
    const versions = HISTORICAL.map(versionOf);
    expect(new Set(versions).size).toBe(HISTORICAL.length);
    expect(versions.every((version) => /^\d+$/.test(version))).toBe(true);
  });

  it("has no stale alternate filename for any historical version", () => {
    // A historical version may appear exactly once across the whole migrations
    // directory. A second file carrying the same version is a leftover
    // pre-reconciliation alias and would make Production history ambiguous.
    const byVersion = new Map<string, string[]>();
    for (const file of repoFiles) {
      const version = versionOf(file);
      byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
    }

    const duplicated = [...byVersion.entries()].filter(([, files]) => files.length > 1);
    expect(duplicated).toEqual([]);

    for (const historical of HISTORICAL) {
      expect(byVersion.get(versionOf(historical))).toEqual([historical]);
    }
  });
});

describe("Pending forward migrations", () => {
  it("are allowed, and are exactly the repo files outside the audited baseline", () => {
    // Every repo migration is either historical or pending-forward; nothing else
    // is possible, and a forward migration must never remove a historical one.
    expect([...pendingForward, ...HISTORICAL].sort()).toEqual(repoFiles);
  });

  it("all sort strictly after the audited Production cutoff", () => {
    expect(CUTOFF).toBe("20260827065840");
    for (const file of pendingForward) {
      expect(versionOf(file) > CUTOFF).toBe(true);
    }
  });

  it("classifies 20260829090000 as pending-forward, not historical drift", () => {
    const inactivityLifecycle = "20260829090000_produce_pending_inactivity_lifecycle.sql";
    expect(repoFiles).toContain(inactivityLifecycle);
    expect(HISTORICAL).not.toContain(inactivityLifecycle);
    expect(pendingForward).toContain(inactivityLifecycle);
  });

  it("do not invalidate historical reconciliation when more are added", () => {
    // Simulate a future forward migration: the historical baseline assertions
    // must still hold unchanged.
    const withFutureForward = [...repoFiles, "20270101000000_future_forward.sql"].sort();
    const stillHistorical = withFutureForward.filter((file) => historicalSet.has(file));
    expect(stillHistorical).toEqual(HISTORICAL);
    expect(stillHistorical).toHaveLength(95);
  });
});
