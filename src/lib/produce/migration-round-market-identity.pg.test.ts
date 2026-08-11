/**
 * Real PostgreSQL 17 proof for market identity consistency inside one
 * accountability round.
 *
 * Reproduces the Production failure of business date 2026-08-10, round
 * d96d2898-43f7-4eeb-9477-5e8b942da477: a withdrawal opened as `ทุ่งลานนา` and
 * returns opened as `วัดทุ่งลานนา` ended up in the SAME round under two market
 * labels. The reviewed catalog says those two labels are one market, so the
 * return must CONTINUE the round rather than fall through to `no_round`; a
 * genuinely different market must fail closed by name.
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
const DATABASE = `rmi_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^rmi_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const SESSION = "group:G-lanna:user:U-typist";
const TOM_SESSION = "group:G-tom:user:U-tom";
const GEN_WITHDRAW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GEN_RETURN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GEN_TOM_WITHDRAW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GEN_TOM_RETURN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DATE = "2026-08-10";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-round-market-identity.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };
async function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
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

/** SQL over stdin: Thai market labels are exactly what this proves. */
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
  seller?: string;
  market?: string;
  newRound?: boolean;
}

async function bind(options: BindOptions = {}): Promise<{
  outcome: string;
  accountability_round_id?: string;
  market_label?: string;
}> {
  const {
    sessionKey = SESSION,
    generation = GEN_WITHDRAW,
    owner = "U-typist",
    sourceId = "G-lanna",
    seller = "ดำ",
    market = "ทุ่งลานนา",
    newRound = true,
  } = options;
  return JSON.parse(await scalar(`
    SELECT public.bind_plain_text_accountability_round(
      '${sessionKey}', '${generation}'::uuid, 'group', '${sourceId}', '${owner}',
      DATE '${DATE}', '${seller}', '${market}', '${market}', ${newRound}
    )`));
}

/** Points the operator's single pending row at a generation, as a rotation does. */
async function rotate(generation: string, sessionKey = SESSION): Promise<void> {
  await scalar(`
    UPDATE public.pending_sessions SET session_generation = '${generation}'::uuid
    WHERE session_key = '${sessionKey}' RETURNING 1`);
}

describe.skipIf(!pgAvailable)("round market identity on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "round_market_identity_bootstrap.sql"));
    await apply(
      join(ROOT, "supabase", "migrations", "20260810120000_p4a_plain_text_round_binding.sql"),
    );
    await apply(
      join(ROOT, "supabase", "migrations", "20260811090000_round_market_identity_consistency.sql"),
    );
    // Production catalog rows, verbatim: ทุ่งลานนา is a REVIEWED alias of the
    // canonical market วัดทุ่งลานนา. ราชพฤกษ์ is a different market entirely.
    await scalar(`
      INSERT INTO public.line_guided_menu_markets (market_code, label) VALUES
        ('wat_thung_lanna', 'วัดทุ่งลานนา'),
        ('ratchaphruek', 'ราชพฤกษ์'),
        ('paseo_fruit', 'พาซิโอ้ผลไม้');
      INSERT INTO public.line_guided_menu_market_aliases (alias_label, market_code) VALUES
        ('ทุ่งลานนา', 'wat_thung_lanna'),
        ('ตลาดทุ่งลานนา', 'wat_thung_lanna');
      SELECT 1`);
    await scalar(`
      INSERT INTO public.pending_sessions (session_key, session_generation, source_id, line_user_id)
      VALUES
        ('${SESSION}', '${GEN_WITHDRAW}'::uuid, 'G-lanna', 'U-typist'),
        ('${TOM_SESSION}', '${GEN_TOM_WITHDRAW}'::uuid, 'G-tom', 'U-tom')
      RETURNING 1`);
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("the reviewed catalog resolves a label to its canonical market code", async () => {
    expect(await scalar(`SELECT public.accountability_round_market_code('ทุ่งลานนา')`))
      .toBe("wat_thung_lanna");
    expect(await scalar(`SELECT public.accountability_round_market_code('วัดทุ่งลานนา')`))
      .toBe("wat_thung_lanna");
    // A label nobody reviewed stays unknown — it is never guessed into a market.
    expect(await scalar(`SELECT coalesce(public.accountability_round_market_code('ตลาดที่ไม่มีในสารบบ'), 'NULL')`))
      .toBe("NULL");
  });

  test("same market only when normalized-equal or catalog-equal, never similar", async () => {
    expect(await scalar(`SELECT public.accountability_round_same_market('ทุ่งลานนา', 'วัดทุ่งลานนา')::text`))
      .toBe("true");
    expect(await scalar(`SELECT public.accountability_round_same_market('ทุ่งลานนา', 'ราชพฤกษ์')::text`))
      .toBe("false");
    // Two unknown labels that merely look alike are NOT merged.
    expect(await scalar(`SELECT public.accountability_round_same_market('พาชิโอ้', 'พาชิโอ้ผลไม้')::text`))
      .toBe("false");
  });

  test("Test 1 — a return sent as วัดทุ่งลานนา continues the ทุ่งลานนา round", async () => {
    const withdrawal = await bind();
    expect(withdrawal.outcome).toBe("bound");

    await rotate(GEN_RETURN);
    const roundCount = await scalar("SELECT count(*)::text FROM public.accountability_rounds");
    const result = await bind({
      generation: GEN_RETURN,
      market: "วัดทุ่งลานนา",
      newRound: false,
    });

    expect(result.outcome).toBe("already_bound");
    expect(result.accountability_round_id).toBe(withdrawal.accountability_round_id);
    // The canonical label comes back so callers display ONE market, not two.
    expect(result.market_label).toBe("ทุ่งลานนา");
    // No second round was minted for the alias spelling.
    expect(await scalar("SELECT count(*)::text FROM public.accountability_rounds")).toBe(roundCount);
  });

  test("Test 2 — a return naming a different market fails closed, by name", async () => {
    const withdrawal = await bind({
      sessionKey: TOM_SESSION,
      generation: GEN_TOM_WITHDRAW,
      sourceId: "G-tom",
      owner: "U-tom",
      seller: "ต้อม",
      market: "พาซิโอ้ผลไม้",
    });
    expect(withdrawal.outcome).toBe("bound");

    await rotate(GEN_TOM_RETURN, TOM_SESSION);
    const result = await bind({
      sessionKey: TOM_SESSION,
      generation: GEN_TOM_RETURN,
      sourceId: "G-tom",
      owner: "U-tom",
      seller: "ต้อม",
      market: "ราชพฤกษ์",
      newRound: false,
    });

    expect(result.outcome).toBe("market_mismatch");
    expect(result.market_label).toBe("พาซิโอ้ผลไม้");
    // Nothing was rebound: the round still holds only its own market.
    expect(await scalar(`
      SELECT market_label FROM public.accountability_rounds
      WHERE id = '${withdrawal.accountability_round_id}'`)).toBe("พาซิโอ้ผลไม้");
  });

  test("an unbound generation naming another market is told which round exists", async () => {
    // Trust 2, not Trust 1: this generation carries no binding of its own, so
    // discovery runs and finds nothing for ราชพฤกษ์. Exactly one open round
    // exists for this seller/day, so it can be named instead of reporting a
    // missing withdrawal the operator would go and re-enter.
    const fresh = "11111111-1111-4111-8111-111111111111";
    await scalar(`
      INSERT INTO public.pending_sessions (session_key, session_generation, source_id, line_user_id)
      VALUES ('group:G-lanna:user:U-typist#2', '${fresh}'::uuid, 'G-lanna', 'U-typist')
      RETURNING 1`);

    const result = await bind({
      sessionKey: "group:G-lanna:user:U-typist#2",
      generation: fresh,
      market: "ราชพฤกษ์",
      newRound: false,
    });
    expect(result.outcome).toBe("market_mismatch");
    expect(result.market_label).toBe("ทุ่งลานนา");
  });

  test("a NEW withdrawal for another market still opens its own round", async () => {
    const before = await scalar("SELECT count(*)::text FROM public.accountability_rounds");
    await rotate("ffffffff-ffff-4fff-8fff-ffffffffffff", TOM_SESSION);
    const result = await bind({
      sessionKey: TOM_SESSION,
      generation: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      sourceId: "G-tom",
      owner: "U-tom",
      seller: "ต้อม",
      market: "ราชพฤกษ์",
      newRound: true,
    });
    expect(result.outcome).toBe("bound");
    expect(Number(await scalar("SELECT count(*)::text FROM public.accountability_rounds")))
      .toBe(Number(before) + 1);
  });

  test("the market helpers are not executable by anon or authenticated", async () => {
    for (const signature of [
      "public.accountability_round_market_code(text)",
      "public.accountability_round_same_market(text,text)",
    ]) {
      expect(await scalar(`SELECT has_function_privilege('anon', '${signature}', 'EXECUTE')::text`))
        .toBe("false");
      expect(await scalar(
        `SELECT has_function_privilege('authenticated', '${signature}', 'EXECUTE')::text`,
      )).toBe("false");
      expect(await scalar(
        `SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')::text`,
      )).toBe("true");
    }
  });
});
