/** Real PostgreSQL 17 proof for the P4A produce entry validation gate. */
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
const DATABASE = `p4a_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^p4a_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const ROUND = "11111111-1111-4111-8111-111111111111";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const GENERATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GENERATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GENERATION_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GENERATION_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GENERATION_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GENERATION_F = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-p4a.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };
async function psql(
  args: string[],
  database = DATABASE,
  stdin?: string,
): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    // Thai labels are part of what this proves, and a Windows psql defaults to
    // the console codepage — without this they arrive as question marks.
    env: {
      ...process.env,
      PGHOST, PGUSER, PGPASSWORD, PGPORT,
      PGDATABASE: database,
      PGCLIENTENCODING: "UTF8",
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

/**
 * SQL goes in over stdin, never as an argv string: Thai labels are part of what
 * this file proves, and a Windows console argv cannot carry them intact.
 */
function run(sql: string): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
}

async function scalar(sql: string): Promise<string> {
  const result = await run(sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/** Runs SQL that is expected to fail, and returns the error text. */
async function expectFailure(sql: string): Promise<string> {
  const result = await run(sql);
  expect(result.code, `expected failure but succeeded:\n${sql}`).not.toBe(0);
  return `${result.stderr}${result.stdout}`;
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_P4A_POSTGRES === "1") {
  throw new Error("REQUIRE_P4A_POSTGRES=1 but the PostgreSQL 17 harness is unavailable");
}

const EXCEPTIONS = `'[{"kind":"price_not_withdrawn","enteredPrice":120,"withdrawnPrices":[100]}]'::jsonb`;

async function record(
  digest: string,
  eventId: string,
  options: { round?: string | null; generation?: string; sessionKey?: string } = {},
): Promise<{ confirmed: boolean; presented_line_event_id: string }> {
  const round = options.round === undefined ? `'${ROUND}'::uuid` : options.round === null ? "NULL" : `'${options.round}'::uuid`;
  return JSON.parse(await scalar(`
    SELECT public.record_produce_validation_review(
      '${options.sessionKey ?? "group:G-round"}', '${options.generation ?? GENERATION_A}'::uuid,
      ${round}, '${digest}',
      DATE '2026-08-09', 'วัดทุ่งลานนา', 'กี้', ${EXCEPTIONS}, 'U-typist', '${eventId}'
    )`));
}

async function confirm(
  digest: string,
  eventId: string,
  actor = "U-typist",
  generation = GENERATION_A,
  sessionKey = "group:G-round",
): Promise<{ status: string }> {
  return JSON.parse(await scalar(`
    SELECT public.confirm_produce_validation_review(
      '${sessionKey}', '${generation}'::uuid, '${digest}', '${actor}', '${eventId}'
    )`));
}

describe.skipIf(!pgAvailable)("P4A produce entry validation gate on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "p4a_produce_entry_validation_bootstrap.sql"));
    await apply(
      join(ROOT, "supabase", "migrations", "20260810090000_p4a_produce_entry_validation_gate.sql"),
    );
    await apply(
      join(ROOT, "supabase", "migrations", "20260810110909_p4a_review_session_generation_uuid.sql"),
    );
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("recording a review is idempotent on the exception set", async () => {
    const first = await record(DIGEST_A, "E1");
    expect(first).toMatchObject({ confirmed: false, presented_line_event_id: "E1" });

    const replay = await record(DIGEST_A, "E1");
    expect(replay).toMatchObject({ confirmed: false, presented_line_event_id: "E1" });

    expect(await scalar(`
      SELECT count(*) FROM public.produce_entry_validation_reviews
      WHERE validation_digest = '${DIGEST_A}'`)).toBe("1");
    expect(await scalar(`
      SELECT confirmed_at IS NULL FROM public.produce_entry_validation_reviews
      WHERE validation_digest = '${DIGEST_A}'`)).toBe("t");
  });

  test("a later press does not overwrite who was shown the exceptions", async () => {
    const second = await record(DIGEST_A, "E2");
    expect(second.presented_line_event_id).toBe("E1");
  });

  test("the presenting event cannot confirm its own review", async () => {
    expect(await confirm(DIGEST_A, "E1")).toMatchObject({ status: "same_event" });
    expect(await scalar(`
      SELECT confirmed_at IS NULL FROM public.produce_entry_validation_reviews
      WHERE validation_digest = '${DIGEST_A}'`)).toBe("t");
  });

  test("a second distinct event confirms once and replays idempotently", async () => {
    expect(await confirm(DIGEST_A, "E2")).toMatchObject({ status: "confirmed" });
    expect(await confirm(DIGEST_A, "E2")).toMatchObject({ status: "already_confirmed" });
    expect(await confirm(DIGEST_A, "E9")).toMatchObject({ status: "already_confirmed" });

    const row = JSON.parse(await scalar(`
      SELECT to_jsonb(r) FROM public.produce_entry_validation_reviews r
      WHERE validation_digest = '${DIGEST_A}'`));
    expect(row.confirmed_by_line_user_id).toBe("U-typist");
    expect(row.confirmed_line_event_id).toBe("E2");
    expect(row.accountability_round_id).toBe(ROUND);
    expect(row.session_generation).toBe(GENERATION_A);
    expect(row.presented_at).toBeTruthy();
    expect(row.confirmed_at).toBeTruthy();
    expect(Date.parse(row.confirmed_at)).toBeGreaterThanOrEqual(Date.parse(row.presented_at));
    expect(row.exceptions[0].enteredPrice).toBe(120);
    // Seller and data-entry actor stay distinguishable.
    expect(row.staff_label).toBe("กี้");
    expect(row.presented_by_line_user_id).toBe("U-typist");
  });

  test("recording after confirmation reports the confirmation, and never resets it", async () => {
    const replay = await record(DIGEST_A, "E3");
    expect(replay.confirmed).toBe(true);
    expect(await scalar(`
      SELECT confirmed_line_event_id FROM public.produce_entry_validation_reviews
      WHERE validation_digest = '${DIGEST_A}'`)).toBe("E2");
  });

  test("a confirmation never carries over to a different exception set", async () => {
    expect(await confirm(DIGEST_B, "E4")).toMatchObject({ status: "not_found" });
    await record(DIGEST_B, "E4");
    expect(await scalar(`
      SELECT confirmed_at IS NULL FROM public.produce_entry_validation_reviews
      WHERE validation_digest = '${DIGEST_B}'`)).toBe("t");
  });

  test("the same digest in another generation is a separate review", async () => {
    await record(DIGEST_A, "E5", { generation: GENERATION_B });
    expect(await scalar(`
      SELECT count(*) FROM public.produce_entry_validation_reviews
      WHERE validation_digest = '${DIGEST_A}'`)).toBe("2");
    expect(await scalar(`
      SELECT confirmed_at IS NULL FROM public.produce_entry_validation_reviews
      WHERE validation_digest = '${DIGEST_A}'
        AND session_generation = '${GENERATION_B}'::uuid`)).toBe("t");
  });

  test("guided and plain-text UUID generations share the same audit contract", async () => {
    const guided = await record("9".repeat(64), "G1", {
      generation: GENERATION_C,
      sessionKey: "group:G-round:user:guided",
    });
    expect(guided.confirmed).toBe(false);
    expect(await confirm(
      "9".repeat(64), "G2", "U-typist", GENERATION_C,
      "group:G-round:user:guided",
    )).toMatchObject({ status: "confirmed" });
  });

  test("the audit is append-only", async () => {
    expect(await expectFailure(`
      DELETE FROM public.produce_entry_validation_reviews WHERE validation_digest = '${DIGEST_B}'`))
      .toContain("append-only");

    expect(await expectFailure(`
      UPDATE public.produce_entry_validation_reviews SET exceptions = '[]'::jsonb
      WHERE validation_digest = '${DIGEST_B}'`))
      .toContain("only the confirmation columns");

    expect(await expectFailure(`
      UPDATE public.produce_entry_validation_reviews
      SET confirmed_at = NULL, confirmed_by_line_user_id = NULL, confirmed_line_event_id = NULL
      WHERE validation_digest = '${DIGEST_A}'
        AND session_generation = '${GENERATION_A}'::uuid`))
      .toContain("immutable");
  });

  test("a bound review cannot name a round that does not exist", async () => {
    expect(await expectFailure(`
      SELECT public.record_produce_validation_review(
        'group:G-round', '${GENERATION_D}'::uuid,
        '33333333-3333-4333-8333-333333333333'::uuid, '${"c".repeat(64)}',
        DATE '2026-08-09', 'm', 's', ${EXCEPTIONS}, 'U-typist', 'E6')`))
      .toContain("foreign key");
  });

  test("a legacy unbound session may still be audited", async () => {
    const unbound = await record("d".repeat(64), "E7", {
      round: null,
      generation: GENERATION_D,
    });
    expect(unbound.confirmed).toBe(false);
    expect(await scalar(`
      SELECT accountability_round_id IS NULL FROM public.produce_entry_validation_reviews
      WHERE validation_digest = '${"d".repeat(64)}'`)).toBe("t");
  });

  test("a malformed digest or an empty exception list is rejected", async () => {
    expect(await expectFailure(`
      SELECT public.record_produce_validation_review(
        'group:G-round', '${GENERATION_E}'::uuid, '${ROUND}'::uuid, 'not-a-digest',
        DATE '2026-08-09', 'm', 's', ${EXCEPTIONS}, 'U-typist', 'E8')`))
      .toContain("validation_digest_check");

    expect(await expectFailure(`
      SELECT public.record_produce_validation_review(
        'group:G-round', '${GENERATION_F}'::uuid, '${ROUND}'::uuid, '${"e".repeat(64)}',
        DATE '2026-08-09', 'm', 's', '[]'::jsonb, 'U-typist', 'E8')`))
      .toContain("exceptions_check");
  });

  test("review attempts preserve entered price and never touch accounting data", async () => {
    expect(await scalar("SELECT count(*) FROM public.produce_sessions")).toBe("1");
    expect(await scalar("SELECT count(*) FROM public.produce_items")).toBe("1");
    expect(await scalar("SELECT price_per_unit FROM public.produce_items")).toBe("120.00");
    expect(await scalar("SELECT marker FROM public.inventory_movements")).toBe("inventory-unchanged");
    expect(await scalar("SELECT marker FROM public.inventory_cost_movements")).toBe("cost-unchanged");
    expect(await scalar("SELECT marker FROM public.profitability_snapshots")).toBe("p3-unchanged");
  });

  test("the UUID RPCs remain service-role only", async () => {

    expect(await scalar(`
      SELECT relrowsecurity FROM pg_class
      WHERE oid = 'public.produce_entry_validation_reviews'::regclass`)).toBe("t");
    expect(await scalar(`
      SELECT count(*) FROM pg_policies
      WHERE tablename = 'produce_entry_validation_reviews'`)).toBe("0");

    for (const role of ["anon", "authenticated"]) {
      expect(await scalar(`
        SELECT count(*) FROM information_schema.role_table_grants
        WHERE table_name = 'produce_entry_validation_reviews' AND grantee = '${role}'`)).toBe("0");
      expect(await scalar(`
        SELECT has_function_privilege('${role}',
          'public.confirm_produce_validation_review(text,uuid,text,text,text)', 'EXECUTE')`)).toBe("f");
    }
    expect(await scalar(`
      SELECT string_agg(privilege_type, ',' ORDER BY privilege_type)
      FROM information_schema.role_table_grants
      WHERE table_name = 'produce_entry_validation_reviews' AND grantee = 'service_role'`)).toBe("SELECT");
    expect(await scalar(`
      SELECT has_function_privilege('service_role',
        'public.confirm_produce_validation_review(text,uuid,text,text,text)', 'EXECUTE')`)).toBe("t");
  });

  test("the audit and both RPC identities use UUID, with no bigint overload left", async () => {
    expect(await scalar(`
      SELECT format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid = 'public.produce_entry_validation_reviews'::regclass
        AND attname = 'session_generation' AND NOT attisdropped`)).toBe("uuid");
    expect(await scalar(`
      SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('record_produce_validation_review', 'confirm_produce_validation_review')
        AND pg_get_function_identity_arguments(oid) LIKE '%p_session_generation uuid%'`)).toBe("2");
    expect(await scalar(`
      SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('record_produce_validation_review', 'confirm_produce_validation_review')
        AND pg_get_function_identity_arguments(oid) LIKE '%p_session_generation bigint%'`)).toBe("0");
  });

  test("both writers pin their search_path", async () => {
    expect(await scalar(`
      SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN (
          'record_produce_validation_review', 'confirm_produce_validation_review',
          'produce_entry_validation_forbid_delete', 'produce_entry_validation_guard_update')
        AND prosecdef
        AND array_to_string(proconfig, ',') LIKE '%search_path=pg_catalog, public%'`)).toBe("4");
  });
});

describe.skipIf(pgAvailable)("P4A PostgreSQL harness", () => {
  test("skipped without a disposable PostgreSQL 17 instance", () => {
    expect(pgAvailable).toBe(false);
  });
});
