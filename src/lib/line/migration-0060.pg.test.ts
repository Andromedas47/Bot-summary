/**
 * Real PostgreSQL 17 proof for migration 0060:
 * submit_manual_white_sheet_note_all_in_one. Disposable local DB only.
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
const DB_NAME_PATTERN = /^wsn_0060_[a-f0-9]+$/;
const DATABASE = `wsn_0060_${randomBytes(4).toString("hex")}`;

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
if (process.env.GITHUB_ACTIONS === "true" && process.env.WSN_0060_CI_PGHOST) {
  ALLOWED_HOSTS.add(process.env.WSN_0060_CI_PGHOST);
}

function assertSafeToRunAgainstDatabase(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-0060.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1. Refusing.",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) {
    throw new Error(
      `migration-0060.pg.test.ts refuses PGHOST="${PGHOST}". Only ${[...ALLOWED_HOSTS].join(", ")} permitted.`,
    );
  }
  if (!DB_NAME_PATTERN.test(DATABASE)) {
    throw new Error(`refusing database name "${DATABASE}"`);
  }
}

const BOOTSTRAP = join(ROOT, "supabase", "tests", "manual_white_sheet_note_sessions_0059_bootstrap.sql");
const MIGRATIONS = [
  "0038_digital_white_sheet_cash_entries.sql",
  "0043_white_sheet_lifecycle.sql",
  "0059_manual_white_sheet_note_sessions.sql",
  "0060_manual_white_sheet_note_all_in_one.sql",
].map((name) => join(ROOT, "supabase", "migrations", name));

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(args: string[]): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: DATABASE },
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
  const lines = result.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[0] ?? "";
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  try {
    const result = await Bun.spawn([PSQL, "-X", "-tAc", "SHOW server_version_num"], {
      env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: "postgres" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(result.stdout).text();
    const code = await result.exited;
    return code === 0 && Number(stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

const pgAvailable = await probe();
let databaseCreated = false;

if (!pgAvailable && process.env.WSN_0060_REQUIRE === "1") {
  throw new Error(
    "WSN_0060_REQUIRE=1 but PostgreSQL 17 harness unavailable.",
  );
}

function allInOneSql(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    p_source_id: "'S-aio'",
    p_market_label: "'ตลาดกี้'",
    p_market_label_normalized: "'ตลาดกี้'",
    p_business_date: "date '2026-08-01'",
    p_labor: "500",
    p_location_fee: "200",
    p_bag: "100",
    p_snack: "50",
    p_other_amount: "30",
    p_other_note: "(chr(3588)||chr(3656)||chr(3634)||chr(3609)||chr(3657)||chr(3635))",
    p_actual_cash: "4850",
    p_opened_by_line_user_id: "NULL",
    p_opened_line_event_id: "'evt-aio'",
    p_closed_by_line_user_id: "NULL",
    p_closed_line_event_id: "'evt-aio'",
  };
  const p = { ...defaults, ...overrides };
  return `SELECT public.submit_manual_white_sheet_note_all_in_one(
    ${p.p_source_id}, ${p.p_market_label}, ${p.p_market_label_normalized}, ${p.p_business_date},
    ${p.p_labor}, ${p.p_location_fee}, ${p.p_bag}, ${p.p_snack}, ${p.p_other_amount}, ${p.p_other_note}, ${p.p_actual_cash},
    ${p.p_opened_by_line_user_id}, ${p.p_opened_line_event_id}, ${p.p_closed_by_line_user_id}, ${p.p_closed_line_event_id}
  )`;
}

function json(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe.skipIf(!pgAvailable)("0060 submit_manual_white_sheet_note_all_in_one on real PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafeToRunAgainstDatabase();
    const created = await psql(["-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`]);
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(BOOTSTRAP);
    for (const migration of MIGRATIONS) await apply(migration);
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated || !DB_NAME_PATTERN.test(DATABASE)) return;
    await psql(["-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", "postgres", "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid()`]);
    await psql(["-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`]);
  }, 60_000);

  test("happy path: one closed session, one canonical row, exact values, no open left", async () => {
    const result = json(await scalar(allInOneSql({ p_source_id: "'S-happy'" })));
    expect(result.outcome).toBe("closed");
    expect(await scalar(`SELECT count(*) FROM public.manual_white_sheet_note_sessions WHERE source_id = 'S-happy' AND status = 'open'`)).toBe("0");
    expect(await scalar(`SELECT count(*) FROM public.manual_white_sheet_note_sessions WHERE source_id = 'S-happy' AND status = 'closed'`)).toBe("1");
    expect(await scalar(`SELECT count(*) FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-happy'`)).toBe("1");
    expect(await scalar(`SELECT labor::text FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-happy'`)).toBe("500.00");
    expect(await scalar(`SELECT actual_cash_submitted::text FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-happy'`)).toBe("4850.00");
    expect(await scalar(`SELECT other::text FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-happy'`)).toBe("30.00");
    expect(await scalar(
      `SELECT encode(convert_to(other_note, 'UTF8'), 'hex') FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-happy'`,
    )).toBe(
      await scalar(
        `SELECT encode(convert_to(chr(3588)||chr(3656)||chr(3634)||chr(3609)||chr(3657)||chr(3635), 'UTF8'), 'hex')`,
      ),
    );
  });

  test("duplicate closed_line_event_id is idempotent", async () => {
    await scalar(allInOneSql({
      p_source_id: "'S-idem'",
      p_opened_line_event_id: "'evt-idem'",
      p_closed_line_event_id: "'evt-idem'",
    }));
    const second = json(await scalar(allInOneSql({
      p_source_id: "'S-idem'",
      p_opened_line_event_id: "'evt-idem'",
      p_closed_line_event_id: "'evt-idem'",
      p_labor: "999",
    })));
    expect(second.outcome).toBe("already_closed");
    expect(await scalar(`SELECT count(*) FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-idem'`)).toBe("1");
    expect(await scalar(`SELECT labor::text FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-idem'`)).toBe("500.00");
  });

  test("correction preserves omitted canonical fields", async () => {
    await scalar(allInOneSql({ p_source_id: "'S-corr'" }));
    const corr = json(await scalar(allInOneSql({
      p_source_id: "'S-corr'",
      p_labor: "NULL",
      p_location_fee: "NULL",
      p_bag: "NULL",
      p_snack: "NULL",
      p_other_amount: "NULL",
      p_other_note: "NULL",
      p_actual_cash: "9999",
      p_opened_line_event_id: "'evt-corr-2'",
      p_closed_line_event_id: "'evt-corr-2'",
    })));
    expect(corr.outcome).toBe("closed");
    expect(await scalar(`SELECT labor::text FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-corr'`)).toBe("500.00");
    expect(await scalar(`SELECT actual_cash_submitted::text FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-corr'`)).toBe("9999.00");
    expect(await scalar(`SELECT count(*) FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-corr'`)).toBe("1");
  });

  test("FINALIZED rejects without mutating", async () => {
    await scalar(allInOneSql({ p_source_id: "'S-fin'", p_opened_line_event_id: "'e1'", p_closed_line_event_id: "'e1'" }));
    await scalar(`UPDATE public.digital_white_sheet_cash_entries SET finalized_at = now() WHERE source_id = 'S-fin'`);
    const rejected = json(await scalar(allInOneSql({
      p_source_id: "'S-fin'",
      p_labor: "777",
      p_opened_line_event_id: "'e2'",
      p_closed_line_event_id: "'e2'",
    })));
    expect(rejected.outcome).toBe("finalized");
    expect(await scalar(`SELECT labor::text FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-fin'`)).toBe("500.00");
    expect(await scalar(`SELECT count(*) FROM public.manual_white_sheet_note_sessions WHERE source_id = 'S-fin' AND status = 'closed'`)).toBe("1");
  });

  test("open_conflict when a different identity session is open", async () => {
    await scalar(`INSERT INTO public.manual_white_sheet_note_sessions (
      source_id, market_label, market_label_normalized, business_date, status, opened_line_event_id
    ) VALUES ('S-conflict', 'อื่น', 'อื่น', date '2026-08-02', 'open', 'evt-open')`);
    const result = json(await scalar(allInOneSql({ p_source_id: "'S-conflict'" })));
    expect(result.outcome).toBe("open_conflict");
    expect(await scalar(`SELECT count(*) FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-conflict'`)).toBe("0");
    expect(await scalar(`SELECT status FROM public.manual_white_sheet_note_sessions WHERE source_id = 'S-conflict'`)).toBe("open");
  });

  test("function grants: only service_role", async () => {
    const signature = "public.submit_manual_white_sheet_note_all_in_one(text,text,text,date,numeric,numeric,numeric,numeric,numeric,text,numeric,text,text,text,text)";
    for (const role of ["anon", "authenticated"]) {
      expect(await scalar(`SELECT has_function_privilege('${role}', '${signature}', 'EXECUTE')`)).toBe("f");
    }
    expect(await scalar(`SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')`)).toBe("t");
  });
});
