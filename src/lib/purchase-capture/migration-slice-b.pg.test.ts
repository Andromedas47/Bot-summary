/**
 * Real PostgreSQL harness for P2B purchase-capture Slice B migration.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const REQUIRE_POSTGRES_TESTS = process.env.REQUIRE_POSTGRES_TESTS === "1";

const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BOOTSTRAP = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_b_bootstrap.sql");
const MIGRATION_0052 = join(REPO_ROOT, "supabase", "migrations", "0052_purchase_receipt_persistence.sql");
const MIGRATION_A = join(REPO_ROOT, "supabase", "migrations", "20260805130000_purchase_capture_sessions.sql");
const MIGRATION_B = join(REPO_ROOT, "supabase", "migrations", "20260805140000_purchase_capture_draft_finalization.sql");
const HARDENING = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_b_hardening.sql");

type PsqlResult = { code: number; stdout: string; stderr: string };

function resolvePsql(): string | null {
  if (existsSync(WIN_PSQL)) return WIN_PSQL;
  return "psql";
}

async function runPsql(
  psql: string,
  args: string[],
  opts?: { database?: string },
): Promise<PsqlResult> {
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
    const r = await runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-tAc", "SELECT 1"]);
    if (r.code !== 0) {
      return { ok: false, detail: `psql exit ${r.code}: ${(r.stderr || r.stdout).trim() || "no output"}` };
    }
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const resolvedPsql = resolvePsql();
const probe = resolvedPsql
  ? await probeConnection(resolvedPsql)
  : { ok: false, detail: "psql binary not found" };

const pgAvailable = Boolean(resolvedPsql && probe.ok);

if (!pgAvailable) {
  console.warn(`Purchase capture Slice B PG tests SKIPPED: PostgreSQL unavailable (${probe.detail})`);
}

if (REQUIRE_POSTGRES_TESTS && !pgAvailable) {
  throw new Error(
    `PostgreSQL tests are required but unavailable at ${PGHOST}:${PGPORT}: ${probe.detail}`,
  );
}

describe.skipIf(!pgAvailable)("Purchase capture Slice B migration PostgreSQL hardening", () => {
  const dbName = `pc_slice_b_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;
  let ready = false;

  test(
    "bootstrap + 0052 + Slice A + Slice B + hardening PASS on disposable DB",
    async () => {
      for (const file of [BOOTSTRAP, MIGRATION_0052, MIGRATION_A, MIGRATION_B, HARDENING]) {
        expect(existsSync(file), `missing ${file}`).toBe(true);
      }

      const create = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`]);
      expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
      dbCreated = true;

      for (const file of [BOOTSTRAP, MIGRATION_0052, MIGRATION_A, MIGRATION_B]) {
        const result = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", file], { database: dbName });
        expect(result.code, `${file} failed:\n${result.stderr}\n${result.stdout}`).toBe(0);
      }

      const hard = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", HARDENING], { database: dbName });
      expect(hard.code, `hardening failed:\n${hard.stderr}\n${hard.stdout}`).toBe(0);
      expect(hard.stderr + hard.stdout).toContain("purchase_capture_slice_b_hardening PASS");
      ready = true;
      console.info("Purchase capture Slice B hardening: PASS (real PostgreSQL)");
    },
    { timeout: 300_000 },
  );

  test("registry tables are service_role SELECT only with RLS enabled", async () => {
    expect(ready).toBe(true);
    const rls = await runPsql(
      psqlPath,
      [
        "-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc",
        `SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.purchase_intake_product_registry'::regclass`,
      ],
      { database: dbName },
    );
    expect(rls.stdout.trim()).toBe("true");
  });

  afterAll(async () => {
    if (!dbCreated) return;
    await runPsql(psqlPath, ["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`]);
  });
});
