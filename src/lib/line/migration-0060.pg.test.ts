/** Real PostgreSQL 17 proof for the separated LINE webhook ordering queue. */
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
const DATABASE = `wsn_0060_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^wsn_0060_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-0060.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };
async function psql(args: string[], database = DATABASE): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
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
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
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
if (!pgAvailable && process.env.WSN_0060_REQUIRE === "1") {
  throw new Error("WSN_0060_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

async function receive(eventId: string, source = "S-ordered"): Promise<string> {
  const result = await scalar(`
    SELECT public.receive_line_webhook_event(
      '${eventId}', 'dest', 'message', 'user', '${source}', '${source}',
      '${eventId}', 'text', 'test',
      jsonb_build_object('type','message','webhookEventId','${eventId}',
        'timestamp', ${Date.now()}, 'source', jsonb_build_object('type','user','userId','${source}'),
        'message', jsonb_build_object('type','text','id','${eventId}','text','test'))
    )`);
  return JSON.parse(result).raw_message_id;
}

describe.skipIf(!pgAvailable)("0060 separated webhook ordering on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    for (const name of [
      "0001_initial_schema.sql",
      "0038_digital_white_sheet_cash_entries.sql",
      "0043_white_sheet_lifecycle.sql",
      "0059_manual_white_sheet_note_sessions.sql",
      "0060_manual_white_sheet_event_ordering.sql",
    ]) await apply(join(ROOT, "supabase", "migrations", name));
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("receive order is durable and array order is preserved", async () => {
    await receive("evt-open");
    await receive("evt-field");
    await receive("evt-close");
    expect(await scalar("SELECT string_agg(line_event_id, ',' ORDER BY receive_order) FROM public.line_webhook_event_queue WHERE source_id='S-ordered'")).toBe("evt-open,evt-field,evt-close");
  });

  test("atomic receive is idempotent and repairs a retry without duplicate rows", async () => {
    const first = await receive("evt-duplicate");
    const second = await receive("evt-duplicate");
    expect(second).toBe(first);
    expect(await scalar("SELECT count(*) FROM public.raw_messages WHERE line_event_id='evt-duplicate'")).toBe("1");
    expect(await scalar("SELECT count(*) FROM public.line_webhook_event_queue WHERE line_event_id='evt-duplicate'")).toBe("1");
  });

  test("a close cannot claim while an earlier field is processing, then proceeds after explicit success", async () => {
    const source = "S-barrier";
    const openRaw = await receive("evt-b-open", source);
    const fieldRaw = await receive("evt-b-field", source);
    const closeRaw = await receive("evt-b-close", source);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-barrier')"))).toMatchObject({ raw_message_id: openRaw });
    await scalar(`SELECT public.complete_line_webhook_event('${openRaw}', 'processed')`);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-barrier')"))).toMatchObject({ raw_message_id: fieldRaw });
    expect(await scalar("SELECT public.claim_line_webhook_event('S-barrier')")).toBe("");
    await scalar(`SELECT public.complete_line_webhook_event('${fieldRaw}', 'processed')`);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-barrier')"))).toMatchObject({ raw_message_id: closeRaw });
  });

  test("failed earlier event explicitly unblocks later close", async () => {
    const source = "S-failed";
    const first = await receive("evt-failed-1", source);
    const second = await receive("evt-failed-2", source);
    await scalar("SELECT public.claim_line_webhook_event('S-failed')");
    await scalar(`SELECT public.complete_line_webhook_event('${first}', 'failed', 'invalid field block')`);
    expect(JSON.parse(await scalar("SELECT public.claim_line_webhook_event('S-failed')"))).toMatchObject({ raw_message_id: second });
  });

  test("different sources do not share the ordering barrier", async () => {
    const first = await receive("evt-a", "S-a");
    const second = await receive("evt-b", "S-b");
    const [a, b] = await Promise.all([
      scalar("SELECT public.claim_line_webhook_event('S-a')"),
      scalar("SELECT public.claim_line_webhook_event('S-b')"),
    ]);
    expect(JSON.parse(a)).toMatchObject({ raw_message_id: first });
    expect(JSON.parse(b)).toMatchObject({ raw_message_id: second });
  });
});

if (!pgAvailable) describe("0060 PostgreSQL 17 unavailable", () => test.skip("requires local PostgreSQL 17", () => {}));
