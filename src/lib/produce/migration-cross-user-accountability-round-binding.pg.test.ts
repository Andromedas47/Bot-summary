/** PostgreSQL 17 proof for cross-user produce round continuation. */
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
const DATABASE = `cuarb_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^cuarb_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const DATE = "2026-08-14";
const SELLER = "ต้อม";
const MARKET = "พาซิโอ้";
const PRODUCTION_ROUND = "4aa36324-79a1-4ee3-9161-e64b86d81632";
const PRODUCTION_SOURCE = "C98f83da381b20df2829b660845d9b271";
const OWNER = "U3f04f748584d997819dec0fc71a9b084";
const ACTOR = "U84e999002627396432553ff25bb861ca";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-cross-user-accountability-round-binding.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
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
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
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

interface RoundOptions {
  sourceId: string;
  owner?: string;
  date?: string;
  seller?: string;
  market?: string;
  status?: "open" | "closed";
  withdrawal?: boolean;
  id?: string;
}

async function seedRound(options: RoundOptions): Promise<string> {
  const id = options.id ?? nextUuid();
  const owner = options.owner ?? OWNER;
  const date = options.date ?? DATE;
  const seller = options.seller ?? SELLER;
  const market = options.market ?? MARKET;
  const status = options.status ?? "open";
  await scalar(`
    INSERT INTO public.accountability_rounds (
      id, source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized, status,
      created_line_event_id, closed_at
    ) VALUES (
      ${q(id)}::uuid, 'group', ${q(options.sourceId)}, ${q(owner)}, DATE ${q(date)},
      ${q(seller)}, ${q(market)}, ${q(market)}, ${q(status)},
      ${q(`event:${id}`)}, ${status === "closed" ? "now()" : "NULL"}
    ) RETURNING 1`);
  if (options.withdrawal !== false) {
    await scalar(`
      INSERT INTO public.produce_transactions (accountability_round_id, base_transaction_type)
      VALUES (${q(id)}::uuid, 'เบิก') RETURNING 1`);
  }
  return id;
}

interface PendingOptions {
  sourceId: string;
  actor?: string;
  key?: string;
  generation?: string;
}

async function seedPending(options: PendingOptions): Promise<{ key: string; generation: string; actor: string }> {
  const actor = options.actor ?? ACTOR;
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

interface BindOptions extends PendingOptions {
  date?: string;
  seller?: string;
  market?: string;
}

async function bind(options: BindOptions): Promise<{
  outcome: string;
  accountability_round_id?: string;
  market_label?: string;
}> {
  const pending = await seedPending(options);
  return bindExisting({
    ...options,
    ...pending,
  });
}

async function bindExisting(options: Required<Pick<PendingOptions, "sourceId">> & {
  key: string;
  generation: string;
  actor: string;
  date?: string;
  seller?: string;
  market?: string;
}): Promise<{
  outcome: string;
  accountability_round_id?: string;
  market_label?: string;
}> {
  return JSON.parse(await scalar(`
    SELECT public.bind_plain_text_accountability_round(
      ${q(options.key)}, ${q(options.generation)}::uuid, 'group',
      ${q(options.sourceId)}, ${q(options.actor)}, DATE ${q(options.date ?? DATE)},
      ${q(options.seller ?? SELLER)}, ${q(options.market ?? MARKET)},
      ${q(options.market ?? MARKET)}, false
    )`));
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_CROSS_USER_ROUND_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_CROSS_USER_ROUND_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("cross-user accountability round binding on PostgreSQL 17", () => {
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
    await apply(join(ROOT, "supabase", "migrations", "20260810100414_p4a_plain_text_round_binding.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260811181727_round_market_identity_consistency.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260814104329_cross_user_accountability_round_binding.sql"));
    await scalar(`
      INSERT INTO public.line_guided_menu_markets (market_code, label) VALUES
        ('wat_thung_lanna', 'วัดทุ่งลานนา');
      INSERT INTO public.line_guided_menu_market_aliases (alias_label, market_code) VALUES
        ('ทุ่งลานนา', 'wat_thung_lanna');
      SELECT 1`);
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("Production identity: B binds A's existing withdrawal round", async () => {
    await seedRound({ sourceId: PRODUCTION_SOURCE, id: PRODUCTION_ROUND });
    const beforeTransactions = await scalar(
      "SELECT count(*)::text FROM public.produce_transactions",
    );
    const pending = await seedPending({ sourceId: PRODUCTION_SOURCE });

    const result = await bindExisting({ sourceId: PRODUCTION_SOURCE, ...pending });
    expect(result).toEqual({
      outcome: "bound",
      accountability_round_id: PRODUCTION_ROUND,
      market_label: MARKET,
    });
    expect(await scalar(`
      SELECT owner_line_user_id FROM public.accountability_rounds
      WHERE id = ${q(PRODUCTION_ROUND)}::uuid`)).toBe(OWNER);
    expect(await scalar(`
      SELECT line_user_id FROM public.pending_sessions
      WHERE session_key = ${q(pending.key)}`)).toBe(ACTOR);
    expect(await scalar(`
      SELECT accountability_round_id::text FROM public.pending_sessions
      WHERE session_key = ${q(pending.key)}`)).toBe(PRODUCTION_ROUND);
    expect(await scalar("SELECT count(*)::text FROM public.accountability_rounds")).toBe("1");
    expect(await scalar("SELECT count(*)::text FROM public.produce_transactions"))
      .toBe(beforeTransactions);

    const replay = await bindExisting({ sourceId: PRODUCTION_SOURCE, ...pending });
    expect(replay.outcome).toBe("already_bound");
    expect(replay.accountability_round_id).toBe(PRODUCTION_ROUND);
  });

  test("different-user damaged return binds the same business round", async () => {
    const sourceId = "G-damaged";
    const round = await seedRound({ sourceId });
    const result = await bind({ sourceId, actor: "U-damaged-actor" });
    expect(result.outcome).toBe("bound");
    expect(result.accountability_round_id).toBe(round);
  });

  test("different-user additional entry binds the same business round", async () => {
    const sourceId = "G-additional";
    const round = await seedRound({ sourceId });
    const result = await bind({ sourceId, actor: "U-additional-actor" });
    expect(result.accountability_round_id).toBe(round);
  });

  test("same-user continuation still binds", async () => {
    const sourceId = "G-same-user";
    const round = await seedRound({ sourceId, owner: "U-same" });
    const result = await bind({ sourceId, actor: "U-same" });
    expect(result.accountability_round_id).toBe(round);
  });

  test("group isolation prevents cross-source binding", async () => {
    await seedRound({ sourceId: "G-group-A" });
    const result = await bind({ sourceId: "G-group-B" });
    expect(result.outcome).toBe("no_round");
    expect(result.accountability_round_id).toBeUndefined();
  });

  test("date isolation prevents cross-date binding", async () => {
    const sourceId = "G-date";
    await seedRound({ sourceId, date: "2026-08-13" });
    expect((await bind({ sourceId })).outcome).toBe("no_round");
  });

  test("seller isolation prevents cross-seller binding", async () => {
    const sourceId = "G-seller";
    await seedRound({ sourceId, seller: "คนละคน" });
    expect((await bind({ sourceId })).outcome).toBe("no_round");
  });

  test("market isolation fails closed without binding", async () => {
    const sourceId = "G-market";
    await seedRound({ sourceId, market: "ราชพฤกษ์" });
    const pending = await seedPending({ sourceId });
    const result = await bindExisting({ sourceId, ...pending });
    expect(result.outcome).toBe("market_mismatch");
    expect(await scalar(`
      SELECT coalesce(accountability_round_id::text, 'null')
      FROM public.pending_sessions WHERE session_key = ${q(pending.key)}`)).toBe("null");
  });

  test("reviewed market aliases keep existing canonical semantics", async () => {
    const sourceId = "G-alias";
    const round = await seedRound({ sourceId, market: "วัดทุ่งลานนา" });
    const result = await bind({ sourceId, market: "ทุ่งลานนา" });
    expect(result.accountability_round_id).toBe(round);
    expect(result.market_label).toBe("วัดทุ่งลานนา");
  });

  test("zero valid candidates retains no-round behavior", async () => {
    expect((await bind({ sourceId: "G-none" })).outcome).toBe("no_round");
  });

  test("two valid business matches are ambiguous and write nothing", async () => {
    const sourceId = "G-ambiguous";
    await seedRound({ sourceId, owner: "U-A" });
    await seedRound({ sourceId, owner: "U-B" });
    const pending = await seedPending({ sourceId, actor: "U-C" });
    const before = await scalar("SELECT count(*)::text FROM public.produce_transactions");
    const result = await bindExisting({ sourceId, ...pending });
    expect(result.outcome).toBe("ambiguous");
    expect(await scalar(`
      SELECT coalesce(accountability_round_id::text, 'null')
      FROM public.pending_sessions WHERE session_key = ${q(pending.key)}`)).toBe("null");
    expect(await scalar("SELECT count(*)::text FROM public.produce_transactions")).toBe(before);
  });

  test("an open round without an active withdrawal is not continuable", async () => {
    const sourceId = "G-no-withdrawal";
    await seedRound({ sourceId, withdrawal: false });
    expect((await bind({ sourceId })).outcome).toBe("no_round");
  });

  test("a closed withdrawal round is not continuable", async () => {
    const sourceId = "G-closed";
    await seedRound({ sourceId, status: "closed" });
    expect((await bind({ sourceId })).outcome).toBe("no_round");
  });

  test("service-role-only execution and pinned search path survive replacement", async () => {
    expect(await scalar(`
      SELECT has_function_privilege(
        'anon',
        'public.bind_plain_text_accountability_round(text,uuid,text,text,text,date,text,text,text,boolean)',
        'EXECUTE'
      )::text`)).toBe("false");
    expect(await scalar(`
      SELECT has_function_privilege(
        'service_role',
        'public.bind_plain_text_accountability_round(text,uuid,text,text,text,date,text,text,text,boolean)',
        'EXECUTE'
      )::text`)).toBe("true");
    expect(await scalar(`
      SELECT array_to_string(proconfig, ',') FROM pg_proc
      WHERE proname = 'bind_plain_text_accountability_round'`))
      .toBe("search_path=public, extensions, pg_temp");
  });
});
