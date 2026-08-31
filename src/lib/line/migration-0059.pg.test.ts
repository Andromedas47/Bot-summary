/**
 * Real PostgreSQL 17 proof for migration 0059: manual_white_sheet_note_sessions
 * and the close_manual_white_sheet_note_session atomic close RPC. Uses one
 * disposable local database and never connects to Production.
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
const DB_NAME_PATTERN = /^wsn_0059_[a-f0-9]+$/;
const DATABASE = `wsn_0059_${randomBytes(4).toString("hex")}`;

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
      "migration-0059.pg.test.ts creates/drops a disposable database and requires " +
        "ALLOW_DISPOSABLE_POSTGRES_TESTS=1 to run. Refusing to proceed.",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) {
    throw new Error(
      `migration-0059.pg.test.ts refuses to run against PGHOST="${PGHOST}". ` +
        `Only ${[...ALLOWED_HOSTS].join(", ")} are permitted, to guarantee this never touches Production.`,
    );
  }
  if (!DB_NAME_PATTERN.test(DATABASE)) {
    throw new Error(`refusing to operate on database name "${DATABASE}": does not match ${DB_NAME_PATTERN}`);
  }
}
const BOOTSTRAP = join(ROOT, "supabase", "tests", "manual_white_sheet_note_sessions_0059_bootstrap.sql");
// Only 0038 (creates digital_white_sheet_cash_entries) and 0043 (adds the
// finalized_at/finalized_by columns the RPC checks) are needed as
// dependencies — 0045 bundles unrelated goals (central pricing tables this
// harness doesn't create) alongside the FINALIZED CHECK/RPCs this test
// doesn't exercise (it sets finalized_at directly via raw SQL instead).
const MIGRATIONS = [
  "0038_digital_white_sheet_cash_entries.sql",
  "0043_white_sheet_lifecycle.sql",
  "20260801092255_manual_white_sheet_note_sessions.sql",
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

async function concurrent(sqlA: string, sqlB: string): Promise<[string, string]> {
  const [a, b] = await Promise.all([scalar(sqlA), scalar(sqlB)]);
  return [a, b];
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

// The dedicated `bun run test:pg:0059` command sets WSN_0059_REQUIRE=1 and
// must never silently skip — a plain `bun test` run keeps the normal
// repo-wide skip behavior when opted out or when PostgreSQL isn't reachable.
if (!pgAvailable && process.env.WSN_0059_REQUIRE === "1") {
  throw new Error(
    "WSN_0059_REQUIRE=1 but the PostgreSQL 17 harness is unavailable. " +
      "Ensure ALLOW_DISPOSABLE_POSTGRES_TESTS=1, PGHOST is an allowed host " +
      `(${[...ALLOWED_HOSTS].join(", ")}), and PostgreSQL 17 is reachable.`,
  );
}

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

describe.skipIf(!pgAvailable)("0059 manual_white_sheet_note_sessions on real PostgreSQL 17", () => {
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

  test("blank identity fields are rejected", async () => {
    await execExpectFail(insertSessionSql({ source_id: "''" }));
    await execExpectFail(insertSessionSql({ market_label: "''" }));
  });

  test("negative money is rejected", async () => {
    await execExpectFail(insertSessionSql({ source_id: "'S-neg'", labor: "-1" }));
  });

  test("lifecycle CHECK rejects an open row with a closed_at timestamp", async () => {
    await execExpectFail(insertSessionSql({ source_id: "'S-lc1'", closed_at: "now()" }));
  });

  test("lifecycle CHECK rejects a closed row without closed_at/closed_line_event_id", async () => {
    await execExpectFail(
      insertSessionSql({ source_id: "'S-lc2'", status: "'closed'" }),
    );
  });

  test("lifecycle CHECK allows a valid closed row", async () => {
    const id = await insertSession({
      source_id: "'S-lc3'",
      status: "'closed'",
      closed_at: "now()",
      closed_line_event_id: "'evt-x'",
    });
    expect(id.length).toBeGreaterThan(0);
  });

  test("one open session per source — partial unique index", async () => {
    await insertSession({ source_id: "'S-onetime'" });
    await execExpectFail(insertSessionSql({ source_id: "'S-onetime'" }));
    expect(
      await scalar(`SELECT count(*) FROM public.manual_white_sheet_note_sessions WHERE source_id = 'S-onetime' AND status = 'open'`),
    ).toBe("1");
  });

  // ── RPC basic behavior ──────────────────────────────────────────────────────

  test("close inserts a new canonical row, defaulting untouched fields to 0", async () => {
    const id = await insertSession({ source_id: "'S-new'", labor: "500", actual_cash: "4850" });
    const result = json(await scalar(closeRpcSql(id, "S-new")));
    expect(result.outcome).toBe("closed");
    expect(
      await scalar(`SELECT labor || ',' || location_fee || ',' || actual_cash_submitted FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-new'`),
    ).toBe("500.00,0.00,4850.00");
  });

  test("close on the same identity updates the existing row instead of duplicating", async () => {
    const id1 = await insertSession({ source_id: "'S-upd'", labor: "500", actual_cash: "100" });
    await scalar(closeRpcSql(id1, "S-upd"));
    const id2 = await insertSession({ source_id: "'S-upd'", labor: "900", actual_cash: "200" });
    await scalar(closeRpcSql(id2, "S-upd"));
    expect(await scalar(`SELECT count(*) FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-upd'`)).toBe("1");
    expect(await scalar(`SELECT labor FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-upd'`)).toBe("900.00");
  });

  test("close preserves fields the session never touched", async () => {
    const id1 = await insertSession({ source_id: "'S-preserve'", labor: "500", location_fee: "200", actual_cash: "100" });
    await scalar(closeRpcSql(id1, "S-preserve"));
    const id2 = await insertSession({ source_id: "'S-preserve'", labor: "0" }); // only labor entered, explicit zero
    await scalar(closeRpcSql(id2, "S-preserve"));
    expect(
      await scalar(`SELECT labor || ',' || location_fee || ',' || actual_cash_submitted FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-preserve'`),
    ).toBe("0.00,200.00,100.00");
  });

  test("close rejects an empty session without mutating anything", async () => {
    const id = await insertSession({ source_id: "'S-empty'" });
    const result = json(await scalar(closeRpcSql(id, "S-empty")));
    expect(result.outcome).toBe("empty");
    expect(await scalar(`SELECT status FROM public.manual_white_sheet_note_sessions WHERE id = '${id}'`)).toBe("open");
  });

  test("closing an already-closed session reports already_closed and does not rewrite canonical data", async () => {
    const id = await insertSession({ source_id: "'S-again'", labor: "500", actual_cash: "1" });
    await scalar(closeRpcSql(id, "S-again"));
    const result = json(await scalar(closeRpcSql(id, "S-again")));
    expect(result.outcome).toBe("already_closed");
    expect(await scalar(`SELECT count(*) FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-again'`)).toBe("1");
  });

  test("closing a cancelled session reports already_cancelled", async () => {
    const id = await insertSession({ source_id: "'S-cancelled'" });
    await exec(`UPDATE public.manual_white_sheet_note_sessions SET status = 'cancelled', closed_at = now(), closed_line_event_id = 'evt-cancel' WHERE id = '${id}'`);
    const result = json(await scalar(closeRpcSql(id, "S-cancelled")));
    expect(result.outcome).toBe("already_cancelled");
  });

  test("close on an unknown session id reports not_found", async () => {
    const result = json(await scalar(closeRpcSql("00000000-0000-0000-0000-000000000000", "S-none")));
    expect(result.outcome).toBe("not_found");
  });

  // ── FINALIZED rejection + rollback (item 7 / P0 case 7) ─────────────────────

  test("a FINALIZED canonical row rejects the close transaction and the session stays open", async () => {
    const id = await insertSession({ source_id: "'S-final'", labor: "500", actual_cash: "1" });
    await scalar(closeRpcSql(id, "S-final"));
    await exec(`UPDATE public.digital_white_sheet_cash_entries SET finalized_at = now(), finalized_by = 'admin-1' WHERE source_id = 'S-final'`);

    const id2 = await insertSession({ source_id: "'S-final'", labor: "999", actual_cash: "1" });
    const result = json(await scalar(closeRpcSql(id2, "S-final")));

    expect(result.outcome).toBe("finalized");
    expect(await scalar(`SELECT status FROM public.manual_white_sheet_note_sessions WHERE id = '${id2}'`)).toBe("open");
    expect(await scalar(`SELECT labor FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-final'`)).toBe("500.00");
  });

  // ── Grants / RLS ─────────────────────────────────────────────────────────────

  test("table grants: anon/authenticated have none, service_role has SELECT/INSERT/UPDATE only", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(
          await scalar(`SELECT has_table_privilege('${role}', 'public.manual_white_sheet_note_sessions', '${priv}')`),
        ).toBe("f");
      }
    }
    for (const priv of ["SELECT", "INSERT", "UPDATE"]) {
      expect(
        await scalar(`SELECT has_table_privilege('service_role', 'public.manual_white_sheet_note_sessions', '${priv}')`),
      ).toBe("t");
    }
    expect(await scalar(`SELECT has_table_privilege('service_role', 'public.manual_white_sheet_note_sessions', 'DELETE')`)).toBe("f");
  });

  test("function grants: only service_role can execute close_manual_white_sheet_note_session", async () => {
    const signature = "public.close_manual_white_sheet_note_session(uuid,text,text,text)";
    for (const role of ["anon", "authenticated"]) {
      expect(await scalar(`SELECT has_function_privilege('${role}', '${signature}', 'EXECUTE')`)).toBe("f");
    }
    expect(await scalar(`SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')`)).toBe("t");
  });

  test("RLS is enabled with zero policies", async () => {
    expect(await scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.manual_white_sheet_note_sessions'::regclass`)).toBe("t");
    expect(await scalar(`SELECT count(*) FROM pg_policies WHERE tablename = 'manual_white_sheet_note_sessions'`)).toBe("0");
  });

  // ── Real concurrency ─────────────────────────────────────────────────────────

  test("concurrent open: exactly one open row survives for the same source", async () => {
    const sqlA = insertSessionSql({ source_id: "'S-race-open'", market_label: "'A'" });
    const sqlB = insertSessionSql({ source_id: "'S-race-open'", market_label: "'B'" });
    const results = await Promise.allSettled([
      psql(["-v", "ON_ERROR_STOP=1", "-tAc", sqlA]),
      psql(["-v", "ON_ERROR_STOP=1", "-tAc", sqlB]),
    ]);
    const codes = results.map((r) => (r.status === "fulfilled" ? r.value.code : -1)).sort();
    expect(codes).toEqual([0, 1].sort() as number[]);
    expect(
      await scalar(`SELECT count(*) FROM public.manual_white_sheet_note_sessions WHERE source_id = 'S-race-open' AND status = 'open'`),
    ).toBe("1");
  }, 20_000);

  test("concurrent field-update vs close: consistent outcome, never a false success", async () => {
    const id = await insertSession({ source_id: "'S-race-field'", actual_cash: "100" });
    const fieldSql = `WITH upd AS (UPDATE public.manual_white_sheet_note_sessions SET labor = 900 WHERE id = '${id}'::uuid AND source_id = 'S-race-field' AND status = 'open' RETURNING id) SELECT count(*) FROM upd`;
    const [fieldRowCount, closeResult] = await concurrent(fieldSql, closeRpcSql(id, "S-race-field"));

    const fieldSucceeded = fieldRowCount === "1";
    const outcome = json(closeResult).outcome;
    expect(outcome).toBe("closed");
    const canonicalLabor = await scalar(`SELECT labor FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-race-field'`);
    if (fieldSucceeded) {
      expect(canonicalLabor).toBe("900.00");
    } else {
      // Close won the row lock first — the field UPDATE matched 0 open rows.
      // This is the real-LINE failure mode when webhook events interleave.
      expect(canonicalLabor).toBe("0.00");
    }
  }, 20_000);

  test("close-before-field (out-of-order webhooks): field UPDATE is lost from canonical", async () => {
    // Deterministic proof — no sleep. Models two LINE webhook deliveries where
    // จบใบขาวมือ is processed before an earlier field event finishes (or is
    // delivered later). Ordered delivery is NOT guaranteed across concurrent
    // serverless invocations; the durable ordering queue (0060) is the safe path.
    const id = await insertSession({ source_id: "'S-close-first'", actual_cash: "100" });
    await scalar(closeRpcSql(id, "S-close-first"));
    const fieldCount = await scalar(
      `WITH upd AS (
         UPDATE public.manual_white_sheet_note_sessions
            SET labor = 900
          WHERE id = '${id}'::uuid AND source_id = 'S-close-first' AND status = 'open'
      RETURNING id
       ) SELECT count(*) FROM upd`,
    );
    expect(fieldCount).toBe("0");
    expect(
      await scalar(`SELECT labor FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-close-first'`),
    ).toBe("0.00");
    expect(
      await scalar(`SELECT status FROM public.manual_white_sheet_note_sessions WHERE id = '${id}'::uuid`),
    ).toBe("closed");
  });

  test("concurrent close vs cancel: exactly one terminal state, canonical row only when close wins", async () => {
    const id = await insertSession({ source_id: "'S-race-close-cancel'", actual_cash: "1" });
    const cancelSql = `UPDATE public.manual_white_sheet_note_sessions SET status = 'cancelled', closed_at = now(), closed_line_event_id = 'evt-cancel' WHERE id = '${id}'::uuid AND source_id = 'S-race-close-cancel' AND status = 'open' RETURNING id`;
    await concurrent(closeRpcSql(id, "S-race-close-cancel"), cancelSql);

    const finalStatus = await scalar(`SELECT status FROM public.manual_white_sheet_note_sessions WHERE id = '${id}'::uuid`);
    expect(["closed", "cancelled"]).toContain(finalStatus);
    const cashCount = await scalar(`SELECT count(*) FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-race-close-cancel'`);
    expect(cashCount).toBe(finalStatus === "closed" ? "1" : "0");
  }, 20_000);

  test("a concurrent external writer on the same canonical row survives the LINE close", async () => {
    // Only one session can be open per source_id, so two concurrent LINE
    // closes can never target the same canonical identity — the realistic
    // race is the RPC vs any other writer touching that exact row (e.g. a
    // Website/admin edit). Seed the row via a first close, then race the
    // RPC (editing labor) against a raw concurrent UPDATE (editing
    // location_fee) on that same identity.
    const seedId = await insertSession({ source_id: "'S-writer'", market_label_normalized: "'ตลาดกลาง'", actual_cash: "1" });
    await scalar(closeRpcSql(seedId, "S-writer"));

    const closeId = await insertSession({ source_id: "'S-writer'", market_label_normalized: "'ตลาดกลาง'", labor: "111" });
    const externalUpdateSql =
      `UPDATE public.digital_white_sheet_cash_entries SET location_fee = 222 ` +
      `WHERE source_id = 'S-writer' AND market_label_normalized = 'ตลาดกลาง' RETURNING id`;

    await concurrent(closeRpcSql(closeId, "S-writer"), externalUpdateSql);

    expect(
      await scalar(`SELECT count(*) FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-writer'`),
    ).toBe("1");
    expect(
      await scalar(`SELECT labor || ',' || location_fee FROM public.digital_white_sheet_cash_entries WHERE source_id = 'S-writer'`),
    ).toBe("111.00,222.00");
  }, 20_000);
});

if (!pgAvailable) {
  describe("0059 note-session PostgreSQL 17 unavailable", () => {
    test.skip("requires local PostgreSQL 17", () => {});
  });
}
