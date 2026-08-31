/**
 * PostgreSQL 17 proof for 20260831120000_produce_close_validation_race.sql.
 *
 * Reproduces the real Production failure of 2026-08-30: the close was admitted
 * at 06:13:30.544Z while legitimate items whose LINE timestamps preceded it
 * kept committing until 06:13:36.980Z. The close boundary landed on a document
 * the entry gate had never seen, and the session later terminalized as
 * failed_closed with validation_errors = ["entry validation review was never
 * confirmed"].
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

const SOURCE = "C4fa145d58f23a17e7e7b14315f334c6d";
const OWNER = "U3f04f748584d997819dec0fc71a9b084";

// The real ordering from 2026-08-30, in LINE milliseconds.
const CLOSE_TS = 1_756_534_410_544; // 06:13:30.544Z — close event
const LATE_ITEM_TS = CLOSE_TS - 4_000; // pre-close LINE timestamp...
const POST_CLOSE_TS = CLOSE_TS + 1; // ...versus a genuinely post-close one

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-produce-close-validation-race.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

function spawnPsql(args: string[], database = DATABASE, stdin?: string) {
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

interface Session {
  key: string;
  generation: string;
  roundId: string;
}

async function seedSession(): Promise<Session> {
  const generation = nextUuid();
  const roundId = nextUuid();
  const key = `group:${SOURCE}:user:${OWNER}:${generation}`;
  await scalar(
    `INSERT INTO public.accountability_rounds (id, status)
     VALUES (${q(roundId)}::uuid, 'open') RETURNING 1`,
  );
  await scalar(`
    INSERT INTO public.pending_sessions (
      session_key, session_generation, source_id, line_user_id,
      accumulated_text, accountability_round_id, runtime_environment
    ) VALUES (
      ${q(key)}, ${q(generation)}::uuid, ${q(SOURCE)}, ${q(OWNER)},
      ${q("จิ้ว-ราชพฤก ชั่งคืน")}, ${q(roundId)}::uuid, 'production'
    ) RETURNING 1`);
  return { key, generation, roundId };
}

/** One ordinary item message. Bumps ingest_revision, like real operator content. */
async function admitItem(s: Session, eventId: string, timestampMs: number): Promise<string> {
  return await scalar(`
    SELECT public.append_pending_session(
      ${q(s.key)}, ${q(`ทุเรียน 10 ${eventId}`)}, NULL, ${q(eventId)},
      ${timestampMs}, false, ${q(s.generation)}::uuid, NULL
    )->>'reason'`);
}

/** A close attempt pinned to the revision the entry gate validated. */
async function closeWithPin(
  s: Session,
  eventId: string,
  pinnedRevision: number | null,
  timestampMs = CLOSE_TS,
): Promise<{ reason: string; accepted: string; currentRevision: string }> {
  const line = await scalar(`
    SELECT
      (r->>'reason') || '|' || (r->>'accepted') || '|' || coalesce(r->>'current_revision', '')
    FROM public.append_pending_session(
      ${q(s.key)}, ${q("จบรายการเบิก")}, NULL, ${q(eventId)},
      ${timestampMs}, true, ${q(s.generation)}::uuid, NULL,
      ${pinnedRevision === null ? "NULL" : pinnedRevision}
    ) AS r`);
  const [reason, accepted, currentRevision] = line.split("|");
  return { reason, accepted, currentRevision };
}

async function field(key: string, column: string): Promise<string> {
  return await scalar(
    `SELECT coalesce(${column}::text, '<null>') FROM public.pending_sessions
     WHERE session_key = ${q(key)}`,
  );
}

async function revisionOf(key: string): Promise<number> {
  return Number(await field(key, "ingest_revision"));
}

async function hold(s: Session, pinnedRevision: number | null): Promise<string> {
  return await scalar(`
    SELECT public.hold_pending_validation_review(
      ${q(s.key)}, ${q(s.generation)}::uuid,
      ${pinnedRevision === null ? "NULL" : pinnedRevision})->>'reason'`);
}

async function resume(s: Session): Promise<string> {
  return await scalar(`
    SELECT public.resume_pending_close_finalization(
      ${q(s.key)}, ${q(s.generation)}::uuid)->>'reason'`);
}

async function recordReview(s: Session, digest: string, eventId: string): Promise<string> {
  return await scalar(`
    SELECT coalesce(r->>'status', 'recorded')
    FROM public.record_produce_validation_review(
      ${q(s.key)}, ${q(s.generation)}::uuid, ${q(s.roundId)}::uuid, ${q(digest)},
      DATE '2026-08-30', 'ราชพฤก', 'จิ้ว', '[]'::jsonb, ${q(OWNER)}, ${q(eventId)}
    ) AS r`);
}

async function confirmReview(s: Session, digest: string, eventId: string): Promise<string> {
  return await scalar(`
    SELECT public.confirm_produce_validation_review(
      ${q(s.key)}, ${q(s.generation)}::uuid, ${q(digest)}, ${q(OWNER)}, ${q(eventId)}
    )->>'status'`);
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_CLOSE_VALIDATION_RACE_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_CLOSE_VALIDATION_RACE_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("produce close validation race on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "produce_close_validation_race_bootstrap.sql"));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260831120000_produce_close_validation_race.sql",
    ));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  beforeEach(async () => {
    await scalar("DELETE FROM public.produce_entry_validation_reviews RETURNING 1");
    await scalar("DELETE FROM public.pending_session_ingest RETURNING 1");
    await scalar("DELETE FROM public.pending_session_admission RETURNING 1");
    await scalar("DELETE FROM public.pending_sessions RETURNING 1");
    await scalar("DELETE FROM public.accountability_rounds RETURNING 1");
  });

  test("the migration is idempotent", async () => {
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260831120000_produce_close_validation_race.sql",
    ));
    expect(await scalar(`
      SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'append_pending_session'`)).toBe("2");
  });

  // ── A. Atomic first-close revision pin ────────────────────────────────────

  test("THE 30 AUG RACE — a pre-close item committing after the gate refuses the close", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    await admitItem(s, "evt-item-2", CLOSE_TS - 15_000);

    // The entry gate validates THIS revision.
    const gateRevision = await revisionOf(s.key);

    // A legitimate item whose LINE timestamp is BEFORE the close commits after
    // the gate read the document — exactly the 06:13:36.980Z admissions.
    expect(await admitItem(s, "evt-late-item", LATE_ITEM_TS)).toBe("appended");
    expect(await revisionOf(s.key)).toBe(gateRevision + 1);

    const close = await closeWithPin(s, "evt-close", gateRevision);
    expect(close.reason).toBe("stale_validation_snapshot");
    expect(close.accepted).toBe("false");
    expect(close.currentRevision).toBe(String(gateRevision + 1));

    // No stale boundary was stamped, nothing was terminalized, and no
    // finalization was scheduled from the stale validation.
    expect(await field(s.key, "close_event_timestamp_ms")).toBe("<null>");
    expect(await field(s.key, "close_requested_at")).toBe("<null>");
    expect(await field(s.key, "next_attempt_at")).toBe("<null>");
    expect(await field(s.key, "terminalized")).toBe("false");
    expect(await field(s.key, "finalization_status")).toBe("pending");
  });

  test("retrying the close against the grown document succeeds — nothing is lost", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);
    await admitItem(s, "evt-late-item", LATE_ITEM_TS);

    expect((await closeWithPin(s, "evt-close", gateRevision)).reason)
      .toBe("stale_validation_snapshot");

    // The operator closes again; the gate now validates the complete list.
    const retryRevision = await revisionOf(s.key);
    expect((await closeWithPin(s, "evt-close-2", retryRevision)).reason).toBe("appended");
    expect(await field(s.key, "close_event_timestamp_ms")).toBe(String(CLOSE_TS));

    // Both items and the late one survived.
    expect(await scalar(
      `SELECT count(*)::text FROM public.pending_session_admission
       WHERE session_generation = ${q(s.generation)}::uuid`)).toBe("3");
  });

  test("revision unchanged — a normal close still works exactly as before", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);

    expect((await closeWithPin(s, "evt-close", gateRevision)).reason).toBe("appended");
    expect(await field(s.key, "close_event_timestamp_ms")).toBe(String(CLOSE_TS));
    expect(await field(s.key, "close_session_generation")).toBe(s.generation);
    expect(await field(s.key, "next_attempt_at")).not.toBe("<null>");
  });

  test("a NULL pin behaves exactly like the unpinned 8-arg close", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    await admitItem(s, "evt-late", LATE_ITEM_TS);
    expect((await closeWithPin(s, "evt-close", null)).reason).toBe("appended");
    expect(await field(s.key, "close_event_timestamp_ms")).toBe(String(CLOSE_TS));
  });

  test("the pin is FIRST-CLOSE only — a second close still reports status", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);
    expect((await closeWithPin(s, "evt-close", gateRevision)).reason).toBe("appended");

    // Late pre-close admission moves the revision AFTER the boundary exists.
    expect(await admitItem(s, "evt-late-item", LATE_ITEM_TS)).toBe("appended");

    // A genuine second close must still work despite the moved revision.
    const second = await closeWithPin(s, "evt-close-2", gateRevision);
    expect(second.reason).toBe("close_already_requested");
    expect(second.accepted).toBe("true");
  });

  // ── A2. Generation identity outranks revision freshness ───────────────────

  test("generation changed AND revision changed -> generation_conflict, never stale", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);

    // The session rotates to a replacement generation and grows content.
    const replacement = nextUuid();
    await scalar(`
      UPDATE public.pending_sessions
      SET session_generation = ${q(replacement)}::uuid,
          ingest_revision = ingest_revision + 1
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    // A stale close from the ORIGINAL generation must be told the generation
    // moved. stale_validation_snapshot would invite a retry that lands on the
    // replacement generation.
    const close = await closeWithPin(s, "evt-stale-close", gateRevision);
    expect(close.reason).toBe("generation_conflict");
    expect(close.reason).not.toBe("stale_validation_snapshot");
    expect(close.accepted).toBe("false");

    // The replacement generation got no close boundary out of it.
    expect(await field(s.key, "close_event_timestamp_ms")).toBe("<null>");
    expect(await field(s.key, "close_requested_at")).toBe("<null>");
    expect(await field(s.key, "session_generation")).toBe(replacement);
  });

  test("terminalized generation AND revision changed -> terminalized, never stale", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);
    await scalar(`
      UPDATE public.pending_sessions
      SET terminalized = true,
          finalization_status = 'failed_closed',
          ingest_revision = ingest_revision + 1
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    const close = await closeWithPin(s, "evt-stale-close", gateRevision);
    expect(close.reason).toBe("terminalized");
    expect(close.reason).not.toBe("stale_validation_snapshot");
    expect(await field(s.key, "close_event_timestamp_ms")).toBe("<null>");
  });

  test("generation changed but revision identical -> still generation_conflict", async () => {
    const s = await seedSession();
    const gateRevision = await revisionOf(s.key);
    const replacement = nextUuid();
    await scalar(`
      UPDATE public.pending_sessions SET session_generation = ${q(replacement)}::uuid
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    expect((await closeWithPin(s, "evt-stale-close", gateRevision)).reason)
      .toBe("generation_conflict");
  });

  // ── B. Out-of-order admission is unchanged ────────────────────────────────

  test("post-close LINE timestamps are still rejected", async () => {
    const s = await seedSession();
    const gateRevision = await revisionOf(s.key);
    await closeWithPin(s, "evt-close", gateRevision);

    expect(await admitItem(s, "evt-after", POST_CLOSE_TS)).toBe("after_close_boundary");
    expect(await scalar(
      `SELECT count(*)::text FROM public.pending_session_admission
       WHERE line_event_id = 'evt-after'`)).toBe("0");
  });

  test("a duplicate delivery of an admitted event stays a no-op", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const revision = await revisionOf(s.key);
    expect(await admitItem(s, "evt-item-1", CLOSE_TS - 20_000)).toBe("duplicate_event");
    expect(await revisionOf(s.key)).toBe(revision);
  });

  // ── C. Recoverable post-boundary validation hold ──────────────────────────

  test("a held generation parks finalization without terminalizing", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    const gateRevision = await revisionOf(s.key);
    await closeWithPin(s, "evt-close", gateRevision);
    await admitItem(s, "evt-late-item", LATE_ITEM_TS);

    const heldRevision = await revisionOf(s.key);
    expect(await hold(s, heldRevision)).toBe("held");

    expect(await field(s.key, "next_attempt_at")).toBe("<null>");
    expect(await field(s.key, "terminalized")).toBe("false");
    expect(await field(s.key, "finalization_status")).toBe("pending");
    // Evidence and the close boundary are untouched.
    expect(await field(s.key, "close_event_timestamp_ms")).toBe(String(CLOSE_TS));
    expect(await field(s.key, "ingest_revision")).toBe(String(heldRevision));
  });

  test("a hold whose revision moved again is refused rather than parking stale state", async () => {
    const s = await seedSession();
    const gateRevision = await revisionOf(s.key);
    await closeWithPin(s, "evt-close", gateRevision);
    const stale = await revisionOf(s.key);
    await admitItem(s, "evt-late-item", LATE_ITEM_TS);

    expect(await hold(s, stale)).toBe("stale_validation_snapshot");
    expect(await field(s.key, "next_attempt_at")).not.toBe("<null>");
  });

  test("hold refuses an open (never closed) session", async () => {
    const s = await seedSession();
    expect(await hold(s, await revisionOf(s.key))).toBe("not_closing");
  });

  test("a distinct later confirmation resumes a held generation", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await admitItem(s, "evt-late-item", LATE_ITEM_TS);
    await hold(s, await revisionOf(s.key));

    expect(await recordReview(s, "digest-1", "evt-present")).toBe("recorded");
    expect(await confirmReview(s, "digest-1", "evt-confirm")).toBe("confirmed");
    expect(await resume(s)).toBe("resumed");

    expect(await field(s.key, "next_attempt_at")).not.toBe("<null>");
    expect(await field(s.key, "terminalized")).toBe("false");
  });

  test("a duplicate delivery of the PRESENTING event does not self-confirm", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-1", "evt-present");

    // The very event that presented the set must never confirm it.
    expect(await confirmReview(s, "digest-1", "evt-present")).toBe("not_found");
    expect(await scalar(
      `SELECT coalesce(confirmed_at::text, '<null>')
       FROM public.produce_entry_validation_reviews WHERE validation_digest = 'digest-1'`))
      .toBe("<null>");

    // A genuinely distinct later event still confirms.
    expect(await confirmReview(s, "digest-1", "evt-confirm")).toBe("confirmed");
  });

  // ── D. Terminalized generations ───────────────────────────────────────────

  test("a terminalized generation grows no new review and confirms none", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await recordReview(s, "digest-1", "evt-present");
    await scalar(`
      UPDATE public.pending_sessions
      SET terminalized = true, finalization_status = 'failed_closed'
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    expect(await recordReview(s, "digest-2", "evt-stale-close")).toBe("terminalized");
    expect(await scalar(
      `SELECT count(*)::text FROM public.produce_entry_validation_reviews
       WHERE validation_digest = 'digest-2'`)).toBe("0");

    // And an old generation cannot authorize anything after the fact.
    expect(await confirmReview(s, "digest-1", "evt-late-confirm")).toBe("terminalized");
  });

  test("hold and resume both refuse a terminalized generation", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await scalar(`
      UPDATE public.pending_sessions SET terminalized = true
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    expect(await hold(s, await revisionOf(s.key))).toBe("terminalized");
    expect(await resume(s)).toBe("terminalized");
  });

  test("hold and resume refuse a generation conflict", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    const impostor: Session = { ...s, generation: nextUuid() };
    expect(await hold(impostor, null)).toBe("generation_conflict");
    expect(await resume(impostor)).toBe("generation_conflict");
  });

  // ── D2. The terminalized guard is atomic, not a TOCTOU ────────────────────

  test("lock order is pending_sessions before produce_entry_validation_reviews", async () => {
    // A consistent order across both review RPCs is what makes the pair
    // deadlock-free against every writer that terminalizes.
    for (const fn of ["record_produce_validation_review", "confirm_produce_validation_review"]) {
      // Flattened: scalar() reads a single line and prosrc is multi-line.
      const src = await scalar(`
        SELECT translate(p.prosrc, E'\\n\\r\\t', '   ')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ${q(fn)}`);
      // Compare STATEMENTS, not any mention: the DECLARE block names the
      // review table as a row type long before either table is touched.
      const pendingLock = src.indexOf("FROM public.pending_sessions");
      const reviewStatements = [
        src.indexOf("INSERT INTO public.produce_entry_validation_reviews"),
        src.indexOf("FROM public.produce_entry_validation_reviews"),
        src.indexOf("UPDATE public.produce_entry_validation_reviews"),
      ].filter((index) => index > -1);

      expect(pendingLock).toBeGreaterThan(-1);
      expect(reviewStatements.length).toBeGreaterThan(0);
      expect(pendingLock).toBeLessThan(Math.min(...reviewStatements));
    }
    expect(await scalar(`
      SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('record_produce_validation_review', 'confirm_produce_validation_review')
        AND p.prosrc LIKE '%FOR UPDATE%'`)).toBe("2");
  });

  test("a review cannot be recorded across a concurrent terminalization", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));

    // Holder takes the pending_sessions row lock, terminalizes, and only then
    // commits. Any recorder that read terminalized WITHOUT the lock would slip
    // its INSERT in during the sleep.
    const holder = spawnPsql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, `
      BEGIN;
      SELECT terminalized FROM public.pending_sessions
      WHERE session_key = ${q(s.key)} FOR UPDATE;
      SELECT pg_sleep(2);
      UPDATE public.pending_sessions
      SET terminalized = true, finalization_status = 'failed_closed'
      WHERE session_key = ${q(s.key)};
      COMMIT;
    `);

    // Let the holder acquire the lock before the recorder attempts anything.
    await Bun.sleep(600);
    const status = await recordReview(s, "digest-race", "evt-present");
    const holderResult = await collect(holder);
    expect(holderResult.code, holderResult.stderr).toBe(0);

    // The recorder blocked on the lock, then observed the committed terminal
    // state — it did not slip a review in beforehand.
    expect(status).toBe("terminalized");
    expect(await scalar(
      `SELECT count(*)::text FROM public.produce_entry_validation_reviews
       WHERE validation_digest = 'digest-race'`)).toBe("0");
    expect(await field(s.key, "terminalized")).toBe("true");
  }, 30_000);

  test("a review cannot be confirmed across a concurrent terminalization", async () => {
    const s = await seedSession();
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    expect(await recordReview(s, "digest-race-2", "evt-present")).toBe("recorded");

    const holder = spawnPsql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, `
      BEGIN;
      SELECT terminalized FROM public.pending_sessions
      WHERE session_key = ${q(s.key)} FOR UPDATE;
      SELECT pg_sleep(2);
      UPDATE public.pending_sessions SET terminalized = true
      WHERE session_key = ${q(s.key)};
      COMMIT;
    `);

    await Bun.sleep(600);
    const status = await confirmReview(s, "digest-race-2", "evt-confirm");
    const holderResult = await collect(holder);
    expect(holderResult.code, holderResult.stderr).toBe(0);

    expect(status).toBe("terminalized");
    expect(await scalar(
      `SELECT coalesce(confirmed_at::text, '<null>')
       FROM public.produce_entry_validation_reviews
       WHERE validation_digest = 'digest-race-2'`)).toBe("<null>");
  }, 30_000);

  // ── E. #108 inactivity interaction ────────────────────────────────────────

  test("a held session is invisible to both #108 inactivity sweeps", async () => {
    const s = await seedSession();
    await admitItem(s, "evt-item-1", CLOSE_TS - 20_000);
    await closeWithPin(s, "evt-close", await revisionOf(s.key));
    await hold(s, await revisionOf(s.key));
    await scalar(`
      UPDATE public.pending_sessions SET updated_at = now() - interval '90 minutes'
      WHERE session_key = ${q(s.key)} RETURNING 1`);

    // Both sweeps require close_event_timestamp_ms IS NULL. A held session has
    // a boundary, so neither can claim it — no auto-finalization, no expiry.
    expect(await scalar(`
      SELECT count(*)::text FROM public.pending_sessions p
      WHERE p.session_key = ${q(s.key)}
        AND p.terminalized = false
        AND p.close_event_timestamp_ms IS NULL
        AND p.close_requested_at IS NULL
        AND p.next_attempt_at IS NULL`)).toBe("0");

    expect(await field(s.key, "terminalized")).toBe("false");
    expect(await field(s.key, "finalization_status")).toBe("pending");
  });
});
