/**
 * Real PostgreSQL 17 proof for migration 0059 (manual_white_sheet_sessions):
 * explicit grants/revokes, RLS posture, CHECK invariants, lifecycle
 * consistency, and the recoverable closing lease (claim_manual_white_sheet_
 * session_close), including real multi-connection concurrency.
 *
 * Uses one disposable local database and never connects to Production.
 * SKIP (not green PASS) when a local PostgreSQL 17 is unavailable.
 */
import { afterAll, describe, expect, test } from "bun:test";
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
const DATABASE = `mwss_0059_${randomBytes(4).toString("hex")}`;
const BOOTSTRAP = join(ROOT, "supabase", "tests", "manual_white_sheet_sessions_0059_bootstrap.sql");
const MIGRATION = join(ROOT, "supabase", "migrations", "0059_manual_white_sheet_sessions.sql");

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(database: string, args: string[]): Promise<PsqlResult> {
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

async function exec(sql: string): Promise<PsqlResult> {
  return psql(DATABASE, ["-v", "ON_ERROR_STOP=1", "-c", sql]);
}

/** Like exec, but does NOT stop on error — for asserting a statement fails. */
async function execExpectFail(sql: string): Promise<PsqlResult> {
  return psql(DATABASE, ["-c", sql]);
}

async function scalar(sql: string): Promise<string> {
  const result = await psql(DATABASE, ["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  // A multi-statement call (e.g. "SET ROLE x; SELECT ...") prints one result
  // line per statement — the caller only wants the final SELECT's value.
  const lines = result.stdout.trim().split(/\r?\n/).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? "";
}

/** Runs SQL as a given role via SET ROLE in the same session (SET ROLE requires superuser or membership; the psql connection is postgres, a superuser, so it may assume any role). */
async function scalarAsRole(role: string, sql: string): Promise<string> {
  return scalar(`SET ROLE ${role}; ${sql}`);
}

async function execAsRoleExpectFail(role: string, sql: string): Promise<PsqlResult> {
  return execExpectFail(`SET ROLE ${role}; ${sql}`);
}

async function apply(file: string): Promise<void> {
  const result = await psql(DATABASE, ["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  try {
    const result = await psql("postgres", ["-tAc", "SHOW server_version_num"]);
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

async function concurrent(sqlA: string, sqlB: string): Promise<[PsqlResult, PsqlResult]> {
  return Promise.all([
    psql(DATABASE, ["-v", "ON_ERROR_STOP=1", "-tAc", sqlA]),
    psql(DATABASE, ["-v", "ON_ERROR_STOP=1", "-tAc", sqlB]),
  ]);
}

function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Fresh valid row's column list/values, identity + status overridable per test. */
function insertRowSql(overrides: Record<string, string> = {}): string {
  const cols: Record<string, string> = {
    source_id: q("src-1"),
    market_label: q("ตลาดเอ"),
    market_label_normalized: q("ตลาดเอ"),
    business_date: "date '2026-07-31'",
    business_date_display: q("31/07/2569"),
    opened_line_event_id: q(`evt-${randomBytes(3).toString("hex")}`),
    ...overrides,
  };
  const columns = Object.keys(cols).join(", ");
  const values = Object.values(cols).join(", ");
  return `INSERT INTO public.manual_white_sheet_sessions (${columns}) VALUES (${values})`;
}

const pgAvailable = await probe();
let databaseCreated = false;

describe.skipIf(!pgAvailable)("0059 manual_white_sheet_sessions on real PostgreSQL 17", () => {
  test(
    "bootstrap + migration 0059 apply cleanly",
    async () => {
      expect(existsSync(BOOTSTRAP)).toBe(true);
      expect(existsSync(MIGRATION)).toBe(true);

      const create = await psql("postgres", ["-c", `CREATE DATABASE ${DATABASE}`]);
      expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
      databaseCreated = true;

      await apply(BOOTSTRAP);
      await apply(MIGRATION);

      const exists = await scalar(
        `SELECT (to_regclass('public.manual_white_sheet_sessions') IS NOT NULL)::text`,
      );
      expect(exists).toBe("true");
    },
    { timeout: 60_000 },
  );

  // ── CHECK invariants ───────────────────────────────────────────────────────

  test("rejects blank identity fields", async () => {
    const cases: Record<string, string>[] = [
      { source_id: q("  ") },
      { market_label: q("") },
      { market_label_normalized: q("   ") },
      { business_date_display: q("") },
    ];
    for (const overrides of cases) {
      const r = await execExpectFail(insertRowSql(overrides));
      expect(r.code, `expected failure for ${JSON.stringify(overrides)}`).not.toBe(0);
      expect(r.stderr).toContain("violates check constraint");
    }
  });

  test("accepts a valid fresh open row", async () => {
    const r = await execExpectFail(insertRowSql({ source_id: q("src-valid-1") }));
    expect(r.code, r.stderr).toBe(0);
  });

  test("rejects a negative money field, allows NULL", async () => {
    const bad = await execExpectFail(
      insertRowSql({ source_id: q("src-money-1"), labor: "-1" }),
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("violates check constraint");

    const okNull = await execExpectFail(insertRowSql({ source_id: q("src-money-2") }));
    expect(okNull.code, okNull.stderr).toBe(0);

    const okZero = await execExpectFail(
      insertRowSql({ source_id: q("src-money-3"), actual_cash_submitted: "0" }),
    );
    expect(okZero.code, okZero.stderr).toBe(0);
  });

  test("rejects other_note longer than 1000 characters", async () => {
    const tooLong = "a".repeat(1001);
    const r = await execExpectFail(
      insertRowSql({ source_id: q("src-note-1"), other_note: q(tooLong) }),
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("violates check constraint");
  });

  test("rejects an unknown edited_fields entry", async () => {
    const r = await execExpectFail(
      insertRowSql({ source_id: q("src-edited-1"), edited_fields: "ARRAY['not_a_real_field']" }),
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("violates check constraint");
  });

  // ── Lifecycle consistency ───────────────────────────────────────────────────

  test("lifecycle CHECK rejects an open row with a closing lease or terminal fields set", async () => {
    const withLease = await execExpectFail(
      insertRowSql({
        source_id: q("src-life-1"),
        closing_started_at: "now()",
      }),
    );
    expect(withLease.code).not.toBe(0);
    expect(withLease.stderr).toContain("manual_white_sheet_sessions_lifecycle_consistency");

    const withTerminal = await execExpectFail(
      insertRowSql({
        source_id: q("src-life-2"),
        closed_at: "now()",
        closed_line_event_id: q("evt-x"),
      }),
    );
    expect(withTerminal.code).not.toBe(0);
    expect(withTerminal.stderr).toContain("manual_white_sheet_sessions_lifecycle_consistency");
  });

  test("lifecycle CHECK rejects closing without a lease timestamp, and closed without terminal fields", async () => {
    const closingNoLease = await execExpectFail(
      insertRowSql({ source_id: q("src-life-3"), status: q("closing") }),
    );
    expect(closingNoLease.code).not.toBe(0);

    const closedNoTerminal = await execExpectFail(
      insertRowSql({ source_id: q("src-life-4"), status: q("closed") }),
    );
    expect(closedNoTerminal.code).not.toBe(0);
  });

  test("the exact single-statement transitions the service issues satisfy the lifecycle CHECK", async () => {
    // open -> closing (claim), in one statement, closing_started_at set together with status.
    await exec(insertRowSql({ source_id: q("src-life-5") }));
    const claim = await execExpectFail(
      `UPDATE public.manual_white_sheet_sessions
         SET status = 'closing', closing_started_at = now()
       WHERE source_id = ${q("src-life-5")} AND status = 'open'`,
    );
    expect(claim.code, claim.stderr).toBe(0);

    // closing -> closed (finalizeClosed): lease cleared + terminal fields set together.
    const finalize = await execExpectFail(
      `UPDATE public.manual_white_sheet_sessions
         SET status = 'closed', closing_started_at = NULL,
             closed_at = now(), closed_line_event_id = ${q("evt-fin")}
       WHERE source_id = ${q("src-life-5")} AND status = 'closing'`,
    );
    expect(finalize.code, finalize.stderr).toBe(0);

    // closed -> open (reopenExisting): lease + terminal fields cleared together.
    const reopen = await execExpectFail(
      `UPDATE public.manual_white_sheet_sessions
         SET status = 'open', closing_started_at = NULL,
             closed_at = NULL, closed_line_event_id = NULL, edited_fields = '{}'
       WHERE source_id = ${q("src-life-5")} AND status IN ('closed', 'cancelled')`,
    );
    expect(reopen.code, reopen.stderr).toBe(0);

    // open -> closing -> open (revertToOpen): lease cleared with status.
    await exec(
      `UPDATE public.manual_white_sheet_sessions
         SET status = 'closing', closing_started_at = now()
       WHERE source_id = ${q("src-life-5")} AND status = 'open'`,
    );
    const revert = await execExpectFail(
      `UPDATE public.manual_white_sheet_sessions
         SET status = 'open', closing_started_at = NULL
       WHERE source_id = ${q("src-life-5")} AND status = 'closing'`,
    );
    expect(revert.code, revert.stderr).toBe(0);
  });

  // ── Unique constraints ──────────────────────────────────────────────────────

  test("canonical identity unique constraint rejects a duplicate (source, market, date)", async () => {
    await exec(insertRowSql({ source_id: q("src-uniq-1"), status: q("cancelled"), closed_at: "now()", closed_line_event_id: q("e1") }));
    const dup = await execExpectFail(
      insertRowSql({ source_id: q("src-uniq-1"), status: q("cancelled"), closed_at: "now()", closed_line_event_id: q("e2") }),
    );
    expect(dup.code).not.toBe(0);
    expect(dup.stderr).toContain("duplicate key value violates unique constraint");
  });

  test("partial unique index allows at most one open/closing row per source, but multiple terminal rows", async () => {
    await exec(insertRowSql({ source_id: q("src-uniq-2"), market_label: q("A"), market_label_normalized: q("A") }));
    const secondOpen = await execExpectFail(
      insertRowSql({ source_id: q("src-uniq-2"), market_label: q("B"), market_label_normalized: q("B") }),
    );
    expect(secondOpen.code).not.toBe(0);
    expect(secondOpen.stderr).toContain("manual_white_sheet_sessions_one_open_per_source");

    // A second row for the same source is fine once the first is terminal.
    await exec(
      `UPDATE public.manual_white_sheet_sessions
         SET status = 'cancelled', closed_at = now(), closed_line_event_id = ${q("e-term")}
       WHERE source_id = ${q("src-uniq-2")} AND market_label_normalized = ${q("A")}`,
    );
    const secondNow = await execExpectFail(
      insertRowSql({ source_id: q("src-uniq-2"), market_label: q("B"), market_label_normalized: q("B") }),
    );
    expect(secondNow.code, secondNow.stderr).toBe(0);
  });

  // ── Grants / RLS ─────────────────────────────────────────────────────────────

  test("explicit table grants: only service_role has SELECT/INSERT/UPDATE, nobody has DELETE/TRUNCATE", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        const has = await scalar(
          `SELECT has_table_privilege('${role}', 'public.manual_white_sheet_sessions', '${priv}')::text`,
        );
        expect(has, `${role} should not have ${priv}`).toBe("false");
      }
    }
    for (const priv of ["SELECT", "INSERT", "UPDATE"]) {
      const has = await scalar(
        `SELECT has_table_privilege('service_role', 'public.manual_white_sheet_sessions', '${priv}')::text`,
      );
      expect(has, `service_role should have ${priv}`).toBe("true");
    }
    for (const priv of ["DELETE", "TRUNCATE"]) {
      const has = await scalar(
        `SELECT has_table_privilege('service_role', 'public.manual_white_sheet_sessions', '${priv}')::text`,
      );
      expect(has, `service_role should NOT have ${priv}`).toBe("false");
    }
  });

  test("anon/authenticated real SELECT/INSERT/UPDATE/DELETE/TRUNCATE attempts are all denied", async () => {
    for (const role of ["anon", "authenticated"]) {
      const sel = await execAsRoleExpectFail(role, `SELECT * FROM public.manual_white_sheet_sessions LIMIT 1`);
      expect(sel.code).not.toBe(0);
      expect(sel.stderr).toContain("permission denied");

      const ins = await execAsRoleExpectFail(role, insertRowSql({ source_id: q(`src-${role}-x`) }));
      expect(ins.code).not.toBe(0);
      expect(ins.stderr).toContain("permission denied");

      const upd = await execAsRoleExpectFail(
        role,
        `UPDATE public.manual_white_sheet_sessions SET market_label = 'x' WHERE true`,
      );
      expect(upd.code).not.toBe(0);
      expect(upd.stderr).toContain("permission denied");

      const del = await execAsRoleExpectFail(role, `DELETE FROM public.manual_white_sheet_sessions`);
      expect(del.code).not.toBe(0);
      expect(del.stderr).toContain("permission denied");

      const trunc = await execAsRoleExpectFail(role, `TRUNCATE public.manual_white_sheet_sessions`);
      expect(trunc.code).not.toBe(0);
      expect(trunc.stderr).toContain("permission denied");
    }
  });

  test("service_role can SELECT/INSERT/UPDATE but DELETE/TRUNCATE are denied even for service_role", async () => {
    const ins = await execAsRoleExpectFail("service_role", insertRowSql({ source_id: q("src-svc-1") }));
    expect(ins.code, ins.stderr).toBe(0);

    const sel = await scalarAsRole(
      "service_role",
      `SELECT count(*)::text FROM public.manual_white_sheet_sessions WHERE source_id = ${q("src-svc-1")}`,
    );
    expect(sel).toBe("1");

    const upd = await execAsRoleExpectFail(
      "service_role",
      `UPDATE public.manual_white_sheet_sessions SET market_label = 'updated' WHERE source_id = ${q("src-svc-1")}`,
    );
    expect(upd.code, upd.stderr).toBe(0);

    const del = await execAsRoleExpectFail(
      "service_role",
      `DELETE FROM public.manual_white_sheet_sessions WHERE source_id = ${q("src-svc-1")}`,
    );
    expect(del.code).not.toBe(0);
    expect(del.stderr).toContain("permission denied");

    const trunc = await execAsRoleExpectFail("service_role", `TRUNCATE public.manual_white_sheet_sessions`);
    expect(trunc.code).not.toBe(0);
    expect(trunc.stderr).toContain("permission denied");
  });

  test("RLS is enabled with zero policies", async () => {
    const rls = await scalar(
      `SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.manual_white_sheet_sessions'::regclass`,
    );
    expect(rls).toBe("true");
    const policyCount = await scalar(
      `SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'manual_white_sheet_sessions'`,
    );
    expect(policyCount).toBe("0");
  });

  test("claim function: EXECUTE is service_role-only", async () => {
    for (const role of ["anon", "authenticated"]) {
      const has = await scalar(
        `SELECT has_function_privilege('${role}', 'public.claim_manual_white_sheet_session_close(text,integer)', 'EXECUTE')::text`,
      );
      expect(has, `${role} should not have EXECUTE`).toBe("false");
    }
    const svc = await scalar(
      `SELECT has_function_privilege('service_role', 'public.claim_manual_white_sheet_session_close(text,integer)', 'EXECUTE')::text`,
    );
    expect(svc).toBe("true");
  });

  // ── Closing lease: claim / stale reclaim / concurrency ──────────────────────

  test("claims an open session, and a fresh second claim on the same source cannot steal it", async () => {
    await exec(insertRowSql({ source_id: q("src-lease-1") }));
    const first = await scalar(
      `SELECT public.claim_manual_white_sheet_session_close(${q("src-lease-1")}, 120)::text`,
    );
    expect(JSON.parse(first).claimed).toBe(true);

    const second = await scalar(
      `SELECT public.claim_manual_white_sheet_session_close(${q("src-lease-1")}, 120)::text`,
    );
    const secondParsed = JSON.parse(second);
    expect(secondParsed.claimed).toBe(false);
    expect(secondParsed.reason).toBe("closing_in_progress");
  });

  test("a stale closing lease is atomically reclaimed after expiry (process-death recovery)", async () => {
    await exec(insertRowSql({ source_id: q("src-lease-2") }));
    await exec(
      `UPDATE public.manual_white_sheet_sessions
         SET status = 'closing', closing_started_at = now() - interval '999 seconds'
       WHERE source_id = ${q("src-lease-2")}`,
    );
    const claim = await scalar(
      `SELECT public.claim_manual_white_sheet_session_close(${q("src-lease-2")}, 120)::text`,
    );
    const parsed = JSON.parse(claim);
    expect(parsed.claimed).toBe(true);
  });

  test("claim on a source with no open/closing row returns not_found", async () => {
    const claim = await scalar(
      `SELECT public.claim_manual_white_sheet_session_close(${q("src-lease-missing")}, 120)::text`,
    );
    expect(JSON.parse(claim).claimed).toBe(false);
    expect(JSON.parse(claim).reason).toBe("not_found");
  });

  test("REAL concurrency: two simultaneous claims on the same source, exactly one wins", async () => {
    await exec(insertRowSql({ source_id: q("src-lease-conc-1") }));
    const sql = `SELECT public.claim_manual_white_sheet_session_close(${q("src-lease-conc-1")}, 120)`;
    const [a, b] = await concurrent(sql, sql);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const ra = JSON.parse(a.stdout.trim());
    const rb = JSON.parse(b.stdout.trim());
    const claimedCount = [ra, rb].filter((r) => r.claimed === true).length;
    expect(claimedCount).toBe(1);

    // Exactly one row remains, now 'closing', with a lease timestamp.
    const status = await scalar(
      `SELECT status FROM public.manual_white_sheet_sessions WHERE source_id = ${q("src-lease-conc-1")}`,
    );
    expect(status).toBe("closing");
  });

  test("REAL concurrency: two simultaneous opens for the same identity, exactly one wins (partial unique index)", async () => {
    const sourceId = "src-open-conc-1";
    const sql = insertRowSql({ source_id: q(sourceId) });
    const [a, b] = await concurrent(sql, sql);
    const codes = [a.code, b.code].sort();
    expect(codes).toEqual([0, 1]);
    const count = await scalar(
      `SELECT count(*)::text FROM public.manual_white_sheet_sessions WHERE source_id = ${q(sourceId)}`,
    );
    expect(count).toBe("1");
  });
});

afterAll(async () => {
  if (!databaseCreated || !/^mwss_0059_[a-f0-9]+$/.test(DATABASE)) return;
  await psql("postgres", [
    "-c",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid()`,
  ]);
  await psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DATABASE}`]);
}, 60_000);

if (!pgAvailable) {
  describe("0059 PostgreSQL 17 unavailable", () => {
    test.skip("requires local PostgreSQL 17", () => {});
  });
}
