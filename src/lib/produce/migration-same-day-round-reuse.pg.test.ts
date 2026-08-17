/**
 * PostgreSQL 17 proof for same-day plain `เบิก` round continuation (P0-A).
 *
 * Production 2026-08-16, seller มิ้น, market ทรัพย์พัน: one withdrawal round was
 * entered as two plain `เบิก` documents — 3 durian rows, then 13 dry-good rows —
 * and became two populated accountability rounds, because `p_is_new_round` went
 * straight to INSERT. The evening `ชั่งคืน` then had two masters to choose from.
 *
 * These tests are the regression for that, plus proof that the PR #53 market
 * identity guard, the PR #50 cross-user continuation contract and the explicit
 * `เบิกเพิ่ม` append are all still intact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `mig_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^mig_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const DATE = "2026-08-16";
const OTHER_DATE = "2026-08-15";
const SELLER = "มิ้น";
const OTHER_SELLER = "เมย์";
const MARKET = "ทรัพย์พัน";
/** Reviewed catalog: one market, three spellings. */
const CANONICAL = "พาซิโอ้";
const ALIAS_SI = "พาซีโอ้";
const ALIAS_SO = "พาสิโอ้";
/** Reviewed markets the catalog deliberately keeps apart. */
const PASEO_VEG = "พาซิโอ้ผัก";
const PASEO_FRUIT = "พาซิโอ้ผลไม้";
const OTHER_MARKET = "วัดทุ่งลานนา";

const OWNER = "U3f04f748584d997819dec0fc71a9b084";
const OTHER_ACTOR = "U02be00ed60d743aa3736c20fa9f69220";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-same-day-round-reuse.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

function spawnPsql(args: string[], database: string, stdin?: string) {
  return Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: database,
      PGCLIENTENCODING: "UTF8",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collect(proc: ReturnType<typeof spawnPsql>): Promise<PsqlResult> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  return collect(spawnPsql(args, database, stdin));
}

function run(sql: string): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
}

async function scalar(sql: string): Promise<string> {
  const result = await run(sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
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

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

let sequence = 1;
function nextUuid(): string {
  return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
}

/** A fresh LINE source per test, so no case can see another's rounds. */
function nextSource(): string {
  return `C${randomBytes(8).toString("hex")}`;
}

interface RoundOptions {
  sourceId: string;
  owner?: string;
  date?: string;
  seller?: string;
  market?: string;
  status?: "open" | "closed" | "cancelled";
  /** false seeds a round holding nothing — the failed-attempt leftover. */
  withdrawal?: boolean;
  id?: string;
}

async function seedRound(options: RoundOptions): Promise<string> {
  const id = options.id ?? nextUuid();
  const status = options.status ?? "open";
  const market = options.market ?? MARKET;
  await scalar(`
    INSERT INTO public.accountability_rounds (
      id, source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized, status,
      created_line_event_id, closed_at
    ) VALUES (
      ${q(id)}::uuid, 'group', ${q(options.sourceId)}, ${q(options.owner ?? OWNER)},
      DATE ${q(options.date ?? DATE)},
      ${q(options.seller ?? SELLER)}, ${q(market)}, ${q(market)}, ${q(status)},
      ${q(`event:${id}`)}, ${status === "open" ? "NULL" : "now()"}
    ) RETURNING 1`);
  if (options.withdrawal !== false) {
    await scalar(`
      INSERT INTO public.produce_transactions (accountability_round_id, base_transaction_type)
      VALUES (${q(id)}::uuid, 'เบิก') RETURNING 1`);
  }
  return id;
}

interface BindOptions {
  sourceId: string;
  actor?: string;
  key?: string;
  generation?: string;
  date?: string;
  seller?: string;
  market?: string;
  isNewRound?: boolean;
}

type BindResult = {
  outcome: string;
  reused?: boolean;
  accountability_round_id?: string;
  market_label?: string;
};

async function seedPending(options: BindOptions) {
  const actor = options.actor ?? OWNER;
  const generation = options.generation ?? nextUuid();
  const key = options.key ?? `group:${options.sourceId}:user:${actor}:${generation}`;
  await scalar(`
    INSERT INTO public.pending_sessions (
      session_key, session_generation, source_id, line_user_id
    ) VALUES (
      ${q(key)}, ${q(generation)}::uuid, ${q(options.sourceId)}, ${q(actor)}
    ) RETURNING 1`);
  return { key, generation, actor };
}

function bindSql(
  options: BindOptions & { key: string; generation: string; actor: string },
): string {
  const market = options.market ?? MARKET;
  return `SELECT public.bind_plain_text_accountability_round(
      ${q(options.key)}, ${q(options.generation)}::uuid, 'group',
      ${q(options.sourceId)}, ${q(options.actor)}, DATE ${q(options.date ?? DATE)},
      ${q(options.seller ?? SELLER)}, ${q(market)}, ${q(market)},
      ${options.isNewRound !== false}
    )`;
}

async function bind(options: BindOptions): Promise<BindResult> {
  const pending = await seedPending(options);
  return JSON.parse(await scalar(bindSql({ ...options, ...pending })));
}

async function openRoundCount(sourceId: string): Promise<number> {
  return Number(await scalar(`
    SELECT count(*)::text FROM public.accountability_rounds
    WHERE source_id = ${q(sourceId)} AND status = 'open'`));
}

async function roundCount(sourceId: string): Promise<number> {
  return Number(await scalar(`
    SELECT count(*)::text FROM public.accountability_rounds
    WHERE source_id = ${q(sourceId)}`));
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_ROUND_REUSE_POSTGRES === "1") {
  throw new Error("REQUIRE_ROUND_REUSE_POSTGRES=1 but the PostgreSQL 17 harness is unavailable");
}

describe.skipIf(!pgAvailable)("same-day plain เบิก round reuse on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "round_market_identity_bootstrap.sql"));
    await scalar(`
      CREATE TABLE public.produce_transactions (
        accountability_round_id uuid NOT NULL REFERENCES public.accountability_rounds(id),
        base_transaction_type text NOT NULL
      );
      SELECT 1`);
    await apply(join(ROOT, "supabase", "migrations", "20260810120000_p4a_plain_text_round_binding.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260811090000_round_market_identity_consistency.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260814100000_cross_user_accountability_round_binding.sql"));
    await scalar(`
      INSERT INTO public.line_guided_menu_markets (market_code, label) VALUES
        ('wat_thung_lanna', 'วัดทุ่งลานนา'),
        ('paseo_vegetable', 'พาซิโอ้ผัก'),
        ('paseo_fruit', 'พาซิโอ้ผลไม้');
      INSERT INTO public.line_guided_menu_market_aliases (alias_label, market_code) VALUES
        ('ทุ่งลานนา', 'wat_thung_lanna');
      SELECT 1`);
    await apply(join(ROOT, "supabase", "migrations", "20260815160000_produce_market_identity_guard.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260817090000_produce_same_day_round_reuse.sql"));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  // ── The Production incident ────────────────────────────────────────────────

  test("CASE 1 — the same sender's second plain เบิก joins the first round", async () => {
    const source = nextSource();
    const first = await bind({ sourceId: source });
    expect(first.outcome).toBe("bound");
    expect(first.reused).toBe(false);
    // The first document's withdrawal lands, making its round the master.
    await scalar(`
      INSERT INTO public.produce_transactions (accountability_round_id, base_transaction_type)
      VALUES (${q(first.accountability_round_id!)}::uuid, 'เบิก') RETURNING 1`);

    const second = await bind({ sourceId: source });
    expect(second.outcome).toBe("bound");
    expect(second.reused).toBe(true);
    expect(second.accountability_round_id).toBe(first.accountability_round_id!);
    expect(await openRoundCount(source)).toBe(1);
  });

  test("CASE 2 — a different LINE sender in the same source joins it too", async () => {
    const source = nextSource();
    const existing = await seedRound({ sourceId: source });
    const second = await bind({ sourceId: source, actor: OTHER_ACTOR });
    expect(second.outcome).toBe("bound");
    expect(second.reused).toBe(true);
    expect(second.accountability_round_id).toBe(existing);
    expect(await openRoundCount(source)).toBe(1);
  });

  // ── Reviewed market identity (PR #53) is what decides "same market" ────────

  test("CASE 3 — พาซีโอ้ then พาซิโอ้ is one round", async () => {
    const source = nextSource();
    const existing = await seedRound({ sourceId: source, market: ALIAS_SI });
    const second = await bind({ sourceId: source, market: CANONICAL });
    expect(second.outcome).toBe("bound");
    expect(second.accountability_round_id).toBe(existing);
    expect(await openRoundCount(source)).toBe(1);
  });

  test("CASE 4 — พาสิโอ้ then พาซิโอ้ is one round", async () => {
    const source = nextSource();
    const existing = await seedRound({ sourceId: source, market: ALIAS_SO });
    const second = await bind({ sourceId: source, market: CANONICAL });
    expect(second.outcome).toBe("bound");
    expect(second.accountability_round_id).toBe(existing);
    expect(await openRoundCount(source)).toBe(1);
  });

  test("CASE 11 — พาซิโอ้ผัก and พาซิโอ้ผลไม้ stay distinct rounds", async () => {
    const source = nextSource();
    const vegetables = await seedRound({ sourceId: source, market: PASEO_VEG });
    const fruit = await bind({ sourceId: source, market: PASEO_FRUIT });
    expect(fruit.outcome).toBe("bound");
    expect(fruit.reused).toBe(false);
    expect(fruit.accountability_round_id).not.toBe(vegetables);
    expect(await openRoundCount(source)).toBe(2);
  });

  // ── Creation still happens when it should ─────────────────────────────────

  test("CASE 5 — no populated round at all creates one", async () => {
    const source = nextSource();
    const result = await bind({ sourceId: source });
    expect(result.outcome).toBe("bound");
    expect(result.reused).toBe(false);
    expect(await roundCount(source)).toBe(1);
  });

  test("CASE 8 — a different business date creates its own round", async () => {
    const source = nextSource();
    await seedRound({ sourceId: source });
    const result = await bind({ sourceId: source, date: OTHER_DATE });
    expect(result.outcome).toBe("bound");
    expect(result.reused).toBe(false);
    expect(await openRoundCount(source)).toBe(2);
  });

  test("CASE 9 — a different seller creates its own round", async () => {
    const source = nextSource();
    await seedRound({ sourceId: source });
    const result = await bind({ sourceId: source, seller: OTHER_SELLER });
    expect(result.outcome).toBe("bound");
    expect(result.reused).toBe(false);
    expect(await openRoundCount(source)).toBe(2);
  });

  test("CASE 10 — a genuinely different market creates its own round", async () => {
    const source = nextSource();
    await seedRound({ sourceId: source, market: CANONICAL });
    const result = await bind({ sourceId: source, market: OTHER_MARKET });
    expect(result.outcome).toBe("bound");
    expect(result.reused).toBe(false);
    expect(await openRoundCount(source)).toBe(2);
  });

  // ── Empty rounds neither shadow nor get reused as masters ─────────────────

  test("CASE 6 — an empty failed-attempt round does not make a populated one ambiguous", async () => {
    const source = nextSource();
    const populated = await seedRound({ sourceId: source });
    await seedRound({ sourceId: source, withdrawal: false });
    const result = await bind({ sourceId: source, actor: OTHER_ACTOR });
    expect(result.outcome).toBe("bound");
    expect(result.reused).toBe(true);
    expect(result.accountability_round_id).toBe(populated);
  });

  test("a cancelled round of the same identity is invisible", async () => {
    const source = nextSource();
    await seedRound({ sourceId: source, status: "cancelled" });
    const result = await bind({ sourceId: source });
    expect(result.outcome).toBe("bound");
    expect(result.reused).toBe(false);
  });

  // ── Fail closed rather than guess ─────────────────────────────────────────

  test("CASE 7 — two populated matching rounds are ambiguous and create nothing", async () => {
    const source = nextSource();
    await seedRound({ sourceId: source });
    await seedRound({ sourceId: source });
    const before = await roundCount(source);
    const result = await bind({ sourceId: source, actor: OTHER_ACTOR });
    expect(result.outcome).toBe("ambiguous");
    expect(await roundCount(source)).toBe(before);
  });

  // ── Nothing PR #53 established is weakened ────────────────────────────────

  test("an UNREVIEWED one-character market variant still fails closed", async () => {
    const source = nextSource();
    await seedRound({ sourceId: source, market: CANONICAL });
    const before = await roundCount(source);
    const result = await bind({ sourceId: source, market: "พาชิโอ้" });
    expect(result.outcome).toBe("market_near_match");
    expect(result.market_label).toBe(CANONICAL);
    expect(await roundCount(source)).toBe(before);
  });

  test("เบิกเพิ่ม remains an explicit append and never creates", async () => {
    const source = nextSource();
    const existing = await seedRound({ sourceId: source });
    const additional = await bind({ sourceId: source, isNewRound: false });
    expect(additional.outcome).toBe("bound");
    expect(additional.accountability_round_id).toBe(existing);
    expect(await openRoundCount(source)).toBe(1);
  });

  test("a return with no withdrawal round still gets no_round", async () => {
    const source = nextSource();
    expect((await bind({ sourceId: source, isNewRound: false })).outcome).toBe("no_round");
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  test("re-binding the same generation is idempotent, whether it created or reused", async () => {
    const source = nextSource();
    const creator = await seedPending({ sourceId: source });
    const first = JSON.parse(await scalar(bindSql({ sourceId: source, ...creator })));
    expect(first.outcome).toBe("bound");
    const replay = JSON.parse(await scalar(bindSql({ sourceId: source, ...creator })));
    expect(replay.accountability_round_id).toBe(first.accountability_round_id);
    expect(await roundCount(source)).toBe(1);

    await scalar(`
      INSERT INTO public.produce_transactions (accountability_round_id, base_transaction_type)
      VALUES (${q(first.accountability_round_id)}::uuid, 'เบิก') RETURNING 1`);

    const joiner = await seedPending({ sourceId: source, actor: OTHER_ACTOR });
    const reused = JSON.parse(await scalar(bindSql({ sourceId: source, ...joiner })));
    expect(reused.reused).toBe(true);
    const reusedReplay = JSON.parse(await scalar(bindSql({ sourceId: source, ...joiner })));
    expect(reusedReplay.accountability_round_id).toBe(first.accountability_round_id);
    expect(await roundCount(source)).toBe(1);
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  test("two racing plain เบิก openers produce exactly one round", async () => {
    const source = nextSource();
    const a = await seedPending({ sourceId: source });
    const b = await seedPending({ sourceId: source, actor: OTHER_ACTOR });

    // A holds the business-identity advisory lock across a deliberate pause. B
    // must block on it rather than reading a snapshot without A's round.
    const first = spawnPsql(
      ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      DATABASE,
      `BEGIN;\n${bindSql({ sourceId: source, ...a })};\nSELECT pg_sleep(2);\nCOMMIT;`,
    );
    await Bun.sleep(500);
    const second = spawnPsql(
      ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      DATABASE,
      `${bindSql({ sourceId: source, ...b })};`,
    );

    const [resultA, resultB] = await Promise.all([collect(first), collect(second)]);
    expect(resultA.code, resultA.stderr).toBe(0);
    expect(resultB.code, resultB.stderr).toBe(0);

    // Whatever order they serialize in, the source ends with ONE round and both
    // generations point at it.
    expect(await roundCount(source)).toBe(1);
    expect(await scalar(`
      SELECT count(DISTINCT accountability_round_id)::text
      FROM public.pending_sessions
      WHERE source_id = ${q(source)} AND accountability_round_id IS NOT NULL`)).toBe("1");
  }, 30_000);
});
