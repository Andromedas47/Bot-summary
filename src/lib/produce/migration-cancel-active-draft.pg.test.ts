/**
 * PostgreSQL 17 proof for `cancel_active_pending_produce_draft`.
 *
 * The operator types the exact command `ยกเลิกรายการ` and the ONE draft they are
 * currently filling in is abandoned. What has to be true, and is proven here:
 *
 *   * the draft terminalizes with the structured reason `user_cancelled`, and
 *     nothing is deleted — accumulated_text and every timestamp survive;
 *   * a round that holds real business data is NEVER cancelled, and a
 *     previously finalized produce session in that round is never touched;
 *   * a provably empty reserved round IS retired, through the existing
 *     `retire_empty_round_of_generation` primitive and no new rule;
 *   * every way this could destroy work in flight is refused, not raced: a
 *     close or finalization already started, a rotated generation, a
 *     concurrent append, another source, another runtime environment;
 *   * a redelivery of the SAME cancel is a success replay that writes nothing,
 *     while a delayed duplicate can never cancel a draft opened afterwards.
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

const DATE = "2026-08-17";
const SELLER = "ดำ";
const MARKET = "ราชพฤกษ์";
const SOURCE = "C4fa145d58f23a17e7e7b14315f334c6d";
const OTHER_SOURCE = "Cffffffffffffffffffffffffffffffff";
const OWNER = "U3f04f748584d997819dec0fc71a9b084";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-cancel-active-draft.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
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
  return `00000000-0000-4000-9000-${String(sequence++).padStart(12, "0")}`;
}

interface RoundOptions {
  /** Give the round a real produce_transactions row — a populated round. */
  withdrawal?: boolean;
  status?: "open" | "cancelled";
}

async function seedRound(options: RoundOptions = {}): Promise<string> {
  const id = nextUuid();
  await scalar(`
    INSERT INTO public.accountability_rounds (
      id, source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized, status, created_line_event_id
    ) VALUES (
      ${q(id)}::uuid, 'group', ${q(SOURCE)}, ${q(OWNER)}, DATE ${q(DATE)},
      ${q(SELLER)}, ${q(MARKET)}, ${q(MARKET)}, ${q(options.status ?? "open")},
      ${q(`event:${id}`)}
    ) RETURNING 1`);
  if (options.withdrawal) {
    await scalar(`
      INSERT INTO public.produce_transactions (accountability_round_id, base_transaction_type)
      VALUES (${q(id)}::uuid, 'เบิก') RETURNING 1`);
  }
  return id;
}

/** The four draft shapes the one primitive has to cover. */
const DRAFTS = {
  withdrawal: `${SELLER}-${MARKET} เบิก 17/8/2569\n1.มังคุด45บาท\n10โล`,
  goodReturn: `${SELLER}-${MARKET} ชั่งคืน 17/8/2569\n1.มังคุด45บาท\n4โล`,
  badReturn: `${SELLER}-${MARKET} คืนเสีย 17/8/2569\n1.มังคุด45บาท\n1โล`,
  additional: `${SELLER}-${MARKET} เบิกเพิ่ม 17/8/2569\n1.ทุเรียน120บาท\n3โล`,
} as const;

interface PendingOptions {
  roundId?: string | null;
  text?: string;
  terminalized?: boolean;
  /** Write a close boundary / close request / finalize start / 'processing'. */
  closeShape?: "boundary" | "requested" | "finalizing" | "processing";
  environment?: string | null;
  sourceId?: string | null;
  entryOrigin?: string | null;
  /** Current-generation opener timestamp; NULL omits stamped evidence. */
  openerTimestamp?: number | null;
  openedLineEventId?: string;
}

async function seedPending(options: PendingOptions = {}) {
  const generation = nextUuid();
  const key = `group:${SOURCE}:user:${OWNER}:${generation}`;
  const shape = options.closeShape ?? null;
  const structured = options.entryOrigin === "structured_menu";
  const openerTimestamp = options.openerTimestamp === undefined ? 1000 : options.openerTimestamp;
  const evidenceTimestamp = openerTimestamp ?? 1000;
  const openerEventId = options.openedLineEventId ?? `evt-open-${generation}`;
  const plainOpenerEventId = structured
    ? null
    : options.openedLineEventId ?? (openerTimestamp === null ? null : openerEventId);
  await scalar(`
    INSERT INTO public.pending_sessions (
      session_key, session_generation, source_id, line_user_id, accumulated_text,
      accountability_round_id, terminalized, created_at, updated_at,
      close_requested_at, close_event_timestamp_ms, close_finalize_started_at,
      close_deadline_at, next_attempt_at, finalization_status, runtime_environment,
      entry_origin, opened_line_event_id,
      plain_text_opened_line_event_id, plain_text_opened_line_timestamp_ms
    ) VALUES (
      ${q(key)}, ${q(generation)}::uuid,
      ${options.sourceId === null ? "NULL" : q(options.sourceId ?? SOURCE)},
      ${q(OWNER)},
      ${q(options.text ?? DRAFTS.withdrawal)},
      ${options.roundId === undefined || options.roundId === null
        ? "NULL"
        : `${q(options.roundId)}::uuid`},
      ${options.terminalized === true},
      now(), now(),
      ${shape === "requested" ? "now()" : "NULL"},
      ${shape === "boundary" ? "1000" : "NULL"},
      ${shape === "finalizing" ? "now()" : "NULL"},
      NULL, NULL,
      ${shape === "processing" ? "'processing'" : "'pending'"},
      ${options.environment === null ? "NULL" : q(options.environment ?? "production")},
      ${structured ? q(options.entryOrigin!) : "NULL"},
      ${structured ? q(openerEventId) : "NULL"},
      ${plainOpenerEventId === null ? "NULL" : q(plainOpenerEventId)},
      ${structured || openerTimestamp === null ? "NULL" : String(openerTimestamp)}
    ) RETURNING 1`);
  const rawOpenerEventId = structured ? openerEventId : plainOpenerEventId;
  if (rawOpenerEventId !== null) {
    await scalar(`
      INSERT INTO public.raw_messages (line_event_id, payload)
      VALUES (${q(rawOpenerEventId)}, jsonb_build_object('timestamp', ${evidenceTimestamp}))
      RETURNING 1`);
  }
  return { key, generation };
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

async function pendingUpdatedAt(key: string): Promise<string> {
  return await scalar(
    `SELECT updated_at::text FROM public.pending_sessions WHERE session_key = ${q(key)}`,
  );
}

interface CancelOptions {
  /** Override the snapshot the caller claims to have resolved. */
  expected?: string | null;
  /** Override the generation the caller claims to be cancelling. */
  generation?: string;
  sourceId?: string | null;
  lineEventId?: string;
  lineTimestamp?: number | null;
  environment?: string | null;
}

interface CancelResult {
  cancelled?: boolean;
  reason?: string;
  round_outcome?: string;
  accountability_round_id?: string | null;
}

/**
 * `p_expected_updated_at` defaults to whatever the row says right now, which is
 * what an honest caller that just resolved the row would send.
 */
async function cancel(
  key: string,
  generation: string,
  options: CancelOptions = {},
): Promise<CancelResult> {
  const expected = options.expected === undefined
    ? await pendingUpdatedAt(key)
    : options.expected;
  const lineTimestamp = options.lineTimestamp === undefined ? 2000 : options.lineTimestamp;
  const environment = options.environment === undefined ? "production" : options.environment;
  return JSON.parse(await scalar(`
    SELECT public.cancel_active_pending_produce_draft(
      ${q(key)},
      ${q(options.generation ?? generation)}::uuid,
      ${expected === null ? "NULL" : `${q(expected)}::timestamptz`},
      ${lineTimestamp === null ? "NULL" : String(lineTimestamp)},
      ${options.sourceId === null ? "NULL" : q(options.sourceId ?? SOURCE)},
      ${q(options.lineEventId ?? "evt-cancel")},
      ${environment === null ? "NULL" : q(environment)})`));
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

describe.skipIf(!pgAvailable)("cancel the active produce draft on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "round_market_identity_bootstrap.sql"));
    await apply(join(ROOT, "supabase", "tests", "produce_pending_lifecycle_bootstrap.sql"));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260817080439_produce_pending_supersession_and_close_recovery.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260817085632_produce_supersession_runtime_environment.sql",
    ));
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260818034244_produce_cancel_active_pending_draft.sql",
    ));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  });

  test("the migration is idempotent", async () => {
    await apply(join(
      ROOT, "supabase", "migrations",
      "20260818034244_produce_cancel_active_pending_draft.sql",
    ));
    expect(await scalar(`
      SELECT count(*)::text FROM pg_proc
      WHERE proname = 'cancel_active_pending_produce_draft'`)).toBe("1");
    expect(await scalar(`
      SELECT (to_regprocedure(
        'public.cancel_active_pending_produce_draft(text,uuid,timestamptz,bigint,text,text,text)'
      ) IS NOT NULL)::text`)).toBe("true");
    expect(await scalar(`
      SELECT (to_regprocedure(
        'public.cancel_active_pending_produce_draft(text,uuid,timestamptz,text,text,text)'
      ) IS NULL)::text`)).toBe("true");
  });

  // ── 1-4. Every draft shape, one primitive ──────────────────────────────────

  for (const [name, text] of Object.entries(DRAFTS)) {
    test(`an active ${name} draft is cancelled and nothing is deleted`, async () => {
      const { key, generation } = await seedPending({ text });
      const result = await cancel(key, generation);

      expect(result.cancelled).toBe(true);
      expect(result.reason).toBe("cancelled");
      expect(await pendingField(key, "terminalized")).toBe("true");
      expect(await pendingField(key, "finalization_status")).toBe("failed_closed");
      expect(await pendingField(key, "finalization_error->>'reason'")).toBe("user_cancelled");
      expect(await pendingField(key, "finalization_error->>'cancel_line_event_id'"))
        .toBe("evt-cancel");
      expect(await pendingField(key, "next_attempt_at")).toBe("<null>");
      expect(await pendingField(key, "finalized_at")).not.toBe("<null>");
      // Evidence survives, byte for byte. Nothing is hard-deleted.
      expect(await pendingField(key, `(accumulated_text = ${q(text)})`)).toBe("true");
      // No close boundary is invented, so the row stays outside the
      // reconciliation failed-close path forever.
      expect(await pendingField(key, "close_event_timestamp_ms")).toBe("<null>");
    });
  }

  test("a prior close-refusal audit blob survives the cancellation", async () => {
    // The PRIMARY UX path: the P4A gate refuses a plain-text close,
    // mark_plain_text_close_refused records WHY (and writes no close boundary,
    // so the draft stays cancellable), then the operator gives up and cancels.
    // finalization_error must be MERGED, not assigned — the only record of the
    // refusal reason lives in those keys, and the function's COMMENT promises
    // it deletes nothing.
    const { key, generation } = await seedPending();
    await scalar(`
      UPDATE public.pending_sessions
      SET finalization_error = jsonb_build_object(
            'reason', 'close_refused',
            'close_line_event_id', 'evt-close',
            'close_refused_reason', 'unmatched_products'
          )
      WHERE session_key = ${q(key)} RETURNING 1`);

    expect((await cancel(key, generation)).cancelled).toBe(true);

    // `reason` is overwritten — user_cancelled is the terminal truth now.
    expect(await pendingField(key, "finalization_error->>'reason'")).toBe("user_cancelled");
    expect(await pendingField(key, "finalization_error->>'cancel_line_event_id'"))
      .toBe("evt-cancel");
    // Every prior key survives beside it.
    expect(await pendingField(key, "finalization_error->>'close_line_event_id'"))
      .toBe("evt-close");
    expect(await pendingField(key, "finalization_error->>'close_refused_reason'"))
      .toBe("unmatched_products");
  });

  // ── 5-7. Rounds and previously finalized business ──────────────────────────

  test("a previously finalized produce session in the same round is untouched", async () => {
    const round = await seedRound();
    const finalized = await seedProduceSession(round);
    const { key, generation } = await seedPending({ roundId: round });

    expect((await cancel(key, generation)).cancelled).toBe(true);

    expect(await scalar(`
      SELECT count(*)::text FROM public.produce_sessions WHERE id = ${q(finalized)}::uuid`))
      .toBe("1");
    expect(await scalar(`
      SELECT accountability_round_id::text FROM public.produce_sessions
      WHERE id = ${q(finalized)}::uuid`)).toBe(round);
  });

  test("a populated accountability round survives the cancellation", async () => {
    const round = await seedRound({ withdrawal: true });
    const { key, generation } = await seedPending({ roundId: round });

    const result = await cancel(key, generation);
    expect(result.cancelled).toBe(true);
    expect(result.round_outcome).toBe("has_transactions");
    expect(await roundStatus(round)).toBe("open");
  });

  test("a round holding a produce session survives the cancellation", async () => {
    const round = await seedRound();
    await seedProduceSession(round);
    const { key, generation } = await seedPending({ roundId: round });

    expect((await cancel(key, generation)).round_outcome).toBe("has_produce_sessions");
    expect(await roundStatus(round)).toBe("open");
  });

  test("a provably empty reserved round is retired", async () => {
    const round = await seedRound();
    const { key, generation } = await seedPending({ roundId: round });

    const result = await cancel(key, generation);
    expect(result.cancelled).toBe(true);
    expect(result.round_outcome).toBe("cancelled");
    expect(await roundStatus(round)).toBe("cancelled");
  });

  test("a draft bound to no round at all cancels cleanly", async () => {
    const { key, generation } = await seedPending({ roundId: null });
    expect((await cancel(key, generation)).round_outcome).toBe("no_round");
  });

  // ── 9, 14, 15. Refusals that protect work in flight ────────────────────────

  for (const shape of ["boundary", "requested", "finalizing", "processing"] as const) {
    test(`a draft whose close is in flight (${shape}) is refused, not raced`, async () => {
      const { key, generation } = await seedPending({ closeShape: shape });
      const result = await cancel(key, generation);

      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe("close_in_progress");
      // Nothing was written: the finalizer still owns this generation and wins.
      expect(await pendingField(key, "terminalized")).toBe("false");
      expect(await pendingField(key, "finalization_error")).toBe("<null>");
    });
  }

  test("a rotated generation answers generation_conflict and writes nothing", async () => {
    const { key, generation } = await seedPending();
    const stale = nextUuid();
    const result = await cancel(key, generation, { generation: stale });

    expect(result).toEqual({ cancelled: false, reason: "generation_conflict" });
    expect(await pendingField(key, "terminalized")).toBe("false");
    expect(await pendingField(key, "session_generation")).toBe(generation);
  });

  test("a concurrent append answers draft_changed — the generation never rotated", async () => {
    const { key, generation } = await seedPending();
    const snapshot = await pendingUpdatedAt(key);
    // Exactly what append_pending_session does: new text, new updated_at, SAME
    // session_generation. The generation check alone cannot see this.
    await scalar(`
      UPDATE public.pending_sessions
      SET accumulated_text = accumulated_text || E'\\n5โล', updated_at = clock_timestamp()
      WHERE session_key = ${q(key)} RETURNING 1`);

    const result = await cancel(key, generation, { expected: snapshot });
    expect(result).toEqual({ cancelled: false, reason: "draft_changed" });
    expect(await pendingField(key, "terminalized")).toBe("false");
    expect(await pendingField(key, "(accumulated_text LIKE '%5โล%')")).toBe("true");
  });

  test("a caller that cannot name the snapshot it resolved cancels nothing", async () => {
    const { key, generation } = await seedPending();
    expect(await cancel(key, generation, { expected: null }))
      .toEqual({ cancelled: false, reason: "expected_updated_at_required" });
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("an already terminal generation is never re-terminalized", async () => {
    const { key, generation } = await seedPending({ terminalized: true });
    expect(await cancel(key, generation))
      .toEqual({ cancelled: false, reason: "already_terminal" });
  });

  test("an unknown session key answers not_found", async () => {
    expect(await cancel("group:nobody:user:nobody", nextUuid(), {
      expected: "2026-08-17 12:00:00+07",
    })).toEqual({ cancelled: false, reason: "not_found" });
  });

  // ── 12-13. Redelivery ──────────────────────────────────────────────────────

  test("the same LINE event delivered twice is an idempotent success replay", async () => {
    const { key, generation } = await seedPending();
    expect((await cancel(key, generation, { lineEventId: "evt-dup" })).cancelled).toBe(true);
    const afterFirst = await pendingUpdatedAt(key);

    const replay = await cancel(key, generation, {
      lineEventId: "evt-dup",
      expected: afterFirst,
    });
    expect(replay).toEqual({ cancelled: true, reason: "already_cancelled" });
    // No second write: the terminal snapshot is byte-identical.
    expect(await pendingUpdatedAt(key)).toBe(afterFirst);
  });

  test("a DIFFERENT event id is not this cancellation and cannot replay it", async () => {
    const { key, generation } = await seedPending();
    expect((await cancel(key, generation, { lineEventId: "evt-a" })).cancelled).toBe(true);
    const afterFirst = await pendingUpdatedAt(key);

    const other = await cancel(key, generation, {
      lineEventId: "evt-b",
      expected: afterFirst,
    });
    expect(other).toEqual({ cancelled: false, reason: "already_terminal" });
    expect(await pendingField(key, "finalization_error->>'cancel_line_event_id'")).toBe("evt-a");
  });

  test("a foreign SOURCE replaying a matching event id is refused, not congratulated", async () => {
    // The replay branch answers cancelled=true, which the caller renders as ✅.
    // Ownership therefore has to be decided BEFORE it: nothing is written
    // either way, but a caller that does not own this row must never be told
    // its cancellation succeeded.
    const { key, generation } = await seedPending();
    expect((await cancel(key, generation, { lineEventId: "evt-own" })).cancelled).toBe(true);
    const afterFirst = await pendingUpdatedAt(key);

    expect(await cancel(key, generation, {
      lineEventId: "evt-own",
      sourceId: OTHER_SOURCE,
      expected: afterFirst,
    })).toEqual({ cancelled: false, reason: "source_mismatch" });
  });

  test("a foreign ENVIRONMENT replaying a matching event id is refused, not congratulated", async () => {
    const { key, generation } = await seedPending({ environment: "production" });
    expect((await cancel(key, generation, { lineEventId: "evt-own" })).cancelled).toBe(true);
    const afterFirst = await pendingUpdatedAt(key);

    // Preview replaying against a Production-owned cancelled row.
    expect(await cancel(key, generation, {
      lineEventId: "evt-own",
      environment: "preview",
      expected: afterFirst,
    })).toEqual({ cancelled: false, reason: "environment_mismatch" });
  });

  test("a delayed duplicate cancel cannot cancel a newly opened generation", async () => {
    const { key, generation } = await seedPending();
    expect((await cancel(key, generation, { lineEventId: "evt-old" })).cancelled).toBe(true);

    // The operator starts a fresh document on the SAME session key — a
    // rotation, exactly as openPlainTextGeneration does.
    const fresh = nextUuid();
    await scalar(`
      UPDATE public.pending_sessions
      SET session_generation = ${q(fresh)}::uuid, terminalized = false,
          finalization_status = 'pending', finalization_error = NULL,
          accumulated_text = ${q(DRAFTS.goodReturn)}, updated_at = clock_timestamp()
      WHERE session_key = ${q(key)} RETURNING 1`);

    // The DB-level backstop behind the raw_messages unique constraint: the old
    // generation cannot reach the new draft.
    const replayed = await cancel(key, generation, { lineEventId: "evt-old" });
    expect(replayed).toEqual({ cancelled: false, reason: "generation_conflict" });
    expect(await pendingField(key, "terminalized")).toBe("false");
    expect(await pendingField(key, "session_generation")).toBe(fresh);
  });

  test("a plain-text cancel at or before the current opener is refused", async () => {
    const { key, generation } = await seedPending({ openerTimestamp: 2000 });

    expect(await cancel(key, generation, { lineTimestamp: 1999 }))
      .toEqual({ cancelled: false, reason: "event_before_opener" });
    expect(await pendingField(key, "terminalized")).toBe("false");

    expect((await cancel(key, generation, { lineTimestamp: 2001 })).cancelled).toBe(true);
  });

  test("legacy plain text with no explicit opener evidence refuses", async () => {
    const { key, generation } = await seedPending({ openerTimestamp: null });

    expect(await cancel(key, generation, { lineTimestamp: 999 }))
      .toEqual({ cancelled: false, reason: "opener_boundary_unproven" });
    expect(await cancel(key, generation, { lineTimestamp: 1001 }))
      .toEqual({ cancelled: false, reason: "opener_boundary_unproven" });
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("plain text never falls back to an earlier out-of-order admission item", async () => {
    const { key, generation } = await seedPending({
      openerTimestamp: null,
      text: "draft-before-real-opener",
    });

    // MIN(admission) is 1000, the delayed cancel is 2000, and the real opener
    // evidence is later at 3000 — but that raw event is not linked as this
    // generation's explicit opener. The boundary is therefore unproven.
    await scalar(`
      INSERT INTO public.pending_session_admission (
        session_key, session_generation, line_event_id, line_timestamp_ms
      ) VALUES (${q(key)}, ${q(generation)}::uuid, 'evt-out-of-order-item', 1000)
      RETURNING 1`);
    await scalar(`
      INSERT INTO public.raw_messages (line_event_id, payload)
      VALUES ('evt-real-opener', jsonb_build_object('timestamp', 3000))
      RETURNING 1`);

    expect(await cancel(key, generation, { lineTimestamp: 2000 }))
      .toEqual({ cancelled: false, reason: "opener_boundary_unproven" });
    expect(await pendingField(key, "terminalized")).toBe("false");
    expect(await pendingField(key, "accumulated_text")).toBe("draft-before-real-opener");
  });

  test("plain text can use its exact opener raw message timestamp", async () => {
    const { key, generation } = await seedPending({
      openerTimestamp: null,
      openedLineEventId: "evt-plain-opener",
    });

    expect(await cancel(key, generation, { lineTimestamp: 999 }))
      .toEqual({ cancelled: false, reason: "event_before_opener" });
    expect((await cancel(key, generation, { lineTimestamp: 1001 })).cancelled).toBe(true);
  });

  test("structured cancellation uses the opener raw message timestamp", async () => {
    const { key, generation } = await seedPending({
      entryOrigin: "structured_menu",
      openerTimestamp: 3000,
    });

    expect(await cancel(key, generation, { lineTimestamp: 2999 }))
      .toEqual({ cancelled: false, reason: "event_before_opener" });
    expect((await cancel(key, generation, { lineTimestamp: 3001 })).cancelled).toBe(true);
  });

  for (const structured of [false, true] as const) {
    test(
      `malformed opener evidence refuses cancellation (${structured ? "structured" : "plain-text"})`,
      async () => {
        const openerEventId = `evt-malformed-opener-${structured ? "structured" : "plain"}`;
        const { key, generation } = await seedPending({
          entryOrigin: structured ? "structured_menu" : null,
          openerTimestamp: null,
          openedLineEventId: openerEventId,
        });
        await scalar(`
          UPDATE public.raw_messages
          SET payload = jsonb_build_object('timestamp', '3000')
          WHERE line_event_id = ${q(openerEventId)} RETURNING 1`);

        expect(await cancel(key, generation, { lineTimestamp: 3001 }))
          .toEqual({ cancelled: false, reason: "opener_boundary_unproven" });
        expect(await pendingField(key, "terminalized")).toBe("false");
      },
    );
  }

  for (const structured of [false, true] as const) {
    test(
      `a delayed cancel cannot cross a generation boundary (${structured ? "structured" : "plain-text"})`,
      async () => {
        const generationA = await seedPending({
          entryOrigin: structured ? "structured_menu" : null,
          openerTimestamp: structured ? 3000 : 1000,
        });
        const generationB = nextUuid();
        const openerEventB = `evt-open-b-${generationB}`;
        const openerTimestampB = structured ? 3000 : 2500;

        // Same session key, fresh generation. This is what the webhook lookup
        // resolves while a delayed cancel authored for A is still in flight.
        await scalar(`
          UPDATE public.pending_sessions
          SET session_generation = ${q(generationB)}::uuid,
              terminalized = false,
              finalization_status = 'pending',
              finalization_error = NULL,
              accumulated_text = ${q(`generation-B-${structured ? "structured" : "plain"}`)},
              updated_at = clock_timestamp(),
              entry_origin = ${structured ? q("structured_menu") : "NULL"},
              opened_line_event_id = ${structured ? q(openerEventB) : "NULL"},
              plain_text_opened_line_event_id = ${structured ? "NULL" : q(openerEventB)},
              plain_text_opened_line_timestamp_ms = ${structured ? "NULL" : String(openerTimestampB)}
          WHERE session_key = ${q(generationA.key)} RETURNING 1`);
        if (structured) {
          await scalar(`
            INSERT INTO public.raw_messages (line_event_id, payload)
            VALUES (${q(openerEventB)}, jsonb_build_object('timestamp', ${openerTimestampB}))
            RETURNING 1`);
        }

        const snapshotB = await pendingUpdatedAt(generationA.key);
        const delayed = await cancel(generationA.key, generationB, {
          expected: snapshotB,
          lineTimestamp: 2000,
          lineEventId: `evt-cancel-a-${structured ? "structured" : "plain"}`,
        });
        expect(delayed).toEqual({ cancelled: false, reason: "event_before_opener" });
        expect(await pendingField(generationA.key, "terminalized")).toBe("false");
        expect(await pendingField(generationA.key, "session_generation"))
          .toBe(generationB);
        expect(await pendingField(generationA.key, "accumulated_text"))
          .toBe(`generation-B-${structured ? "structured" : "plain"}`);

        const currentEvent = `evt-cancel-b-${structured ? "structured" : "plain"}`;
        expect((await cancel(generationA.key, generationB, {
          expected: snapshotB,
          lineTimestamp: openerTimestampB + 1,
          lineEventId: currentEvent,
        })).cancelled).toBe(true);
        const replaySnapshot = await pendingUpdatedAt(generationA.key);
        expect(await cancel(generationA.key, generationB, {
          expected: replaySnapshot,
          lineTimestamp: openerTimestampB + 1,
          lineEventId: currentEvent,
        })).toEqual({ cancelled: true, reason: "already_cancelled" });
      },
    );
  }

  for (const structured of [false, true] as const) {
    test(
      `missing opener evidence refuses cancellation (${structured ? "structured" : "plain-text"})`,
      async () => {
        const { key, generation } = await seedPending({
          entryOrigin: structured ? "structured_menu" : null,
        });
        if (structured) {
          await scalar(`
            DELETE FROM public.raw_messages
            WHERE line_event_id = (
              SELECT opened_line_event_id FROM public.pending_sessions
              WHERE session_key = ${q(key)}
            ) RETURNING 1`);
        } else {
          await scalar(`
            UPDATE public.pending_sessions
            SET plain_text_opened_line_event_id = NULL,
                plain_text_opened_line_timestamp_ms = NULL
            WHERE session_key = ${q(key)} RETURNING 1`);
        }
        const result = await cancel(key, generation, { lineTimestamp: 2001 });
        expect(result).toEqual({ cancelled: false, reason: "opener_boundary_unproven" });
        expect(await pendingField(key, "terminalized")).toBe("false");
      },
    );
  }

  // ── 16-18. Ownership ───────────────────────────────────────────────────────

  test("source A cannot cancel source B's draft", async () => {
    const { key, generation } = await seedPending();
    const result = await cancel(key, generation, { sourceId: OTHER_SOURCE });

    expect(result).toEqual({ cancelled: false, reason: "source_mismatch" });
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("a legacy row with no source_id is still cancellable — session_key carries the source", async () => {
    const { key, generation } = await seedPending({ sourceId: null });
    expect((await cancel(key, generation)).cancelled).toBe(true);
  });

  test("Preview cannot cancel a Production draft", async () => {
    const { key, generation } = await seedPending({ environment: "production" });
    const result = await cancel(key, generation, { environment: "preview" });

    expect(result).toEqual({ cancelled: false, reason: "environment_mismatch" });
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("Production cannot cancel a Preview draft either", async () => {
    const { key, generation } = await seedPending({ environment: "preview" });
    expect(await cancel(key, generation, { environment: "production" }))
      .toEqual({ cancelled: false, reason: "environment_mismatch" });
  });

  test("Production owns a legacy NULL runtime_environment", async () => {
    const { key, generation } = await seedPending({ environment: null });
    expect((await cancel(key, generation, { environment: "production" })).cancelled).toBe(true);
  });

  for (const environment of ["preview", "development"] as const) {
    test(`NULL is never a wildcard for ${environment}`, async () => {
      const { key, generation } = await seedPending({ environment: null });
      expect(await cancel(key, generation, { environment }))
        .toEqual({ cancelled: false, reason: "environment_mismatch" });
      expect(await pendingField(key, "terminalized")).toBe("false");
    });
  }

  test("an unrecognised runtime environment is refused rather than guessed", async () => {
    const { key, generation } = await seedPending();
    expect(await cancel(key, generation, { environment: "staging" }))
      .toEqual({ cancelled: false, reason: "invalid_runtime_environment" });
    expect(await cancel(key, generation, { environment: null }))
      .toEqual({ cancelled: false, reason: "invalid_runtime_environment" });
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("a missing session key or event id is a programming error, not an outcome", async () => {
    const { key, generation } = await seedPending();
    const noKey = await run(`
      SELECT public.cancel_active_pending_produce_draft(
        '', ${q(generation)}::uuid, now(), 2000, ${q(SOURCE)}, 'evt', 'production')`);
    expect(noKey.code).not.toBe(0);
    const noEvent = await run(`
      SELECT public.cancel_active_pending_produce_draft(
        ${q(key)}, ${q(generation)}::uuid, now(), 2000, ${q(SOURCE)}, '  ', 'production')`);
    expect(noEvent.code).not.toBe(0);
    expect(await pendingField(key, "terminalized")).toBe("false");
  });

  test("the function is not reachable by anon or authenticated", async () => {
    expect(await scalar(`
      SELECT (
        has_function_privilege('anon', oid, 'EXECUTE')
        OR has_function_privilege('authenticated', oid, 'EXECUTE')
      )::text
      FROM pg_proc WHERE proname = 'cancel_active_pending_produce_draft'`)).toBe("false");
    expect(await scalar(`
      SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text
      FROM pg_proc WHERE proname = 'cancel_active_pending_produce_draft'`)).toBe("true");
  });
});
