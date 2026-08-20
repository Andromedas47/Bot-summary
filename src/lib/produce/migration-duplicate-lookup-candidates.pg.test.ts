/**
 * PostgreSQL 17 proof for the historical-compatible LOOKUP-only duplicate
 * check added by migration 20260820100000.
 *
 * The finding: the pending-session finalizer sends the RPC only the V2
 * identity and the V1 market-alias RESERVATION class
 * (`weighSessionCompatibilityFingerprints`). `duplicateLookupCandidates` in
 * session-dedup-service.ts has always known a wider set — the pre-PR #51 V0
 * shape, the retired subunit-price reading, and the product/unit
 * alias-compatibility readings — but the finalizer never forwarded it. A
 * historical document re-sent through the finalizer (the path most Produce
 * sessions take) could persist a second time: ~90% of imported_sessions
 * predate V1/V2, and an EXACT resend does not even reach the withdrawal
 * containment guard, because containment only compares UNEQUAL cardinalities.
 *
 * These tests prove: the new `duplicate_lookup_hashes` key (riding inside the
 * existing `p_session` payload, no RPC signature change) recognises every
 * historical reading; it is existence-only, never reserved; a genuinely new
 * document is unaffected; and both rollout directions are safe, because the
 * RPC's positional signature never changes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import {
  computeLegacySessionHash,
  computeSessionHash,
  duplicateLookupCandidates,
  legacySubunitPricedSession,
  legacyUnitAliasSession,
} from "@/lib/line/session-dedup-service";
import {
  businessContentFingerprint,
  canonicalWithdrawalItemLines,
  weighSessionCompatibilityFingerprints,
} from "@/lib/produce/business-fingerprint";

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

const DATE = "15/8/2569";
const ISO_DATE = "2026-08-15";
const SELLER = "เมย์";
const MARKET = "ราชพฤกษ์";
const ACTOR = "U3f04f748584d997819dec0fc71a9b084";
const SOURCE = "C8405e382aafefa28a6bf0b0b15bb2971";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-duplicate-lookup-candidates.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

function spawnPsql(args: string[], database: string, stdin?: string) {
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

function sqlTextArray(values: string[]): string {
  return `ARRAY[${values.map(q).join(", ")}]::text[]`;
}

/** A plain single-item withdrawal, parameterized on the bits each test varies. */
function withdrawal(options: {
  product: string;
  unit: string;
  price?: number;
  quantity?: number;
  market?: string;
  seller?: string;
}): WeighSession {
  return parseWeighSession(
    [
      `${options.seller ?? SELLER}-${options.market ?? MARKET} เบิก ${DATE}`,
      `1.${options.product}${options.price ?? 60}บาท`,
      `${options.quantity ?? 5}${options.unit}`,
      "จบรายการเบิก",
    ].join("\n"),
    ISO_DATE,
  );
}

async function seedPending(sessionKey: string, sourceId = SOURCE) {
  const generation = randomUUID();
  const rawMessageId = randomUUID();
  await scalar(`
    INSERT INTO public.raw_messages (id, source_id)
    VALUES (${q(rawMessageId)}::uuid, ${q(sourceId)});
    INSERT INTO public.pending_sessions (
      session_key, session_generation, line_user_id, source_id, ingest_revision,
      close_event_timestamp_ms, close_requested_at, close_deadline_at,
      close_session_generation, next_attempt_at
    ) VALUES (
      ${q(sessionKey)}, ${q(generation)}::uuid, ${q(ACTOR)}, ${q(sourceId)}, 1,
      1000, now(), now() + interval '30 seconds',
      ${q(generation)}::uuid, now() - interval '1 second'
    );
    SELECT 1`);
  return { generation, rawMessageId };
}

interface SubmitOptions {
  /** Force the payload key off, to model an older application build. */
  withoutLookupKey?: boolean;
  /** Explicit lookup set. Defaults to duplicateLookupCandidates minus reservations. */
  lookupHashes?: string[];
  sourceId?: string;
  /** Defaults to `${sessionKey}:${generation}` — override to model a retry. */
  ingestIdempotencyKey?: string;
}

/** The reservation set this attempt would send — mirrors the real finalizer. */
function reservationsFor(parsed: WeighSession): { hash: string; compatibility: string[] } {
  return {
    hash: computeSessionHash(parsed),
    compatibility: weighSessionCompatibilityFingerprints(parsed),
  };
}

/** The lookup-only set the real finalizer computes — everything else minus the reservations. */
function lookupOnlyFor(parsed: WeighSession): string[] {
  const { hash, compatibility } = reservationsFor(parsed);
  const reserved = new Set([hash, ...compatibility]);
  return duplicateLookupCandidates(parsed).filter((candidate) => !reserved.has(candidate));
}

const rawItemIdentity = { resolveProduct: (name: string) => name, resolveUnit: (unit: string) => unit };

function contentOf(parsed: WeighSession) {
  return {
    businessDate: parsed.date,
    sellerLabel: parsed.staff_name,
    marketLabel: parsed.session_title,
    items: parsed.items.map((item) => ({
      productName: item.product_name,
      unit: item.unit,
      quantity: item.quantity,
      pricePerUnit: item.price_per_unit,
      transactionType: item.transaction_type,
      basisQuantity: item.basis_quantity,
      basisUnit: item.basis_unit,
      basisPrice: item.basis_price,
    })),
  };
}

/**
 * The hash a pre-alias reading of `parsed` would have produced, computed
 * independently of duplicateLookupCandidates/weighSessionAliasCompatibility-
 * Fingerprints (the functions under test), via the public
 * businessContentFingerprint + a hand-built bypass resolver. For the unit
 * axis, pass `legacyUnitAliasSession(parsed)` — `item.unit` is already
 * canonical on `parsed` itself, so bypassing the alias there reconstructs
 * nothing (see legacyUnitAliasSession in session-dedup-service.ts).
 */
function rawHash(reading: WeighSession): string {
  return businessContentFingerprint(contentOf(reading), undefined, rawItemIdentity);
}

function finalizeSql(
  sessionKey: string,
  generation: string,
  rawMessageId: string,
  parsed: WeighSession,
  options: SubmitOptions = {},
): string {
  const items = parsed.items.map((item) => ({
    item_number: item.item_number,
    product_name: item.product_name,
    price_per_unit: item.price_per_unit,
    quantity: item.quantity,
    unit: item.unit,
    section: item.section,
    transaction_type: item.transaction_type,
  }));
  const sessionPayload: Record<string, unknown> = {
    raw_message_id: rawMessageId,
    staff_name: parsed.staff_name,
    session_date: parsed.date,
    session_title: parsed.session_title,
    transaction_types: [...new Set(items.map((i) => i.transaction_type))].sort().join(","),
    session_kind: "main",
    declared_transaction_type: parsed.declared_transaction_type,
    ingest_idempotency_key: options.ingestIdempotencyKey ?? `${sessionKey}:${generation}`,
    ingest_source: "line_webhook",
    canonical_withdrawal_item_lines: canonicalWithdrawalItemLines(parsed),
    historical_withdrawal_candidates: [],
  };
  if (!options.withoutLookupKey) {
    sessionPayload.duplicate_lookup_hashes = options.lookupHashes ?? lookupOnlyFor(parsed);
  }

  const { hash, compatibility } = reservationsFor(parsed);
  return `SELECT public.try_finalize_pending_generation(
      ${q(sessionKey)}, ${q(generation)}::uuid, ${q(ACTOR)}, 1,
      ${q(hash)}, 'raw',
      ${q(JSON.stringify(sessionPayload))}::jsonb,
      ${q(JSON.stringify(items))}::jsonb,
      ${sqlTextArray(compatibility)}
    )`;
}

type FinalizeResult = { status: string; reason?: string; session_id?: string };

async function submit(
  label: string,
  parsed: WeighSession,
  options: SubmitOptions = {},
): Promise<FinalizeResult> {
  const sessionKey = `group:G:${label}:${randomBytes(3).toString("hex")}`;
  const { generation, rawMessageId } = await seedPending(sessionKey, options.sourceId ?? SOURCE);
  return JSON.parse(await scalar(
    finalizeSql(sessionKey, generation, rawMessageId, parsed, options),
  ));
}

/** Write a row an earlier generation/algorithm would have written. */
async function seedImported(hash: string, marketName = MARKET): Promise<void> {
  await scalar(`
    INSERT INTO public.imported_sessions (session_hash, market_name)
    VALUES (${q(hash)}, ${q(marketName)})
    ON CONFLICT (session_hash) DO NOTHING;
    SELECT 1`);
}

async function produceSessionCount(): Promise<number> {
  return Number(await scalar("SELECT count(*)::text FROM public.produce_sessions"));
}

async function importedSessionCount(): Promise<number> {
  return Number(await scalar("SELECT count(*)::text FROM public.imported_sessions"));
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_DUPLICATE_LOOKUP_POSTGRES === "1") {
  throw new Error(
    "REQUIRE_DUPLICATE_LOOKUP_POSTGRES=1 but the PostgreSQL 17 harness is unavailable",
  );
}

describe.skipIf(!pgAvailable)("historical-compatible duplicate lookup on PostgreSQL 17", () => {
  let preMigrationNewAppCall: PsqlResult;

  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;

    await apply(join(ROOT, "supabase", "tests", "produce_fingerprint_compatibility_bootstrap.sql"));
    await apply(join(ROOT, "supabase", "migrations", "0061_pending_session_runtime_environment.sql"));
    await apply(join(ROOT, "supabase", "tests", "produce_withdrawal_containment_bootstrap.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260811090000_round_market_identity_consistency.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260815160000_produce_market_identity_guard.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260815150000_produce_fingerprint_compatibility.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260817090100_produce_withdrawal_containment_guard.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260817090400_produce_historical_withdrawal_containment.sql"));

    // STATE 0 — the base tip, before THIS migration lands. Prove a NEW-shaped
    // call (extra `duplicate_lookup_hashes` key inside p_session) does NOT
    // error against the not-yet-migrated function — captured here because
    // this is the only moment that schema exists. Contrast
    // migration-fingerprint-compatibility.pg.test.ts's FORBIDDEN case: that
    // migration changed the RPC's ARGUMENT list, so an old call shape could
    // not resolve. This migration changes nothing about the argument list —
    // the new data rides inside the existing p_session jsonb — so there is no
    // equivalent forbidden state.
    const preSessionKey = `group:G:premigration:${randomBytes(3).toString("hex")}`;
    const preSeed = await seedPending(preSessionKey);
    const preParsed = withdrawal({ product: "ไชมัส", unit: "โล" });
    preMigrationNewAppCall = await run(finalizeSql(
      preSessionKey, preSeed.generation, preSeed.rawMessageId, preParsed,
    ));

    await apply(join(ROOT, "supabase", "migrations", "20260820100000_produce_duplicate_lookup_candidates.sql"));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("the migration is idempotent and the RPC signature is unchanged", async () => {
    await apply(join(ROOT, "supabase", "migrations", "20260820100000_produce_duplicate_lookup_candidates.sql"));
    expect(await scalar(`
      SELECT count(*)::text FROM pg_proc
      WHERE proname = 'try_finalize_pending_generation'`)).toBe("1");
    expect(await scalar(`
      SELECT to_regprocedure(
        'public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb,text[])'
      ) IS NOT NULL`)).toBe("t");
  });

  test("a NEW-shaped call against the OLD (pre-migration) schema does not error", () => {
    // Captured in beforeAll, against the real pre-migration function.
    expect(preMigrationNewAppCall.code, preMigrationNewAppCall.stderr).toBe(0);
    const result = JSON.parse(preMigrationNewAppCall.stdout.trim().split("\n").pop()!);
    expect(result.status).toBe("finalized");
  });

  test("V0 historical resend is recognised as a duplicate", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal({ product: "มะม่วง", unit: "โล" });
    // What a pre-PR #51 import would have written.
    await seedImported(computeLegacySessionHash(parsed));
    expect(lookupOnlyFor(parsed)).toContain(computeLegacySessionHash(parsed));

    const before = await produceSessionCount();
    const result = await submit("v0", parsed);
    expect(result.status).toBe("duplicate");
    expect(result.reason).toBe("historical_fingerprint");
    expect(await produceSessionCount()).toBe(before);
  });

  test("legacy subunit-price resend is recognised", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    // 2 องุ่นคิมสัน @120 / 0.7 ขีด — the pre-2026-08-19 parser rescaled the
    // price to 1200 (see legacySubunitPricedSession).
    const parsed = parseWeighSession(
      [`${SELLER}-${MARKET} เบิก ${DATE}`, "2องุ่นคิมสัน120บาท", "0.7.ขีด", "จบรายการเบิก"].join("\n"),
      ISO_DATE,
    );
    const beforeTheFix = legacySubunitPricedSession(parsed)!;
    expect(beforeTheFix).not.toBeNull();
    await seedImported(computeSessionHash(beforeTheFix));
    expect(lookupOnlyFor(parsed)).toContain(computeSessionHash(beforeTheFix));

    const before = await produceSessionCount();
    const result = await submit("legacyprice", parsed);
    expect(result.status).toBe("duplicate");
    expect(result.reason).toBe("historical_fingerprint");
    expect(await produceSessionCount()).toBe(before);
  });

  test("product-alias historical resend is recognised", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    // ไชมัส is the pre-correction spelling PRODUCT_ALIASES folds onto ไซมัส.
    // item.product_name stays raw all the way to hash time, so bypassing the
    // alias on `parsed` itself reconstructs the pre-alias reading directly.
    const parsed = withdrawal({ product: "ไชมัส", unit: "โล" });
    const preAliasHash = rawHash(parsed);
    await seedImported(preAliasHash);
    expect(lookupOnlyFor(parsed)).toContain(preAliasHash);

    const before = await produceSessionCount();
    const result = await submit("productalias", parsed);
    expect(result.status).toBe("duplicate");
    expect(result.reason).toBe("historical_fingerprint");
    expect(await produceSessionCount()).toBe(before);
  });

  test("unit-alias historical resend is recognised", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    // กก is a pure UNIT_ALIASES spelling of โล (factor 1) — the PARSER folds
    // it at parse time (unlike a product name), so item.unit already reads
    // "โล" on `parsed` itself by hash time. The reading that matters is
    // legacyUnitAliasSession(parsed), which puts the raw "กก" back from the
    // legacy_unit_alias_raw evidence the parser left; bypassing the alias on
    // THAT reading (rawHash) is what reconstructs the pre-alias hash —
    // computeSessionHash would just re-fold "กก" back to "โล".
    const parsed = withdrawal({ product: "มะม่วง", unit: "กก" });
    const reverted = legacyUnitAliasSession(parsed);
    expect(reverted).not.toBeNull();
    const preAliasHash = rawHash(reverted!);
    expect(preAliasHash).not.toBe(computeSessionHash(parsed));
    await seedImported(preAliasHash);
    expect(lookupOnlyFor(parsed)).toContain(preAliasHash);

    const before = await produceSessionCount();
    const result = await submit("unitalias", parsed);
    expect(result.status).toBe("duplicate");
    expect(result.reason).toBe("historical_fingerprint");
    expect(await produceSessionCount()).toBe(before);
  });

  test("a current canonical NEW document still lands, and reserves nothing beyond its own identity", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal({ product: "มะม่วง", unit: "โล" });
    const before = await produceSessionCount();

    const result = await submit("newdoc", parsed);
    expect(result.status).toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);

    // Exactly the reservation set — session_hash plus any V1 market
    // compatibility — never any of the lookup-only hashes.
    const { hash, compatibility } = reservationsFor(parsed);
    expect(await importedSessionCount()).toBe(1 + compatibility.length);
    const stored = (await scalar(`
      SELECT string_agg(session_hash, ',' ORDER BY session_hash)
      FROM public.imported_sessions`)).split(",").sort();
    expect(stored).toEqual([hash, ...compatibility].sort());
  });

  test("an exact resend bypasses withdrawal containment (equal cardinality) but is still caught by the lookup", async () => {
    // The withdrawal containment guard only compares UNEQUAL cardinalities —
    // this is the exact gap named in the audit finding. Seed a historical
    // pre-alias row with NO canonical_withdrawal_item_lines and no
    // produce_sessions counterpart (mirroring the ~90% of imported_sessions
    // that predate that column), so containment cannot see it at all, and
    // only the new lookup can.
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal({ product: "ไชมัส", unit: "โล" });
    const preAliasHash = rawHash(parsed);
    await seedImported(preAliasHash);

    const before = await produceSessionCount();
    const result = await submit("equalcardinality", parsed);
    expect(result.status).toBe("duplicate");
    expect(result.reason).toBe("historical_fingerprint");
    expect(await produceSessionCount()).toBe(before);
  });

  test("subset/superset containment is unaffected by this migration", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    const base = withdrawal({ product: "มะม่วง", unit: "โล" });
    expect((await submit("containbase", base)).status).toBe("finalized");

    // A strict superset of the same withdrawal, different content — the
    // withdrawal containment guard (20260817090100/090400), not this
    // migration, must still refuse it.
    const superset = parseWeighSession(
      [
        `${SELLER}-${MARKET} เบิก ${DATE}`,
        "1.มะม่วง60บาท", "5โล",
        "2.กล้วย30บาท", "3โล",
        "จบรายการเบิก",
      ].join("\n"),
      ISO_DATE,
    );
    const before = await produceSessionCount();
    const result = await submit("containsuper", superset);
    expect(result.status).toBe("failed_closed");
    expect(result.reason).toBe("withdrawal_containment");
    expect(await produceSessionCount()).toBe(before);
  });

  test("does not mark a distinct same-day document a duplicate merely because a legacy hash exists", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    // A legacy reading exists for ไชมัส (same date/seller/market as `distinct`
    // below), but the resend is a genuinely DIFFERENT product.
    const legacy = withdrawal({ product: "ไชมัส", unit: "โล" });
    await seedImported(computeLegacySessionHash(legacy));

    const distinct = withdrawal({ product: "ทุเรียนหมอนทอง", unit: "โล" });
    expect(lookupOnlyFor(distinct)).not.toContain(computeLegacySessionHash(legacy));

    const before = await produceSessionCount();
    const result = await submit("distinct", distinct);
    expect(result.status).toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("a duplicate LINE retry (same idempotency key) is unaffected by this migration", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal({ product: "มะม่วง", unit: "โล" });
    const sessionKey = `group:G:retry:${randomBytes(3).toString("hex")}`;
    const { generation, rawMessageId } = await seedPending(sessionKey);

    const first = JSON.parse(await scalar(finalizeSql(sessionKey, generation, rawMessageId, parsed)));
    expect(first.status).toBe("finalized");
    const before = await produceSessionCount();

    // The identical retry: same session_key/generation is unreachable a
    // second time (terminalized), so this proves via a FRESH pending row that
    // explicitly carries the SAME ingest_idempotency_key — the authoritative
    // retry collapse, unaffected by anything in this migration.
    const retryKey = `group:G:retry2:${randomBytes(3).toString("hex")}`;
    const retrySeed = await seedPending(retryKey);
    const retryResult = JSON.parse(await scalar(finalizeSql(
      retryKey, retrySeed.generation, retrySeed.rawMessageId, parsed,
      { ingestIdempotencyKey: `${sessionKey}:${generation}` },
    )));
    expect(retryResult.status).toBe("duplicate");
    expect(retryResult.reason).toBe("idempotency_key");
    expect(await produceSessionCount()).toBe(before);
  });

  test("OLD app call shape (no duplicate_lookup_hashes key) works unchanged on the migrated schema", async () => {
    await scalar("DELETE FROM public.produce_items; DELETE FROM public.produce_sessions; DELETE FROM public.imported_sessions; SELECT 1");
    const parsed = withdrawal({ product: "ไชมัส", unit: "โล" });
    // A historical row exists, but the OLD build never sends the lookup key —
    // omitting the parameter (here, the payload key) defaults it to "absent",
    // so this is the pre-migration behaviour: the historical match is missed,
    // not an error.
    const preAliasHash = rawHash(parsed);
    await seedImported(preAliasHash);

    const before = await produceSessionCount();
    const result = await submit("oldapp", parsed, { withoutLookupKey: true });
    expect(result.status).toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });
});
