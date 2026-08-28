/** Real PostgreSQL 17 proof for P4A plain-text accountability round binding. */
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
const DATABASE = `p4arb_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^p4arb_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const SESSION = "group:G-1:user:U-typist";
const OTHER_SESSION = "group:G-1:user:U-other";
const GEN_WITHDRAW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GEN_RETURN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GEN_SECOND_WITHDRAW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DATE = "2026-08-11";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-p4a-round-binding.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
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

/** SQL over stdin: Thai seller/market labels are part of what this proves. */
function run(sql: string): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
}

async function scalar(sql: string): Promise<string> {
  const result = await run(sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

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
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) {
    return false;
  }
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

interface BindOptions {
  sessionKey?: string;
  generation?: string;
  owner?: string;
  sourceId?: string;
  date?: string;
  seller?: string;
  market?: string;
  newRound?: boolean;
}

async function bind(options: BindOptions = {}): Promise<{
  outcome: string;
  accountability_round_id?: string;
}> {
  const {
    sessionKey = SESSION,
    generation = GEN_WITHDRAW,
    owner = "U-typist",
    sourceId = "G-1",
    date = DATE,
    seller = "ดำ",
    market = "ราชพฤกษ์",
    newRound = true,
  } = options;
  return JSON.parse(await scalar(`
    SELECT public.bind_plain_text_accountability_round(
      '${sessionKey}', '${generation}'::uuid, 'group', '${sourceId}', '${owner}',
      DATE '${date}', '${seller}', '${market}', '${market}', ${newRound}
    )`));
}

/** Points the operator's single pending row at a generation, as a rotation does. */
async function rotate(generation: string, sessionKey = SESSION): Promise<void> {
  await scalar(`
    UPDATE public.pending_sessions SET session_generation = '${generation}'::uuid
    WHERE session_key = '${sessionKey}' RETURNING 1`);
}

describe.skipIf(!pgAvailable)("P4A plain-text round binding on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "p4a_plain_text_round_binding_bootstrap.sql"));
    await apply(
      join(ROOT, "supabase", "migrations", "20260810100414_p4a_plain_text_round_binding.sql"),
    );
    await scalar(`
      INSERT INTO public.pending_sessions (session_key, session_generation, source_id, line_user_id)
      VALUES
        ('${SESSION}', '${GEN_WITHDRAW}'::uuid, 'G-1', 'U-typist'),
        ('${OTHER_SESSION}', gen_random_uuid(), 'G-1', 'U-other')
      RETURNING 1`);
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("a main withdrawal creates a round and binds the generation to its UUID", async () => {
    const result = await bind();
    expect(result.outcome).toBe("bound");
    expect(result.accountability_round_id).toMatch(/^[0-9a-f-]{36}$/);

    expect(await scalar(`
      SELECT accountability_round_id::text FROM public.pending_sessions
      WHERE session_key = '${SESSION}'`)).toBe(result.accountability_round_id!);
    expect(await scalar(`
      SELECT created_line_event_id FROM public.accountability_rounds
      WHERE id = '${result.accountability_round_id}'`))
      .toBe(`plaintext:${SESSION}:${GEN_WITHDRAW}`);
  });

  test("closing the same generation twice reuses one round", async () => {
    const first = await scalar("SELECT count(*)::text FROM public.accountability_rounds");
    const replay = await bind();
    expect(replay.outcome).toBe("already_bound");
    expect(await scalar("SELECT count(*)::text FROM public.accountability_rounds")).toBe(first);
  });

  test("binding writes no produce rows at all", async () => {
    expect(await scalar("SELECT count(*)::text FROM public.produce_sessions")).toBe("0");
  });

  test("a return in the next generation inherits the same round", async () => {
    const withdrawal = await scalar(`
      SELECT accountability_round_id::text FROM public.pending_sessions
      WHERE session_key = '${SESSION}'`);
    await rotate(GEN_RETURN);

    const result = await bind({ generation: GEN_RETURN, newRound: false });
    expect(result.outcome).toBe("already_bound");
    expect(result.accountability_round_id).toBe(withdrawal);
  });

  test("a damaged return inherits the very same round, not a second one", async () => {
    const before = await scalar("SELECT count(*)::text FROM public.accountability_rounds");
    const result = await bind({ generation: GEN_RETURN, newRound: false });
    expect(result.outcome).toBe("already_bound");
    expect(await scalar("SELECT count(*)::text FROM public.accountability_rounds")).toBe(before);
  });

  test("a second main withdrawal mints a DISTINCT round despite an identical description", async () => {
    const first = await scalar(`
      SELECT accountability_round_id::text FROM public.pending_sessions
      WHERE session_key = '${SESSION}'`);
    await rotate(GEN_SECOND_WITHDRAW);

    const result = await bind({ generation: GEN_SECOND_WITHDRAW });
    expect(result.outcome).toBe("bound");
    expect(result.accountability_round_id).not.toBe(first);

    // Same seller, market and business date; two separate economic cycles.
    expect(await scalar(`
      SELECT count(*)::text FROM public.accountability_rounds
      WHERE business_date = DATE '${DATE}' AND status = 'open'`)).toBe("2");
  });

  test("two open same-description rounds make an unbound return ambiguous", async () => {
    await scalar(`
      UPDATE public.pending_sessions SET accountability_round_id = NULL
      WHERE session_key = '${SESSION}' RETURNING 1`);
    const result = await bind({ generation: GEN_SECOND_WITHDRAW, newRound: false });
    expect(result.outcome).toBe("ambiguous");
    expect(await scalar(`
      SELECT coalesce(accountability_round_id::text, 'null') FROM public.pending_sessions
      WHERE session_key = '${SESSION}'`)).toBe("null");
  });

  test("discovery binds when exactly one open round matches", async () => {
    const survivor = await scalar(`
      UPDATE public.accountability_rounds SET status = 'closed', closed_at = now()
      WHERE created_line_event_id = 'plaintext:${SESSION}:${GEN_WITHDRAW}'
      RETURNING id::text`);
    expect(survivor).toMatch(/^[0-9a-f-]{36}$/);

    const result = await bind({ generation: GEN_SECOND_WITHDRAW, newRound: false });
    expect(result.outcome).toBe("bound");
    expect(result.accountability_round_id).not.toBe(survivor);
  });

  test("a closed round is never a discovery candidate", async () => {
    await scalar(`
      UPDATE public.pending_sessions SET accountability_round_id = NULL
      WHERE session_key = '${SESSION}' RETURNING 1`);
    await scalar(`
      UPDATE public.accountability_rounds SET status = 'closed', closed_at = now()
      WHERE status = 'open' RETURNING 1`);

    const result = await bind({ generation: GEN_SECOND_WITHDRAW, newRound: false });
    expect(result.outcome).toBe("no_round");
  });

  test("a return never borrows another market's round", async () => {
    await scalar(`
      INSERT INTO public.accountability_rounds (
        source_type, source_id, owner_line_user_id, business_date,
        seller_label, market_label, market_label_normalized, created_line_event_id
      ) VALUES (
        'group', 'G-1', 'U-typist', DATE '${DATE}',
        'ดำ', 'บางใหญ่', 'บางใหญ่', 'evt-other-market'
      ) RETURNING 1`);

    const result = await bind({ generation: GEN_SECOND_WITHDRAW, newRound: false });
    expect(result.outcome).toBe("no_round");
  });

  test("another operator's open round is never a candidate", async () => {
    await scalar(`
      INSERT INTO public.accountability_rounds (
        source_type, source_id, owner_line_user_id, business_date,
        seller_label, market_label, market_label_normalized, created_line_event_id
      ) VALUES (
        'group', 'G-1', 'U-other', DATE '${DATE}',
        'ดำ', 'ราชพฤกษ์', 'ราชพฤกษ์', 'evt-other-owner'
      ) RETURNING 1`);

    const result = await bind({ generation: GEN_SECOND_WITHDRAW, newRound: false });
    expect(result.outcome).toBe("no_round");
  });

  test("a generation that is not the row's current one is not found", async () => {
    const result = await bind({ generation: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    expect(result.outcome).toBe("not_found");
  });

  test("a mismatched owner is refused rather than bound", async () => {
    const result = await bind({ generation: GEN_SECOND_WITHDRAW, owner: "U-impostor" });
    expect(result.outcome).toBe("identity_mismatch");
  });

  test("another operator's legacy row keeps its NULL round throughout", async () => {
    expect(await scalar(`
      SELECT coalesce(accountability_round_id::text, 'null') FROM public.pending_sessions
      WHERE session_key = '${OTHER_SESSION}'`)).toBe("null");
  });

  test("the RPC is service_role only", async () => {
    expect(await scalar(`
      SELECT has_function_privilege(
        'anon',
        'public.bind_plain_text_accountability_round(text,uuid,text,text,text,date,text,text,text,boolean)',
        'EXECUTE'
      )::text`)).toBe("false");
    expect(await scalar(`
      SELECT has_function_privilege(
        'authenticated',
        'public.bind_plain_text_accountability_round(text,uuid,text,text,text,date,text,text,text,boolean)',
        'EXECUTE'
      )::text`)).toBe("false");
    expect(await scalar(`
      SELECT has_function_privilege(
        'service_role',
        'public.bind_plain_text_accountability_round(text,uuid,text,text,text,date,text,text,text,boolean)',
        'EXECUTE'
      )::text`)).toBe("true");
  });

  test("it is SECURITY DEFINER with a pinned search_path", async () => {
    expect(await scalar(`
      SELECT prosecdef::text FROM pg_proc
      WHERE proname = 'bind_plain_text_accountability_round'`)).toBe("true");
    expect(await scalar(`
      SELECT array_to_string(proconfig, ',') FROM pg_proc
      WHERE proname = 'bind_plain_text_accountability_round'`))
      .toBe("search_path=public, extensions, pg_temp");
  });

  test("a blank identity is rejected outright", async () => {
    const error = await expectFailure(`
      SELECT public.bind_plain_text_accountability_round(
        '${SESSION}', '${GEN_SECOND_WITHDRAW}'::uuid, 'group', 'G-1', '  ',
        DATE '${DATE}', 'ดำ', 'ราชพฤกษ์', 'ราชพฤกษ์', true
      )`);
    expect(error).toContain("invalid plain-text round binding identity");
  });
});
