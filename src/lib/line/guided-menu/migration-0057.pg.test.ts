/**
 * Real PostgreSQL 17 proof for 0057's source-wide Guided Menu owner lock.
 * Uses one disposable local database and never connects to Production.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `gm_0057_${randomBytes(4).toString("hex")}`;
const BOOTSTRAP = join(ROOT, "supabase", "tests", "produce_0049_bootstrap.sql");
const MIGRATIONS = ["0048_pending_session_function_parity.sql", "0049_produce_structured_session_foundation.sql", "20260730093019_atomic_guided_owner.sql"]
  .map((name) => join(ROOT, "supabase", "migrations", name));

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(database: string, args: string[]): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: database,
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

async function scalar(database: string, sql: string): Promise<string> {
  const result = await psql(database, ["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code !== 0) {
    throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  }
  return result.stdout.trim();
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

const pgAvailable = await probe();
let databaseCreated = false;
let oldRpcBefore0057 = "";
let oldRpcAfter0057 = "";

function openSql(input: {
  user: string;
  source: string;
  market: string;
  date: string;
  event: string;
  guided?: boolean;
  expectedGeneration?: string | null;
}): string {
  const sessionKey = `group:${input.source}:user:${input.user}`;
  const args = [
    `'${sessionKey}'`,
    "'group'",
    `'${input.source}'`,
    `'${input.user}'`,
    `'${input.event}'`,
    "1785294000000",
    "1",
    `date '${input.date}'`,
    "'10:00'",
    "'line_event'",
    "'seller'",
    `'${input.market}'`,
    ...(input.guided === false ? [] : [`'${input.market}'`]),
    "'main'",
    "U&'\\0E40\\0E1A\\0E34\\0E01'",
    "NULL",
    "NULL",
    input.expectedGeneration ? `'${input.expectedGeneration}'::uuid` : "NULL",
    "'structured_menu'",
  ];
  const rpc = input.guided === false
    ? "open_or_rotate_produce_structured_session"
    : "open_or_rotate_guided_produce_structured_session";
  return `SELECT public.${rpc}(${args.join(",")})::text`;
}

function json(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe.skipIf(!pgAvailable)("0057 atomic Guided Menu owner on PostgreSQL 17", () => {
  beforeAll(async () => {
    const created = await psql("postgres", ["-c", `CREATE DATABASE ${DATABASE}`]);
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(BOOTSTRAP);
    await apply(MIGRATIONS[0]!);
    await apply(MIGRATIONS[1]!);
    oldRpcBefore0057 = await scalar(
      DATABASE,
      "SELECT pg_get_functiondef('public.open_or_rotate_produce_structured_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,uuid,text)'::regprocedure)",
    );
    await apply(MIGRATIONS[2]!);
    oldRpcAfter0057 = await scalar(
      DATABASE,
      "SELECT pg_get_functiondef('public.open_or_rotate_produce_structured_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,uuid,text)'::regprocedure)",
    );
    await scalar(
      DATABASE,
      `CREATE FUNCTION public.gm_0057_delay_insert() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.market_label = 'race-market' THEN PERFORM pg_sleep(0.5); END IF;
         RETURN NEW;
       END
       $$;
       CREATE TRIGGER gm_0057_delay_insert
       BEFORE INSERT ON public.pending_sessions
       FOR EACH ROW EXECUTE FUNCTION public.gm_0057_delay_insert()`,
    );
  }, 60_000);

  test("two concurrent operators serialize on the tuple and exactly one writes", async () => {
    const base = {
      source: "G-race",
      market: "race-market",
      date: "2026-07-29",
      guided: true,
    };
    const [a, b] = await Promise.all([
      scalar(DATABASE, openSql({ ...base, user: "U-a", event: "evt-race-a" })),
      scalar(DATABASE, openSql({ ...base, user: "U-b", event: "evt-race-b" })),
    ]);
    const outcomes = [json(a), json(b)];

    expect(outcomes.map((value) => value.outcome).sort()).toEqual([
      "opened",
      "ownership_conflict",
    ]);
    expect(
      outcomes.find((value) => value.outcome === "ownership_conflict")?.reason,
    ).toBe("other_operator");
    expect(
      await scalar(
        DATABASE,
        `SELECT count(*) FROM public.pending_sessions
         WHERE source_id = 'G-race' AND business_date = '2026-07-29'
           AND market_label = 'race-market'`,
      ),
    ).toBe("1");
  }, 20_000);

  test("same operator same event is idempotent and keeps one generation", async () => {
    const input = {
      user: "U-retry",
      source: "G-retry",
      market: "retry-market",
      date: "2026-07-29",
      event: "evt-retry",
    };
    const first = json(await scalar(DATABASE, openSql(input)));
    const second = json(await scalar(DATABASE, openSql(input)));

    expect(first.outcome).toBe("opened");
    expect(second.outcome).toBe("idempotent");
    expect(second.session_generation).toBe(first.session_generation);
    expect(
      await scalar(
        DATABASE,
        "SELECT count(*) FROM public.pending_sessions WHERE source_id = 'G-retry'",
      ),
    ).toBe("1");
  });

  test("later date, different market and different source remain independent", async () => {
    const base = {
      user: "U-scope-a",
      source: "G-scope",
      market: "scope-market",
      date: "2026-07-29",
      event: "evt-scope-base",
    };
    expect(json(await scalar(DATABASE, openSql(base))).outcome).toBe("opened");

    for (const input of [
      { ...base, user: "U-date", date: "2026-07-30", event: "evt-scope-date" },
      { ...base, user: "U-market", market: "other-market", event: "evt-scope-market" },
      { ...base, user: "U-source", source: "G-other", event: "evt-scope-source" },
    ]) {
      expect(json(await scalar(DATABASE, openSql(input))).outcome).toBe("opened");
    }
  });

  test("ambiguous pre-existing owners refuse with zero extra rows", async () => {
    const base = {
      source: "G-ambiguous",
      market: "ambiguous-market",
      date: "2026-07-29",
      guided: false,
    };
    expect(
      json(await scalar(DATABASE, openSql({ ...base, user: "U-a", event: "evt-amb-a" }))).outcome,
    ).toBe("opened");
    expect(
      json(await scalar(DATABASE, openSql({ ...base, user: "U-b", event: "evt-amb-b" }))).outcome,
    ).toBe("opened");
    const before = await scalar(
      DATABASE,
      "SELECT count(*) FROM public.pending_sessions WHERE source_id = 'G-ambiguous'",
    );
    const refused = json(
      await scalar(
        DATABASE,
        openSql({ ...base, guided: true, user: "U-c", event: "evt-amb-c" }),
      ),
    );

    expect(refused).toMatchObject({
      outcome: "ownership_conflict",
      reason: "ambiguous",
    });
    expect(
      await scalar(
        DATABASE,
        "SELECT count(*) FROM public.pending_sessions WHERE source_id = 'G-ambiguous'",
      ),
    ).toBe(before);
  });

  test("optimistic generation refusal is delegated unchanged", async () => {
    const input = {
      user: "U-generation",
      source: "G-generation",
      market: "generation-market",
      date: "2026-07-29",
      event: "evt-generation-1",
    };
    const opened = json(await scalar(DATABASE, openSql(input)));
    const refused = json(
      await scalar(
        DATABASE,
        openSql({
          ...input,
          event: "evt-generation-2",
          expectedGeneration: "00000000-0000-0000-0000-000000000001",
        }),
      ),
    );

    expect(refused).toMatchObject({
      outcome: "generation_conflict",
      reason: "stale_generation",
      session_generation: opened.session_generation,
    });
  });

  test("0057 leaves the old open RPC byte-for-byte unchanged and callable", async () => {
    expect(oldRpcAfter0057).toBe(oldRpcBefore0057);
    const result = json(
      await scalar(
        DATABASE,
        openSql({
          user: "U-legacy",
          source: "G-legacy",
          market: "legacy-market",
          date: "2026-07-29",
          event: "evt-legacy",
          guided: false,
        }),
      ),
    );
    expect(result.outcome).toBe("opened");
  });
});

afterAll(async () => {
  if (!databaseCreated || !/^gm_0057_[a-f0-9]+$/.test(DATABASE)) return;
  await psql("postgres", [
    "-c",
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid()`,
  ]);
  await psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DATABASE}`]);
}, 60_000);

if (!pgAvailable) {
  describe("0057 PostgreSQL 17 unavailable", () => {
    test.skip("requires local PostgreSQL 17", () => {});
  });
}
