/**
 * PostgreSQL 17 proof for the plain-withdrawal containment guard (P0-B).
 *
 * Production 2026-08-16, seller โด้, market ตลาด72: a 4-row หมอนทอง withdrawal
 * (80.2 kg, 8,020 THB) persisted, and a later resend of the SAME four rows plus
 * 12 dry-good rows persisted as well, because the two documents have different
 * whole-document fingerprints. The day carried 8,020 THB of durian twice.
 *
 * These tests prove the guard catches both directions of containment, that
 * multiplicity and every price/quantity digit still separate two documents, that
 * `เบิกเพิ่ม` remains an intentional append, and that concurrency cannot let both
 * halves of the incident through.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { computeSessionHash } from "@/lib/line/session-dedup-service";
import {
  canonicalWithdrawalItemLines,
  weighSessionCompatibilityFingerprints,
} from "@/lib/produce/business-fingerprint";
import { baseTransactionType } from "@/lib/summary/transactions";

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

const DATE = "16/8/2569";
const ISO_DATE = "2026-08-16";
const OTHER_DATE = "15/8/2569";
const SELLER = "โด้";
const MARKET = "ตลาด72";
const ACTOR = "U3f04f748584d997819dec0fc71a9b084";
/** Containment is scoped to one LINE source. Two groups are two streams. */
const SOURCE = "C8405e382aafefa28a6bf0b0b15bb2971";
const OTHER_SOURCE = "C14f5c6d51f7b8ef458e18aa44461b5bd";
/** Reviewed catalog: one market, three spellings. */
const CANONICAL = "พาซิโอ้";
const ALIAS_SI = "พาซีโอ้";

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-withdrawal-containment.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
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

/** One produce line, as an operator types it. */
interface Row {
  product: string;
  price: number;
  quantity: number;
  unit: string;
}

const DURIAN: Row[] = [
  { product: "หมอนทอง", price: 100, quantity: 3.9, unit: "โล" },
  { product: "หมอนทอง", price: 100, quantity: 23.2, unit: "โล" },
  { product: "หมอนทอง", price: 100, quantity: 26.5, unit: "โล" },
  { product: "หมอนทอง", price: 100, quantity: 26.6, unit: "โล" },
];

const DRY_GOODS: Row[] = [
  { product: "กระชาย", price: 20, quantity: 6, unit: "แพค" },
  { product: "มะนาว", price: 50, quantity: 3, unit: "โล" },
  { product: "ตะไคร้", price: 15, quantity: 4, unit: "แพค" },
];

interface DocumentOptions {
  rows: Row[];
  seller?: string;
  market?: string;
  date?: string;
  kind?: "main" | "additional";
}

function document(options: DocumentOptions): WeighSession {
  const head = options.kind === "additional" ? "เบิกเพิ่ม" : "เบิก";
  const lines = [
    `${options.seller ?? SELLER}-${options.market ?? MARKET} ${head} ${options.date ?? DATE}`,
  ];
  options.rows.forEach((row, index) => {
    lines.push(`${index + 1}.${row.product}${row.price}บาท`);
    lines.push(`${row.quantity}${row.unit}`);
  });
  lines.push(`จบรายการ${head}`);
  return parseWeighSession(lines.join("\n"), ISO_DATE);
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

function sqlTextArray(values: string[]): string {
  return `ARRAY[${values.map(q).join(", ")}]::text[]`;
}

interface SubmitOptions {
  kind?: "main" | "additional";
  /** Force the payload key off, to model an older application build. */
  withoutContainmentKey?: boolean;
  /** The LINE group the document arrived in. Containment is scoped by it. */
  sourceId?: string;
  /**
   * Pre-migration sessions the application derived canonical lines for. The
   * database re-validates each one; only the content comes from here.
   */
  historical?: HistoricalCandidate[];
  /** Stored and delivered only after the authoritative transaction commits. */
  notificationPayload?: string;
}

interface HistoricalCandidate {
  produce_session_id: string;
  lines: string[];
  item_count: number;
}

/**
 * What `loadHistoricalWithdrawalCandidates` produces for a session that was
 * persisted before the stored column existed. The lines come from the same
 * canonicalizer; in the application they are derived from the persisted
 * `produce_items` of that session, which are the rows this document wrote.
 */
function historicalOf(produceSessionId: string, parsed: WeighSession): HistoricalCandidate {
  const lines = canonicalWithdrawalItemLines(parsed) ?? [];
  return { produce_session_id: produceSessionId, lines, item_count: lines.length };
}

function finalizeSql(
  sessionKey: string,
  generation: string,
  rawMessageId: string,
  parsed: WeighSession,
  options: SubmitOptions = {},
): string {
  const kind = options.kind ?? "main";
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
  const containment = options.withoutContainmentKey || kind === "additional"
    ? null
    : canonicalWithdrawalItemLines(parsed);
  const sessionPayload: Record<string, unknown> = {
    raw_message_id: rawMessageId,
    staff_name: parsed.staff_name,
    session_date: parsed.date,
    session_title: parsed.session_title,
    transaction_types: [...new Set(items.map((i) => i.transaction_type))].sort().join(","),
    session_kind: kind,
    declared_transaction_type: kind === "additional"
      ? baseTransactionType(parsed.declared_transaction_type ?? "เบิกเพิ่ม") ?? "เบิก"
      : parsed.declared_transaction_type,
    ingest_idempotency_key: `${sessionKey}:${generation}`,
    ingest_source: "line_webhook",
    validation_errors: [],
  };
  if (options.notificationPayload) {
    sessionPayload.notification_payload = options.notificationPayload;
    sessionPayload.notification_source_id = options.sourceId ?? SOURCE;
    sessionPayload.correlation_id = `${sessionKey}:${generation}`;
  }
  if (!options.withoutContainmentKey) {
    sessionPayload.canonical_withdrawal_item_lines = containment;
    sessionPayload.historical_withdrawal_candidates = options.historical ?? [];
  }

  return `SELECT public.try_finalize_pending_generation(
      ${q(sessionKey)}, ${q(generation)}::uuid, ${q(ACTOR)}, 1,
      ${q(computeSessionHash(parsed))}, 'raw',
      ${q(JSON.stringify(sessionPayload))}::jsonb,
      ${q(JSON.stringify(items))}::jsonb,
      ${sqlTextArray(weighSessionCompatibilityFingerprints(parsed))}
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

async function produceSessionCount(): Promise<number> {
  return Number(await scalar("SELECT count(*)::text FROM public.produce_sessions"));
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_CONTAINMENT_POSTGRES === "1") {
  throw new Error("REQUIRE_CONTAINMENT_POSTGRES=1 but the PostgreSQL 17 harness is unavailable");
}

describe.skipIf(!pgAvailable)("plain-withdrawal containment guard on PostgreSQL 17", () => {
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
    await apply(join(ROOT, "supabase", "migrations", "20260810090000_p4a_produce_entry_validation_gate.sql"));
    await apply(join(ROOT, "supabase", "migrations", "20260810160000_p4a_review_session_generation_uuid.sql"));
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  // ── The multiset primitive ────────────────────────────────────────────────

  test("containment is order-insensitive and multiplicity-preserving", async () => {
    const contains = async (superset: string[], subset: string[]) =>
      await scalar(`SELECT public.produce_item_multiset_contains(
        ${sqlTextArray(superset)}, ${sqlTextArray(subset)})`);

    // CASE 5 — same items, different order.
    expect(await contains(["b", "a", "c"], ["c", "a"])).toBe("t");
    // CASE 4 — multiplicity is not ignored.
    expect(await contains(["a", "b"], ["a", "a"])).toBe("f");
    expect(await contains(["a", "a", "b"], ["a", "a"])).toBe("t");
    expect(await contains(["a"], ["b"])).toBe("f");
    // An empty subset is contained by anything, which is exactly why the guard
    // never runs on a document with no withdrawal rows.
    expect(await contains(["a"], [])).toBe("t");
  });

  test("price advisory finalization persists the entered return price and outbox payload", async () => {
    const seller = "ขวัญราคา";
    const withdrawal = document({
      seller,
      rows: [{ product: "แตงไทย", price: 20, quantity: 28, unit: "ลูก" }],
    });
    expect((await submit("price-withdrawal", withdrawal)).status).toBe("finalized");

    const returned = parseWeighSession([
      `${seller}-${MARKET} ชั่งคืน ${DATE}`,
      "1.แตงไทย25บาท",
      "22ลูก",
      "จบรายการชั่งคืน",
    ].join("\n"), ISO_DATE);
    const warning = [
      "บันทึกแล้ว ✅",
      "",
      "⚠️ พบ 1 รายการที่ราคาแตกต่างจากตอนเบิก",
      "• แตงไทย — เบิก 20 บาท/ลูก → ชั่งคืน 25 บาท/ลูก",
      "",
      "ระบบบันทึกตามราคาที่กรอกไว้แล้ว",
    ].join("\n");
    const finalized = await submit("price-return", returned, {
      notificationPayload: warning,
    });
    expect(finalized.status).toBe("finalized");

    expect(await scalar(`
      SELECT price_per_unit::text FROM public.produce_items
      WHERE product_name = 'แตงไทย' AND transaction_type = 'เบิก'`)).toBe("20");
    expect(await scalar(`
      SELECT price_per_unit::text FROM public.produce_items
      WHERE product_name = 'แตงไทย' AND transaction_type = 'คืน'`)).toBe("25");
    expect(await scalar(`
      SELECT price_per_unit::text FROM public.produce_transactions
      WHERE product_name = 'แตงไทย' AND transaction_type = 'คืน'`)).toBe("25");
    expect(await scalar(`
      SELECT price_per_unit::text FROM public.produce_transactions
      WHERE product_name = 'แตงไทย' AND transaction_type = 'เบิก'`)).toBe("20");
    expect(JSON.parse(await scalar(`
      SELECT to_json(notification_payload)::text
      FROM public.produce_session_notifications
      WHERE produce_session_id = ${q(finalized.session_id ?? "")}::uuid`))).toContain(
      "แตงไทย — เบิก 20 บาท/ลูก → ชั่งคืน 25 บาท/ลูก",
    );
    expect(await scalar("SELECT count(*)::text FROM public.produce_entry_validation_reviews"))
      .toBe("0");
  });

  // ── The Production incident ───────────────────────────────────────────────

  test("CASE 2 — the โด้ superset resend fails closed and persists nothing", async () => {
    expect((await submit("do-first", document({ rows: DURIAN }))).status).toBe("finalized");
    const before = await produceSessionCount();

    const resend = await submit("do-resend", document({ rows: [...DURIAN, ...DRY_GOODS] }));
    expect(resend.status).toBe("failed_closed");
    expect(resend.reason).toBe("withdrawal_containment");
    expect(await produceSessionCount()).toBe(before);
  });

  test("CASE 3 — a strict subset of an already-recorded document fails closed", async () => {
    const seller = "โด้ซับเซ็ต";
    expect((await submit("sub-first", document({ rows: [...DURIAN, ...DRY_GOODS], seller })))
      .status).toBe("finalized");
    const before = await produceSessionCount();

    const fragment = await submit("sub-resend", document({ rows: DURIAN, seller }));
    expect(fragment.status).toBe("failed_closed");
    expect(fragment.reason).toBe("withdrawal_containment");
    expect(await produceSessionCount()).toBe(before);
  });

  test("CASE 1 — an exact resend is still the fingerprint duplicate path", async () => {
    const seller = "โด้เท่ากัน";
    expect((await submit("eq-first", document({ rows: DURIAN, seller }))).status).toBe("finalized");
    const before = await produceSessionCount();

    const again = await submit("eq-resend", document({ rows: DURIAN, seller }));
    expect(again.status).toBe("duplicate");
    expect(await produceSessionCount()).toBe(before);
  });

  test("CASE 5 — the same rows in a different order are still recognised", async () => {
    const seller = "โด้สลับ";
    expect((await submit("ord-first", document({ rows: DURIAN, seller }))).status).toBe("finalized");
    const reordered = await submit(
      "ord-resend",
      document({ rows: [...[...DURIAN].reverse(), ...DRY_GOODS], seller }),
    );
    expect(reordered.reason).toBe("withdrawal_containment");
  });

  // ── One digit apart is a different document ───────────────────────────────

  test("CASE 6 — one differing quantity is not containment", async () => {
    const seller = "โด้จำนวน";
    expect((await submit("qty-first", document({ rows: DURIAN, seller }))).status).toBe("finalized");
    const changed = [...DURIAN.slice(0, 3), { ...DURIAN[3], quantity: 26.7 }];
    expect((await submit("qty-resend", document({ rows: [...changed, ...DRY_GOODS], seller })))
      .status).toBe("finalized");
  });

  test("CASE 7 — one differing price is not containment", async () => {
    const seller = "โด้ราคา";
    expect((await submit("price-first", document({ rows: DURIAN, seller }))).status)
      .toBe("finalized");
    const changed = [...DURIAN.slice(0, 3), { ...DURIAN[3], price: 105 }];
    expect((await submit("price-resend", document({ rows: [...changed, ...DRY_GOODS], seller })))
      .status).toBe("finalized");
  });

  test("CASE 4 — a repeated row is not contained by a single one", async () => {
    const seller = "โด้ทวีคูณ";
    const once = [{ product: "กระชาย", price: 20, quantity: 6, unit: "แพค" }];
    expect((await submit("mult-first", document({ rows: once, seller }))).status).toBe("finalized");
    // Two identical rows plus one more: the existing single row IS contained,
    // so this correctly fails closed rather than being called "not equal".
    const twice = await submit(
      "mult-resend",
      document({ rows: [...once, ...once, ...DRY_GOODS.slice(1)], seller }),
    );
    expect(twice.reason).toBe("withdrawal_containment");
  });

  // ── Different business identity is never compared ─────────────────────────

  test("CASE 8 — a different seller is allowed", async () => {
    expect((await submit("seller-a", document({ rows: DURIAN, seller: "ผู้ขายเอ" }))).status)
      .toBe("finalized");
    expect((await submit("seller-b", document({
      rows: [...DURIAN, ...DRY_GOODS], seller: "ผู้ขายบี",
    }))).status).toBe("finalized");
  });

  test("CASE 9 — a different business date is allowed", async () => {
    const seller = "โด้วันที่";
    expect((await submit("date-a", document({ rows: DURIAN, seller }))).status).toBe("finalized");
    expect((await submit("date-b", document({
      rows: [...DURIAN, ...DRY_GOODS], seller, date: OTHER_DATE,
    }))).status).toBe("finalized");
  });

  test("CASE 10 — a genuinely different market is allowed", async () => {
    const seller = "โด้ตลาด";
    expect((await submit("mkt-a", document({ rows: DURIAN, seller, market: "ทรัพย์พัน" }))).status)
      .toBe("finalized");
    expect((await submit("mkt-b", document({
      rows: [...DURIAN, ...DRY_GOODS], seller, market: "วัดตะกล่ำ",
    }))).status).toBe("finalized");
  });

  test("a DIFFERENT LINE source is allowed, even under strict containment", async () => {
    // Containment refuses a mere superset, which is a far more aggressive
    // verdict than the fingerprint's exact-duplicate refusal. Two LINE groups
    // are two independent business streams and must not block each other.
    const seller = "โด้คนละกลุ่ม";
    expect((await submit("src-a", document({ rows: DURIAN, seller }),
      { sourceId: SOURCE })).status).toBe("finalized");

    const before = await produceSessionCount();
    const other = await submit(
      "src-b",
      document({ rows: [...DURIAN, ...DRY_GOODS], seller }),
      { sourceId: OTHER_SOURCE },
    );
    expect(other.status).toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("the SAME source is still blocked, with everything else identical", async () => {
    const seller = "โด้กลุ่มเดียว";
    expect((await submit("same-src-a", document({ rows: DURIAN, seller }),
      { sourceId: OTHER_SOURCE })).status).toBe("finalized");

    const before = await produceSessionCount();
    const resend = await submit(
      "same-src-b",
      document({ rows: [...DURIAN, ...DRY_GOODS], seller }),
      { sourceId: OTHER_SOURCE },
    );
    expect(resend.reason).toBe("withdrawal_containment");
    expect(await produceSessionCount()).toBe(before);
  });

  test("a session whose raw message carries no source is not a candidate", async () => {
    const seller = "โด้ไร้ต้นทาง";
    await submit("nosrc-a", document({ rows: DURIAN, seller }), { sourceId: SOURCE });
    await scalar(`
      UPDATE public.raw_messages SET source_id = NULL
      WHERE id IN (SELECT raw_message_id FROM public.produce_sessions
                   WHERE staff_name = ${q(seller)})
      RETURNING 1`);

    const resend = await submit(
      "nosrc-b",
      document({ rows: [...DURIAN, ...DRY_GOODS], seller }),
      { sourceId: SOURCE },
    );
    expect(resend.status).toBe("finalized");
  });

  test("CASE 12 — reviewed market aliases share one containment identity", async () => {
    const seller = "โด้พาซิโอ้";
    expect((await submit("alias-a", document({ rows: DURIAN, seller, market: ALIAS_SI }))).status)
      .toBe("finalized");
    const resend = await submit("alias-b", document({
      rows: [...DURIAN, ...DRY_GOODS], seller, market: CANONICAL,
    }));
    expect(resend.reason).toBe("withdrawal_containment");
  });

  // ── The false-positive boundary ───────────────────────────────────────────

  test("CASE 11 — เบิกเพิ่ม repeating identical items is an intentional append", async () => {
    const seller = "โด้เบิกเพิ่ม";
    expect((await submit("add-first", document({ rows: DURIAN, seller }))).status)
      .toBe("finalized");
    const append = await submit(
      "add-second",
      document({ rows: DURIAN, seller, kind: "additional" }),
      { kind: "additional" },
    );
    expect(append.status).toBe("finalized");
  });

  test("an older application build that omits the key is simply unguarded", async () => {
    const seller = "โด้บิลด์เก่า";
    expect((await submit("legacy-a", document({ rows: DURIAN, seller }),
      { withoutContainmentKey: true })).status).toBe("finalized");
    expect((await submit("legacy-b", document({ rows: [...DURIAN, ...DRY_GOODS], seller }),
      { withoutContainmentKey: true })).status).toBe("finalized");
  });

  test("a plain withdrawal stores its multiset; nothing else does", async () => {
    const seller = "โด้คอลัมน์";
    await submit("col-main", document({ rows: DRY_GOODS, seller }));
    expect(await scalar(`
      SELECT cardinality(canonical_withdrawal_item_lines)::text
      FROM public.produce_sessions
      WHERE staff_name = ${q(seller)} AND session_kind = 'main'`)).toBe("3");

    await submit(
      "col-add",
      document({ rows: DRY_GOODS, seller, kind: "additional" }),
      { kind: "additional" },
    );
    expect(await scalar(`
      SELECT count(*)::text FROM public.produce_sessions
      WHERE staff_name = ${q(seller)} AND session_kind = 'additional'
        AND canonical_withdrawal_item_lines IS NULL`)).toBe("1");
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  test("CASE 13 — a racing first and superset resend cannot both persist", async () => {
    const seller = "โด้พร้อมกัน";
    const first = document({ rows: DURIAN, seller });
    const superset = document({ rows: [...DURIAN, ...DRY_GOODS], seller });

    const a = await seedPending(`group:G:race-a:${randomBytes(3).toString("hex")}`);
    const b = await seedPending(`group:G:race-b:${randomBytes(3).toString("hex")}`);
    const keyA = await scalar(`
      SELECT session_key FROM public.pending_sessions
      WHERE session_generation = ${q(a.generation)}::uuid`);
    const keyB = await scalar(`
      SELECT session_key FROM public.pending_sessions
      WHERE session_generation = ${q(b.generation)}::uuid`);

    const before = await produceSessionCount();
    // A holds the business-identity advisory lock across a pause; B must block
    // on it and then see A's committed session.
    const procA = spawnPsql(
      ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      DATABASE,
      `BEGIN;\n${finalizeSql(keyA, a.generation, a.rawMessageId, first)};\n`
        + `SELECT pg_sleep(2);\nCOMMIT;`,
    );
    await Bun.sleep(500);
    const procB = spawnPsql(
      ["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      DATABASE,
      `${finalizeSql(keyB, b.generation, b.rawMessageId, superset)};`,
    );

    const [resultA, resultB] = await Promise.all([collect(procA), collect(procB)]);
    expect(resultA.code, resultA.stderr).toBe(0);
    expect(resultB.code, resultB.stderr).toBe(0);
    expect(resultB.stdout).toContain("withdrawal_containment");
    expect(await produceSessionCount()).toBe(before + 1);
  }, 30_000);

  // ── Sessions persisted BEFORE the stored column existed ───────────────────
  // Production carried 91 of these and 0 with the column. `withoutContainmentKey`
  // reproduces exactly that: the session persists with a NULL array, so only the
  // caller-supplied arm can see it.

  /**
   * A seller nobody else in this suite uses. Two scenarios that shared one
   * would collide on the PR #51 whole-document fingerprint and answer
   * `duplicate` before containment was ever consulted, which would prove
   * nothing about containment.
   */
  // Thai only: the header parser reads the seller up to the `-`, and a digit in
  // that position makes the whole document fail validation before the guard.
  // `โด้` is excluded: it is the suite-wide SELLER, and reusing it here would
  // collide with the earlier tests' documents on the whole-document fingerprint.
  const SCENARIO_SELLERS = [
    "มิ้น", "จิ้ว", "ขวัญ", "เมย์", "ต้อม", "แทน", "ป้าลี", "น้อย", "หนึ่ง",
    "สอง", "สาม", "สี่",
  ];
  let scenario = -1;
  const nextSeller = () => {
    scenario += 1;
    const name = SCENARIO_SELLERS[scenario];
    if (!name) throw new Error("add another scenario seller");
    return name;
  };

  /** Persist a pre-migration session and return what the app would supply for it. */
  async function seedHistorical(parsed: WeighSession, sourceId = SOURCE) {
    const result = await submit("historical", parsed, {
      withoutContainmentKey: true,
      sourceId,
    });
    expect(result.status, JSON.stringify(result)).toBe("finalized");
    const id = result.session_id!;
    expect(await scalar(`
      SELECT coalesce(canonical_withdrawal_item_lines::text, '<null>')
      FROM public.produce_sessions WHERE id = ${q(id)}::uuid`)).toBe("<null>");
    return { id, candidate: historicalOf(id, parsed) };
  }

  const MORE_GOODS: Row[] = [
    { product: "ขิง", price: 30, quantity: 2, unit: "โล" },
    { product: "ข่า", price: 25, quantity: 1.5, unit: "โล" },
    { product: "ใบมะกรูด", price: 10, quantity: 5, unit: "แพค" },
  ];

  test("a superset of a pre-migration withdrawal is blocked", async () => {
    const seller = nextSeller();
    const historical = document({ rows: DURIAN, seller });
    const { candidate } = await seedHistorical(historical);
    const before = await produceSessionCount();

    const resend = document({ rows: [...DURIAN, ...DRY_GOODS, ...MORE_GOODS], seller });
    const result = await submit("superset", resend, { historical: [candidate] });
    expect(result.status).toBe("failed_closed");
    expect(result.reason).toBe("withdrawal_containment");
    expect(await produceSessionCount()).toBe(before);
  });

  test("a fragment of a pre-migration withdrawal is blocked", async () => {
    const seller = nextSeller();
    const historical = document({ rows: [...DURIAN, ...DRY_GOODS, ...MORE_GOODS], seller });
    const { candidate } = await seedHistorical(historical);
    const before = await produceSessionCount();

    const fragment = document({ rows: DURIAN, seller });
    const result = await submit("fragment", fragment, { historical: [candidate] });
    expect(result.status).toBe("failed_closed");
    expect(result.reason).toBe("withdrawal_containment");
    expect(await produceSessionCount()).toBe(before);
  });

  test("a pre-migration withdrawal in ANOTHER LINE source never blocks", async () => {
    const seller = nextSeller();
    const historical = document({ rows: DURIAN, seller });
    const { candidate } = await seedHistorical(historical, OTHER_SOURCE);
    const before = await produceSessionCount();

    const resend = document({ rows: [...DURIAN, ...DRY_GOODS], seller });
    // The caller offers it; the database refuses it, because the session's raw
    // message carries a different source. Cross-source isolation is unchanged.
    const result = await submit("cross-source", resend, {
      historical: [candidate],
      sourceId: SOURCE,
    });
    expect(result.status).toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("a different quantity or price is a different withdrawal", async () => {
    for (const rows of [
      [{ ...DURIAN[0]!, quantity: 3.95 }, ...DURIAN.slice(1)],
      [{ ...DURIAN[0]!, price: 110 }, ...DURIAN.slice(1)],
    ]) {
      // A fresh seller per case: re-seeding the same historical document under
      // one seller would answer `duplicate` before containment was consulted.
      const seller = nextSeller();
      const { candidate } = await seedHistorical(document({ rows: DURIAN, seller }));
      const before = await produceSessionCount();
      const result = await submit("different", document({ rows: [...rows, ...DRY_GOODS], seller }), {
        historical: [candidate],
      });
      expect(result.status).toBe("finalized");
      expect(await produceSessionCount()).toBe(before + 1);
    }
  });

  test("multiplicity is preserved against a pre-migration session", async () => {
    const seller = nextSeller();
    // Historical holds กระชาย twice; a resend carrying it once plus new rows is
    // NOT a superset, so it is a genuinely different document.
    const twice = [DRY_GOODS[0]!, DRY_GOODS[0]!, ...DURIAN];
    const { candidate } = await seedHistorical(document({ rows: twice, seller }));
    const before = await produceSessionCount();

    const once = document({ rows: [DRY_GOODS[0]!, ...DURIAN, ...MORE_GOODS], seller });
    expect((await submit("multiplicity", once, { historical: [candidate] })).status)
      .toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("เบิกเพิ่ม is still exempt from the historical arm", async () => {
    const seller = nextSeller();
    const { candidate } = await seedHistorical(document({ rows: DURIAN, seller }));
    const before = await produceSessionCount();
    // A superset of the historical document, declared as an intentional append.
    // Containment must stay out of it; the rows differ from the main document
    // so the whole-document fingerprint cannot answer first.
    const append = document({ rows: [...DURIAN, ...DRY_GOODS], kind: "additional", seller });
    expect((await submit("append", append, { historical: [candidate] })).status)
      .toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("a voided pre-migration session is not a candidate", async () => {
    const seller = nextSeller();
    const { id, candidate } = await seedHistorical(document({ rows: DURIAN, seller }));
    await scalar(`UPDATE public.produce_sessions SET voided_at = now()
                  WHERE id = ${q(id)}::uuid RETURNING 1`);
    const before = await produceSessionCount();
    const resend = document({ rows: [...DURIAN, ...DRY_GOODS], seller });
    expect((await submit("voided", resend, { historical: [candidate] })).status)
      .toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("a supply whose item count no longer matches the row is dropped", async () => {
    const seller = nextSeller();
    // The one way a caller's content could be stale. The database compares the
    // claimed count against the persisted produce_items and refuses to trust it.
    const { candidate } = await seedHistorical(document({ rows: DURIAN, seller }));
    const before = await produceSessionCount();
    const resend = document({ rows: [...DURIAN, ...DRY_GOODS], seller });
    expect((await submit("stale-count", resend, {
      historical: [{ ...candidate, item_count: candidate.item_count + 1 }],
    })).status).toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });

  test("a session that already carries the stored column ignores a supplied array", async () => {
    const seller = nextSeller();
    // Only column-less sessions enter the supplied arm, so one session can
    // never be counted through both and a caller cannot override stored content.
    const stored = document({ rows: DURIAN, seller });
    const first = await submit("stored", stored);
    expect(first.status).toBe("finalized");
    const before = await produceSessionCount();

    const resend = document({ rows: [...DURIAN, ...DRY_GOODS], seller });
    const result = await submit("stored-resend", resend, {
      historical: [{
        produce_session_id: first.session_id!,
        lines: ["totally|unrelated|line"],
        item_count: 1,
      }],
    });
    // Still blocked — by the stored arm, on the real content.
    expect(result.status).toBe("failed_closed");
    expect(result.reason).toBe("withdrawal_containment");
    expect(result.session_id).toBe(first.session_id!);
    expect(await produceSessionCount()).toBe(before);
  });

  test("an older application build supplies nothing and nothing breaks", async () => {
    const seller = nextSeller();
    const { candidate } = await seedHistorical(document({ rows: DURIAN, seller }));
    expect(candidate.lines).toHaveLength(4);
    const before = await produceSessionCount();
    const resend = document({ rows: [...DURIAN, ...DRY_GOODS], seller });
    // No historical key at all: the guard is exactly as strong as before.
    expect((await submit("no-key", resend, { withoutContainmentKey: true })).status)
      .toBe("finalized");
    expect(await produceSessionCount()).toBe(before + 1);
  });
});
