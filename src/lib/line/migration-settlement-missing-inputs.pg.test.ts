/**
 * Real PostgreSQL 17 proof for migration 20260825092000
 * (settlement_missing_inputs): the white_sheet_sales/owner_cash columns, and
 * the six new *_entered provenance columns on digital_white_sheet_cash_entries
 * that fix the "never-entered read back as a submitted 0" bug (see the
 * module doc in src/lib/settlement/daily-financial-settlement.ts). Modeled
 * on migration-0059.pg.test.ts. Uses one disposable local database and never
 * connects to Production.
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
const DB_NAME_PATTERN = /^wsn_smi_[a-f0-9]+$/;
const DATABASE = `wsn_smi_${randomBytes(4).toString("hex")}`;

// Disposable-DB safety guard: this harness runs CREATE DATABASE / DROP
// DATABASE, so it must never trust an inherited PGHOST/credentials blindly —
// require explicit opt-in and restrict which hosts are ever touched.
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
if (process.env.GITHUB_ACTIONS === "true" && process.env.WSN_0059_CI_PGHOST) {
  ALLOWED_HOSTS.add(process.env.WSN_0059_CI_PGHOST);
}

function assertSafeToRunAgainstDatabase(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-settlement-missing-inputs.pg.test.ts creates/drops a disposable database and requires " +
        "ALLOW_DISPOSABLE_POSTGRES_TESTS=1 to run. Refusing to proceed.",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) {
    throw new Error(
      `migration-settlement-missing-inputs.pg.test.ts refuses to run against PGHOST="${PGHOST}". ` +
        `Only ${[...ALLOWED_HOSTS].join(", ")} are permitted, to guarantee this never touches Production.`,
    );
  }
  if (!DB_NAME_PATTERN.test(DATABASE)) {
    throw new Error(`refusing to operate on database name "${DATABASE}": does not match ${DB_NAME_PATTERN}`);
  }
}

const BOOTSTRAP = join(ROOT, "supabase", "tests", "manual_white_sheet_note_sessions_0059_bootstrap.sql");
// Same dependency set as migration-0059.pg.test.ts (0038 creates
// digital_white_sheet_cash_entries, 0043 adds finalized_at/finalized_by),
// plus 0059 itself (creates manual_white_sheet_note_sessions and the first
// version of the close RPC) — this migration ALTERs both tables and
// CREATE OR REPLACEs that same RPC, so it cannot be applied standalone.
const MIGRATIONS = [
  "0038_digital_white_sheet_cash_entries.sql",
  "0043_white_sheet_lifecycle.sql",
  "0059_manual_white_sheet_note_sessions.sql",
  "20260825092000_settlement_missing_inputs.sql",
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

async function exec(sql: string): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-c", sql]);
}

async function execExpectFail(sql: string): Promise<PsqlResult> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-c", sql]);
  expect(result.code, `expected failure but succeeded:\n${sql}`).not.toBe(0);
  return result;
}

/**
 * Returns the first non-empty stdout line. -tAc still prints the command
 * completion tag (e.g. "INSERT 0 1") on its own line AFTER RETURNING's
 * tuple output even with -t, so the data is always the first line, not
 * the last.
 */
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

function insertSessionSql(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    source_id: "'S-default'",
    market_label: "'ตลาด'",
    market_label_normalized: "'ตลาด'",
    business_date: "date '2026-08-01'",
    opened_line_event_id: "'evt-open'",
  };
  const cols = { ...defaults, ...overrides };
  const names = Object.keys(cols).join(", ");
  const values = Object.values(cols).join(", ");
  return `INSERT INTO public.manual_white_sheet_note_sessions (${names}) VALUES (${values}) RETURNING id`;
}

async function insertSession(overrides: Record<string, string> = {}): Promise<string> {
  return scalar(insertSessionSql(overrides));
}

function closeRpcSql(sessionId: string, sourceId: string, eventId = "evt-close"): string {
  return `SELECT public.close_manual_white_sheet_note_session('${sessionId}'::uuid, '${sourceId}', NULL, '${eventId}')`;
}

function json(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

async function cashRow(sourceId: string, columns: string): Promise<string> {
  return scalar(
    `SELECT ${columns} FROM public.digital_white_sheet_cash_entries WHERE source_id = '${sourceId}'`,
  );
}

describe.skipIf(!pgAvailable)("20260825092000 settlement_missing_inputs on real PostgreSQL 17", () => {
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

  // ── Schema invariants ───────────────────────────────────────────────────────

  test("white_sheet_sales/owner_cash nonneg CHECK constraints reject negative values", async () => {
    await execExpectFail(insertSessionSql({ source_id: "'S-neg-wss'", white_sheet_sales: "-1" }));
    await execExpectFail(insertSessionSql({ source_id: "'S-neg-oc'", owner_cash: "-1" }));
  });

  test("*_entered columns default to true (pre-existing/other-path rows are treated as fully entered)", async () => {
    // Models a row written by a path other than the ใบขาวมือ RPC (e.g. the
    // "digital" saveWhiteSheetCashEntry path in persist.ts, which always
    // supplies real values) — a raw INSERT that never mentions the new
    // columns at all must default every *_entered flag to true.
    await exec(
      `INSERT INTO public.digital_white_sheet_cash_entries (source_id, market_label_normalized, business_date, actual_cash_submitted)
       VALUES ('S-other-path', 'ตลาด', date '2026-08-01', 500)`,
    );
    expect(
      await cashRow(
        "S-other-path",
        "labor_entered || ',' || location_fee_entered || ',' || bag_entered || ',' || snack_entered || ',' || other_entered || ',' || actual_cash_submitted_entered",
      ),
    ).toBe("true,true,true,true,true,true");
  });

  // ── The bug scenario: partial close never reads back as a submitted 0 ──────

  test("BUG FIX: close with only white_sheet_sales/owner_cash entered leaves the other six *_entered flags false", async () => {
    // Exact reviewer scenario: operator sends only ยอดขาย + เงินให้เจ้า, then
    // types จบใบขาวมือ — never sending actual cash, labor, or any expense
    // field. The RPC still succeeds (partial close is intentional — see
    // hasAnyValue in white-sheet-note-session-service.ts), and the money
    // columns get COALESCEd to their placeholder 0, but the six *_entered
    // flags must record that those fields were never actually sent.
    const id = await insertSession({
      source_id: "'S-bug'",
      white_sheet_sales: "28632",
      owner_cash: "1500",
    });
    const result = json(await scalar(closeRpcSql(id, "S-bug")));
    expect(result.outcome).toBe("closed");

    expect(
      await cashRow("S-bug", "labor || ',' || location_fee || ',' || bag || ',' || snack || ',' || other || ',' || actual_cash_submitted"),
    ).toBe("0.00,0.00,0.00,0.00,0.00,0.00");
    expect(
      await cashRow(
        "S-bug",
        "labor_entered || ',' || location_fee_entered || ',' || bag_entered || ',' || snack_entered || ',' || other_entered || ',' || actual_cash_submitted_entered",
      ),
    ).toBe("false,false,false,false,false,false");
    // white_sheet_sales/owner_cash are nullable-by-design (0059/this
    // migration) — no separate *_entered flag is needed for them.
    expect(await cashRow("S-bug", "white_sheet_sales || ',' || owner_cash")).toBe("28632.00,1500.00");
  });

  test("a close with every field entered sets all six *_entered flags true", async () => {
    const id = await insertSession({
      source_id: "'S-full'",
      labor: "500",
      location_fee: "100",
      bag: "50",
      snack: "50",
      other_amount: "30",
      actual_cash: "4850",
      white_sheet_sales: "1000",
      owner_cash: "0",
    });
    const result = json(await scalar(closeRpcSql(id, "S-full")));
    expect(result.outcome).toBe("closed");
    expect(
      await cashRow(
        "S-full",
        "labor_entered || ',' || location_fee_entered || ',' || bag_entered || ',' || snack_entered || ',' || other_entered || ',' || actual_cash_submitted_entered",
      ),
    ).toBe("true,true,true,true,true,true");
  });

  test("BOUNDARY: a genuine ค่าแรง 0 (labor NOT NULL, value 0) sets labor=0 AND labor_entered=true — proves IS NOT NULL, not truthiness", async () => {
    // The case that distinguishes "operator entered 0" from "operator never
    // entered this": labor = 0 is NOT NULL, so the close must (a) not treat
    // the session as empty just because 0 is falsy, and (b) record
    // labor_entered = true, not false. A regression to a truthy/COALESCE-style
    // check would either reject this close as empty or read the 0 back as
    // never-entered — either way, this test would catch it.
    const id = await insertSession({ source_id: "'S-zero-wage'", labor: "0" });
    const result = json(await scalar(closeRpcSql(id, "S-zero-wage")));
    expect(result.outcome).toBe("closed");
    expect(await cashRow("S-zero-wage", "labor || ',' || labor_entered")).toBe("0.00,true");
  });

  // ── INSERT vs ON CONFLICT DO UPDATE, and OR-accumulation across closes ──────

  test("second close on the same identity supplying a previously-missing field flips only that flag to true", async () => {
    const id1 = await insertSession({ source_id: "'S-accum'", white_sheet_sales: "1000", owner_cash: "0" });
    await scalar(closeRpcSql(id1, "S-accum"));
    expect(
      await cashRow("S-accum", "labor_entered || ',' || actual_cash_submitted_entered"),
    ).toBe("false,false");

    // A later ใบขาวมือ session for the same identity now sends labor only.
    const id2 = await insertSession({ source_id: "'S-accum'", labor: "500" });
    await scalar(closeRpcSql(id2, "S-accum"));
    expect(await cashRow("S-accum", "labor")).toBe("500.00");
    expect(
      await cashRow("S-accum", "labor_entered || ',' || actual_cash_submitted_entered"),
    ).toBe("true,false"); // labor flipped true; actual_cash still never sent
  });

  test("OR-accumulation: an entered flag never regresses back to false on a later close that omits the field again", async () => {
    const id1 = await insertSession({ source_id: "'S-sticky'", labor: "500", white_sheet_sales: "1000", owner_cash: "0" });
    await scalar(closeRpcSql(id1, "S-sticky"));
    expect(await cashRow("S-sticky", "labor_entered")).toBe("t");

    // Second session never mentions labor again — labor_entered must stay
    // true, and the previously-entered labor value must be preserved
    // (existing CASE WHEN behavior from 0059), not reset to a placeholder.
    const id2 = await insertSession({ source_id: "'S-sticky'", actual_cash: "1" });
    await scalar(closeRpcSql(id2, "S-sticky"));
    expect(await cashRow("S-sticky", "labor || ',' || labor_entered")).toBe("500.00,true");
  });

  // ── CASE-WHEN preserve paths for white_sheet_sales/owner_cash (Task 4) ──────

  test("close preserves white_sheet_sales/owner_cash the session never touched", async () => {
    const id1 = await insertSession({ source_id: "'S-wss-preserve'", white_sheet_sales: "5000", owner_cash: "200", labor: "1" });
    await scalar(closeRpcSql(id1, "S-wss-preserve"));
    // Second session only updates labor — white_sheet_sales/owner_cash left
    // NULL on the session row — must NOT null out the previously-set values.
    const id2 = await insertSession({ source_id: "'S-wss-preserve'", labor: "2" });
    await scalar(closeRpcSql(id2, "S-wss-preserve"));
    expect(
      await cashRow("S-wss-preserve", "white_sheet_sales || ',' || owner_cash || ',' || labor"),
    ).toBe("5000.00,200.00,2.00");
  });

  test("close preserves owner_cash of exactly 0 (a genuine entered zero, not erased by a later close)", async () => {
    const id1 = await insertSession({ source_id: "'S-wss-zero'", white_sheet_sales: "100", owner_cash: "0", labor: "1" });
    await scalar(closeRpcSql(id1, "S-wss-zero"));
    const id2 = await insertSession({ source_id: "'S-wss-zero'", labor: "2" });
    await scalar(closeRpcSql(id2, "S-wss-zero"));
    expect(await cashRow("S-wss-zero", "owner_cash")).toBe("0.00");
  });

  test("a close that only sets white_sheet_sales/owner_cash never nulls out already-closed money fields", async () => {
    const id1 = await insertSession({ source_id: "'S-money-preserve'", labor: "500", actual_cash: "100" });
    await scalar(closeRpcSql(id1, "S-money-preserve"));
    const id2 = await insertSession({ source_id: "'S-money-preserve'", white_sheet_sales: "9000", owner_cash: "0" });
    await scalar(closeRpcSql(id2, "S-money-preserve"));
    expect(
      await cashRow("S-money-preserve", "labor || ',' || actual_cash_submitted || ',' || white_sheet_sales || ',' || owner_cash"),
    ).toBe("500.00,100.00,9000.00,0.00");
    // The second close never touched labor/actual_cash — their *_entered
    // flags from the first close must still hold.
    expect(
      await cashRow("S-money-preserve", "labor_entered || ',' || actual_cash_submitted_entered"),
    ).toBe("true,true");
  });

  // ── INSERT branch (fresh row) ────────────────────────────────────────────────

  test("close inserts a new canonical row with white_sheet_sales/owner_cash NULL when never sent", async () => {
    const id = await insertSession({ source_id: "'S-new-null'", labor: "500", actual_cash: "1" });
    const result = json(await scalar(closeRpcSql(id, "S-new-null")));
    expect(result.outcome).toBe("closed");
    expect(await cashRow("S-new-null", "white_sheet_sales IS NULL AND owner_cash IS NULL")).toBe("t");
  });

  // ── Idempotent re-close ──────────────────────────────────────────────────────

  test("closing an already-closed session is idempotent — no re-write of canonical data or *_entered flags", async () => {
    const id = await insertSession({ source_id: "'S-idempotent'", white_sheet_sales: "1000", owner_cash: "0" });
    const first = json(await scalar(closeRpcSql(id, "S-idempotent")));
    expect(first.outcome).toBe("closed");
    const before = await cashRow(
      "S-idempotent",
      "labor_entered || ',' || actual_cash_submitted_entered || ',' || white_sheet_sales || ',' || owner_cash",
    );
    const second = json(await scalar(closeRpcSql(id, "S-idempotent")));
    expect(second.outcome).toBe("already_closed");
    const after = await cashRow(
      "S-idempotent",
      "labor_entered || ',' || actual_cash_submitted_entered || ',' || white_sheet_sales || ',' || owner_cash",
    );
    expect(after).toBe(before);
    expect(await cashRow("S-idempotent", "count(*)")).toBe("1");
  });

  // ── Empty guard is unchanged: white_sheet_sales/owner_cash alone still count ─

  test("close rejects an empty session (all eight fields NULL) without mutating anything", async () => {
    const id = await insertSession({ source_id: "'S-empty-8'" });
    const result = json(await scalar(closeRpcSql(id, "S-empty-8")));
    expect(result.outcome).toBe("empty");
    expect(await scalar(`SELECT status FROM public.manual_white_sheet_note_sessions WHERE id = '${id}'`)).toBe("open");
  });

  test("close succeeds with ONLY white_sheet_sales sent — partial close is intentional, the gate is not tightened", async () => {
    const id = await insertSession({ source_id: "'S-wss-only'", white_sheet_sales: "1000" });
    const result = json(await scalar(closeRpcSql(id, "S-wss-only")));
    expect(result.outcome).toBe("closed");
  });
});

if (!pgAvailable) {
  describe("20260825092000 settlement_missing_inputs PostgreSQL 17 unavailable", () => {
    test.skip("requires local PostgreSQL 17", () => {});
  });
}
