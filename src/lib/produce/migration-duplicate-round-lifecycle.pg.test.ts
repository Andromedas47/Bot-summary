/**
 * PostgreSQL 17 proof for the duplicate hotfix's two database contracts:
 *
 *   1. cancel_duplicate_plain_text_round retires the empty round a duplicate
 *      generation minted, and refuses whenever the round holds anything.
 *   2. imported_sessions.session_hash is what makes two identical submissions
 *      race-safe: a UNIQUE index plus INSERT ... ON CONFLICT DO NOTHING, so
 *      exactly one concurrent transaction gets the RETURNING row.
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
const DATABASE = `dupround_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^dupround_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const DATE = "2026-08-14";
const SELLER = "จิ๋ว";
const MARKET = "ราชพฤก";
const SOURCE = "C4fa145d58f23a17e7e7b14315f334c6d";
const OWNER = "U3f04f748584d997819dec0fc71a9b084";
const OTHER_ACTOR = "U84e999002627396432553ff25bb861ca";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-duplicate-round-lifecycle.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
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

/** One plain-text generation that minted its own round, exactly as binding does. */
async function seedMintedRound(options: {
  actor?: string;
  roundId?: string;
} = {}): Promise<{ key: string; generation: string; roundId: string; creationKey: string }> {
  const actor = options.actor ?? OWNER;
  const generation = nextUuid();
  const roundId = options.roundId ?? nextUuid();
  const key = `group:${SOURCE}:user:${actor}:${generation}`;
  const creationKey = `plaintext:${key}:${generation}`;
  await scalar(`
    INSERT INTO public.accountability_rounds (
      id, source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized, status,
      created_line_event_id
    ) VALUES (
      ${q(roundId)}::uuid, 'group', ${q(SOURCE)}, ${q(actor)}, DATE ${q(DATE)},
      ${q(SELLER)}, ${q(MARKET)}, ${q(MARKET)}, 'open', ${q(creationKey)}
    );
    INSERT INTO public.pending_sessions (
      session_key, session_generation, source_id, line_user_id, accountability_round_id
    ) VALUES (
      ${q(key)}, ${q(generation)}::uuid, ${q(SOURCE)}, ${q(actor)}, ${q(roundId)}::uuid
    ) RETURNING 1`);
  return { key, generation, roundId, creationKey };
}

async function cancel(key: string, generation: string): Promise<{
  outcome: string;
  accountability_round_id?: string;
}> {
  return JSON.parse(await scalar(
    `SELECT public.cancel_duplicate_plain_text_round(${q(key)}, ${q(generation)}::uuid)`,
  ));
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_DUPLICATE_ROUND_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_DUPLICATE_ROUND_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("duplicate round lifecycle on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "round_market_identity_bootstrap.sql"));
    await scalar(`
      CREATE TABLE public.produce_transactions (
        accountability_round_id uuid REFERENCES public.accountability_rounds(id),
        base_transaction_type text NOT NULL
      );
      CREATE TABLE public.imported_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_hash text NOT NULL UNIQUE
      );
      SELECT 1`);
    await apply(join(
      ROOT, "supabase", "migrations", "20260815090000_cancel_duplicate_plain_text_round.sql",
    ));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("cancels the empty round a duplicate generation minted", async () => {
    const minted = await seedMintedRound({ actor: OTHER_ACTOR });

    expect(await cancel(minted.key, minted.generation)).toEqual({
      outcome: "cancelled",
      accountability_round_id: minted.roundId,
    });
    expect(await scalar(
      `SELECT status FROM public.accountability_rounds WHERE id = ${q(minted.roundId)}::uuid`,
    )).toBe("cancelled");
    expect(await scalar(
      `SELECT closed_at IS NOT NULL FROM public.accountability_rounds
       WHERE id = ${q(minted.roundId)}::uuid`,
    )).toBe("t");
  });

  test("refuses a round holding a produce session", async () => {
    const minted = await seedMintedRound();
    await scalar(`
      INSERT INTO public.produce_sessions (session_date, staff_name, accountability_round_id)
      VALUES (DATE ${q(DATE)}, ${q(SELLER)}, ${q(minted.roundId)}::uuid) RETURNING 1`);

    expect((await cancel(minted.key, minted.generation)).outcome).toBe("has_produce_sessions");
    expect(await scalar(
      `SELECT status FROM public.accountability_rounds WHERE id = ${q(minted.roundId)}::uuid`,
    )).toBe("open");
  });

  test("refuses a round holding produce transactions", async () => {
    const minted = await seedMintedRound();
    await scalar(`
      INSERT INTO public.produce_transactions (accountability_round_id, base_transaction_type)
      VALUES (${q(minted.roundId)}::uuid, 'เบิก') RETURNING 1`);

    expect((await cancel(minted.key, minted.generation)).outcome).toBe("has_transactions");
    expect(await scalar(
      `SELECT status FROM public.accountability_rounds WHERE id = ${q(minted.roundId)}::uuid`,
    )).toBe("open");
  });

  test("refuses a round another pending generation is also bound to", async () => {
    const minted = await seedMintedRound();
    await scalar(`
      INSERT INTO public.pending_sessions (
        session_key, session_generation, source_id, line_user_id, accountability_round_id
      ) VALUES (
        ${q(`${minted.key}:continuation`)}, ${q(nextUuid())}::uuid,
        ${q(SOURCE)}, ${q(OTHER_ACTOR)}, ${q(minted.roundId)}::uuid
      ) RETURNING 1`);

    expect((await cancel(minted.key, minted.generation)).outcome)
      .toBe("shared_with_other_generation");
    expect(await scalar(
      `SELECT status FROM public.accountability_rounds WHERE id = ${q(minted.roundId)}::uuid`,
    )).toBe("open");
  });

  test("never touches a round it did not mint", async () => {
    const minted = await seedMintedRound();
    // A continuation generation minted nothing, so there is nothing to cancel.
    expect(await cancel(`${minted.key}:other`, nextUuid())).toEqual({ outcome: "no_round" });
    expect(await scalar(
      `SELECT status FROM public.accountability_rounds WHERE id = ${q(minted.roundId)}::uuid`,
    )).toBe("open");
  });

  test("is idempotent — a second cancel is a no-op", async () => {
    const minted = await seedMintedRound();
    expect((await cancel(minted.key, minted.generation)).outcome).toBe("cancelled");
    expect((await cancel(minted.key, minted.generation)).outcome).toBe("not_open");
  });

  test("CASE J — concurrent identical fingerprints: exactly one insert wins", async () => {
    // The finalize RPC's own duplicate rule, isolated: whoever gets the
    // RETURNING row persists produce, the other is classified duplicate. A
    // SELECT-then-INSERT would let both through; the UNIQUE index does not.
    const hash = `race-${randomBytes(8).toString("hex")}`;
    const attempt = () => scalar(`
      WITH inserted AS (
        INSERT INTO public.imported_sessions (session_hash)
        VALUES (${q(hash)})
        ON CONFLICT (session_hash) DO NOTHING
        RETURNING id
      )
      SELECT count(*)::text FROM inserted`);

    const outcomes = await Promise.all([attempt(), attempt()]);
    expect(outcomes.filter((won) => won === "1")).toHaveLength(1);
    expect(outcomes.filter((won) => won === "0")).toHaveLength(1);
    expect(await scalar(
      `SELECT count(*)::text FROM public.imported_sessions WHERE session_hash = ${q(hash)}`,
    )).toBe("1");
  });
});
