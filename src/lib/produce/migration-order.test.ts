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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "supabase", "migrations");

const COMPATIBILITY = "produce_fingerprint_compatibility";
const MARKET_IDENTITY = "produce_market_identity_guard";
/**
 * Shipped with PR #51 and still unapplied in Production at preflight, so it is
 * a release prerequisite rather than history. It only has to land before the
 * compatibility migration; nothing in either PR A migration touches it.
 */
const PREREQUISITE = "cancel_duplicate_plain_text_round";

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

/**
 * Every function a migration DEFINES (bare name, schema qualifier dropped).
 * Calls do not count — only `CREATE [OR REPLACE] FUNCTION`, which is the shape
 * that can silently revert an earlier migration's definition.
 */
function definedFunctions(slug: string): string[] {
  const file = sortedMigrations().find((f) => f.includes(slug));
  expect(file, `${slug} is missing from supabase/migrations`).toBeTruthy();
  const sql = readFileSync(join(MIGRATIONS, file!), "utf8");
  const names = new Set<string>();
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:[A-Za-z_][\w$]*\s*\.\s*)?([A-Za-z_][\w$]*)/gi;
  for (const match of sql.matchAll(re)) names.add(match[1]);
  return [...names];
}

describe("PR A migration ordering", () => {
  it("applies fingerprint compatibility BEFORE market identity activation", () => {
    expect(indexOfMigration(COMPATIBILITY)).toBeLessThan(indexOfMigration(MARKET_IDENTITY));
  });

  it("keeps the outstanding PR #51 prerequisite ahead of both", () => {
    const prerequisite = indexOfMigration(PREREQUISITE);
    expect(prerequisite).toBeLessThan(indexOfMigration(COMPATIBILITY));
    expect(prerequisite).toBeLessThan(indexOfMigration(MARKET_IDENTITY));
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

  it("keeps the two adjacent, with nothing landing between them", () => {
    // The original guard asserted these were the last two files. Session
    // integrity hardening consciously lands AFTER both — it reissues the very
    // functions they install — so the guarantee that survives is adjacency:
    // nothing may ever sort between compatibility and market identity.
    expect(indexOfMigration(MARKET_IDENTITY)).toBe(indexOfMigration(COMPATIBILITY) + 1);
  });
});

/**
 * Session integrity hardening (P0-A / P0-B / P1-A / P1-B).
 *
 * All three sort after PR A, because each one reissues a function PR A installs:
 * round reuse rebuilds `bind_plain_text_accountability_round` on top of the
 * market identity guard, and the containment guard rebuilds
 * `try_finalize_pending_generation` on top of fingerprint compatibility.
 * Applying them in the other order would silently revert PR A.
 */
describe("session integrity migration ordering", () => {
  const ROUND_REUSE = "produce_same_day_round_reuse";
  const CONTAINMENT = "produce_withdrawal_containment_guard";
  const SUPERSESSION = "produce_pending_supersession_and_close_recovery";
  const ENVIRONMENT = "produce_supersession_runtime_environment";
  const HISTORICAL = "produce_historical_withdrawal_containment";

  it("applies all five after both PR A migrations", () => {
    const prA = Math.max(indexOfMigration(COMPATIBILITY), indexOfMigration(MARKET_IDENTITY));
    for (const slug of [ROUND_REUSE, CONTAINMENT, SUPERSESSION, ENVIRONMENT, HISTORICAL]) {
      expect(indexOfMigration(slug)).toBeGreaterThan(prA);
    }
  });

  it("keeps the five contiguous, in rollout order, with nothing landing between them", () => {
    // The original guard asserted these were the last five files, exactly as the
    // PR A guard above once asserted its two were the last two. A later
    // migration that touches none of these functions may legitimately land
    // after them (the first is the draft-cancellation RPC, which installs a new
    // function and reissues nothing), so the guarantee that survives is the
    // real one: the block stays contiguous and in rollout order, because each
    // of these five reissues a function an earlier one installs.
    const files = sortedMigrations();
    const order = [ROUND_REUSE, CONTAINMENT, SUPERSESSION, ENVIRONMENT, HISTORICAL];
    const first = indexOfMigration(ROUND_REUSE);
    order.forEach((slug, offset) => {
      expect(files[first + offset], `${slug} is out of rollout order`).toContain(slug);
    });
  });

  it("lands draft cancellation after the whole block, reissuing none of it", () => {
    // Forward-only and additive: it installs cancel_active_pending_produce_draft
    // and only CALLS retire_empty_round_of_generation, so it can never revert a
    // function an earlier migration installed.
    const CANCELLATION = "produce_cancel_active_pending_draft";
    expect(indexOfMigration(CANCELLATION)).toBeGreaterThan(indexOfMigration(HISTORICAL));

    // The ordering above is only half the claim. "Reissuing none of it" is the
    // half that actually keeps the block safe, so it is asserted rather than
    // asserted-by-comment: every function the five install must be ABSENT from
    // the cancellation migration's own CREATE OR REPLACE set. If a future edit
    // makes it redefine one of them, the ordering guarantee stops protecting
    // anything and this fails.
    const installed = new Set(
      [ROUND_REUSE, CONTAINMENT, SUPERSESSION, ENVIRONMENT, HISTORICAL]
        .flatMap((slug) => definedFunctions(slug)),
    );
    expect(installed.size, "the five-migration block defines no functions?").toBeGreaterThan(0);

    const reissued = definedFunctions(CANCELLATION).filter((fn) => installed.has(fn));
    expect(reissued, `draft cancellation reissues ${reissued.join(", ")}`).toEqual([]);

    // And it does install the one new function it is for.
    expect(definedFunctions(CANCELLATION)).toContain("cancel_active_pending_produce_draft");
  });

  it("orders both release fixes strictly after the three Production already applied", () => {
    // 090000/090100/090200 are Production history: recorded there as
    // 20260817080247 / 080346 / 080439. The release-safety fixes must be NEW
    // migrations after them, never edits to them.
    for (const applied of [ROUND_REUSE, CONTAINMENT, SUPERSESSION]) {
      for (const fix of [ENVIRONMENT, HISTORICAL]) {
        expect(indexOfMigration(fix)).toBeGreaterThan(indexOfMigration(applied));
      }
    }
  });
});
