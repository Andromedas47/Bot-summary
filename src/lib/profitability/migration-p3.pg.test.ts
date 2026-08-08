/**
 * Real PostgreSQL harness for P3 (20260808130000_p3_profitability_snapshots.sql).
 *
 * Harness style (psql resolution, probe, REQUIRE_P3_POSTGRES hard-fail,
 * describe.skipIf, one disposable randomly-named database, unconditional
 * afterAll drop) follows src/lib/accountability-round/migration-p2e.pg.test.ts,
 * per this repo's convention that every *.pg.test.ts is self-contained.
 *
 * ── Apply chain ─────────────────────────────────────────────────────────────
 *
 *   supabase/tests/purchase_capture_slice_b_bootstrap.sql
 *   supabase/migrations/0052_purchase_receipt_persistence.sql
 *   supabase/tests/purchase_capture_slice_c_pre_0053.sql
 *   supabase/migrations/0053_inventory_movement_ledger.sql
 *   supabase/migrations/0054_inventory_cost_valuation.sql
 *   supabase/tests/p3_profitability_bootstrap.sql
 *   supabase/migrations/20260808105001_p2e_accountability_round_identity.sql
 *   supabase/migrations/20260808130000_p3_profitability_snapshots.sql
 *
 * That chain applies in about a second and is the MINIMUM that makes P3
 * exercisable end to end: 0052 + 0053 + 0054 give the real
 * draft -> confirm -> post -> value purchase pipeline that seeds valued stock,
 * p3_profitability_bootstrap gives the produce / pricing / white-sheet /
 * settlement / slip objects at their owning migrations' shapes, and P2E gives
 * the accountability round that is P3's entire identity.
 *
 * DELIBERATELY NOT IN THE CHAIN — these are unrelated to P3 and one of them is
 * actively hostile to a fast suite:
 *
 *   supabase/tests/purchase_capture_slice_c_hardening.sql
 *       Belongs to P2C's LINE purchase-capture slice, not to profitability. It
 *       also executes a pg_sleep-based statement-timeout assertion, which makes
 *       the chain hang for MINUTES for no P3 coverage whatsoever.
 *   supabase/tests/purchase_capture_slice_c_post_0053.sql
 *       Purchase-capture session fixtures layered on 0053. P3 reads the ledger,
 *       never the capture session tables.
 *   supabase/migrations/20260805130000_purchase_capture_sessions.sql
 *   supabase/migrations/20260805140000_purchase_capture_draft_finalization.sql
 *   supabase/migrations/20260805150000_purchase_capture_slice_b_contract_hardening.sql
 *   supabase/migrations/20260805160000_purchase_capture_confirm_post.sql
 *       The LINE capture UX and its confirm/post orchestration. P3 touches
 *       purchase_receipts only to verify that a caller-supplied
 *       purchasing-expense receipt id is `confirmed`, which 0052 alone provides.
 *
 * ── Deliberate harness rules ────────────────────────────────────────────────
 *
 *  1. NO UUID is ever parsed out of psql output that could carry a command tag.
 *     Every read runs `-q -tAc` (quiet + tuples-only + unaligned), and every
 *     generated id comes back through `WITH ins AS (INSERT ... RETURNING id)
 *     SELECT ...`, which is a SELECT and therefore emits a tuple and nothing
 *     else. `-tAc` alone does NOT suppress `INSERT 0 1` on psql 17 — verified.
 *  2. Booleans are normalized once, at the boundary: every boolean read is cast
 *     `::int` in SQL and compared as "1"/"0". No test compares against "t".
 *  3. No BigInt literals — exact satang is compared as decimal STRINGS, which
 *     is also what get_profitability_snapshot() emits (`::text`, never a JSON
 *     number).
 *  4. No monolithic run: focused test() blocks over ONE shared disposable
 *     database, dropped unconditionally in afterAll even when a test failed.
 *  5. REQUIRE_P3_POSTGRES=1 turns an unreachable database into a hard FAILURE
 *     rather than a green skip.
 *
 * Env: PGHOST=localhost, PGUSER=postgres, PGPASSWORD=postgres, PGPORT=5432.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const psql = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";

const env = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "localhost",
  PGUSER: process.env.PGUSER ?? "postgres",
  PGPASSWORD: process.env.PGPASSWORD ?? "postgres",
  PGPORT: process.env.PGPORT ?? "5432",
  PGCLIENTENCODING: "UTF8",
};

const APPLY_CHAIN = [
  join(ROOT, "supabase", "tests", "purchase_capture_slice_b_bootstrap.sql"),
  join(ROOT, "supabase", "migrations", "0052_purchase_receipt_persistence.sql"),
  join(ROOT, "supabase", "tests", "purchase_capture_slice_c_pre_0053.sql"),
  join(ROOT, "supabase", "migrations", "0053_inventory_movement_ledger.sql"),
  join(ROOT, "supabase", "migrations", "0054_inventory_cost_valuation.sql"),
  join(ROOT, "supabase", "tests", "p3_profitability_bootstrap.sql"),
  join(ROOT, "supabase", "migrations", "20260808105001_p2e_accountability_round_identity.sql"),
  join(ROOT, "supabase", "migrations", "20260808130000_p3_profitability_snapshots.sql"),
];

type PsqlResult = { code: number; stdout: string; stderr: string };

function spawnPsql(args: string[], database: string) {
  return Bun.spawn([psql, ...args], {
    cwd: ROOT,
    env: { ...env, PGDATABASE: database },
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
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function run(args: string[], database = "postgres"): Promise<PsqlResult> {
  return collect(spawnPsql(args, database));
}

const probe = await run(["-q", "-v", "ON_ERROR_STOP=1", "-tAc", "SELECT 1"]).catch(
  (error): PsqlResult => ({ code: 1, stdout: "", stderr: String(error) }),
);
const available = probe.code === 0;
if (!available) {
  const detail = probe.stderr || `psql exit ${probe.code}`;
  if (process.env.REQUIRE_P3_POSTGRES === "1") {
    throw new Error(
      `P3 PostgreSQL tests are required (REQUIRE_P3_POSTGRES=1) but the database at ` +
        `${env.PGHOST}:${env.PGPORT} is unreachable: ${detail}`,
    );
  }
  console.warn(`P3 PG tests SKIPPED: PostgreSQL unavailable (${detail}). Tried: ${psql}`);
}

// ── Fixture vocabulary shared by every round in this suite ────────────────────
const SOURCE = "G1";
const OWNER = "U1";
const DATE = "2026-08-08";
const SELLER = "Seller";
const MARKET = "Market";

/**
 * Thai transaction types as SQL unicode escapes. Windows console/codepage
 * round-trips of raw Thai through a spawned psql are the single most common
 * cause of a "works on Linux only" pg test in this repo, so the bytes are
 * spelled out instead.
 */
const TH = {
  issue: "U&'\\0E40\\0E1A\\0E34\\0E01'", //           เบิก
  goodReturn: "U&'\\0E04\\0E37\\0E19'", //            คืน
  damaged: "U&'\\0E04\\0E37\\0E19\\0E40\\0E2A\\0E35\\0E22'", // คืนเสีย
} as const;

function lit(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

type Attribution = { itemId: string; product: string; unit?: string; location?: string };

function attributionJson(entries: readonly Attribution[]): string {
  return JSON.stringify(
    entries.map((e) => ({
      produce_item_id: e.itemId,
      location_code: e.location ?? "MAIN",
      product_key: e.product,
      unit_key: e.unit ?? "kg",
    })),
  );
}

type SnapshotResult = {
  replayed: boolean;
  snapshot_id: string;
  accountability_round_id: string;
  revision: number;
  certification_state: string;
  incomplete_reasons: string[];
};

/** line_ordinal is a JSON number; every money/quantity field leaves as ::text. */
type SnapshotLine = Record<string, string | number | null | string[]>;
type Snapshot = Record<string, unknown> & {
  lines: SnapshotLine[];
  sources: Array<{ artifact_kind: string; artifact_id: string }>;
  incomplete_reasons: string[];
};

describe.skipIf(!available)("P3 profitability snapshots (real PostgreSQL)", () => {
  const db = `p3_${randomBytes(4).toString("hex")}`;
  let created = false;
  let rawMessageId = "";

  // ── Core psql plumbing ─────────────────────────────────────────────────────

  async function sql(statement: string): Promise<string> {
    const r = await run(["-q", "-v", "ON_ERROR_STOP=1", "-tAc", statement], db);
    if (r.code !== 0) throw new Error(`SQL failed: ${r.stderr || r.stdout}\n${statement}`);
    return r.stdout;
  }

  /** Runs SQL expected to FAIL. Returns the error text. */
  async function sqlFails(statement: string): Promise<string> {
    const r = await run(["-q", "-v", "ON_ERROR_STOP=1", "-tAc", statement], db);
    if (r.code === 0) throw new Error(`expected failure but succeeded:\n${statement}\n${r.stdout}`);
    return r.stderr || r.stdout;
  }

  /** Rule 2: every boolean crosses the boundary as an int, never as "t"/"f". */
  async function sqlBool(expression: string): Promise<boolean> {
    const raw = await sql(`SELECT (${expression})::int`);
    if (raw !== "0" && raw !== "1") throw new Error(`not a boolean: ${raw} <- ${expression}`);
    return raw === "1";
  }

  function startScript(script: string) {
    return spawnPsql(["-q", "-v", "ON_ERROR_STOP=1", "-c", script], db);
  }

  /** Rule 1: generated ids always arrive through a SELECT over a data-modifying CTE. */
  async function insertReturningId(statement: string): Promise<string> {
    const id = await sql(`WITH ins AS (${statement} RETURNING id) SELECT id::text FROM ins`);
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error(`not a bare uuid: ${JSON.stringify(id)}`);
    return id;
  }

  // ── P2E round fixtures ─────────────────────────────────────────────────────

  async function openRound(key: string, event: string): Promise<string> {
    const raw = await sql(
      `SELECT public.open_accountability_round_produce_session(
         ${lit(key)}, 'group', ${lit(SOURCE)}, ${lit(OWNER)}, ${lit(event)}, 1, 1,
         ${lit(DATE)}, '08:00', 'operator', ${lit(SELLER)}, ${lit(MARKET)}, ${lit(MARKET)},
         'main', ${TH.issue})`,
    );
    const parsed = JSON.parse(raw) as { accountability_round_id: string };
    return parsed.accountability_round_id;
  }

  /**
   * A produce session bound explicitly to a round. ingest_idempotency_key stays
   * NULL so P2E's propagate trigger no-ops and the explicit binding stands.
   *
   * One session per movement, deliberately: 0053's
   * inventory_movements_source_posting_uidx gives a source document AT MOST ONE
   * posting movement, so an ISSUE and a GOOD_RETURN of the same round must cite
   * two different sessions — which is exactly what P2E continuations produce.
   */
  async function newSession(round: string): Promise<string> {
    return insertReturningId(
      `INSERT INTO public.produce_sessions
         (raw_message_id, line_user_id, staff_name, session_date, session_title, accountability_round_id)
       VALUES ('${rawMessageId}', ${lit(OWNER)}, ${lit(SELLER)}, ${lit(DATE)}, ${lit(MARKET)}, '${round}')`,
    );
  }

  /** A session that carries NO round at all — the legacy/unbound shape. */
  async function newUnboundSession(): Promise<string> {
    return insertReturningId(
      `INSERT INTO public.produce_sessions
         (raw_message_id, line_user_id, staff_name, session_date, session_title)
       VALUES ('${rawMessageId}', ${lit(OWNER)}, ${lit(SELLER)}, ${lit(DATE)}, ${lit(MARKET)})`,
    );
  }

  type ItemSpec = { type: keyof typeof TH; product: string; qty: string; unit?: string };

  async function addItems(sessionId: string, items: readonly ItemSpec[]): Promise<string[]> {
    const values = items
      .map(
        (it, i) =>
          `('${sessionId}', ${i + 1}, ${lit(it.product)}, ${it.qty}, ${lit(it.unit ?? "kg")}, ${TH[it.type]})`,
      )
      .join(", ");
    const joined = await sql(
      `WITH ins AS (
         INSERT INTO public.produce_items (session_id, item_number, product_name, quantity, unit, transaction_type)
         VALUES ${values} RETURNING id, item_number)
       SELECT string_agg(id::text, ',' ORDER BY item_number) FROM ins`,
    );
    const ids = joined.split(",");
    expect(ids).toHaveLength(items.length);
    return ids;
  }

  async function voidSession(sessionId: string): Promise<void> {
    await sql(
      `UPDATE public.produce_sessions
          SET voided_at = now(), voided_by = 'tester', void_reason = 'rejected damage'
        WHERE id = '${sessionId}'`,
    );
  }

  // ── 0053 ledger fixtures ───────────────────────────────────────────────────

  type LineSpec = { product: string; qty: string; unit?: string; location?: string };

  /**
   * Header AND lines in ONE psql invocation. Each sql() call is its own psql
   * process with its own implicit transaction, and 0053's line_count DEFERRED
   * constraint trigger fires at THAT transaction's commit — splitting this in
   * two would commit a header with zero visible lines and be rejected.
   */
  async function postMovement(opts: {
    type: "ISSUE" | "GOOD_RETURN" | "DAMAGED_WRITE_OFF";
    sessionId: string;
    round: string;
    lines: readonly LineSpec[];
    dedupe?: string;
  }): Promise<string> {
    const mid = await sql(`SELECT gen_random_uuid()`);
    const dedupe = opts.dedupe ?? `p3-${opts.type.toLowerCase()}-${randomBytes(6).toString("hex")}`;
    const values = opts.lines
      .map(
        (l, i) =>
          `('${mid}', ${i + 1}, ${lit(l.product)}, ${lit(l.unit ?? "kg")}, ` +
          `${lit(l.location ?? "MAIN")}, ${l.qty})`,
      )
      .join(", ");
    await sql(
      `INSERT INTO public.inventory_movements
         (id, movement_type, business_date, source_system, source_document_type,
          source_document_id, dedupe_key, line_count, accountability_round_id)
       VALUES ('${mid}', ${lit(opts.type)}, ${lit(DATE)}, 'p3-test-harness', 'produce_session',
               '${opts.sessionId}', ${lit(dedupe)}, ${opts.lines.length}, '${opts.round}');
       INSERT INTO public.inventory_movement_lines
         (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
       VALUES ${values}`,
    );
    return mid;
  }

  async function valueIssue(movementId: string): Promise<void> {
    await sql(`SELECT public.value_inventory_consumption_movement('${movementId}')`);
  }

  async function valueGoodReturn(movementId: string, sourceCostLineIds: readonly string[]): Promise<void> {
    const arr = `ARRAY[${sourceCostLineIds.map((v) => lit(v)).join(",")}]::uuid[]`;
    await sql(`SELECT public.value_good_return_movement('${movementId}', ${arr})`);
  }

  async function valueGoodReturnFails(
    movementId: string,
    sourceCostLineIds: readonly string[],
  ): Promise<string> {
    const arr = `ARRAY[${sourceCostLineIds.map((v) => lit(v)).join(",")}]::uuid[]`;
    return sqlFails(`SELECT public.value_good_return_movement('${movementId}', ${arr})`);
  }

  /** Cost line ids of a movement, ordered by ledger line_ordinal. */
  async function costLineIds(movementId: string): Promise<string[]> {
    const joined = await sql(
      `SELECT coalesce(string_agg(c.id::text, ',' ORDER BY l.line_ordinal), '')
         FROM public.inventory_cost_movement_lines c
         JOIN public.inventory_movement_lines l ON l.id = c.movement_line_id
        WHERE l.movement_id = '${movementId}'`,
    );
    return joined === "" ? [] : joined.split(",");
  }

  /** Real P2B/P2C/P2D pipeline: draft -> confirm -> post -> value. */
  function itemJson(product: string, quantity: string, unitCostBaht: string, unit = "kg"): string {
    return (
      `{"product_key":${JSON.stringify(product)},"raw_product_text":${JSON.stringify(product)},` +
      `"quantity":"${quantity}","unit_key":"${unit}","raw_unit":"${unit}","unit_cost":"${unitCostBaht}"}`
    );
  }

  async function makeConfirmedReceipt(key: string, items: readonly string[]): Promise<string> {
    await sql(
      `SELECT public.upsert_purchase_receipt_draft(
         'line-text', ${lit(key)}, 'p2b-slice-a-v1', '2026-07-29',
         '[${items.join(",")}]'::jsonb, p_source_type=>'group', p_source_id=>${lit(SOURCE)})`,
    );
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key = ${lit(key)}`);
    await sql(`SELECT public.confirm_purchase_receipt('${id}', ${lit(`ck-${key}`)})`);
    return id;
  }

  async function makeValuedReceipt(key: string, items: readonly string[]): Promise<string> {
    const receiptId = await makeConfirmedReceipt(key, items);
    const movementId = await sql(
      `SELECT public.post_purchase_receipt_inventory_movement('${receiptId}')->>'movement_id'`,
    );
    await sql(`SELECT public.value_purchase_receipt_movement('${movementId}')`);
    return receiptId;
  }

  // ── financial artifacts ────────────────────────────────────────────────────

  async function seedPrice(product: string, satang: number, unit = "kg"): Promise<string> {
    return insertReturningId(
      `INSERT INTO public.central_selling_prices (product_key, unit_key, business_date, price_satang)
       VALUES (${lit(product)}, ${lit(unit)}, ${lit(DATE)}, ${satang})`,
    );
  }

  type SheetSpec = {
    labor?: string;
    locationFee?: string;
    bag?: string;
    snack?: string;
    other?: string;
    actualCash: string;
    finalized?: boolean;
  };

  /** Must run while the round is still OPEN — P2E's artifact guard says so. */
  async function whiteSheet(round: string, spec: SheetSpec): Promise<string> {
    return insertReturningId(
      `INSERT INTO public.digital_white_sheet_cash_entries
         (source_id, market_label_normalized, business_date, labor, location_fee, bag, snack,
          other, actual_cash_submitted, finalized_at, accountability_round_id)
       VALUES (${lit(SOURCE)}, ${lit(MARKET)}, ${lit(DATE)},
               ${spec.labor ?? "0"}, ${spec.locationFee ?? "0"}, ${spec.bag ?? "0"},
               ${spec.snack ?? "0"}, ${spec.other ?? "0"}, ${spec.actualCash},
               ${spec.finalized === false ? "NULL" : "now()"}, '${round}')`,
    );
  }

  async function setActualCash(round: string, baht: string): Promise<void> {
    await sql(
      `UPDATE public.digital_white_sheet_cash_entries
          SET actual_cash_submitted = ${baht}
        WHERE accountability_round_id = '${round}'`,
    );
  }

  async function finalizePendingSessions(round: string): Promise<void> {
    await sql(
      `UPDATE public.pending_sessions SET finalization_status = 'finalized'
        WHERE accountability_round_id = '${round}'`,
    );
  }

  async function closeRound(round: string, event: string): Promise<void> {
    const status = await sql(
      `SELECT status FROM public.close_accountability_round('${round}', ${lit(SOURCE)}, ${lit(OWNER)}, ${lit(event)})`,
    );
    expect(status).toBe("closed");
  }

  // ── P3 RPCs ────────────────────────────────────────────────────────────────

  type RecordOpts = {
    transfers?: string | null;
    transferSourceIds?: readonly string[];
    purchasing?: string | null;
    purchasingReceiptIds?: readonly string[];
    version?: string;
    actor?: string;
  };

  function recordCall(round: string, attributions: readonly Attribution[], opts: RecordOpts = {}): string {
    const uuidArray = (ids?: readonly string[]) =>
      `ARRAY[${(ids ?? []).map((v) => lit(v)).join(",")}]::uuid[]`;
    return (
      `SELECT public.record_profitability_snapshot(` +
      `'${round}'::uuid, ` +
      `${lit(attributionJson(attributions))}::jsonb, ` +
      `${opts.transfers ?? "NULL"}, ` +
      `${uuidArray(opts.transferSourceIds)}, ` +
      `${opts.purchasing ?? "NULL"}, ` +
      `${uuidArray(opts.purchasingReceiptIds)}, ` +
      `${lit(opts.version ?? "p3:v1")}, ` +
      `${opts.actor ? lit(opts.actor) : "NULL"})`
    );
  }

  async function record(
    round: string,
    attributions: readonly Attribution[],
    opts: RecordOpts = {},
  ): Promise<SnapshotResult> {
    return JSON.parse(await sql(recordCall(round, attributions, opts))) as SnapshotResult;
  }

  async function recordFails(
    round: string,
    attributions: readonly Attribution[],
    opts: RecordOpts = {},
  ): Promise<string> {
    return sqlFails(recordCall(round, attributions, opts));
  }

  async function readSnapshot(round: string, revision?: number): Promise<Snapshot> {
    const raw = await sql(
      `SELECT public.get_profitability_snapshot('${round}'${revision === undefined ? "" : `, ${revision}`})`,
    );
    return JSON.parse(raw) as Snapshot;
  }

  async function snapshotCount(round: string): Promise<string> {
    return sql(`SELECT count(*) FROM public.profitability_snapshots WHERE accountability_round_id = '${round}'`);
  }

  function line(snapshot: Snapshot, ordinal: number): SnapshotLine {
    const found = snapshot.lines.find((l) => l.line_ordinal === ordinal);
    if (!found) throw new Error(`no line ${ordinal} in ${JSON.stringify(snapshot.lines)}`);
    return found;
  }

  /**
   * A fingerprint of everything 0053 and 0054 own. P3 claims to write no
   * quantity movement and mutate no cost line; the only way to believe that is
   * to compare this string before and after a posting.
   */
  async function ledgerFingerprint(): Promise<string> {
    return sql(
      `SELECT (SELECT count(*) FROM public.inventory_movements)::text
         || '|' || (SELECT count(*) FROM public.inventory_movement_lines)::text
         || '|' || (SELECT count(*) FROM public.inventory_cost_movements)::text
         || '|' || (SELECT count(*) FROM public.inventory_cost_movement_lines)::text
         || '|' || coalesce((SELECT md5(string_agg(t, '~' ORDER BY t)) FROM (
              SELECT m.id::text || ':' || m.movement_type || ':' || m.dedupe_key || ':'
                     || m.line_count::text || ':' || coalesce(m.reversed_by_movement_id::text, '-')
                     || ':' || coalesce(m.accountability_round_id::text, '-') AS t
                FROM public.inventory_movements m) q), 'none')
         || '|' || coalesce((SELECT md5(string_agg(t, '~' ORDER BY t)) FROM (
              SELECT l.id::text || ':' || l.movement_id::text || ':' || l.line_ordinal::text || ':'
                     || l.product_key || ':' || l.unit_key || ':' || l.location_code || ':'
                     || l.signed_quantity::text AS t
                FROM public.inventory_movement_lines l) q), 'none')
         || '|' || coalesce((SELECT md5(string_agg(t, '~' ORDER BY t)) FROM (
              SELECT c.id::text || ':' || c.cost_movement_id::text || ':' || c.movement_line_id::text
                     || ':' || c.signed_value_satang::text || ':'
                     || coalesce(c.unit_cost_satang_snapshot::text, '-') || ':'
                     || coalesce(c.source_cost_line_id::text, '-') AS t
                FROM public.inventory_cost_movement_lines c) q), 'none')`,
    );
  }

  /** The whole snapshot row except the one column P3 is allowed to move once. */
  async function snapshotFingerprint(snapshotId: string): Promise<string> {
    return sql(
      `SELECT md5((to_jsonb(s) - 'superseded_by_snapshot_id')::text)
         FROM public.profitability_snapshots s WHERE s.id = '${snapshotId}'`,
    );
  }

  async function costBalance(product: string, unit = "kg", location = "MAIN"): Promise<string> {
    return sql(
      `SELECT coalesce((
         SELECT (b->>'quantity_balance') || '/' || (b->>'value_balance_satang')
           FROM jsonb_array_elements(
                  public.get_inventory_cost_balances(${lit(location)}, ${lit(product)}, ${lit(unit)}, true)->'balances') b
          LIMIT 1), 'NONE')`,
    );
  }

  afterAll(async () => {
    if (!created) return;
    await run(["-q", "-d", "postgres", "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}'`]);
    await run(["-q", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`]);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 1. Chain, structure and security posture
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "the P3 chain applies clean and lands the documented structure and security posture",
    async () => {
      for (const file of APPLY_CHAIN) expect(existsSync(file), `missing ${file}`).toBe(true);

      const create = await run(["-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${db}`]);
      expect(create.code, create.stderr).toBe(0);
      created = true;
      for (const file of APPLY_CHAIN) {
        const applied = await run(["-q", "-v", "ON_ERROR_STOP=1", "-f", file], db);
        expect(applied.code, `${file}\n${applied.stderr}`).toBe(0);
      }

      rawMessageId = await insertReturningId(
        `INSERT INTO public.raw_messages (source_id, line_user_id) VALUES (${lit(SOURCE)}, ${lit(OWNER)})`,
      );

      expect(
        await sql(
          `SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables
            WHERE schemaname = 'public' AND tablename LIKE 'profitability%'`,
        ),
      ).toBe("profitability_snapshot_lines,profitability_snapshot_sources,profitability_snapshots");

      // RLS on, zero policies — service_role reads through BYPASSRLS (0053/0054).
      expect(
        await sql(
          `SELECT string_agg(relname || '=' || relrowsecurity::int::text, ',' ORDER BY relname)
             FROM pg_class WHERE relkind = 'r' AND relname LIKE 'profitability%'`,
        ),
      ).toBe(
        "profitability_snapshot_lines=1,profitability_snapshot_sources=1,profitability_snapshots=1",
      );
      expect(
        await sql(
          `SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'profitability%'`,
        ),
      ).toBe("0");

      const RECORD = "public.record_profitability_snapshot(uuid,jsonb,numeric,uuid[],numeric,uuid[],text,text)";
      const GET = "public.get_profitability_snapshot(uuid,integer)";

      // record_* is SECURITY DEFINER with a pinned search_path; get_* is INVOKER.
      expect(await sqlBool(`SELECT prosecdef FROM pg_proc WHERE oid = '${RECORD}'::regprocedure`)).toBe(true);
      expect(
        await sql(`SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = '${RECORD}'::regprocedure`),
      ).toBe("search_path=public, extensions, pg_temp");
      expect(await sqlBool(`SELECT prosecdef FROM pg_proc WHERE oid = '${GET}'::regprocedure`)).toBe(false);
      expect(
        await sql(`SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = '${GET}'::regprocedure`),
      ).toBe("search_path=public, pg_temp");

      // EXECUTE: service_role only, on BOTH RPCs.
      for (const fn of [RECORD, GET]) {
        expect(await sqlBool(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE')`)).toBe(true);
        expect(await sqlBool(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE')`)).toBe(false);
        expect(await sqlBool(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE')`)).toBe(false);
      }

      // Tables: SELECT for service_role, nothing at all for anon/authenticated,
      // and no DML for anybody — every write goes through the RPC.
      for (const t of [
        "public.profitability_snapshots",
        "public.profitability_snapshot_lines",
        "public.profitability_snapshot_sources",
      ]) {
        expect(await sqlBool(`SELECT has_table_privilege('service_role', '${t}', 'SELECT')`)).toBe(true);
        for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
          expect(await sqlBool(`SELECT has_table_privilege('service_role', '${t}', '${priv}')`)).toBe(false);
        }
        for (const role of ["anon", "authenticated"]) {
          for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            expect(await sqlBool(`SELECT has_table_privilege('${role}', '${t}', '${priv}')`)).toBe(false);
          }
        }
      }
    },
    120_000,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 2. A complete round: exact satang, expenses, wages, purchasing, replay,
  //    and proof that nothing in 0053/0054 moved.
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "certifies a complete single-product round with exact satang, and writes no ledger or cost row",
    async () => {
      const product = uniqueKey("p3-complete");
      const round = await openRound("p3-complete", "p3-complete-open");

      // 10 kg at 2.00 baht -> 2000 satang, moving average 200 satang/kg.
      const receipt = await makeValuedReceipt(`doc-${product}`, [itemJson(product, "10", "2")]);

      const issueSession = await newSession(round);
      const [issuedItem] = await addItems(issueSession, [{ type: "issue", product, qty: "6" }]);
      const issue = await postMovement({
        type: "ISSUE", sessionId: issueSession, round, lines: [{ product, qty: "-6" }],
      });
      await valueIssue(issue);
      const [issueCostLine] = await costLineIds(issue);

      const returnSession = await newSession(round);
      const [returnedItem] = await addItems(returnSession, [{ type: "goodReturn", product, qty: "2" }]);
      const goodReturn = await postMovement({
        type: "GOOD_RETURN", sessionId: returnSession, round, lines: [{ product, qty: "2" }],
      });
      await valueGoodReturn(goodReturn, [issueCostLine!]);

      // Approved damage: a คืนเสีย produce row and NOTHING in the ledger. The
      // stock left MAIN on the issue and never came back.
      const damageSession = await newSession(round);
      const [damagedItem] = await addItems(damageSession, [{ type: "damaged", product, qty: "1" }]);

      const priceId = await seedPrice(product, 2000);
      const sheetId = await whiteSheet(round, {
        labor: "10.00", locationFee: "5.00", bag: "2.50", snack: "1.25", other: "0.25",
        actualCash: "38.50",
      });
      await finalizePendingSessions(round);
      await closeRound(round, "p3-complete-close");

      const attributions: Attribution[] = [
        { itemId: issuedItem!, product },
        { itemId: returnedItem!, product },
        { itemId: damagedItem!, product },
      ];
      const opts: RecordOpts = {
        transfers: "250", purchasing: "300", purchasingReceiptIds: [receipt], actor: "tester",
      };

      const before = await ledgerFingerprint();
      const posted = await record(round, attributions, opts);
      const after = await ledgerFingerprint();

      expect(posted.certification_state).toBe("CERTIFIED");
      expect(posted.incomplete_reasons).toEqual([]);
      expect(posted.revision).toBe(1);
      expect(posted.replayed).toBe(false);

      // The whole point of §2 of the plan: P3 reads 0053/0054 and writes nothing.
      expect(after, "P3 created or mutated an inventory movement, line or cost line").toBe(before);

      const snapshot = await readSnapshot(round);
      //   issued_cost      6 * 200                                    = 1200
      //   good_return_cost restored at the proven issue rate 200 * 2   =  400
      //   damage_loss      round(1200 * 1 / 6)                         =  200
      //   cogs_sold        1200 - 400 - 200                            =  600
      //   expected_money   sold 3 * 2000                               = 6000
      //   margin           6000 - 600                                  = 5400
      //   wages            10.00 baht                                  = 1000
      //   expenses         (5.00+2.50+1.25+0.25) baht                  =  900
      //   operating        6000-600-200-900-1000-300                   = 3000
      //   shortage         3850 - (6000 - 250 - 1900)                  =    0
      //   realized         3000 + 0                                    = 3000
      expect(snapshot.issued_quantity).toBe("6.000000");
      expect(snapshot.good_return_quantity).toBe("2.000000");
      expect(snapshot.damaged_quantity).toBe("1.000000");
      expect(snapshot.sold_quantity).toBe("3.000000");
      expect(snapshot.issued_cost_satang).toBe("1200");
      expect(snapshot.good_return_cost_satang).toBe("400");
      expect(snapshot.damage_loss_satang).toBe("200");
      expect(snapshot.cogs_sold_satang).toBe("600");
      expect(snapshot.expected_money_satang).toBe("6000");
      expect(snapshot.standard_margin_satang).toBe("5400");
      expect(snapshot.approved_wages_satang).toBe("1000");
      expect(snapshot.approved_expenses_satang).toBe("900");
      expect(snapshot.purchasing_expenses_satang).toBe("300");
      expect(snapshot.verified_transfers_satang).toBe("250");
      expect(snapshot.actual_cash_satang).toBe("3850");
      expect(snapshot.expected_operating_pl_satang).toBe("3000");
      expect(snapshot.shortage_overage_satang).toBe("0");
      expect(snapshot.realized_pl_satang).toBe("3000");

      expect(snapshot.lines).toHaveLength(1);
      const only = line(snapshot, 1);
      expect(only.location_code).toBe("MAIN");
      expect(only.product_key).toBe(product);
      expect(only.unit_key).toBe("kg");
      expect(only.issued_ledger_quantity).toBe("6.000000");
      expect(only.price_satang).toBe("2000");
      expect(only.cogs_sold_satang).toBe("600");
      expect(only.incomplete_reasons).toEqual([]);

      // Lineage: the price, the white sheet, the confirmed receipt proving the
      // purchasing expense, and every produce item that was attributed.
      const kinds = snapshot.sources.map((s) => `${s.artifact_kind}:${s.artifact_id}`);
      expect(kinds).toContain(`central_selling_price:${priceId}`);
      expect(kinds).toContain(`white_sheet_cash_entry:${sheetId}`);
      expect(kinds).toContain(`purchase_receipt:${receipt}`);
      for (const a of attributions) expect(kinds).toContain(`produce_item:${a.itemId}`);
      expect(kinds).toContain(`inventory_movement:${issue}`);
      expect(kinds).toContain(`inventory_movement:${goodReturn}`);

      // Idempotency: identical inputs replay and write nothing.
      const replay = await record(round, attributions, opts);
      expect(replay.replayed).toBe(true);
      expect(replay.snapshot_id).toBe(posted.snapshot_id);
      expect(replay.revision).toBe(1);
      expect(await snapshotCount(round)).toBe("1");
      expect(await ledgerFingerprint()).toBe(before);
    },
    120_000,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 3. Revisions: shortage, overage, immutability of history
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "a changed input appends a revision, supersedes the previous one and leaves it byte-identical",
    async () => {
      const product = uniqueKey("p3-rev");
      const round = await openRound("p3-rev", "p3-rev-open");
      await makeValuedReceipt(`doc-${product}`, [itemJson(product, "10", "2")]);

      const session = await newSession(round);
      const [item] = await addItems(session, [{ type: "issue", product, qty: "6" }]);
      const issue = await postMovement({
        type: "ISSUE", sessionId: session, round, lines: [{ product, qty: "-6" }],
      });
      await valueIssue(issue);
      await seedPrice(product, 2000);
      await whiteSheet(round, { actualCash: "120.00" });
      await finalizePendingSessions(round);
      await closeRound(round, "p3-rev-close");

      const attributions: Attribution[] = [{ itemId: item!, product }];
      const opts: RecordOpts = { transfers: "0", purchasing: "0" };

      // rev1 — expected 12000, cogs 1200, actual cash 12000 => shortage exactly 0.
      const rev1 = await record(round, attributions, opts);
      expect(rev1.revision).toBe(1);
      expect(rev1.certification_state).toBe("CERTIFIED");
      const read1 = await readSnapshot(round, 1);
      expect(read1.cogs_sold_satang).toBe("1200");
      expect(read1.expected_money_satang).toBe("12000");
      expect(read1.shortage_overage_satang).toBe("0");
      expect(read1.realized_pl_satang).toBe("10800");
      const frozen1 = await snapshotFingerprint(rev1.snapshot_id);

      // rev2 — 100.00 baht submitted against 12000 expected: a 2000 satang SHORTAGE.
      await setActualCash(round, "100.00");
      const rev2 = await record(round, attributions, opts);
      expect(rev2.revision).toBe(2);
      expect(rev2.snapshot_id).not.toBe(rev1.snapshot_id);
      const read2 = await readSnapshot(round, 2);
      expect(read2.actual_cash_satang).toBe("10000");
      expect(read2.shortage_overage_satang).toBe("-2000");
      expect(read2.realized_pl_satang).toBe("8800");

      // rev3 — 130.00 baht submitted: a 1000 satang OVERAGE, which ADDS to P/L.
      await setActualCash(round, "130.00");
      const rev3 = await record(round, attributions, opts);
      expect(rev3.revision).toBe(3);
      const read3 = await readSnapshot(round, 3);
      expect(read3.shortage_overage_satang).toBe("1000");
      expect(read3.realized_pl_satang).toBe("11800");

      // History is frozen; only the supersede pointer moved, exactly once.
      expect(await snapshotFingerprint(rev1.snapshot_id)).toBe(frozen1);
      const supersededBy = await sql(
        `SELECT coalesce(superseded_by_snapshot_id::text, 'null') FROM public.profitability_snapshots
          WHERE id = '${rev1.snapshot_id}'`,
      );
      expect(supersededBy).toBe(rev2.snapshot_id);
      expect(
        await sql(
          `SELECT coalesce(superseded_by_snapshot_id::text, 'null') FROM public.profitability_snapshots
            WHERE id = '${rev2.snapshot_id}'`,
        ),
      ).toBe(rev3.snapshot_id);
      expect(
        await sql(
          `SELECT coalesce(superseded_by_snapshot_id::text, 'null') FROM public.profitability_snapshots
            WHERE id = '${rev3.snapshot_id}'`,
        ),
      ).toBe("null");

      // Default read is the newest revision; an explicit revision is pinned.
      expect((await readSnapshot(round)).revision).toBe(3);
      expect((await readSnapshot(round, 1)).realized_pl_satang).toBe("10800");

      // Append-only: no UPDATE and no DELETE anywhere in the P3 ledger.
      expect(
        await sqlFails(
          `UPDATE public.profitability_snapshots SET certification_state = 'INCOMPLETE'
            WHERE id = '${rev1.snapshot_id}'`,
        ),
      ).toMatch(/profitability_ledger_is_append_only/u);
      expect(
        await sqlFails(`DELETE FROM public.profitability_snapshots WHERE id = '${rev1.snapshot_id}'`),
      ).toMatch(/profitability_ledger_is_append_only/u);
      expect(
        await sqlFails(
          `UPDATE public.profitability_snapshot_lines SET sold_quantity = 0
            WHERE snapshot_id = '${rev1.snapshot_id}'`,
        ),
      ).toMatch(/profitability_ledger_is_append_only/u);
      expect(
        await sqlFails(`DELETE FROM public.profitability_snapshot_lines WHERE snapshot_id = '${rev1.snapshot_id}'`),
      ).toMatch(/profitability_ledger_is_append_only/u);
      expect(
        await sqlFails(
          `UPDATE public.profitability_snapshot_sources SET artifact_kind = 'slip_batch'
            WHERE snapshot_id = '${rev1.snapshot_id}'`,
        ),
      ).toMatch(/profitability_ledger_is_append_only/u);
      expect(
        await sqlFails(`DELETE FROM public.profitability_snapshot_sources WHERE snapshot_id = '${rev1.snapshot_id}'`),
      ).toMatch(/profitability_ledger_is_append_only/u);
      // Even the one permitted transition is one-way: it may not be re-pointed.
      expect(
        await sqlFails(
          `UPDATE public.profitability_snapshots SET superseded_by_snapshot_id = '${rev3.snapshot_id}'
            WHERE id = '${rev1.snapshot_id}'`,
        ),
      ).toMatch(/profitability_ledger_is_append_only/u);

      expect(await snapshotFingerprint(rev1.snapshot_id)).toBe(frozen1);
    },
    120_000,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 4. Two rounds that share every descriptive field
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "two identical-description rounds get distinct ids, both begin at revision 1, and never share an artifact",
    async () => {
      const product = uniqueKey("p3-twin");
      await makeValuedReceipt(`doc-${product}`, [itemJson(product, "20", "1")]); // avg 100
      await seedPrice(product, 300);

      const roundA = await openRound("p3-twin-a", "p3-twin-a-open");
      const roundB = await openRound("p3-twin-b", "p3-twin-b-open");
      const roundC = await openRound("p3-twin-c", "p3-twin-c-open");
      expect(new Set([roundA, roundB, roundC]).size).toBe(3);

      // Same source, owner, seller, market and business date on all three.
      expect(
        await sql(
          `SELECT count(*) FROM public.accountability_rounds
            WHERE source_id = ${lit(SOURCE)} AND owner_line_user_id = ${lit(OWNER)}
              AND business_date = ${lit(DATE)} AND seller_label = ${lit(SELLER)}
              AND market_label_normalized = ${lit(MARKET)}
              AND id IN ('${roundA}', '${roundB}', '${roundC}')`,
        ),
      ).toBe("3");

      async function build(round: string, tag: string) {
        const session = await newSession(round);
        const [item] = await addItems(session, [{ type: "issue", product, qty: "5" }]);
        const issue = await postMovement({
          type: "ISSUE", sessionId: session, round, lines: [{ product, qty: "-5" }],
        });
        await valueIssue(issue);
        const batch = await insertReturningId(
          `INSERT INTO public.slip_batches
             (source_id, source_type, sender_id, seller_name, market_name, slip_date, accountability_round_id)
           VALUES (${lit(SOURCE)}, 'group', ${lit(OWNER)}, ${lit(SELLER)}, ${lit(MARKET)}, ${lit(DATE)}, '${round}')`,
        );
        const settlement = await insertReturningId(
          `INSERT INTO public.settlement_entries
             (settlement_date, settlement_time, staff_name, market_name, source_id, accountability_round_id)
           VALUES (${lit(DATE)}, ${lit(`10:0${tag}`)}, ${lit(SELLER)}, ${lit(MARKET)}, ${lit(SOURCE)}, '${round}')`,
        );
        return { item: item!, batch, settlement };
      }

      const a = await build(roundA, "1");
      const b = await build(roundB, "2");

      for (const round of [roundA, roundB]) {
        await whiteSheet(round, { actualCash: "15.00" });
        await finalizePendingSessions(round);
      }
      // Round C deliberately gets NO white sheet of its own, while its two
      // identically-described siblings have one each.
      const cSession = await newSession(roundC);
      const [cItem] = await addItems(cSession, [{ type: "issue", product, qty: "1" }]);
      const cIssue = await postMovement({
        type: "ISSUE", sessionId: cSession, round: roundC, lines: [{ product, qty: "-1" }],
      });
      await valueIssue(cIssue);
      await finalizePendingSessions(roundC);

      await closeRound(roundA, "p3-twin-a-close");
      await closeRound(roundB, "p3-twin-b-close");
      await closeRound(roundC, "p3-twin-c-close");

      const opts: RecordOpts = { transfers: "0", purchasing: "0" };
      const postedA = await record(roundA, [{ itemId: a.item, product }], {
        ...opts, transferSourceIds: [a.batch],
      });
      const postedB = await record(roundB, [{ itemId: b.item, product }], {
        ...opts, transferSourceIds: [b.batch],
      });

      // Independent revision sequences: both start at 1, no collision, no lock
      // contention — the advisory key is hashed from the round id alone.
      expect(postedA.revision).toBe(1);
      expect(postedB.revision).toBe(1);
      expect(postedA.certification_state).toBe("CERTIFIED");
      expect(postedB.certification_state).toBe("CERTIFIED");
      expect(postedA.snapshot_id).not.toBe(postedB.snapshot_id);
      expect(
        await sql(
          `SELECT count(DISTINCT dedupe_key) FROM public.profitability_snapshots
            WHERE id IN ('${postedA.snapshot_id}', '${postedB.snapshot_id}')`,
        ),
      ).toBe("2");

      // Round A's settlement entry never appears in Round B's lineage, and vice
      // versa — every automatic source is selected by round id.
      const sourcesB = (await readSnapshot(roundB)).sources.map((s) => `${s.artifact_kind}:${s.artifact_id}`);
      expect(sourcesB).toContain(`settlement_entry:${b.settlement}`);
      expect(sourcesB).not.toContain(`settlement_entry:${a.settlement}`);
      expect(sourcesB).toContain(`slip_batch:${b.batch}`);
      expect(sourcesB).not.toContain(`slip_batch:${a.batch}`);

      // A transfer-evidence id from Round A offered to Round B is refused, not
      // silently dropped.
      expect(
        await recordFails(roundB, [{ itemId: b.item, product }], {
          ...opts, transferSourceIds: [a.batch],
        }),
      ).toMatch(/cross_round_artifact/u);

      // Round C: two sibling white sheets exist for the same (source, market,
      // date) and neither can satisfy it, because the lookup is by round id.
      const postedC = await record(roundC, [{ itemId: cItem!, product }], opts);
      expect(postedC.revision).toBe(1);
      expect(postedC.certification_state).toBe("INCOMPLETE");
      expect(postedC.incomplete_reasons).toEqual(["white_sheet_missing"]);
      const readC = await readSnapshot(roundC);
      expect(readC.approved_wages_satang).toBeNull();
      expect(readC.approved_expenses_satang).toBeNull();
      expect(readC.actual_cash_satang).toBeNull();
      expect(readC.sources.some((s) => s.artifact_kind === "white_sheet_cash_entry")).toBe(false);
    },
    180_000,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 5. Cost layers, several issue movements, same-key multi-line, exact drain
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "consumes two cost layers across several issues with no stranded satang, and sells out with no return rows",
    async () => {
      const product = uniqueKey("p3-layers");
      const round = await openRound("p3-layers", "p3-layers-open");

      // Two receipts at different unit costs feeding one weighted-average pool:
      // 10 @ 1.00 = 1000 satang, 10 @ 3.00 = 3000 satang -> 20 qty / 4000 value.
      await makeValuedReceipt(`doc-${product}-a`, [itemJson(product, "10", "1")]);
      await makeValuedReceipt(`doc-${product}-b`, [itemJson(product, "10", "3")]);
      expect(await costBalance(product)).toBe("20.000000/4000");

      const s1 = await newSession(round);
      const [i1] = await addItems(s1, [{ type: "issue", product, qty: "5" }]);
      const m1 = await postMovement({ type: "ISSUE", sessionId: s1, round, lines: [{ product, qty: "-5" }] });
      await valueIssue(m1); // round(4000 * 5 / 20) = 1000

      // ONE movement, TWO lines against the SAME balance key: the second line
      // must see the first line's effect (11 qty / 2200 value), not the original.
      const s2 = await newSession(round);
      const [i2] = await addItems(s2, [{ type: "issue", product, qty: "10" }]);
      const m2 = await postMovement({
        type: "ISSUE", sessionId: s2, round,
        lines: [{ product, qty: "-4" }, { product, qty: "-6" }],
      });
      await valueIssue(m2); // 800 then 1200 = 2000

      const s3 = await newSession(round);
      const [i3] = await addItems(s3, [{ type: "issue", product, qty: "5" }]);
      const m3 = await postMovement({ type: "ISSUE", sessionId: s3, round, lines: [{ product, qty: "-5" }] });
      await valueIssue(m3); // exact drain: the entire remaining 1000

      expect(await costBalance(product)).toBe("0.000000/0");
      expect(
        await sql(
          `SELECT sum(c.signed_value_satang)::text
             FROM public.inventory_cost_movement_lines c
             JOIN public.inventory_movement_lines l ON l.id = c.movement_line_id
            WHERE l.movement_id IN ('${m1}', '${m2}', '${m3}')`,
        ),
      ).toBe("-4000");

      await seedPrice(product, 500);
      await whiteSheet(round, { actualCash: "100.00" });
      await finalizePendingSessions(round);
      await closeRound(round, "p3-layers-close");

      const posted = await record(
        round,
        [{ itemId: i1!, product }, { itemId: i2!, product }, { itemId: i3!, product }],
        { transfers: "0", purchasing: "0" },
      );
      expect(posted.certification_state).toBe("CERTIFIED");

      const snapshot = await readSnapshot(round);
      expect(snapshot.lines).toHaveLength(1);
      const only = line(snapshot, 1);
      expect(only.issued_quantity).toBe("20.000000");
      expect(only.issued_ledger_quantity).toBe("20.000000");
      // Every satang of both layers landed in the issue, none stranded.
      expect(only.issued_cost_satang).toBe("4000");
      // No return rows at all: sold out, and both return terms are exactly zero.
      expect(only.good_return_quantity).toBe("0.000000");
      expect(only.good_return_cost_satang).toBe("0");
      expect(only.damaged_quantity).toBe("0.000000");
      expect(only.damage_loss_satang).toBe("0");
      expect(only.sold_quantity).toBe("20.000000");
      expect(only.cogs_sold_satang).toBe("4000");
      expect(only.expected_money_satang).toBe("10000");
      expect(snapshot.standard_margin_satang).toBe("6000");
      // An explicit 0 is a real assertion, distinct from "not supplied".
      expect(snapshot.verified_transfers_satang).toBe("0");
      expect(snapshot.purchasing_expenses_satang).toBe("0");
      expect(snapshot.shortage_overage_satang).toBe("0");
      expect(snapshot.realized_pl_satang).toBe("6000");
    },
    180_000,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 6. Good returns: partial, then full to exactly zero
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "a partial good return restores the original issue cost and a full one drives COGS to exactly 0",
    async () => {
      const product = uniqueKey("p3-return");
      const round = await openRound("p3-return", "p3-return-open");
      await makeValuedReceipt(`doc-${product}`, [itemJson(product, "4", "1")]); // 400 satang, avg 100

      const s1 = await newSession(round);
      const [issued] = await addItems(s1, [{ type: "issue", product, qty: "4" }]);
      const issue = await postMovement({ type: "ISSUE", sessionId: s1, round, lines: [{ product, qty: "-4" }] });
      await valueIssue(issue);
      const [sourceCostLine] = await costLineIds(issue);
      expect(await costBalance(product)).toBe("0.000000/0");

      // Restock at 9.00 baht BEFORE anything comes back, so the warehouse
      // moving average at return time (900/kg) is nothing like the rate this
      // round's stock actually left at (100/kg). P2D restores the source issue
      // snapshot, and P3 reads that rather than re-deriving anything.
      await makeValuedReceipt(`doc-${product}-restock`, [itemJson(product, "4", "9")]);
      expect(await costBalance(product)).toBe("4.000000/3600");

      await seedPrice(product, 500);
      await whiteSheet(round, { actualCash: "15.00" });
      await finalizePendingSessions(round);
      await closeRound(round, "p3-return-close");

      const s2 = await newSession(round);
      const [returned1] = await addItems(s2, [{ type: "goodReturn", product, qty: "1" }]);
      const gr1 = await postMovement({ type: "GOOD_RETURN", sessionId: s2, round, lines: [{ product, qty: "1" }] });
      await valueGoodReturn(gr1, [sourceCostLine!]);

      const rev1 = await record(round, [{ itemId: issued!, product }, { itemId: returned1!, product }], {
        transfers: "0", purchasing: "0",
      });
      expect(rev1.certification_state).toBe("CERTIFIED");
      const read1 = await readSnapshot(round, 1);
      expect(read1.issued_cost_satang).toBe("400");
      // The ORIGINAL issue rate (100/kg), not the 900/kg average now on hand.
      expect(read1.good_return_cost_satang).toBe("100");
      expect(read1.sold_quantity).toBe("3.000000");
      expect(read1.cogs_sold_satang).toBe("300");
      expect(read1.expected_money_satang).toBe("1500");

      // The remaining 3 units come back. The exact-drain rule in P2D restores
      // 400 - 100 = 300, so the two returns sum to exactly the issued value.
      const s3 = await newSession(round);
      const [returned2] = await addItems(s3, [{ type: "goodReturn", product, qty: "3" }]);
      const gr2 = await postMovement({ type: "GOOD_RETURN", sessionId: s3, round, lines: [{ product, qty: "3" }] });
      await valueGoodReturn(gr2, [sourceCostLine!]);
      // 3600 restocked + the full 400 the issue took = 4000, no residue.
      expect(await costBalance(product)).toBe("8.000000/4000");

      const rev2 = await record(
        round,
        [{ itemId: issued!, product }, { itemId: returned1!, product }, { itemId: returned2!, product }],
        { transfers: "0", purchasing: "0" },
      );
      expect(rev2.revision).toBe(2);
      const read2 = await readSnapshot(round, 2);
      expect(read2.good_return_quantity).toBe("4.000000");
      expect(read2.sold_quantity).toBe("0.000000");
      expect(read2.issued_cost_satang).toBe("400");
      expect(read2.good_return_cost_satang).toBe("400");
      // COGS is a residual, not a third rounding: a full return is EXACTLY zero.
      expect(read2.cogs_sold_satang).toBe("0");
      expect(read2.expected_money_satang).toBe("0");
      expect(line(read2, 1).cogs_sold_satang).toBe("0");
    },
    180_000,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 7. Cross-round return provenance is P2D's refusal, not P3's
  // ═════════════════════════════════════════════════════════════════════════

  test("a GOOD_RETURN cannot restore an ISSUE cost line from another accountability round", async () => {
    const product = uniqueKey("p3-xround");
    const roundA = await openRound("p3-xround-a", "p3-xround-a-open");
    const roundB = await openRound("p3-xround-b", "p3-xround-b-open");
    await makeValuedReceipt(`doc-${product}`, [itemJson(product, "3", "1")]);

    const sa = await newSession(roundA);
    await addItems(sa, [{ type: "issue", product, qty: "3" }]);
    const issue = await postMovement({ type: "ISSUE", sessionId: sa, round: roundA, lines: [{ product, qty: "-3" }] });
    await valueIssue(issue);
    const [costLine] = await costLineIds(issue);

    const sb = await newSession(roundB);
    await addItems(sb, [{ type: "goodReturn", product, qty: "1" }]);
    const crossReturn = await postMovement({
      type: "GOOD_RETURN", sessionId: sb, round: roundB, lines: [{ product, qty: "1" }],
    });

    expect(await valueGoodReturnFails(crossReturn, [costLine!])).toMatch(
      /unprovable_return_cost[\s\S]*across accountability rounds/u,
    );
    // Nothing was written: the refused return has no cost movement at all.
    expect(
      await sql(`SELECT count(*) FROM public.inventory_cost_movements WHERE movement_id = '${crossReturn}'`),
    ).toBe("0");
  }, 120_000);

  // ═════════════════════════════════════════════════════════════════════════
  // 8. Damage: approved, pending, rejected — and unsupported ledger classes
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "approved damage is valued at the proven issue rate while pending damage blocks and rejected damage is absent",
    async () => {
      const product = uniqueKey("p3-damage");
      const round = await openRound("p3-damage", "p3-damage-open");
      await makeValuedReceipt(`doc-${product}-a`, [itemJson(product, "6", "1")]); // avg 100

      const s1 = await newSession(round);
      const [issued] = await addItems(s1, [{ type: "issue", product, qty: "6" }]);
      const issue = await postMovement({ type: "ISSUE", sessionId: s1, round, lines: [{ product, qty: "-6" }] });
      await valueIssue(issue);

      // Restock at a very different price AFTER the issue, so the warehouse
      // moving average (500/kg) is nowhere near the round's proven issue rate
      // (100/kg). Damage must use the rate the stock actually left at.
      await makeValuedReceipt(`doc-${product}-b`, [itemJson(product, "4", "5")]);
      expect(await costBalance(product)).toBe("4.000000/2000");

      const s2 = await newSession(round);
      const [damaged] = await addItems(s2, [{ type: "damaged", product, qty: "2" }]);

      // REJECTED damage: a voided session. produce_transactions filters it out,
      // so it structurally cannot reduce anything.
      const voided = await newSession(round);
      const [voidedItem] = await addItems(voided, [{ type: "damaged", product, qty: "5" }]);
      await voidSession(voided);
      expect(await sql(`SELECT count(*) FROM public.produce_transactions WHERE id = '${voidedItem}'`)).toBe("0");
      expect(await sql(`SELECT count(*) FROM public.produce_transactions_all WHERE id = '${voidedItem}'`)).toBe("1");

      // PENDING damage: an unresolved pending session bound to the round.
      await sql(
        `INSERT INTO public.pending_sessions
           (session_key, source_type, source_id, line_user_id, opened_line_event_id, line_timestamp_ms,
            command_contract_version, business_date, transaction_time, transaction_time_source,
            staff_label, market_label, market_label_normalized, session_kind, initial_transaction_type,
            entry_origin, finalization_status, accountability_round_id)
         VALUES ('p3-damage-undecided', 'group', ${lit(SOURCE)}, ${lit(OWNER)}, 'p3-damage-undecided', 2, 1,
                 ${lit(DATE)}, '09:00', 'operator', ${lit(SELLER)}, ${lit(MARKET)}, ${lit(MARKET)},
                 'main', ${TH.damaged}, 'structured_menu', 'pending', '${round}')`,
      );

      await seedPrice(product, 500);
      await whiteSheet(round, { actualCash: "20.00" });
      await sql(
        `UPDATE public.pending_sessions SET finalization_status = 'finalized'
          WHERE accountability_round_id = '${round}' AND session_key = 'p3-damage'`,
      );
      await closeRound(round, "p3-damage-close");

      const attributions: Attribution[] = [{ itemId: issued!, product }, { itemId: damaged!, product }];
      const opts: RecordOpts = { transfers: "0", purchasing: "0" };

      const rev1 = await record(round, attributions, opts);
      expect(rev1.certification_state).toBe("INCOMPLETE");
      expect(rev1.incomplete_reasons).toEqual(["pending_produce_sessions"]);
      const read1 = await readSnapshot(round, 1);
      // Pending damage changes NO quantity — it only blocks certification.
      expect(read1.issued_quantity).toBe("6.000000");
      expect(read1.damaged_quantity).toBe("2.000000");
      expect(read1.sold_quantity).toBe("4.000000");
      expect(read1.damage_loss_satang).toBe("200");

      await finalizePendingSessions(round);
      const rev2 = await record(round, attributions, opts);
      expect(rev2.revision).toBe(2);
      expect(rev2.certification_state).toBe("CERTIFIED");
      const read2 = await readSnapshot(round, 2);
      //   damage_loss  round(600 * 2 / 6) = 200, i.e. 100/kg, NOT the 500/kg
      //   warehouse average that the restock created.
      expect(read2.damage_loss_satang).toBe("200");
      expect(read2.issued_cost_satang).toBe("600");
      expect(read2.cogs_sold_satang).toBe("400");
      expect(read2.sold_quantity).toBe("4.000000"); // rejected damage reduced nothing
      expect(read2.expected_money_satang).toBe("2000");
      expect(read2.standard_margin_satang).toBe("1600");
      expect(read2.expected_operating_pl_satang).toBe("1400");
      expect(read2.shortage_overage_satang).toBe("0");
      expect(read2.realized_pl_satang).toBe("1400");
      expect(read2.sources.some((s) => s.artifact_id === voidedItem)).toBe(false);

      // The rejected item is not merely ignored — it cannot even be attributed.
      expect(await recordFails(round, [...attributions, { itemId: voidedItem!, product }], opts)).toMatch(
        /cross_round_artifact/u,
      );

      // A round-bound DAMAGED_WRITE_OFF has no defined contribution here: it
      // would decrement MAIN a second time for stock that already left.
      const s4 = await newSession(round);
      const writeOff = await postMovement({
        type: "DAMAGED_WRITE_OFF", sessionId: s4, round, lines: [{ product, qty: "-1" }],
      });
      expect(writeOff).toMatch(/^[0-9a-f-]{36}$/u);
      const rev3 = await record(round, attributions, opts);
      expect(rev3.revision).toBe(3);
      expect(rev3.certification_state).toBe("INCOMPLETE");
      expect(rev3.incomplete_reasons).toEqual(["unsupported_round_movement"]);
      const read3 = await readSnapshot(round, 3);
      expect(read3.issued_quantity).toBe("6.000000");
      expect(read3.damaged_quantity).toBe("2.000000");
      expect(read3.sold_quantity).toBe("4.000000");
    },
    180_000,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 9. Line grain: products, units and locations never combine
  // ═════════════════════════════════════════════════════════════════════════

  test("products, units of one product, and locations stay isolated as separate lines", async () => {
    const suffix = randomBytes(4).toString("hex");
    const productA = `p3-grain-a-${suffix}`;
    const productB = `p3-grain-b-${suffix}`;
    const round = await openRound("p3-grain", "p3-grain-open");

    // One receipt, three balance keys: (MAIN,A,kg) (MAIN,A,box) (MAIN,B,kg).
    await makeValuedReceipt(`doc-grain-${suffix}`, [
      itemJson(productA, "10", "1", "kg"), //  1000 satang -> avg 100
      itemJson(productA, "4", "5", "box"), //  2000 satang -> avg 500
      itemJson(productB, "8", "2", "kg"), //   1600 satang -> avg 200
    ]);

    const session = await newSession(round);
    const items = await addItems(session, [
      { type: "issue", product: productA, qty: "5", unit: "kg" },
      { type: "issue", product: productA, qty: "2", unit: "box" },
      { type: "issue", product: productB, qty: "3", unit: "kg" },
      { type: "issue", product: productA, qty: "1", unit: "kg" }, // sold at the stall
    ]);
    const issue = await postMovement({
      type: "ISSUE", sessionId: session, round,
      lines: [
        { product: productA, qty: "-5", unit: "kg" },
        { product: productA, qty: "-2", unit: "box" },
        { product: productB, qty: "-3", unit: "kg" },
      ],
    });
    await valueIssue(issue);

    await seedPrice(productA, 300, "kg");
    await seedPrice(productA, 1500, "box");
    await seedPrice(productB, 700, "kg");
    await whiteSheet(round, { actualCash: "0" });
    await finalizePendingSessions(round);
    await closeRound(round, "p3-grain-close");

    const posted = await record(
      round,
      [
        { itemId: items[0]!, product: productA, unit: "kg" },
        { itemId: items[1]!, product: productA, unit: "box" },
        { itemId: items[2]!, product: productB, unit: "kg" },
        { itemId: items[3]!, product: productA, unit: "kg", location: "MKT1" },
      ],
      { transfers: "0", purchasing: "0" },
    );
    // The MKT1 key has produce activity but no bound ledger movement, so it is
    // unprovable — and it says so on its own line without touching the others.
    expect(posted.certification_state).toBe("INCOMPLETE");
    expect(posted.incomplete_reasons).toEqual(["issue_movement_unbound"]);

    const snapshot = await readSnapshot(round);
    expect(snapshot.lines).toHaveLength(4);
    const ordered = snapshot.lines.map((l) => `${l.location_code}|${l.product_key}|${l.unit_key}`);
    expect(ordered).toEqual([
      `MAIN|${productA}|box`,
      `MAIN|${productA}|kg`,
      `MAIN|${productB}|kg`,
      `MKT1|${productA}|kg`,
    ]);

    // Two units of one product: two lines, two costs, no blending.
    expect(line(snapshot, 1).issued_quantity).toBe("2.000000");
    expect(line(snapshot, 1).issued_cost_satang).toBe("1000");
    expect(line(snapshot, 1).expected_money_satang).toBe("3000");
    expect(line(snapshot, 2).issued_quantity).toBe("5.000000");
    expect(line(snapshot, 2).issued_cost_satang).toBe("500");
    expect(line(snapshot, 2).expected_money_satang).toBe("1500");
    // A second product keeps its own cost entirely.
    expect(line(snapshot, 3).issued_cost_satang).toBe("600");
    expect(line(snapshot, 3).expected_money_satang).toBe("2100");
    // A second location of the SAME product and unit is a separate line whose
    // missing proof does not borrow MAIN's cost — NULL, never 0.
    expect(line(snapshot, 4).issued_quantity).toBe("1.000000");
    expect(line(snapshot, 4).issued_ledger_quantity).toBeNull();
    expect(line(snapshot, 4).issued_cost_satang).toBeNull();
    expect(line(snapshot, 4).cogs_sold_satang).toBeNull();
    expect(line(snapshot, 4).incomplete_reasons).toEqual(["issue_movement_unbound"]);
    // One unprovable line makes the HEADER money unprovable too, never partial.
    expect(snapshot.issued_cost_satang).toBeNull();
    expect(snapshot.cogs_sold_satang).toBeNull();
  }, 180_000);

  // ═════════════════════════════════════════════════════════════════════════
  // 10. Unprovable inputs: NULL plus a reason, never a zero
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "an unvalued issue, a missing white sheet and legacy unbound rows give INCOMPLETE with NULL money",
    async () => {
      const product = uniqueKey("p3-unproven");
      const round = await openRound("p3-unproven", "p3-unproven-open");
      await makeValuedReceipt(`doc-${product}`, [itemJson(product, "5", "1")]);

      const s1 = await newSession(round);
      const [issued] = await addItems(s1, [{ type: "issue", product, qty: "5" }]);
      // Posted to the QUANTITY ledger and deliberately never valued.
      await postMovement({ type: "ISSUE", sessionId: s1, round, lines: [{ product, qty: "-5" }] });

      // A produce withdrawal with no ledger counterpart at all: the attributed
      // quantity (7) then disagrees with the proven ledger quantity (5).
      const s2 = await newSession(round);
      const [extra] = await addItems(s2, [{ type: "issue", product, qty: "2" }]);

      // Legacy, unbound artifacts describing the same source/market/date. None
      // of them may be inferred into this round.
      const legacySession = await newUnboundSession();
      const [legacyItem] = await addItems(legacySession, [{ type: "issue", product, qty: "99" }]);
      const legacySheet = await insertReturningId(
        `INSERT INTO public.digital_white_sheet_cash_entries
           (source_id, market_label_normalized, business_date, labor, actual_cash_submitted, finalized_at)
         VALUES (${lit(SOURCE)}, ${lit(MARKET)}, ${lit(DATE)}, 99.00, 999.00, now())`,
      );
      expect(
        await sqlBool(
          `SELECT accountability_round_id IS NULL FROM public.digital_white_sheet_cash_entries
            WHERE id = '${legacySheet}'`,
        ),
      ).toBe(true);

      await seedPrice(product, 500);
      await finalizePendingSessions(round);
      await closeRound(round, "p3-unproven-close");

      const posted = await record(round, [
        { itemId: issued!, product },
        { itemId: extra!, product },
      ]);
      expect(posted.certification_state).toBe("INCOMPLETE");
      expect(posted.incomplete_reasons).toEqual([
        "issue_cost_unvalued",
        "issue_quantity_mismatch",
        "missing_verified_transfers",
        "purchasing_expenses_unattributable",
        "white_sheet_missing",
      ]);

      const snapshot = await readSnapshot(round);
      // Every term that consumes the missing cost is NULL. Never 0.
      expect(snapshot.issued_cost_satang).toBeNull();
      expect(snapshot.damage_loss_satang).toBeNull();
      // ...but "no good return happened" is itself a PROVEN fact, so that term
      // is an honest 0 rather than an absence. The distinction is the whole
      // point: NULL means unprovable, 0 means proven to be nothing.
      expect(snapshot.good_return_cost_satang).toBe("0");
      expect(snapshot.cogs_sold_satang).toBeNull();
      expect(snapshot.standard_margin_satang).toBeNull();
      expect(snapshot.expected_operating_pl_satang).toBeNull();
      expect(snapshot.shortage_overage_satang).toBeNull();
      expect(snapshot.realized_pl_satang).toBeNull();
      expect(snapshot.verified_transfers_satang).toBeNull();
      expect(snapshot.purchasing_expenses_satang).toBeNull();
      expect(snapshot.actual_cash_satang).toBeNull();
      // The quantity side is still fully exposed — a partially calculable round
      // shows what it can prove.
      expect(snapshot.issued_quantity).toBe("7.000000");
      expect(snapshot.sold_quantity).toBe("7.000000");
      expect(line(snapshot, 1).issued_ledger_quantity).toBe("5.000000");
      expect(line(snapshot, 1).expected_money_satang).toBe("3500");

      // The legacy rows were never merged in, in either direction.
      const sourceIds = snapshot.sources.map((s) => s.artifact_id);
      expect(sourceIds).not.toContain(legacySheet);
      expect(sourceIds).not.toContain(legacyItem);
      expect(sourceIds).not.toContain(legacySession);
      expect(
        await sql(
          `SELECT count(*) FROM public.profitability_snapshots WHERE accountability_round_id IS NULL`,
        ),
      ).toBe("0");
    },
    180_000,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 11. Hard refusals — contradictions raise instead of degrading
  // ═════════════════════════════════════════════════════════════════════════

  test("contradictory input raises instead of clamping, defaulting or degrading", async () => {
    const product = uniqueKey("p3-refuse");
    const roundA = await openRound("p3-refuse-a", "p3-refuse-a-open");
    const roundB = await openRound("p3-refuse-b", "p3-refuse-b-open");

    const sa = await newSession(roundA);
    const [itemA] = await addItems(sa, [{ type: "issue", product, qty: "1" }]);
    const sb = await newSession(roundB);
    const [itemB] = await addItems(sb, [{ type: "issue", product, qty: "1" }]);

    // A produce item of Round A attributed into Round B.
    expect(await recordFails(roundB, [{ itemId: itemA!, product }, { itemId: itemB!, product }])).toMatch(
      /cross_round_artifact/u,
    );
    // The same item attributed twice.
    expect(await recordFails(roundB, [{ itemId: itemB!, product }, { itemId: itemB!, product }])).toMatch(
      /attributed more than once/u,
    );
    // A round that does not exist.
    expect(
      await sqlFails(
        `SELECT public.record_profitability_snapshot('00000000-0000-4000-8000-000000000000'::uuid, '[]'::jsonb)`,
      ),
    ).toMatch(/accountability_round_not_found/u);
    // Fractional satang in a caller-supplied money term.
    expect(await recordFails(roundB, [{ itemId: itemB!, product }], { transfers: "1.5" })).toMatch(
      /invalid_satang_input/u,
    );
    expect(await recordFails(roundB, [{ itemId: itemB!, product }], { purchasing: "-1" })).toMatch(
      /invalid_satang_input/u,
    );
    // A purchasing-expense "proof" that is not a confirmed receipt.
    const draftKey = uniqueKey("p3-draft");
    await sql(
      `SELECT public.upsert_purchase_receipt_draft(
         'line-text', ${lit(draftKey)}, 'p2b-slice-a-v1', '2026-07-29',
         '[${itemJson(product, "1", "1")}]'::jsonb, p_source_type=>'group', p_source_id=>${lit(SOURCE)})`,
    );
    const draftId = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key = ${lit(draftKey)}`);
    expect(
      await recordFails(roundB, [{ itemId: itemB!, product }], {
        purchasing: "100", purchasingReceiptIds: [draftId],
      }),
    ).toMatch(/required_artifact_unbound/u);

    // Returning more than was ever issued is a contradiction in the record.
    const roundC = await openRound("p3-refuse-c", "p3-refuse-c-open");
    const sc1 = await newSession(roundC);
    const [outItem] = await addItems(sc1, [{ type: "issue", product, qty: "1" }]);
    const sc2 = await newSession(roundC);
    const [backItem] = await addItems(sc2, [{ type: "goodReturn", product, qty: "3" }]);
    expect(
      await recordFails(roundC, [{ itemId: outItem!, product }, { itemId: backItem!, product }]),
    ).toMatch(/negative_sold_quantity/u);
    expect(await snapshotCount(roundC)).toBe("0");

    // The state and the reasons are one fact; the CHECK is what keeps them
    // from disagreeing, even against a direct superuser INSERT.
    const hash = "a".repeat(64);
    expect(
      await sqlFails(
        `INSERT INTO public.profitability_snapshots
           (accountability_round_id, revision, calculation_version, input_hash, dedupe_key,
            certification_state, incomplete_reasons)
         VALUES ('${roundC}', 1, 'p3:v1', ${lit(hash)}, 'p3-forced-certified', 'CERTIFIED', ARRAY['white_sheet_missing'])`,
      ),
    ).toMatch(/profitability_snapshots_certified_iff_no_reasons/u);
    expect(
      await sqlFails(
        `INSERT INTO public.profitability_snapshots
           (accountability_round_id, revision, calculation_version, input_hash, dedupe_key,
            certification_state, incomplete_reasons)
         VALUES ('${roundC}', 1, 'p3:v1', ${lit(hash)}, 'p3-forced-incomplete', 'INCOMPLETE', '{}')`,
      ),
    ).toMatch(/profitability_snapshots_certified_iff_no_reasons/u);
    // A CERTIFIED row may not carry an absent money term either.
    expect(
      await sqlFails(
        `INSERT INTO public.profitability_snapshots
           (accountability_round_id, revision, calculation_version, input_hash, dedupe_key,
            certification_state, incomplete_reasons)
         VALUES ('${roundC}', 1, 'p3:v1', ${lit(hash)}, 'p3-forced-empty', 'CERTIFIED', '{}')`,
      ),
    ).toMatch(/profitability_snapshots_certified_is_complete/u);
    expect(await snapshotCount(roundC)).toBe("0");
  }, 180_000);

  // ═════════════════════════════════════════════════════════════════════════
  // 12. Concurrency: one round, two overlapping posters
  // ═════════════════════════════════════════════════════════════════════════

  test(
    "two overlapping snapshot postings for one round serialize into distinct revisions",
    async () => {
      const product = uniqueKey("p3-conc");
      const round = await openRound("p3-conc", "p3-conc-open");
      const session = await newSession(round);
      const [item] = await addItems(session, [{ type: "issue", product, qty: "1" }]);
      const attributions: Attribution[] = [{ itemId: item!, product }];

      const gate = `p3conc${randomBytes(3).toString("hex")}`;
      const markA = `MARK_${gate}_A`.toUpperCase();
      const markB = `MARK_${gate}_B`.toUpperCase();
      const hold =
        `DO $hold$ BEGIN LOOP EXIT WHEN EXISTS ` +
        `(SELECT 1 FROM public.test_barrier_release WHERE k = '${gate}'); ` +
        `PERFORM pg_sleep(0.05); END LOOP; END $hold$;`;

      await sql(`CREATE TABLE IF NOT EXISTS public.test_barrier_release (k text PRIMARY KEY)`);
      await sql(`DELETE FROM public.test_barrier_release WHERE k = '${gate}'`);

      const marked = (mark: string, alias = "a") =>
        `${alias}.datname = current_database() AND ${alias}.pid <> pg_backend_pid()
           AND ${alias}.query LIKE '%${mark}%' AND ${alias}.query NOT LIKE '%pg_stat_activity%'`;

      async function pollUntil(label: string, query: string, timeoutMs = 30_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (Number(await sql(query)) > 0) return;
          if (Date.now() > deadline) throw new Error(`harness: ${label} within ${timeoutMs}ms`);
          await Bun.sleep(25);
        }
      }

      // psql -c sends the whole string as ONE simple query, so both statements
      // share one implicit transaction — which is exactly what keeps the
      // xact-scoped advisory lock held while the child parks on the barrier.
      const childA = startScript(
        `/* ${markA} */ ${recordCall(round, attributions, { transfers: "111", purchasing: "0" })}; ${hold}`,
      );
      const resultA = collect(childA);
      let childB: ReturnType<typeof startScript> | null = null;
      let resultB: Promise<PsqlResult> | null = null;

      try {
        await pollUntil(
          "child A never took the round advisory lock",
          `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.granted AND ${marked(markA)}`,
        );

        childB = startScript(
          `/* ${markB} */ ${recordCall(round, attributions, { transfers: "222", purchasing: "0" })}`,
        );
        resultB = collect(childB);

        await pollUntil(
          "child B never blocked on child A's round lock",
          `SELECT count(DISTINCT a.pid) FROM pg_stat_activity a
             JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
            WHERE a.wait_event_type = 'Lock' AND ${marked(markB)}`,
        );

        // Serialization is real: B has written nothing while A holds the lock.
        expect(await snapshotCount(round)).toBe("0");

        await sql(`INSERT INTO public.test_barrier_release (k) VALUES ('${gate}') ON CONFLICT DO NOTHING`);

        const a = await resultA;
        const b = await resultB;
        expect(a.code, a.stderr).toBe(0);
        expect(b.code, b.stderr).toBe(0);
      } finally {
        // Unconditional cleanup: release, reap, terminate leftovers, drop row.
        await sql(`INSERT INTO public.test_barrier_release (k) VALUES ('${gate}') ON CONFLICT DO NOTHING`)
          .catch(() => undefined);
        for (const child of [childA, childB]) {
          if (!child) continue;
          try {
            child.kill();
          } catch {
            /* already exited */
          }
        }
        await Promise.allSettled([resultA, resultB ?? Promise.resolve()]);
        for (const mark of [markA, markB]) {
          await sql(
            `SELECT count(pg_terminate_backend(a.pid)) FROM pg_stat_activity a WHERE ${marked(mark)}`,
          ).catch(() => undefined);
        }
        await sql(`DELETE FROM public.test_barrier_release WHERE k = '${gate}'`).catch(() => undefined);
      }

      // Both landed, in order, under two distinct revisions and dedupe keys.
      expect(await snapshotCount(round)).toBe("2");
      expect(
        await sql(
          `SELECT string_agg(revision::text, ',' ORDER BY revision) FROM public.profitability_snapshots
            WHERE accountability_round_id = '${round}'`,
        ),
      ).toBe("1,2");
      expect(
        await sql(
          `SELECT count(DISTINCT dedupe_key) FROM public.profitability_snapshots
            WHERE accountability_round_id = '${round}'`,
        ),
      ).toBe("2");
      expect(
        await sql(
          `SELECT string_agg(verified_transfers_satang::text, ',' ORDER BY revision)
             FROM public.profitability_snapshots WHERE accountability_round_id = '${round}'`,
        ),
      ).toBe("111,222");
      // Revision 1 was superseded by revision 2, once.
      expect(
        await sql(
          `SELECT count(*) FROM public.profitability_snapshots
            WHERE accountability_round_id = '${round}' AND superseded_by_snapshot_id IS NOT NULL`,
        ),
      ).toBe("1");
      expect(
        await sql(
          `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'
             AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`,
        ),
      ).toBe("0");
    },
    180_000,
  );
});
