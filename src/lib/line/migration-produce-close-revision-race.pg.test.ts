/** PostgreSQL 17 proof for revision-pinned close and terminalized review guards. */
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
const DATABASE = `produce_close_rev_${randomBytes(4).toString("hex")}`;
const SAFE_DATABASE = /^produce_close_rev_[a-f0-9]+$/;
const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

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

async function scalar(sql: string): Promise<string> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !SAFE_HOSTS.has(PGHOST)) return false;
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

const GEN = "4bbe8461-f8b0-481f-8d31-fec65a81e1ea";
const KEY = "group:g1:user:u1";

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_PRODUCE_CLOSE_REVISION_POSTGRES === "1") {
  throw new Error("PostgreSQL 17 close-revision harness is unavailable");
}

describe.skipIf(!pgAvailable)("pending close revision pin on PostgreSQL 17", () => {
  beforeAll(async () => {
    if (!SAFE_DATABASE.test(DATABASE) || !SAFE_HOSTS.has(PGHOST)) throw new Error("unsafe PG target");
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await scalar(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE public.pending_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_key text UNIQUE NOT NULL,
        source_id text, accumulated_text text NOT NULL DEFAULT '', latest_reply_token text,
        line_user_id text, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), session_generation uuid NOT NULL DEFAULT gen_random_uuid(),
        close_event_timestamp_ms bigint, close_requested_at timestamptz, close_line_event_id text,
        close_finalize_started_at timestamptz, terminalized boolean NOT NULL DEFAULT false,
        next_attempt_at timestamptz, close_deadline_at timestamptz, close_session_generation uuid,
        expected_item_count integer, ingest_revision integer NOT NULL DEFAULT 0
      );
      CREATE TABLE public.pending_session_admission (
        session_key text NOT NULL, session_generation uuid NOT NULL,
        line_event_id text NOT NULL, line_timestamp_ms bigint NOT NULL,
        UNIQUE(session_generation, line_event_id)
      );
      CREATE TABLE public.pending_session_ingest (
        session_key text NOT NULL, session_generation uuid NOT NULL,
        line_event_id text NOT NULL, line_timestamp_ms bigint NOT NULL, raw_text text NOT NULL,
        UNIQUE(session_generation, line_event_id)
      );
      CREATE TABLE public.produce_entry_validation_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_key text NOT NULL, session_generation uuid NOT NULL,
        accountability_round_id uuid, validation_digest text NOT NULL,
        business_date date, market_label text, staff_label text,
        exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
        presented_by_line_user_id text NOT NULL, presented_line_event_id text NOT NULL,
        presented_at timestamptz NOT NULL DEFAULT now(),
        confirmed_at timestamptz, confirmed_by_line_user_id text, confirmed_line_event_id text,
        CONSTRAINT produce_entry_validation_reviews_identity
          UNIQUE (session_key, session_generation, validation_digest)
      );
      CREATE FUNCTION public.append_pending_session(
        p_session_key text, p_new_text text, p_reply_token text, p_line_event_id text,
        p_line_timestamp_ms bigint, p_mark_close boolean,
        p_expected_session_generation uuid, p_expected_item_count integer
      ) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        RETURN jsonb_build_object('accepted', false, 'reason', 'stub');
      END $$;
      SELECT 1`);
    await apply(join(ROOT, "supabase", "migrations", "20260822180000_pending_close_revision_pin.sql"));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  async function seed(revision = 4, extra = ""): Promise<void> {
    await scalar(`
      DELETE FROM public.pending_session_ingest;
      DELETE FROM public.pending_session_admission;
      DELETE FROM public.produce_entry_validation_reviews;
      DELETE FROM public.pending_sessions;
      INSERT INTO public.pending_sessions (
        session_key, session_generation, accumulated_text, line_user_id, ingest_revision
      ) VALUES (${q(KEY)}, ${q(GEN)}::uuid, 'header', 'U1', ${revision});
      ${extra}
    `);
  }

  test("TEST 1 — first close with stale ingest_revision cannot stamp the boundary", async () => {
    await seed(5);
    const result = JSON.parse(await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, 'จบรายการเบิก', 'reply', 'close-1', 2000, true,
      ${q(GEN)}::uuid, NULL, 4)`));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("stale_validation_snapshot");
    expect(result.current_revision).toBe(5);
    expect(await scalar(
      `SELECT close_event_timestamp_ms::text FROM public.pending_sessions WHERE session_key=${q(KEY)}`,
    )).toBe("");
    expect(await scalar(
      `SELECT terminalized::text FROM public.pending_sessions WHERE session_key=${q(KEY)}`,
    )).toBe("false");
  });

  test("matching revision establishes the first-close boundary", async () => {
    await seed(5);
    const result = JSON.parse(await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, 'จบรายการเบิก', 'reply', 'close-ok', 2000, true,
      ${q(GEN)}::uuid, NULL, 5)`));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe("first_close");
    expect(await scalar(
      `SELECT close_event_timestamp_ms::text FROM public.pending_sessions WHERE session_key=${q(KEY)}`,
    )).toBe("2000");
  });

  test("TEST 3 — pre-close LINE timestamp still admits after the boundary", async () => {
    await seed(1);
    await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, 'จบรายการเบิก', 'reply', 'close-b', 5000, true,
      ${q(GEN)}::uuid, NULL, 1)`);
    const admitted = JSON.parse(await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, '25อะโวคาโด้70บาท', 'reply', 'item-late', 4000, false,
      ${q(GEN)}::uuid, NULL, NULL)`));
    expect(admitted.accepted).toBe(true);
    expect(admitted.reason).toBe("appended");
    expect(await scalar(
      `SELECT count(*)::text FROM public.pending_session_ingest WHERE line_event_id='item-late'`,
    )).toBe("1");
  });

  test("TEST 4 — post-close LINE timestamp is still rejected", async () => {
    await seed(1);
    await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, 'จบรายการเบิก', 'reply', 'close-c', 5000, true,
      ${q(GEN)}::uuid, NULL, 1)`);
    const rejected = JSON.parse(await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, '26ทุเรียน', 'reply', 'item-after', 6000, false,
      ${q(GEN)}::uuid, NULL, NULL)`));
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe("after_close_boundary");
  });

  test("duplicate LINE close event is idempotent and does not confirm anything", async () => {
    await seed(2);
    const first = JSON.parse(await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, 'จบรายการเบิก', 'reply', 'close-dup', 3000, true,
      ${q(GEN)}::uuid, NULL, 2)`));
    const second = JSON.parse(await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, 'จบรายการเบิก', 'reply', 'close-dup', 3000, true,
      ${q(GEN)}::uuid, NULL, 2)`));
    expect(first.reason).toBe("first_close");
    expect(second.accepted).toBe(true);
    expect(second.reason).toBe("duplicate_event");
    expect(await scalar(
      `SELECT count(*)::text FROM public.pending_session_ingest WHERE line_event_id='close-dup'`,
    )).toBe("1");
  });

  test("generation mismatch is distinct from revision mismatch", async () => {
    await seed(3);
    const result = JSON.parse(await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, 'จบรายการเบิก', 'reply', 'close-gen', 3000, true,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, NULL, 3)`));
    expect(result.reason).toBe("generation_conflict");
  });

  test("TEST 5 — record_produce_validation_review refuses a terminalized generation", async () => {
    await seed(1);
    await scalar(`UPDATE public.pending_sessions SET terminalized = true WHERE session_key=${q(KEY)}`);
    const result = JSON.parse(await scalar(`SELECT public.record_produce_validation_review(
      ${q(KEY)}, ${q(GEN)}::uuid, NULL, ${q("a".repeat(64))}, NULL, NULL, NULL,
      '[{"kind":"unknown_product_vocabulary"}]'::jsonb, 'U1', 'close-term')`));
    expect(result.reason).toBe("terminalized");
    expect(result.recorded).toBe(false);
    expect(await scalar(
      `SELECT count(*)::text FROM public.produce_entry_validation_reviews`,
    )).toBe("0");
  });

  test("hold parks next_attempt_at; resume reopens the sweep without Produce writes", async () => {
    await seed(1);
    await scalar(`SELECT public.append_pending_session(
      ${q(KEY)}, 'จบรายการเบิก', 'reply', 'close-hold', 3000, true,
      ${q(GEN)}::uuid, NULL, 1)`);
    const revision = await scalar(
      `SELECT ingest_revision::text FROM public.pending_sessions WHERE session_key=${q(KEY)}`,
    );
    const held = JSON.parse(await scalar(`SELECT public.hold_pending_validation_review(
      ${q(KEY)}, ${q(GEN)}::uuid, ${revision}::integer)`));
    expect(held.accepted).toBe(true);
    expect(await scalar(
      `SELECT next_attempt_at IS NULL::text FROM public.pending_sessions WHERE session_key=${q(KEY)}`,
    )).toBe("true");
    expect(await scalar(
      `SELECT terminalized::text FROM public.pending_sessions WHERE session_key=${q(KEY)}`,
    )).toBe("false");
    expect(await scalar(
      `SELECT close_event_timestamp_ms::text FROM public.pending_sessions WHERE session_key=${q(KEY)}`,
    )).toBe("3000");

    const staleHold = JSON.parse(await scalar(`SELECT public.hold_pending_validation_review(
      ${q(KEY)}, ${q(GEN)}::uuid, 0)`));
    expect(staleHold.reason).toBe("stale_validation_snapshot");

    const resumed = JSON.parse(await scalar(`SELECT public.resume_pending_close_finalization(
      ${q(KEY)}, ${q(GEN)}::uuid)`));
    expect(resumed.accepted).toBe(true);
    expect(await scalar(
      `SELECT next_attempt_at IS NOT NULL::text FROM public.pending_sessions WHERE session_key=${q(KEY)}`,
    )).toBe("true");
  });
});
