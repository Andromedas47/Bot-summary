/**
 * Real PostgreSQL smoke harness for P2A migration 0047.
 *
 * Creates a disposable DB, applies bootstrap + 0047 + hardening SQL via psql,
 * then drops the DB. Skips only when psql/connection is unavailable.
 *
 * Env: PGPASSWORD=postgres (default), PGHOST=localhost, PGUSER=postgres
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";

const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BOOTSTRAP = join(REPO_ROOT, "supabase", "tests", "p2a_0047_bootstrap.sql");
const MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "0047_physical_inventory_capture.sql",
);
const HARDENING = join(REPO_ROOT, "supabase", "tests", "p2a_0047_hardening.sql");

function resolvePsql(): string | null {
  // Prefer explicit Windows install path when present (PATH may lack psql).
  if (existsSync(WIN_PSQL)) return WIN_PSQL;
  return "psql";
}

async function runPsql(
  psql: string,
  args: string[],
  opts?: { database?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([psql, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: opts?.database ?? "postgres",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function probeConnection(psql: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await runPsql(psql, [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "postgres",
      "-tAc",
      "SELECT 1",
    ]);
    if (r.code !== 0) {
      return {
        ok: false,
        detail: `psql exit ${r.code}: ${(r.stderr || r.stdout).trim() || "no output"}`,
      };
    }
    return { ok: true, detail: "ok" };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("P2A migration 0047 PostgreSQL hardening", () => {
  const dbName = `p2a_0047_hardening_${randomBytes(4).toString("hex")}`;
  let psqlPath: string | null = null;
  let skipReason: string | null = null;
  let dbCreated = false;

  test(
    "bootstrap + 0047 + hardening PASS on disposable DB",
    async () => {
      const resolved = resolvePsql();
      if (!resolved) {
        skipReason = "Skipping P2A 0047 PG hardening: psql binary not found";
        console.warn(skipReason);
        return;
      }
      psqlPath = resolved;
      const probe = await probeConnection(psqlPath);
      if (!probe.ok) {
        skipReason = `Skipping P2A 0047 PG hardening: psql/connection unavailable (${probe.detail}). Tried: ${psqlPath}`;
        console.warn(skipReason);
        return;
      }

      expect(existsSync(BOOTSTRAP)).toBe(true);
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(HARDENING)).toBe(true);

      const create = await runPsql(psqlPath, [
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        "postgres",
        "-c",
        `CREATE DATABASE ${dbName}`,
      ]);
      expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
      dbCreated = true;

      try {
        const boot = await runPsql(
          psqlPath,
          ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", BOOTSTRAP],
          { database: dbName },
        );
        expect(boot.code, `bootstrap failed:\n${boot.stderr}\n${boot.stdout}`).toBe(0);

        const mig = await runPsql(
          psqlPath,
          ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", MIGRATION],
          { database: dbName },
        );
        expect(mig.code, `migration 0047 failed:\n${mig.stderr}\n${mig.stdout}`).toBe(0);

        const hard = await runPsql(
          psqlPath,
          ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", HARDENING],
          { database: dbName },
        );
        expect(
          hard.code,
          `hardening failed:\n${hard.stderr}\n${hard.stdout}`,
        ).toBe(0);
        expect(hard.stderr + hard.stdout).toContain("p2a_0047_hardening PASS");
      } finally {
        if (dbCreated && psqlPath) {
          await runPsql(psqlPath, [
            "-v",
            "ON_ERROR_STOP=1",
            "-d",
            "postgres",
            "-c",
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
          ]);
          const drop = await runPsql(psqlPath, [
            "-v",
            "ON_ERROR_STOP=1",
            "-d",
            "postgres",
            "-c",
            `DROP DATABASE IF EXISTS ${dbName}`,
          ]);
          if (drop.code !== 0) {
            console.warn(`DROP DATABASE ${dbName} failed: ${drop.stderr}`);
          } else {
            dbCreated = false;
          }
        }
      }
    },
    { timeout: 180_000 },
  );

  afterAll(async () => {
    if (dbCreated && psqlPath) {
      await runPsql(psqlPath, [
        "-d",
        "postgres",
        "-c",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
      ]);
      await runPsql(psqlPath, [
        "-d",
        "postgres",
        "-c",
        `DROP DATABASE IF EXISTS ${dbName}`,
      ]);
    }
  });
});
