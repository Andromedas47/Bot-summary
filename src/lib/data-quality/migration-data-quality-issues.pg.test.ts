/**
 * Real PostgreSQL 17 proof for migration 20260825120000_data_quality_issues.sql.
 *
 * The table is standalone (no FKs into the rest of the schema), so the only
 * migration applied here is this one — no bootstrap chain needed. This test
 * proves the constraints the application logic (src/lib/data-quality/inbox.ts)
 * relies on are ALSO enforced at the database level, not just in app code:
 *   - issue_key UNIQUE — the actual dedup guarantee behind "one row per
 *     underlying problem", enforced even if a future caller bypasses
 *     upsertDataQualityIssue() and inserts directly.
 *   - severity CHECK — NORMAL can never be persisted (matches severity.ts's
 *     "NORMAL never reaches the table" contract).
 *   - status CHECK — only OPEN/RESOLVED/IGNORED.
 *   - resolved_at IS NULL iff status = 'OPEN' — resolution metadata can never
 *     be partially set.
 *
 * SKIP (not a failing red) when PostgreSQL 17 is unavailable or the
 * ALLOW_DISPOSABLE_POSTGRES_TESTS=1 guard is not set.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `dqi_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^dqi_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MIGRATION = join(ROOT, "supabase", "migrations", "20260825120000_data_quality_issues.sql");

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-data-quality-issues.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(args: string[], database = DATABASE): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
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

async function scalar(sql: string): Promise<string> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/** Runs SQL expected to fail; returns the combined error text. */
async function expectSqlError(sql: string): Promise<string> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code === 0) throw new Error(`expected SQL to fail but it succeeded: ${sql}`);
  return result.stderr || result.stdout;
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 130000;
  } catch {
    return false;
  }
}

const pgAvailable = await probe();
let databaseCreated = false;

function insertIssue(overrides: Partial<{
  issue_key: string;
  category: string;
  severity: string;
  business_date: string;
  summary_th: string;
  status: string;
  resolved_at: string | null;
}> = {}): string {
  const row = {
    issue_key: "k1",
    category: "produce_no_return",
    severity: "ACTION_REQUIRED",
    business_date: "2026-08-25",
    summary_th: "test",
    status: "OPEN",
    resolved_at: null as string | null,
    ...overrides,
  };
  const resolvedAtSql = row.resolved_at === null ? "NULL" : `'${row.resolved_at}'`;
  return `
    INSERT INTO public.data_quality_issues
      (issue_key, category, severity, business_date, summary_th, status, resolved_at)
    VALUES
      ('${row.issue_key}', '${row.category}', '${row.severity}', '${row.business_date}',
       '${row.summary_th}', '${row.status}', ${resolvedAtSql})
  `;
}

describe.skipIf(!pgAvailable)("data_quality_issues migration on PostgreSQL", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(MIGRATION);
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("a normal insert round-trips with defaults (id, first_seen, last_seen, created_at)", async () => {
    await psql(["-v", "ON_ERROR_STOP=1", "-c", insertIssue({ issue_key: "roundtrip-1" })]);
    expect(await scalar("SELECT status FROM public.data_quality_issues WHERE issue_key = 'roundtrip-1'")).toBe("OPEN");
    expect(await scalar("SELECT resolved_at IS NULL FROM public.data_quality_issues WHERE issue_key = 'roundtrip-1'")).toBe("t");
    expect(await scalar("SELECT id IS NOT NULL FROM public.data_quality_issues WHERE issue_key = 'roundtrip-1'")).toBe("t");
  });

  test("issue_key is UNIQUE — the actual dedup guarantee, enforced by the database itself", async () => {
    await psql(["-v", "ON_ERROR_STOP=1", "-c", insertIssue({ issue_key: "dup-key" })]);
    const error = await expectSqlError(insertIssue({ issue_key: "dup-key", category: "produce_price_conflict" }));
    expect(error).toMatch(/duplicate key value violates unique constraint/i);
    expect(await scalar("SELECT count(*) FROM public.data_quality_issues WHERE issue_key = 'dup-key'")).toBe("1");
  });

  test("severity is constrained to CRITICAL / ACTION_REQUIRED / ADVISORY — NORMAL can never be persisted", async () => {
    const error = await expectSqlError(insertIssue({ issue_key: "normal-1", severity: "NORMAL" }));
    expect(error).toMatch(/violates check constraint/i);
    expect(await scalar("SELECT count(*) FROM public.data_quality_issues WHERE issue_key = 'normal-1'")).toBe("0");
  });

  test("severity rejects an arbitrary invented value", async () => {
    const error = await expectSqlError(insertIssue({ issue_key: "bogus-severity", severity: "URGENT" }));
    expect(error).toMatch(/violates check constraint/i);
  });

  test("status is constrained to OPEN / RESOLVED / IGNORED", async () => {
    const error = await expectSqlError(insertIssue({ issue_key: "bogus-status", status: "DELETED" }));
    expect(error).toMatch(/violates check constraint/i);
  });

  test("resolved_at must be NULL for OPEN and NOT NULL for RESOLVED/IGNORED — never partially set", async () => {
    const openWithResolvedAt = await expectSqlError(
      insertIssue({ issue_key: "bad-open", status: "OPEN", resolved_at: "2026-08-25T00:00:00Z" }),
    );
    expect(openWithResolvedAt).toMatch(/violates check constraint/i);

    const resolvedWithoutResolvedAt = await expectSqlError(
      insertIssue({ issue_key: "bad-resolved", status: "RESOLVED", resolved_at: null }),
    );
    expect(resolvedWithoutResolvedAt).toMatch(/violates check constraint/i);

    // The valid pairing succeeds.
    await psql([
      "-v", "ON_ERROR_STOP=1", "-c",
      insertIssue({ issue_key: "good-resolved", status: "RESOLVED", resolved_at: "2026-08-25T00:00:00Z" }),
    ]);
    expect(await scalar("SELECT status FROM public.data_quality_issues WHERE issue_key = 'good-resolved'")).toBe("RESOLVED");
  });

  test("the status/business_date/severity indexes from the migration exist", async () => {
    for (const name of [
      "data_quality_issues_status_idx",
      "data_quality_issues_business_date_idx",
      "data_quality_issues_severity_idx",
      "data_quality_issues_status_date_idx",
    ]) {
      expect(
        await scalar(`SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='${name}'`),
      ).toBe("1");
    }
  });

  test("re-applying the migration is refused (preflight guard), never silently duplicating the table", async () => {
    const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", MIGRATION]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/already applied/i);
  });
});
