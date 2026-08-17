/**
 * PostgreSQL 17 proof for pending supersession (P1-A) and close recovery (P1-B).
 *
 * Production 2026-08-17, pending 313eaa61-473d-4041-a6b4-00710fb72c58 (จิ้ว —
 * ราชพฤก, 2026-08-16): the exact close `จบรายการชั่งคืน` was received, the entry
 * gate presented an unconfirmed price review, and the generation was left with
 * close_requested_at, close_deadline_at, close_event_timestamp_ms and
 * next_attempt_at all NULL, terminalized false, finalization_status pending —
 * with the close text sitting in accumulated_text and no deferred event row.
 * Four such rows existed at the time of writing.
 *
 * These tests prove the two terminal outcomes that state can now reach, and that
 * neither of them can touch a generation still legitimately in flight or a round
 * holding real business data.
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
const SELLER = "จิ้ว";
const MARKET = "ราชพฤก";
const SOURCE = "C4fa145d58f23a17e7e7b14315f334c6d";
const OWNER = "U3f04f748584d997819dec0fc71a9b084";
const CLOSE_TEXT = "จบรายการชั่งคืน";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-pending-lifecycle-recovery.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
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
  withdrawal?: boolean;
  market?: string;
  status?: "open" | "cancelled";
}

async function seedRound(options: RoundOptions = {}): Promise<string> {
  const id = nextUuid();
  const market = options.market ?? MARKET;
  await scalar(`
    INSERT INTO public.accountability_rounds (
      id, source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized, status, created_line_event_id
    ) VALUES (
      ${q(id)}::uuid, 'group', ${q(SOURCE)}, ${q(OWNER)}, DATE ${q(DATE)},
      ${q(SELLER)}, ${q(market)}, ${q(market)}, ${q(options.status ?? "open")},
      ${q(`event:${id}`)}
    ) RETURNING 1`);
  if (options.withdrawal) {
    await scalar(`
      INSERT INTO public.produce_transactions (accountability_round_id, base_transaction_type)
      VALUES (${q(id)}::uuid, 'เบิก') RETURNING 1`);
  }
  return id;
}

interface PendingOptions {
  roundId?: string | null;
  /** Minutes ago the row was last touched. */
  idleMinutes?: number;
  terminalized?: boolean;
  closeScheduled?: boolean;
  environment?: string | null;
  text?: string;
}

async function seedPending(options: PendingOptions = {}) {
  const generation = nextUuid();
  const key = `group:${SOURCE}:user:${OWNER}:${generation}`;
  const idle = options.idleMinutes ?? 0;
  await scalar(`
    INSERT INTO public.pending_sessions (
      session_key, session_generation, source_id, line_user_id, accumulated_text,
      accountability_round_id, terminalized, created_at, updated_at,
      close_requested_at, close_event_timestamp_ms, close_deadline_at,
      next_attempt_at, finalization_status, runtime_environment
    ) VALUES (
      ${q(key)}, ${q(generation)}::uuid, ${q(SOURCE)}, ${q(OWNER)},
      ${q(options.text ?? `${SELLER}-${MARKET} ชั่งคืน 16/8/2569\n${CLOSE_TEXT}`)},
      ${options.roundId === undefined || options.roundId === null
        ? "NULL"
        : `${q(options.roundId)}::uuid`},
      ${options.terminalized === true},
      now() - interval '${idle} minutes', now() - interval '${idle} minutes',
      ${options.closeScheduled ? "now()" : "NULL"},
      ${options.closeScheduled ? "1000" : "NULL"},
      ${options.closeScheduled ? "now() + interval '30 seconds'" : "NULL"},
      ${options.closeScheduled ? "now()" : "NULL"},
      'pending',
      ${options.environment === null ? "NULL" : q(options.environment ?? "production")}
    ) RETURNING 1`);
  return { key, generation };
}

async function markRefused(key: string, generation: string, reason = "entry_gate_refusal") {
  return JSON.parse(await scalar(`
    SELECT public.mark_plain_text_close_refused(
      ${q(key)}, ${q(generation)}::uuid, 'evt-close', ${q(reason)})`));
}

/** Backdate the refusal stamp so the grace period has provably elapsed. */
async function ageRefusal(key: string, minutes: number): Promise<void> {
  await scalar(`
    UPDATE public.pending_sessions
    SET close_refused_at = close_refused_at - interval '${minutes} minutes',
        updated_at = updated_at - interval '${minutes} minutes'
    WHERE session_key = ${q(key)} RETURNING 1`);
}

async function recover(): Promise<Array<Record<string, string>>> {
  const output = await run(`
    SELECT session_key || '|' || round_outcome
    FROM public.recover_stranded_plain_text_closes(25, 'production')`);
  if (output.code !== 0) throw new Error(output.stderr);
  return output.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sessionKey, roundOutcome] = line.split("|");
      return { sessionKey, roundOutcome };
    });
}

async function pendingField(key: string, column: string): Promise<string> {
  return await scalar(
    `SELECT coalesce(${column}::text, '<null>') FROM public.pending_sessions
     WHERE session_key = ${q(key)}`,
  );
}

async function roundStatus(id: string): Promise<string> {
  return await scalar(`SELECT status FROM public.accountability_rounds WHERE id = ${q(id)}::uuid`);
}

async function seedProduceSession(roundId: string | null): Promise<string> {
  const id = nextUuid();
  await scalar(`
    INSERT INTO public.produce_sessions (id, session_date, staff_name, accountability_round_id)
    VALUES (${q(id)}::uuid, DATE ${q(DATE)}, ${q(SELLER)},
            ${roundId === null ? "NULL" : `${q(roundId)}::uuid`})
    RETURNING 1`);
  return id;
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_PENDING_LIFECYCLE_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_PENDING_LIFECYCLE_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("pending lifecycle recovery on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "round_market_identity_bootstrap.sql"));
    await apply(join(ROOT, "supabase", "tests", "produce_pending_lifecycle_bootstrap.sql"));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260817090200_produce_pending_supersession_and_close_recovery.sql",
    ));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("the migration is idempotent", async () => {
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260817090200_produce_pending_supersession_and_close_recovery.sql",
    ));
    expect(await scalar(`
      SELECT count(*)::text FROM information_schema.columns
      WHERE table_name = 'pending_sessions'
        AND column_name IN ('close_refused_at', 'close_refused_session_generation')`)).toBe("2");
  });

  // ── P1-B: the stranded close reaches a terminal state ─────────────────────

  test("the exact Production state is recovered, not left pending", async () => {
    const round = await seedRound();
    const { key, generation } = await seedPending({ roundId: round });
    expect((await markRefused(key, generation)).marked).toBe(true);

    // Before the grace period nothing happens — the operator is still in their
    // correction window.
    expect(await recover()).toEqual([]);
    expect(await pendingField(key, "terminalized")).toBe("false");

    await ageRefusal(key, 31);
    const recovered = await recover();
    expect(recovered).toEqual([{ sessionKey: key, roundOutcome: "cancelled" }]);

    expect(await pendingField(key, "terminalized")).toBe("true");
    expect(await pendingField(key, "finalization_status")).toBe("failed_closed");
    expect(await pendingField(key, "finalization_error->>'reason'"))
      .toBe("close_refused_unresolved");
    expect(await pendingField(key, "finalization_error->>'close_refused_reason'"))
      .toBe("entry_gate_refusal");
    expect(await pendingField(key, "next_attempt_at")).toBe("<null>");
    // Evidence survives. Nothing is deleted.
    expect(await pendingField(key, "(accumulated_text LIKE '%' || " + q(CLOSE_TEXT) + " || '%')")).toBe("true");
    expect(await roundStatus(round)).toBe("cancelled");
  });

  test("a generation whose close DID schedule is never stamped or swept", async () => {
    const { key, generation } = await seedPending({ closeScheduled: true, idleMinutes: 120 });
    expect((await markRefused(key, generation)).reason).toBe("close_already_scheduled");
    expect(await recover()).toEqual([]);
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("an operator still sending corrections keeps extending their window", async () => {
    const { key, generation } = await seedPending();
    await markRefused(key, generation);
    await ageRefusal(key, 31);
    // A fresh append touches updated_at, exactly as append_pending_session does.
    await scalar(`UPDATE public.pending_sessions SET updated_at = now()
                  WHERE session_key = ${q(key)} RETURNING 1`);
    expect(await recover()).toEqual([]);
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("a rotation to a new generation retires the stamp with no cleanup write", async () => {
    const { key, generation } = await seedPending();
    await markRefused(key, generation);
    await ageRefusal(key, 31);
    await scalar(`
      UPDATE public.pending_sessions
      SET session_generation = gen_random_uuid(), updated_at = now() - interval '90 minutes'
      WHERE session_key = ${q(key)} RETURNING 1`);
    expect(await recover()).toEqual([]);
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("a terminalized generation is never stamped", async () => {
    const { key, generation } = await seedPending({ terminalized: true });
    expect((await markRefused(key, generation)).reason).toBe("terminalized");
  });

  test("a stale generation of another environment is left alone", async () => {
    const { key, generation } = await seedPending({ environment: "preview" });
    await markRefused(key, generation);
    await ageRefusal(key, 31);
    expect(await recover()).toEqual([]);
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("a legacy NULL-environment row belongs to production", async () => {
    const { key, generation } = await seedPending({ environment: null });
    await markRefused(key, generation);
    await ageRefusal(key, 31);
    expect((await recover()).map((row) => row.sessionKey)).toEqual([key]);
  });

  test("recovery never cancels a round holding real business data", async () => {
    const round = await seedRound({ withdrawal: true });
    const { key, generation } = await seedPending({ roundId: round });
    await markRefused(key, generation);
    await ageRefusal(key, 31);
    expect(await recover()).toEqual([{ sessionKey: key, roundOutcome: "has_transactions" }]);
    expect(await roundStatus(round)).toBe("open");
  });

  test("recovery never cancels a round another generation still holds", async () => {
    const round = await seedRound();
    const first = await seedPending({ roundId: round });
    await seedPending({ roundId: round });
    await markRefused(first.key, first.generation);
    await ageRefusal(first.key, 31);
    expect(await recover())
      .toEqual([{ sessionKey: first.key, roundOutcome: "shared_with_other_generation" }]);
    expect(await roundStatus(round)).toBe("open");
  });

  test("recovery is idempotent under a second sweep", async () => {
    const { key, generation } = await seedPending();
    await markRefused(key, generation);
    await ageRefusal(key, 31);
    expect((await recover()).map((row) => row.sessionKey)).toEqual([key]);
    expect(await recover()).toEqual([]);
  });

  // ── P1-A: supersession only on proof, and only where it is safe ───────────

  test("a proven successor terminalizes the attempt and retires its empty round", async () => {
    const round = await seedRound();
    const { key, generation } = await seedPending({ roundId: round });
    const successor = await seedProduceSession(null);

    const result = JSON.parse(await scalar(`
      SELECT public.supersede_pending_generation(
        ${q(key)}, ${q(generation)}::uuid, ${q(successor)}::uuid,
        '{"business_date": "2026-08-16"}'::jsonb)`));
    expect(result.superseded).toBe(true);
    expect(result.round_outcome).toBe("cancelled");

    expect(await pendingField(key, "terminalized")).toBe("true");
    expect(await pendingField(key, "finalization_status")).toBe("failed_closed");
    expect(await pendingField(key, "finalization_error->>'reason'")).toBe("superseded");
    expect(await pendingField(key, "finalization_error->>'superseded_by_produce_session_id'"))
      .toBe(successor);
    expect(await pendingField(key, "finalization_error->>'business_date'")).toBe("2026-08-16");
    expect(await pendingField(key, "(accumulated_text LIKE '%' || " + q(CLOSE_TEXT) + " || '%')")).toBe("true");
    expect(await roundStatus(round)).toBe("cancelled");
  });

  test("a populated round is never cancelled by supersession", async () => {
    const round = await seedRound({ withdrawal: true });
    const { key, generation } = await seedPending({ roundId: round });
    const successor = await seedProduceSession(null);
    const result = JSON.parse(await scalar(`
      SELECT public.supersede_pending_generation(
        ${q(key)}, ${q(generation)}::uuid, ${q(successor)}::uuid)`));
    expect(result.superseded).toBe(true);
    expect(result.round_outcome).toBe("has_transactions");
    expect(await roundStatus(round)).toBe("open");
  });

  test("a round holding a produce session is never cancelled", async () => {
    const round = await seedRound();
    const { key, generation } = await seedPending({ roundId: round });
    await seedProduceSession(round);
    const successor = await seedProduceSession(null);
    const result = JSON.parse(await scalar(`
      SELECT public.supersede_pending_generation(
        ${q(key)}, ${q(generation)}::uuid, ${q(successor)}::uuid)`));
    expect(result.round_outcome).toBe("has_produce_sessions");
    expect(await roundStatus(round)).toBe("open");
  });

  test("a missing or voided successor is no proof at all", async () => {
    const { key, generation } = await seedPending();
    expect(JSON.parse(await scalar(`
      SELECT public.supersede_pending_generation(
        ${q(key)}, ${q(generation)}::uuid, gen_random_uuid())`)).reason)
      .toBe("successor_not_found");

    const voided = await seedProduceSession(null);
    await scalar(`UPDATE public.produce_sessions SET voided_at = now()
                  WHERE id = ${q(voided)}::uuid RETURNING 1`);
    expect(JSON.parse(await scalar(`
      SELECT public.supersede_pending_generation(
        ${q(key)}, ${q(generation)}::uuid, ${q(voided)}::uuid)`)).reason)
      .toBe("successor_not_found");
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("supersession is idempotent and refuses a stale generation", async () => {
    const { key, generation } = await seedPending();
    const successor = await seedProduceSession(null);
    const call = `SELECT public.supersede_pending_generation(
      ${q(key)}, ${q(generation)}::uuid, ${q(successor)}::uuid)`;
    expect(JSON.parse(await scalar(call)).superseded).toBe(true);
    expect(JSON.parse(await scalar(call)).reason).toBe("already_terminal");

    const other = await seedPending();
    expect(JSON.parse(await scalar(`
      SELECT public.supersede_pending_generation(
        ${q(other.key)}, gen_random_uuid(), ${q(successor)}::uuid)`)).reason)
      .toBe("generation_conflict");
  });
});
