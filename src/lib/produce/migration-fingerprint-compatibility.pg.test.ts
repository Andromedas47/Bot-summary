/**
 * PostgreSQL 17 proof for the authoritative duplicate path across fingerprint
 * generations.
 *
 * The unit tests prove the V0/V1/V2 hashes relate correctly. This proves the
 * thing that actually decides whether a produce session persists:
 * `try_finalize_pending_generation` and the UNIQUE `imported_sessions`
 * reservation it takes.
 *
 * Every "previously persisted" hash below is produced by the real
 * previous-generation function, so a drift in the fingerprint code fails here
 * rather than in Production.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  computeLegacySessionHash,
  computeSessionHash,
} from "@/lib/line/session-dedup-service";
import {
  weighSessionCompatibilityFingerprints,
  weighSessionLegacyMarketFingerprint,
} from "./business-fingerprint";
import { baseTransactionType } from "@/lib/summary/transactions";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `fpc_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^fpc_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const DATE = "15/8/2569";
const ISO_DATE = "2026-08-15";
const ACTOR = "U3f04f748584d997819dec0fc71a9b084";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-fingerprint-compatibility.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
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

/** A ต้อม withdrawal, retyped under any market spelling. */
function withdrawal(market: string, options: { extra?: boolean; kind?: "additional" } = {}) {
  const head = options.kind === "additional" ? "เบิกเพิ่ม" : "เบิก";
  return parseWeighSession(
    [
      `ต้อม-${market} ${head} ${DATE}`,
      "กระชาย 20 บาท",
      "6 แพค",
      ...(options.extra ? ["มะนาว 50 บาท", "3 โล"] : []),
      `จบรายการ${head}`,
    ].join("\n"),
    ISO_DATE,
  );
}

/** Seed a pending generation that is closing and ready to finalize. */
async function seedPending(sessionKey: string): Promise<{ generation: string; rawMessageId: string }> {
  const generation = randomUUID();
  const rawMessageId = randomUUID();
  await scalar(`
    INSERT INTO public.raw_messages (id) VALUES (${q(rawMessageId)}::uuid);
    INSERT INTO public.pending_sessions (
      session_key, session_generation, line_user_id, ingest_revision,
      close_event_timestamp_ms, close_requested_at, close_deadline_at,
      close_session_generation, next_attempt_at
    ) VALUES (
      ${q(sessionKey)}, ${q(generation)}::uuid, ${q(ACTOR)}, 1,
      1000, now(), now() + interval '30 seconds',
      ${q(generation)}::uuid, now() - interval '1 second'
    );
    SELECT 1`);
  return { generation, rawMessageId };
}

interface FinalizeOptions {
  sessionKey: string;
  generation: string;
  rawMessageId: string;
  parsed: WeighSession;
  /** Omit to let the RPC default it — the "old application build" call shape. */
  compatibility?: string[] | null;
  sessionKind?: "main" | "additional";
}

function sqlTextArray(values: string[]): string {
  return `ARRAY[${values.map(q).join(", ")}]::text[]`;
}

/** The two jsonb payloads the finalizer takes, as the application builds them. */
function payloadFor(
  parsed: WeighSession,
  rawMessageId: string,
  sessionKey: string,
  generation: string,
): { session: string; items: string } {
  const items = parsed.items.map((item) => ({
    item_number: item.item_number,
    product_name: item.product_name,
    price_per_unit: item.price_per_unit,
    quantity: item.quantity,
    unit: item.unit,
    section: item.section,
    transaction_type: item.transaction_type,
  }));
  return {
    session: JSON.stringify({
      raw_message_id: rawMessageId,
      staff_name: parsed.staff_name,
      session_date: parsed.date,
      session_title: parsed.session_title,
      transaction_types: [...new Set(items.map((i) => i.transaction_type))].sort().join(","),
      session_kind: "main",
      declared_transaction_type: parsed.declared_transaction_type,
      ingest_idempotency_key: `${sessionKey}:${generation}`,
      ingest_source: "line_webhook",
      item_count: parsed.items.length,
    }),
    items: JSON.stringify(items),
  };
}

async function finalize(options: FinalizeOptions): Promise<{ status: string; reason?: string }> {
  const { parsed } = options;
  const kind = options.sessionKind ?? "main";
  // An additional session must declare a BASE transaction type and carry base
  // types on its items — the same folding the real finalizer does before it
  // builds this payload.
  const items = parsed.items.map((item) => ({
    item_number: item.item_number,
    product_name: item.product_name,
    price_per_unit: item.price_per_unit,
    quantity: item.quantity,
    unit: item.unit,
    section: item.section,
    transaction_type: kind === "additional"
      ? baseTransactionType(item.transaction_type) ?? item.transaction_type
      : item.transaction_type,
  }));
  const sessionPayload = {
    raw_message_id: options.rawMessageId,
    staff_name: parsed.staff_name,
    session_date: parsed.date,
    session_title: parsed.session_title,
    transaction_types: [...new Set(items.map((i) => i.transaction_type))].sort().join(","),
    session_kind: kind,
    declared_transaction_type: kind === "additional"
      ? baseTransactionType(parsed.declared_transaction_type ?? "เบิกเพิ่ม") ?? "เบิก"
      : parsed.declared_transaction_type,
    ingest_idempotency_key: `${options.sessionKey}:${options.generation}`,
    ingest_source: "line_webhook",
    item_count: parsed.items.length,
  };

  const compatibilityArg =
    options.compatibility === undefined
      ? ""
      : `, ${options.compatibility === null ? "NULL::text[]" : sqlTextArray(options.compatibility)}`;

  return JSON.parse(await scalar(`
    SELECT public.try_finalize_pending_generation(
      ${q(options.sessionKey)}, ${q(options.generation)}::uuid, ${q(ACTOR)}, 1,
      ${q(computeSessionHash(parsed))}, 'raw',
      ${q(JSON.stringify(sessionPayload))}::jsonb,
      ${q(JSON.stringify(items))}::jsonb${compatibilityArg}
    )`));
}

/** Full submit: seed a fresh generation, then finalize it. */
async function submit(
  label: string,
  parsed: WeighSession,
  options: { compatibility?: string[] | null; sessionKind?: "main" | "additional" } = {},
): Promise<{ status: string; reason?: string }> {
  const sessionKey = `group:G:${label}:${randomBytes(3).toString("hex")}`;
  const { generation, rawMessageId } = await seedPending(sessionKey);
  return finalize({
    sessionKey,
    generation,
    rawMessageId,
    parsed,
    compatibility: options.compatibility === undefined
      ? weighSessionCompatibilityFingerprints(parsed)
      : options.compatibility,
    sessionKind: options.sessionKind,
  });
}

/** Write a row the PREVIOUS generation would have written. */
async function seedImported(hash: string, marketName: string): Promise<void> {
  await scalar(`
    INSERT INTO public.imported_sessions (session_hash, market_name)
    VALUES (${q(hash)}, ${q(marketName)})
    ON CONFLICT (session_hash) DO NOTHING;
    SELECT 1`);
}

async function produceSessionCount(): Promise<number> {
  return Number(await scalar("SELECT count(*)::text FROM public.produce_sessions"));
}

/**
 * The application does not call this function positionally. Supabase's client
 * posts a JSON object to PostgREST, which invokes the function with NAMED
 * arguments — so the only call shape worth proving is the named one. The old
 * build sends exactly the eight parameters it knows about and omits
 * `p_compatibility_hashes` entirely; the new build sends nine.
 *
 * This is psql rather than PostgREST — the harness has no HTTP layer — so it
 * reproduces the argument *binding* PostgREST performs, not its HTTP routing.
 * That is the half that can break: resolution against a function whose ninth
 * parameter is defaulted.
 */
function namedCall(args: Record<string, string>): string {
  const bound = Object.entries(args).map(([name, value]) => `${name} => ${value}`);
  return `SELECT public.try_finalize_pending_generation(${bound.join(", ")})`;
}

/** The eight parameters every deployed build has always sent. */
function oldAppArgs(sessionKey: string, generation: string, hash: string, session: string, items: string) {
  return {
    p_session_key: q(sessionKey),
    p_expected_generation: `${q(generation)}::uuid`,
    p_expected_line_user_id: q(ACTOR),
    p_snapshot_revision: "1",
    p_session_hash: q(hash),
    p_raw_text: "'raw'",
    p_session: `${q(session)}::jsonb`,
    p_items: `${q(items)}::jsonb`,
  };
}

const pgAvailable = await probe();
let databaseCreated = false;
let forbiddenState: PsqlResult;
if (!pgAvailable && process.env.REQUIRE_FINGERPRINT_COMPATIBILITY_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_FINGERPRINT_COMPATIBILITY_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("fingerprint compatibility on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(join(ROOT, "supabase", "tests", "produce_fingerprint_compatibility_bootstrap.sql"));
    // The 0061 function, then the compatibility reissue on top of it — the same
    // order Production applies them in.
    await apply(join(ROOT, "supabase", "migrations", "0061_pending_session_runtime_environment.sql"));

    // STATE 0 — old schema. Before the compatibility migration lands, prove the
    // forbidden rollout state really is forbidden: the new application's call
    // shape cannot resolve against the deployed 8-argument function. Captured
    // here because this is the only moment the old schema exists.
    forbiddenState = await psql([
      "-c",
      `SELECT public.try_finalize_pending_generation(
         p_session_key => 'x', p_expected_generation => gen_random_uuid(),
         p_expected_line_user_id => 'u', p_snapshot_revision => 1,
         p_session_hash => 'h', p_raw_text => 'r',
         p_session => '{}'::jsonb, p_items => '[]'::jsonb,
         p_compatibility_hashes => ARRAY['a']::text[])`,
    ]);

    await apply(join(ROOT, "supabase", "migrations", "20260815150000_produce_fingerprint_compatibility.sql"));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("exactly one definition survives, and it takes the new parameter", async () => {
    // Two overloads would let an 8-argument call keep the OLD body and silently
    // skip compatibility, which is the whole failure mode this migration fixes.
    expect(await scalar(`
      SELECT count(*)::text FROM pg_proc
      WHERE proname = 'try_finalize_pending_generation'`)).toBe("1");
    expect(await scalar(`
      SELECT to_regprocedure(
        'public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb)'
      ) IS NULL`)).toBe("t");
    expect(await scalar(`
      SELECT to_regprocedure(
        'public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb,text[])'
      ) IS NOT NULL`)).toBe("t");
  });

  // ── Rolling-deploy state machine ───────────────────────────────────────────

  test("FORBIDDEN — new app call shape against the OLD schema does not resolve", () => {
    // Captured in beforeAll, against the real pre-migration function.
    expect(forbiddenState.code).not.toBe(0);
    expect(forbiddenState.stderr).toMatch(/does not exist|p_compatibility_hashes/i);
  });

  test("CASE 7 — a new session writes only its own V2 identity plus reservations", async () => {
    const parsed = withdrawal("พาซิโอ้");
    expect((await submit("fresh", parsed)).status).toBe("finalized");

    const hashes = (await scalar(`
      SELECT string_agg(session_hash, ',' ORDER BY session_hash) FROM public.imported_sessions`))
      .split(",");
    const expected = [
      computeSessionHash(parsed),
      ...weighSessionCompatibilityFingerprints(parsed),
    ].sort();
    expect(hashes.sort()).toEqual(expected);
    // The V0 hash is never written.
    expect(hashes).not.toContain(computeLegacySessionHash(parsed));
    expect(await produceSessionCount()).toBe(1);
  });

  test("CASE 1 — V1 exact alias resend is a duplicate", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซีโอ้", { extra: true });
    // What PR #51 persisted for this document when it was typed พาซีโอ้.
    await seedImported(weighSessionLegacyMarketFingerprint(parsed, "พาซีโอ้"), "พาซีโอ้");

    const before = await produceSessionCount();
    const result = await submit("case1", parsed);
    expect(result.status).toBe("duplicate");
    expect(result.reason).toBe("compatibility_fingerprint");
    expect(await produceSessionCount()).toBe(before);
  });

  test("CASE 2 — V1 alias, resent as canonical, is a duplicate", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const old = withdrawal("พาซีโอ้", { extra: true });
    await seedImported(weighSessionLegacyMarketFingerprint(old, "พาซีโอ้"), "พาซีโอ้");

    const before = await produceSessionCount();
    const result = await submit("case2", withdrawal("พาซิโอ้", { extra: true }));
    expect(result.status).toBe("duplicate");
    expect(await produceSessionCount()).toBe(before);
  });

  test("CASE 3 — V1 canonical, resent as another alias, is a duplicate", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const old = withdrawal("พาซิโอ้", { extra: true });
    // A canonical-labelled V1 row IS the V2 hash, so this proves the plain
    // reservation path still catches it from an alias resend.
    await seedImported(weighSessionLegacyMarketFingerprint(old, "พาซิโอ้"), "พาซิโอ้");

    const before = await produceSessionCount();
    expect((await submit("case3", withdrawal("พาสิโอ้", { extra: true }))).status).toBe("duplicate");
    expect(await produceSessionCount()).toBe(before);
  });

  test("CASE 4 — different reviewed markets stay independent", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const before = await produceSessionCount();
    expect((await submit("case4a", withdrawal("พาซิโอ้ผัก"))).status).toBe("finalized");
    expect((await submit("case4b", withdrawal("พาซิโอ้ผลไม้"))).status).toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 2);
  });

  test("CASE 5 — an unreviewed near-match stays independent", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const before = await produceSessionCount();
    expect((await submit("case5a", withdrawal("พาซิโอ้"))).status).toBe("finalized");
    // พาชิโอ้ is one character away and is NOT a reviewed alias.
    expect((await submit("case5b", withdrawal("พาชิโอ้"))).status).toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 2);
  });

  test("CASE 9 — an exact main-session duplicate is still blocked", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซิโอ้", { extra: true });
    expect((await submit("case9a", parsed)).status).toBe("finalized");
    const before = await produceSessionCount();
    expect((await submit("case9b", parsed)).status).toBe("duplicate");
    expect(await produceSessionCount()).toBe(before);
  });

  test("CASE 10 — intentional additional batches still both persist", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซีโอ้", { kind: "additional" });
    const before = await produceSessionCount();
    expect((await submit("case10a", parsed, { sessionKind: "additional" })).status)
      .toBe("finalized");
    // Identical content, second intentional batch — PR #51's rule, unchanged by
    // the compatibility reservation.
    expect((await submit("case10b", parsed, { sessionKind: "additional" })).status)
      .toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 2);
  });

  test("an additional batch does not let a later main duplicate slip through", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซีโอ้", { extra: true });
    expect((await submit("mixa", parsed)).status).toBe("finalized");
    const before = await produceSessionCount();
    expect((await submit("mixb", withdrawal("พาซิโอ้", { extra: true }))).status).toBe("duplicate");
    expect(await produceSessionCount()).toBe(before);
  });

  test("rolling deploy A — a previous build's V1 write blocks the new build", async () => {
    // Old build, old app code: writes V1 for the alias spelling it was given and
    // knows nothing about compatibility.
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซีโอ้", { extra: true });
    await seedImported(weighSessionLegacyMarketFingerprint(parsed, "พาซีโอ้"), "พาซีโอ้");

    const before = await produceSessionCount();
    expect((await submit("rollA", withdrawal("พาซิโอ้", { extra: true }))).status).toBe("duplicate");
    expect(await produceSessionCount()).toBe(before);
  });

  test("rolling deploy B — the new build's reservation blocks a previous build", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซิโอ้", { extra: true });
    expect((await submit("rollB1", parsed)).status).toBe("finalized");
    const before = await produceSessionCount();

    // The previous build calls with EIGHT arguments — no compatibility set —
    // and hashes the alias spelling as V1. That hash is already reserved.
    const aliasParsed = withdrawal("พาซีโอ้", { extra: true });
    const sessionKey = `group:G:rollB2:${randomBytes(3).toString("hex")}`;
    const { generation, rawMessageId } = await seedPending(sessionKey);
    const oldBuildHash = weighSessionLegacyMarketFingerprint(aliasParsed, "พาซีโอ้");
    expect(weighSessionCompatibilityFingerprints(parsed)).toContain(oldBuildHash);

    const result = JSON.parse(await scalar(`
      SELECT public.try_finalize_pending_generation(
        ${q(sessionKey)}, ${q(generation)}::uuid, ${q(ACTOR)}, 1,
        ${q(oldBuildHash)}, 'raw',
        ${q(JSON.stringify({
          raw_message_id: rawMessageId,
          staff_name: aliasParsed.staff_name,
          session_date: aliasParsed.date,
          session_title: aliasParsed.session_title,
          transaction_types: "เบิก",
          session_kind: "main",
          ingest_idempotency_key: `${sessionKey}:${generation}`,
          ingest_source: "line_webhook",
        }))}::jsonb,
        ${q(JSON.stringify(aliasParsed.items.map((item) => ({
          item_number: item.item_number,
          product_name: item.product_name,
          price_per_unit: item.price_per_unit,
          quantity: item.quantity,
          unit: item.unit,
          section: item.section,
          transaction_type: item.transaction_type,
        }))))}::jsonb
      )`));

    expect(result.status).toBe("duplicate");
    expect(await produceSessionCount()).toBe(before);
  });

  test("CASE 11 — two simultaneous equivalent submissions persist exactly one", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const before = await produceSessionCount();

    // Same business document, two different reviewed spellings, two separate
    // psql connections finalizing at the same moment. The UNIQUE index on
    // imported_sessions.session_hash is the serialization point.
    const canonical = withdrawal("พาซิโอ้", { extra: true });
    const alias = withdrawal("พาสิโอ้", { extra: true });

    const a = `group:G:race-a:${randomBytes(3).toString("hex")}`;
    const b = `group:G:race-b:${randomBytes(3).toString("hex")}`;
    const seedA = await seedPending(a);
    const seedB = await seedPending(b);

    const [resultA, resultB] = await Promise.all([
      finalize({ sessionKey: a, ...seedA, parsed: canonical,
        compatibility: weighSessionCompatibilityFingerprints(canonical) }),
      finalize({ sessionKey: b, ...seedB, parsed: alias,
        compatibility: weighSessionCompatibilityFingerprints(alias) }),
    ]);

    const outcomes = [resultA.status, resultB.status].sort();
    expect(outcomes).toEqual(["duplicate", "finalized"]);
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("CASE 11 — a simultaneous old-build/new-build pair also persists one", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const before = await produceSessionCount();

    const parsed = withdrawal("พาซีโอ้", { extra: true });
    const newBuild = withdrawal("พาซิโอ้", { extra: true });

    const a = `group:G:mix-new:${randomBytes(3).toString("hex")}`;
    const b = `group:G:mix-old:${randomBytes(3).toString("hex")}`;
    const seedA = await seedPending(a);
    const seedB = await seedPending(b);

    const [newResult, oldResult] = await Promise.all([
      // New build: V2 identity plus the reserved V1 class.
      finalize({ sessionKey: a, ...seedA, parsed: newBuild,
        compatibility: weighSessionCompatibilityFingerprints(newBuild) }),
      // Old build: V1 identity for the alias, no compatibility argument.
      finalize({ sessionKey: b, ...seedB, parsed, compatibility: null })
        .catch(() => ({ status: "error" as const })),
    ]);

    // The old build's own hash differs from the new build's identity, so the
    // reservation is the only thing that can stop it — and it does.
    expect([newResult.status, oldResult.status].sort()).toEqual(["duplicate", "finalized"]);
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("an 8-argument call still works and reserves only its own hash", async () => {
    // Rolling deploy direction A: new schema, previous application build. The
    // defaulted parameter is what keeps that build alive rather than erroring
    // on every finalization.
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const before = await produceSessionCount();
    const parsed = withdrawal("พาซิโอ้");
    const sessionKey = `group:G:eightarg:${randomBytes(3).toString("hex")}`;
    const seed = await seedPending(sessionKey);

    // `compatibility: undefined` omits the argument entirely.
    const result = await finalize({ sessionKey, ...seed, parsed, compatibility: undefined });
    expect(result.status).toBe("finalized");
    expect(await scalar("SELECT count(*)::text FROM public.imported_sessions")).toBe("1");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("an explicit NULL compatibility array behaves as an empty one", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const before = await produceSessionCount();
    expect((await submit("nocompat", withdrawal("พาซิโอ้"), { compatibility: null })).status)
      .toBe("finalized");
    expect(await scalar("SELECT count(*)::text FROM public.imported_sessions")).toBe("1");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("a failed finalization reserves nothing — the whole call is one transaction", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซิโอ้");
    const sessionKey = `group:G:stale:${randomBytes(3).toString("hex")}`;
    const { generation, rawMessageId } = await seedPending(sessionKey);
    // A stale snapshot revision is refused before any reservation is taken.
    const result = JSON.parse(await scalar(`
      SELECT public.try_finalize_pending_generation(
        ${q(sessionKey)}, ${q(generation)}::uuid, ${q(ACTOR)}, 99,
        ${q(computeSessionHash(parsed))}, 'raw',
        ${q(JSON.stringify({ raw_message_id: rawMessageId, staff_name: "ต้อม" }))}::jsonb,
        '[]'::jsonb,
        ${sqlTextArray(weighSessionCompatibilityFingerprints(parsed))}
      )`));
    expect(result.status).toBe("stale_snapshot");
    expect(await scalar("SELECT count(*)::text FROM public.imported_sessions")).toBe("0");
  });

  // ── Rolling-deploy state machine, in the application's own call shape ──────

  test("STATE 1 — OLD app named call shape works on the compatibility schema", async () => {
    // The deployed build sends the eight parameters it knows about and omits
    // p_compatibility_hashes. This is the proof that applying the migration
    // first cannot break the build that is already running.
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซิโอ้", { extra: true });
    const sessionKey = `group:G:oldapp:${randomBytes(3).toString("hex")}`;
    const { generation, rawMessageId } = await seedPending(sessionKey);
    const { session, items } = payloadFor(parsed, rawMessageId, sessionKey, generation);

    const result = JSON.parse(await scalar(
      namedCall(oldAppArgs(sessionKey, generation, computeSessionHash(parsed), session, items)),
    ));

    expect(result.status).toBe("finalized");
    // Omitting the parameter defaults it to NULL, so only the V2 identity is
    // taken — exactly the pre-migration behaviour.
    expect(await scalar("SELECT count(*)::text FROM public.imported_sessions")).toBe("1");
    expect(await scalar(`
      SELECT session_hash FROM public.imported_sessions`)).toBe(computeSessionHash(parsed));
  });

  test("STATE 2 — NEW app named call shape works on the compatibility schema", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal("พาซีโอ้", { extra: true });
    const sessionKey = `group:G:newapp:${randomBytes(3).toString("hex")}`;
    const { generation, rawMessageId } = await seedPending(sessionKey);
    const { session, items } = payloadFor(parsed, rawMessageId, sessionKey, generation);
    const compatibility = weighSessionCompatibilityFingerprints(parsed);
    expect(compatibility.length).toBeGreaterThan(0);

    const result = JSON.parse(await scalar(namedCall({
      ...oldAppArgs(sessionKey, generation, computeSessionHash(parsed), session, items),
      p_compatibility_hashes: sqlTextArray(compatibility),
    })));

    expect(result.status).toBe("finalized");
    // The V2 identity and the whole V1 class, every row stamped with this
    // generation so ghost recovery can prove ownership later.
    expect(await scalar(`
      SELECT count(*)::text FROM public.imported_sessions
      WHERE reserved_by_generation = ${q(generation)}::uuid`))
      .toBe(String(1 + compatibility.length));
    expect(await scalar(`
      SELECT count(*)::text FROM public.imported_sessions
      WHERE reserved_by_generation IS NULL`)).toBe("0");
  });

  test("provenance makes a historical reservation distinguishable from this attempt's", async () => {
    await scalar("DELETE FROM public.imported_sessions; SELECT 1");
    // A row the PREVIOUS release wrote carries no provenance, and that is what
    // makes it unreleasable by any future attempt.
    await seedImported("historical-v1-hash", "พาซีโอ้");
    expect(await scalar(`
      SELECT reserved_by_generation IS NULL FROM public.imported_sessions
      WHERE session_hash = 'historical-v1-hash'`)).toBe("t");
  });
});
