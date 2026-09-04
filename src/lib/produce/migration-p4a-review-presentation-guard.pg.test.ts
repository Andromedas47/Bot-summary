/**
 * Real PostgreSQL 17 proof for 20260904090000_p4a_review_presentation_guard.sql.
 *
 * Reproduces the production loop UAT found after PR #117: a recorded review
 * whose delivery could never be stamped, because the P4A append-only guard
 * trigger (installed by 20260810070313) still permitted only the confirmation
 * columns to move. mark_produce_validation_review(s)_presented UPDATEs
 * presented_delivered_at and presented_line_event_id, so every stamp raised
 *   'P4A: confirmation cannot be cleared' / 'only the confirmation columns'
 * the row stayed presented_delivered_at IS NULL, confirm_ returned
 * not_presented, and the operator saw the same unknown-product review forever.
 *
 * The chain is applied WITHOUT the fix first, and the stamp is proven to raise
 * (this is what fails on current main). The forward migration is then applied,
 * and both legal transitions plus every forbidden mutation are proven.
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
const DATABASE = `p4apg_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^p4apg_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const ROUND = "11111111-1111-4111-8111-111111111111"; // seeded by the bootstrap
const SESSION_KEY = "group:G-round";
const EXCEPTIONS = `'[{"kind":"price_not_withdrawn","enteredPrice":120,"withdrawnPrices":[100]}]'::jsonb`;

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-p4a-review-presentation-guard.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
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
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database, PGCLIENTENCODING: "UTF8" },
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

async function expectFailure(sql: string): Promise<string> {
  const result = await run(sql);
  expect(result.code, `expected failure but succeeded:\n${sql}`).not.toBe(0);
  return `${result.stderr}${result.stdout}`;
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

let digestSeq = 1;
function nextDigest(): string {
  return (digestSeq++).toString(16).padStart(64, "0");
}
let genSeq = 1;
function nextGen(): string {
  return `00000000-0000-4000-8000-${String(genSeq++).padStart(12, "0")}`;
}

const migration = (name: string) => join(ROOT, "supabase", "migrations", name);

async function record(gen: string, digest: string, eventId: string, round: string | null = ROUND): Promise<string> {
  const roundSql = round === null ? "NULL" : `'${round}'::uuid`;
  return scalar(`
    SELECT coalesce(r->>'status', 'recorded') FROM public.record_produce_validation_review(
      '${SESSION_KEY}', '${gen}'::uuid, ${roundSql}, '${digest}',
      DATE '2026-08-09', 'วัดทุ่งลานนา', 'กี้', ${EXCEPTIONS}, 'U-typist', '${eventId}'
    ) AS r`);
}

function markManySql(gen: string, digests: string[], eventId: string): string {
  const arr = `ARRAY[${digests.map((d) => `'${d}'`).join(",")}]::text[]`;
  return `SELECT public.mark_produce_validation_reviews_presented('${SESSION_KEY}', '${gen}'::uuid, ${arr}, '${eventId}')`;
}
function markOneSql(gen: string, digest: string, eventId: string): string {
  return `SELECT public.mark_produce_validation_review_presented('${SESSION_KEY}', '${gen}'::uuid, '${digest}', '${eventId}')`;
}
async function markMany(gen: string, digests: string[], eventId: string): Promise<{ status: string; marked: number }> {
  return JSON.parse(await scalar(markManySql(gen, digests, eventId)));
}
async function markOne(gen: string, digest: string, eventId: string): Promise<{ status: string }> {
  return JSON.parse(await scalar(markOneSql(gen, digest, eventId)));
}
async function confirm(gen: string, digest: string, eventId: string, actor = "U-typist"): Promise<{ status: string }> {
  return JSON.parse(await scalar(
    `SELECT public.confirm_produce_validation_review('${SESSION_KEY}', '${gen}'::uuid, '${digest}', '${actor}', '${eventId}')`,
  ));
}
async function deliveredAt(gen: string, digest: string): Promise<string> {
  return scalar(`
    SELECT coalesce(presented_delivered_at::text, '<null>') FROM public.produce_entry_validation_reviews
    WHERE session_generation = '${gen}'::uuid AND validation_digest = '${digest}'`);
}
async function presentedEventId(gen: string, digest: string): Promise<string> {
  return scalar(`
    SELECT presented_line_event_id FROM public.produce_entry_validation_reviews
    WHERE session_generation = '${gen}'::uuid AND validation_digest = '${digest}'`);
}
async function forceUpdate(gen: string, digest: string, setClause: string): Promise<string> {
  return expectFailure(`
    UPDATE public.produce_entry_validation_reviews SET ${setClause}
    WHERE session_generation = '${gen}'::uuid AND validation_digest = '${digest}'`);
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_P4A_PRESENTATION_GUARD_POSTGRES === "1") {
  throw new Error("REQUIRE_P4A_PRESENTATION_GUARD_POSTGRES=1 but the PostgreSQL 17 harness is unavailable");
}

describe.skipIf(!pgAvailable)("P4A review presentation guard on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;

    // Base schema (accountability_rounds + pending_sessions + seed round).
    await apply(join(ROOT, "supabase", "tests", "p4a_produce_entry_validation_bootstrap.sql"));
    // The delivery functions read pending_sessions.terminalized; the base
    // bootstrap predates that column, so add it here (a missing pending row is
    // treated as not-terminalized, which is why most tests need no row).
    const altered = await run(
      "ALTER TABLE public.pending_sessions ADD COLUMN IF NOT EXISTS terminalized boolean NOT NULL DEFAULT false",
    );
    expect(altered.code, altered.stderr).toBe(0);

    // The production migration chain, up to and NOT including the fix.
    await apply(migration("20260810070313_p4a_produce_entry_validation_gate.sql"));
    await apply(migration("20260810112416_p4a_review_session_generation_uuid.sql"));
    await apply(migration("20260901090000_produce_finalizer_review_presentation.sql"));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  // ── The regression, before the fix ─────────────────────────────────────────

  test("REGRESSION — before the fix, stamping delivery raises the append-only guard", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    expect(await record(gen, digest, "evt-rec")).toBe("recorded");

    // Both the batch and the single-row stamp trip the pre-fix guard: the batch
    // rebinds presented_line_event_id (a non-confirmation column) and neither
    // sets confirmed_at, so the old guard raises.
    const batchErr = await expectFailure(markManySql(gen, [digest], "evt-present"));
    expect(batchErr).toMatch(/confirmation cannot be cleared|only the confirmation columns/);

    const singleErr = await expectFailure(markOneSql(gen, digest, "evt-present"));
    expect(singleErr).toMatch(/confirmation cannot be cleared|only the confirmation columns/);

    // The exact production symptom: the row can never become delivered.
    expect(await deliveredAt(gen, digest)).toBe("<null>");
  });

  test("apply the forward guard migration", async () => {
    await apply(migration("20260904090000_p4a_review_presentation_guard.sql"));
    // The live guard is now the evolved one.
    expect(await scalar(`
      SELECT (obj_description('public.produce_entry_validation_guard_update()'::regprocedure) LIKE '%delivery-proof transition%')::text`))
      .toBe("true");
  });

  // ── Transition A: delivery ─────────────────────────────────────────────────

  test("delivery stamp (batch) succeeds, is idempotent, and rebinds to the delivering event", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");

    // The presenting event is REBOUND from the recording attempt to the event
    // that actually delivered the review.
    expect(await markMany(gen, [digest], "evt-deliver")).toMatchObject({ status: "presented", marked: 1 });
    expect(await presentedEventId(gen, digest)).toBe("evt-deliver");
    expect(await deliveredAt(gen, digest)).not.toBe("<null>");

    // Idempotent: a redelivery marks nothing new and keeps the first delivering
    // event — a later duplicate can never masquerade as a distinct presenter.
    expect(await markMany(gen, [digest], "evt-deliver-2")).toMatchObject({ status: "presented", marked: 0 });
    expect(await presentedEventId(gen, digest)).toBe("evt-deliver");
  });

  test("delivery stamp (single row) succeeds and is idempotent", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");

    expect(await markOne(gen, digest, "evt-deliver")).toMatchObject({ status: "presented" });
    expect(await presentedEventId(gen, digest)).toBe("evt-deliver");
    expect(await markOne(gen, digest, "evt-deliver-2")).toMatchObject({ status: "already_presented" });
    expect(await presentedEventId(gen, digest)).toBe("evt-deliver");
  });

  // ── Transition B: confirm ──────────────────────────────────────────────────

  test("a delivered review confirms on a DISTINCT event; the presenting event cannot self-confirm", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");
    await markMany(gen, [digest], "evt-present");

    // The very event that presented the set must never confirm it.
    expect(await confirm(gen, digest, "evt-present")).toMatchObject({ status: "not_found" });

    expect(await confirm(gen, digest, "evt-confirm")).toMatchObject({ status: "confirmed" });
    expect(await confirm(gen, digest, "evt-confirm")).toMatchObject({ status: "already_confirmed" });

    const row = JSON.parse(await scalar(`
      SELECT to_jsonb(r) FROM public.produce_entry_validation_reviews r
      WHERE session_generation = '${gen}'::uuid AND validation_digest = '${digest}'`));
    expect(row.confirmed_line_event_id).toBe("evt-confirm");
    expect(row.presented_line_event_id).toBe("evt-present"); // untouched by confirm
  });

  test("mark_presented then confirm is exactly the two-step contract PR #117 required", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");
    expect((await markMany(gen, [digest], "evt-present")).status).toBe("presented");
    expect((await confirm(gen, digest, "evt-confirm")).status).toBe("confirmed");
  });

  // ── Forbidden mutations ────────────────────────────────────────────────────

  test("confirming a review that was never delivered is refused (RPC and raw)", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");

    // The RPC fails safe without mutating.
    expect(await confirm(gen, digest, "evt-confirm")).toMatchObject({ status: "not_presented" });
    // A forced confirmation still cannot bypass the delivery requirement.
    expect(await forceUpdate(gen, digest,
      "confirmed_at = now(), confirmed_by_line_user_id = 'U-x', confirmed_line_event_id = 'evt-x'"))
      .toContain("must be presented before confirmation");
  });

  test("delivery proof cannot be cleared, and the presenting event cannot be rewritten after delivery", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");
    await markMany(gen, [digest], "evt-present");

    expect(await forceUpdate(gen, digest, "presented_delivered_at = NULL"))
      .toContain("presentation delivery proof cannot be cleared");
    // Rewriting the presenting event id outside the first delivery is not a
    // permitted transition.
    expect(await forceUpdate(gen, digest, "presented_line_event_id = 'evt-forged'"))
      .toContain("not a permitted validation review transition");
  });

  test("business identity is immutable across every transition", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");
    await markMany(gen, [digest], "evt-present");

    for (const setClause of [
      "exceptions = '[]'::jsonb",
      "validation_digest = '" + "f".repeat(64) + "'",
      "market_label = 'somewhere else'",
      "presented_at = now() + interval '1 day'",
    ]) {
      expect(await forceUpdate(gen, digest, setClause)).toContain("business identity is immutable");
    }
  });

  test("a confirmed review is immutable — its confirmation cannot be cleared", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");
    await markMany(gen, [digest], "evt-present");
    await confirm(gen, digest, "evt-confirm");

    expect(await forceUpdate(gen, digest,
      "confirmed_at = NULL, confirmed_by_line_user_id = NULL, confirmed_line_event_id = NULL"))
      .toContain("immutable");
    expect(await forceUpdate(gen, digest, "market_label = 'x'")).toContain("immutable");
  });

  test("the audit stays append-only — no delete", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    await record(gen, digest, "evt-rec");
    expect(await expectFailure(`
      DELETE FROM public.produce_entry_validation_reviews
      WHERE session_generation = '${gen}'::uuid`)).toContain("append-only");
  });

  test("a terminalized generation refuses the delivery stamp", async () => {
    const gen = nextGen();
    const digest = nextDigest();
    // A pending row that is terminalized makes the stamp fail safe (status only,
    // no mutation), preserving the terminalization protection.
    await run(`
      INSERT INTO public.pending_sessions (session_key, session_generation, terminalized)
      VALUES ('${SESSION_KEY}', '${gen}'::uuid, true)`);
    expect((await markMany(gen, [digest], "evt-present")).status).toBe("terminalized");
    expect((await markOne(gen, digest, "evt-present")).status).toBe("terminalized");
  });

  test("the guard pins its search_path and is SECURITY DEFINER", async () => {
    expect(await scalar(`
      SELECT (prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=pg_catalog, public%')::text
      FROM pg_proc WHERE oid = 'public.produce_entry_validation_guard_update()'::regprocedure`)).toBe("true");
  });
});

describe.skipIf(pgAvailable)("P4A review presentation guard PostgreSQL harness", () => {
  test("skipped without a disposable PostgreSQL 17 instance", () => {
    expect(pgAvailable).toBe(false);
  });
});
