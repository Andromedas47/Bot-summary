/**
 * Real PostgreSQL harness for P2D migration 0054 (inventory cost valuation).
 *
 * Harness (psql resolution, probeConnection, REQUIRE_POSTGRES_TESTS hard-fail,
 * describe.skipIf, disposable DB naming, sql()/sqlFails(), the withGate()
 * advisory-lock concurrency harness with unconditional cleanup) is copied
 * verbatim from src/lib/inventory-ledger/migration-0053.pg.test.ts, per this
 * repo's convention that every *.pg.test.ts is self-contained. See that file
 * for the harness's own commentary; comments here focus on what is specific
 * to 0054.
 *
 * Apply order for the disposable database (NOT the ALL_FIXTURES array in
 * integration-slice-c2.pg.test.ts, which is unordered as written):
 *   purchase_capture_slice_b_bootstrap.sql
 *   0052_purchase_receipt_persistence.sql
 *   20260805130000_purchase_capture_sessions.sql
 *   20260805140000_purchase_capture_draft_finalization.sql
 *   20260805150000_purchase_capture_slice_b_contract_hardening.sql
 *   purchase_capture_slice_c_pre_0053.sql
 *   0053_inventory_movement_ledger.sql
 *   purchase_capture_slice_c_post_0053.sql
 *   20260805160000_purchase_capture_confirm_post.sql
 *   purchase_capture_slice_c_hardening.sql
 *   0054_inventory_cost_valuation.sql
 *
 * ── On the direct inventory_movements/inventory_movement_lines inserts below ──
 *
 * 0053 ships posting RPCs for PURCHASE_RECEIPT and REVERSAL only. There is no
 * posting adapter yet for ISSUE, GOOD_RETURN, DAMAGED_WRITE_OFF or ADJUSTMENT
 * — 0054 only widens the movement_type CHECK so those movements CAN exist;
 * nothing writes them. So every consumption/return/write-off/adjustment
 * scenario below inserts the 0053 ledger rows directly with SQL via
 * insertRawMovement(), then calls the REAL, UNMODIFIED 0054 valuation RPC
 * against them. That is legitimate and is the function under test: the RPC is
 * always invoked for real, never mocked or reimplemented. Only the PURCHASE_
 * RECEIPT path is driven through the real pipeline (upsert_purchase_receipt_
 * draft -> confirm_purchase_receipt -> post_purchase_receipt_inventory_movement
 * -> value_purchase_receipt_movement), because a real posting adapter exists
 * for it.
 *
 * SKIP (not green PASS) when psql/connection is unavailable — EXCEPT under
 * REQUIRE_POSTGRES_TESTS=1, where unavailability is a hard FAILURE.
 *
 * Env: PGPASSWORD=postgres (default), PGHOST=localhost, PGUSER=postgres
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const REQUIRE_POSTGRES_TESTS = process.env.REQUIRE_POSTGRES_TESTS === "1";

const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const BOOTSTRAP = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_b_bootstrap.sql");
const MIGRATION_0052 = join(REPO_ROOT, "supabase", "migrations", "0052_purchase_receipt_persistence.sql");
const MIGRATION_SESSIONS = join(REPO_ROOT, "supabase", "migrations", "20260805130000_purchase_capture_sessions.sql");
const MIGRATION_DRAFT_FINALIZATION = join(
  REPO_ROOT, "supabase", "migrations", "20260805140000_purchase_capture_draft_finalization.sql",
);
const MIGRATION_SLICE_B_HARDENING = join(
  REPO_ROOT, "supabase", "migrations", "20260805150000_purchase_capture_slice_b_contract_hardening.sql",
);
const PRE_0053 = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_c_pre_0053.sql");
const MIGRATION_0053 = join(REPO_ROOT, "supabase", "migrations", "0053_inventory_movement_ledger.sql");
const POST_0053 = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_c_post_0053.sql");
const MIGRATION_CONFIRM_POST = join(
  REPO_ROOT, "supabase", "migrations", "20260805160000_purchase_capture_confirm_post.sql",
);
const SLICE_C_HARDENING = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_c_hardening.sql");
const MIGRATION_0054 = join(REPO_ROOT, "supabase", "migrations", "0054_inventory_cost_valuation.sql");

const APPLY_CHAIN = [
  BOOTSTRAP,
  MIGRATION_0052,
  MIGRATION_SESSIONS,
  MIGRATION_DRAFT_FINALIZATION,
  MIGRATION_SLICE_B_HARDENING,
  PRE_0053,
  MIGRATION_0053,
  POST_0053,
  MIGRATION_CONFIRM_POST,
  SLICE_C_HARDENING,
  MIGRATION_0054,
];

// Stable test UUIDs model P2E's canonical inventory movement provenance. The
// harness adds the nullable column after applying 0054, exercising the real
// mixed-version order where P2D is installed first and P2E arrives later.
const ROUND_A = "10000000-0000-4000-8000-000000000001";
const ROUND_B = "10000000-0000-4000-8000-000000000002";

type PsqlResult = { code: number; stdout: string; stderr: string };

function resolvePsql(): string | null {
  if (existsSync(WIN_PSQL)) return WIN_PSQL;
  return "psql";
}

function spawnPsql(psql: string, args: string[], database: string) {
  return Bun.spawn([psql, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
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

async function runPsql(
  psql: string,
  args: string[],
  opts?: { database?: string },
): Promise<PsqlResult> {
  return collect(spawnPsql(psql, args, opts?.database ?? "postgres"));
}

async function probeConnection(psql: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-tAc", "SELECT 1"]);
    if (r.code !== 0) {
      return { ok: false, detail: `psql exit ${r.code}: ${(r.stderr || r.stdout).trim()}` };
    }
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const resolvedPsql = resolvePsql();
const probe = resolvedPsql
  ? await probeConnection(resolvedPsql)
  : { ok: false, detail: "psql binary not found" };

const pgAvailable = Boolean(resolvedPsql && probe.ok);

if (!pgAvailable) {
  console.warn(
    `P2D 0054 PG tests SKIPPED: PostgreSQL unavailable (${probe.detail}). Tried: ${resolvedPsql ?? "none"}`,
  );
}

if (REQUIRE_POSTGRES_TESTS && !pgAvailable) {
  throw new Error(
    `PostgreSQL tests are required (REQUIRE_POSTGRES_TESTS=1) but unavailable at ` +
      `${PGHOST}:${PGPORT}: ${probe.detail}`,
  );
}

describe.skipIf(!pgAvailable)("P2D migration 0054 PostgreSQL", () => {
  const dbName = `p2d_0054_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;
  let ready = false;

  async function sql(text: string): Promise<string> {
    const r = await runPsql(
      psqlPath,
      ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", text],
      { database: dbName },
    );
    if (r.code !== 0) throw new Error(`SQL failed: ${r.stderr || r.stdout}\n${text}`);
    return (r.stdout || "").trim();
  }

  /** Runs SQL expected to FAIL; returns the error text. */
  async function sqlFails(text: string): Promise<string> {
    const r = await runPsql(
      psqlPath,
      ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", text],
      { database: dbName },
    );
    if (r.code === 0) throw new Error(`expected failure but succeeded:\n${text}\n${r.stdout}`);
    return (r.stderr || r.stdout).trim();
  }

  /** Runs a multi-statement script on ONE connection, in the background. */
  function startScript(script: string) {
    return spawnPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-c", script], dbName);
  }

  async function applyChainTo(name: string): Promise<void> {
    const create = await runPsql(psqlPath, [
      "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${name}`,
    ]);
    if (create.code !== 0) throw new Error(`CREATE DATABASE ${name} failed: ${create.stderr}`);
    for (const file of APPLY_CHAIN) {
      const r = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", name, "-f", file], { database: name });
      if (r.code !== 0) throw new Error(`${file} failed against ${name}:\n${r.stderr}\n${r.stdout}`);
    }
    const p2eColumn = await runPsql(
      psqlPath,
      [
        "-v", "ON_ERROR_STOP=1", "-d", name, "-c",
        "ALTER TABLE public.inventory_movements ADD COLUMN accountability_round_id uuid",
      ],
      { database: name },
    );
    if (p2eColumn.code !== 0) {
      throw new Error(`P2E inventory round contract failed against ${name}:\n${p2eColumn.stderr}\n${p2eColumn.stdout}`);
    }
  }

  async function dropDb(name: string): Promise<void> {
    await runPsql(psqlPath, [
      "-d", "postgres", "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`,
    ]);
    await runPsql(psqlPath, ["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${name}`]);
  }

  afterAll(async () => {
    if (!pgAvailable || !dbCreated) return;
    await dropDb(dbName);
  });

  // ── P2B/P2C helpers: build a confirmed, posted, VALUED PURCHASE_RECEIPT ────

  function itemJson(productKey: string, quantity: string, unitCost: string, unitKey = "kg"): string {
    return `{"product_key":${JSON.stringify(productKey)},"raw_product_text":${JSON.stringify(productKey)},` +
      `"quantity":"${quantity}","unit_key":"${unitKey}","raw_unit":"${unitKey}","unit_cost":"${unitCost}"}`;
  }

  /** Drafts and confirms a P2B receipt for `db`, returning its id. */
  async function makeConfirmedIn(
    dbSql: (t: string) => Promise<string>,
    key: string,
    items: readonly string[],
  ): Promise<string> {
    await dbSql(
      `SELECT public.upsert_purchase_receipt_draft(
        'line-text', ${sqlLiteral(key)}, 'p2b-slice-a-v1', '2026-07-29',
        '[${items.join(",")}]'::jsonb,
        p_source_type=>'group', p_source_id=>'G1')`,
    );
    const id = await dbSql(`SELECT id FROM public.purchase_receipts WHERE document_key=${sqlLiteral(key)}`);
    await dbSql(`SELECT public.confirm_purchase_receipt('${id}', ${sqlLiteral(`ck-${key}`)})`);
    return id;
  }

  async function makeConfirmed(key: string, items: readonly string[]): Promise<string> {
    return makeConfirmedIn(sql, key, items);
  }

  type ValuedReceipt = { movementId: string; costMovementId: string; lines: CostLine[]; raw: Record<string, unknown> };
  type CostLine = {
    movement_line_id: string;
    signed_value_satang: string;
    unit_cost_satang_snapshot: string | null;
    source_cost_line_id: string | null;
  };

  async function postReceipt(rid: string, actor?: string): Promise<{ movementId: string; replayed: boolean }> {
    const res = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}'${actor ? `, ${sqlLiteral(actor)}` : ""})`),
    ) as { movement_id: string; replayed: boolean };
    return { movementId: res.movement_id, replayed: res.replayed };
  }

  async function valuePurchaseReceipt(movementId: string, actor?: string): Promise<Record<string, unknown>> {
    return JSON.parse(
      await sql(`SELECT public.value_purchase_receipt_movement('${movementId}'${actor ? `, ${sqlLiteral(actor)}` : ""})`),
    ) as Record<string, unknown>;
  }

  /** Full real pipeline: draft -> confirm -> post -> value. Returns everything a scenario needs. */
  async function makeValuedReceipt(
    key: string,
    items: readonly string[],
    actor?: string,
  ): Promise<ValuedReceipt> {
    const rid = await makeConfirmed(key, items);
    const post = await postReceipt(rid, actor);
    const val = await valuePurchaseReceipt(post.movementId, actor);
    return {
      movementId: post.movementId,
      costMovementId: val.cost_movement_id as string,
      lines: val.lines as CostLine[],
      raw: val,
    };
  }

  // ── Direct 0053 ledger inserts for ISSUE/GOOD_RETURN/DAMAGED_WRITE_OFF/ ────
  // ADJUSTMENT — see file header for why this is legitimate.

  async function insertRawMovement(opts: {
    type: "ISSUE" | "GOOD_RETURN" | "DAMAGED_WRITE_OFF" | "ADJUSTMENT";
    lines: Array<{ productKey: string; qty: string; unitKey?: string; locationCode?: string }>;
    dedupeKey?: string;
    accountabilityRoundId?: string | null;
  }): Promise<string> {
    const dedupe = opts.dedupeKey ?? `test-${opts.type.toLowerCase()}-${randomBytes(8).toString("hex")}`;
    const mid = await sql(`SELECT gen_random_uuid()`);
    const roundId = opts.accountabilityRoundId === undefined
      ? (opts.type === "ADJUSTMENT" ? null : ROUND_A)
      : opts.accountabilityRoundId;
    const values = opts.lines
      .map(
        (l, i) =>
          `('${mid}', ${i + 1}, ${sqlLiteral(l.productKey)}, ${sqlLiteral(l.unitKey ?? "kg")}, ` +
          `${sqlLiteral(l.locationCode ?? "MAIN")}, ${l.qty})`,
      )
      .join(",\n         ");
    // Header + lines MUST be written in a single sql() call: each sql() call
    // is its own psql invocation with its own implicit transaction, and the
    // line_count deferred constraint trigger fires at THAT transaction's
    // commit. Splitting this into two calls would commit the header alone,
    // with zero lines visible yet, and the trigger would reject it.
    await sql(
      `INSERT INTO public.inventory_movements
         (id, movement_type, business_date, source_system, source_document_type,
          source_document_id, dedupe_key, line_count, accountability_round_id)
       VALUES ('${mid}', '${opts.type}', '2026-07-29', 'test-harness',
               ${sqlLiteral(`manual-${opts.type.toLowerCase()}`)}, gen_random_uuid(),
               ${sqlLiteral(dedupe)}, ${opts.lines.length},
               ${roundId === null ? "NULL" : sqlLiteral(roundId)}::uuid);
       INSERT INTO public.inventory_movement_lines
         (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
       VALUES ${values}`,
    );
    return mid;
  }

  async function valueConsumption(movementId: string, actor?: string): Promise<Record<string, unknown>> {
    return JSON.parse(
      await sql(`SELECT public.value_inventory_consumption_movement('${movementId}'${actor ? `, ${sqlLiteral(actor)}` : ""})`),
    ) as Record<string, unknown>;
  }

  async function valueConsumptionFails(movementId: string): Promise<string> {
    return sqlFails(`SELECT public.value_inventory_consumption_movement('${movementId}')`);
  }

  async function valueGoodReturn(
    movementId: string,
    sourceCostLineIds: ReadonlyArray<string | null>,
    actor?: string,
  ): Promise<Record<string, unknown>> {
    const arr = `ARRAY[${sourceCostLineIds.map((v) => (v === null ? "NULL" : sqlLiteral(v))).join(",")}]::uuid[]`;
    return JSON.parse(
      await sql(`SELECT public.value_good_return_movement('${movementId}', ${arr}${actor ? `, ${sqlLiteral(actor)}` : ""})`),
    ) as Record<string, unknown>;
  }

  async function valueGoodReturnFails(
    movementId: string,
    sourceCostLineIds: ReadonlyArray<string | null>,
  ): Promise<string> {
    const arr = `ARRAY[${sourceCostLineIds.map((v) => (v === null ? "NULL" : sqlLiteral(v))).join(",")}]::uuid[]`;
    return sqlFails(`SELECT public.value_good_return_movement('${movementId}', ${arr})`);
  }

  async function reverseQuantityMovement(
    movementId: string,
    key: string,
    reason: string,
    actor: string,
  ): Promise<{ reversalId: string; replayed: boolean }> {
    const r = JSON.parse(
      await sql(
        `SELECT public.reverse_inventory_movement('${movementId}', ${sqlLiteral(key)}, ${sqlLiteral(reason)}, ${sqlLiteral(actor)})`,
      ),
    ) as { reversal_id: string; replayed: boolean };
    return { reversalId: r.reversal_id, replayed: r.replayed };
  }

  async function reverseCostMovement(
    costMovementId: string,
    reversalMovementId: string,
    reason: string,
    actor?: string,
  ): Promise<Record<string, unknown>> {
    return JSON.parse(
      await sql(
        `SELECT public.reverse_inventory_cost_movement('${costMovementId}', '${reversalMovementId}', ` +
          `${sqlLiteral(reason)}${actor ? `, ${sqlLiteral(actor)}` : ""})`,
      ),
    ) as Record<string, unknown>;
  }

  type CostBalance = { qty: string; value: string; avg: string | null } | "NONE";

  async function costBalance(product: string, unit = "kg", location = "MAIN"): Promise<CostBalance> {
    const row = await sql(
      `SELECT coalesce((
         SELECT jsonb_build_object(
                  'qty', b->>'quantity_balance',
                  'value', b->>'value_balance_satang',
                  'avg', b->>'average_unit_cost_satang')
           FROM jsonb_array_elements(
                  public.get_inventory_cost_balances('${location}', ${sqlLiteral(product)}, '${unit}', true)->'balances') b
          LIMIT 1), 'null'::jsonb)::text`,
    );
    const parsed = JSON.parse(row) as { qty: string; value: string; avg: string | null } | null;
    return parsed === null ? "NONE" : parsed;
  }

  /**
   * costBalance() legitimately returns "NONE" for a key that has never been
   * valued, so reading .qty off it does not typecheck. Narrow by FAILING when
   * the balance is absent rather than by casting: a test that expected a
   * balance and got none has already found something, and a cast would hide it.
   */
  async function costBalanceRow(
    product: string,
    unit = "kg",
    location = "MAIN",
  ): Promise<{ qty: string; value: string; avg: string | null }> {
    const balance = await costBalance(product, unit, location);
    if (balance === "NONE") {
      throw new Error(`expected a cost balance for (${location},${product},${unit}), got NONE`);
    }
    return balance;
  }

  async function ledgerQtySum(product: string, unit = "kg", location = "MAIN"): Promise<string> {
    return sql(
      `SELECT coalesce(sum(signed_quantity), 0)::text FROM public.inventory_movement_lines
        WHERE location_code = '${location}' AND product_key = ${sqlLiteral(product)} AND unit_key = '${unit}'`,
    );
  }

  async function costMovementCount(movementId: string): Promise<string> {
    return sql(`SELECT count(*)::text FROM public.inventory_cost_movements WHERE movement_id = '${movementId}'`);
  }

  function uniqueProduct(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString("hex")}`;
  }

  // ── Controller-released barrier with unconditional cleanup (copied verbatim
  // from migration-0053.pg.test.ts — see that file for full commentary). ────

  const CHILD_EXIT_MS = 20_000;
  const CHILD_KILL_MS = 5_000;
  const WAIT_MS = 20_000;
  const TIMED_OUT = Symbol("timed-out");

  function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  type Child = {
    name: string;
    marker: string;
    proc: ReturnType<typeof spawnPsql>;
    result: Promise<PsqlResult>;
  };

  type GateReport = { terminated: string[]; leaked: string[] };

  type GateScope = {
    hold: string;
    start(name: string, script: string): Child;
    started(child: Child): Promise<void>;
    parked(child: Child): Promise<void>;
    blocked(child: Child): Promise<void>;
    exits(child: Child, ms?: number): Promise<PsqlResult>;
    exitedWithin(child: Child, ms: number): Promise<PsqlResult | null>;
    release(): Promise<void>;
  };

  async function ensureBarrierTable(): Promise<void> {
    await sql(`CREATE TABLE IF NOT EXISTS public.test_barrier_release (k text PRIMARY KEY)`);
  }

  function markerPredicate(marker: string, alias = ""): string {
    const q = alias ? `${alias}.` : "";
    return `${q}datname = current_database()
              AND ${q}pid <> pg_backend_pid()
              AND ${q}query LIKE '%${marker}%'
              AND ${q}query NOT LIKE '%pg_stat_activity%'`;
  }

  async function pollUntil(label: string, query: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Number(await sql(query)) > 0) return;
      if (Date.now() > deadline) throw new Error(`harness: ${label} within ${timeoutMs}ms`);
      await Bun.sleep(25);
    }
  }

  async function withGate(
    name: string,
    key: number,
    body: (gate: GateScope) => Promise<void>,
    opts: {
      allowTermination?: boolean;
      onCleanup?: (report: GateReport) => void;
    } = {},
  ): Promise<GateReport> {
    await ensureBarrierTable();
    await sql(`DELETE FROM public.test_barrier_release WHERE k = '${name}'`);

    const children: Child[] = [];
    const report: GateReport = { terminated: [], leaked: [] };
    let released = false;

    async function release(): Promise<void> {
      if (released) return;
      released = true;
      await sql(`INSERT INTO public.test_barrier_release (k) VALUES ('${name}')
                   ON CONFLICT DO NOTHING`);
    }

    const scope: GateScope = {
      hold: `DO $hold$
        BEGIN
          LOOP
            EXIT WHEN EXISTS (SELECT 1 FROM public.test_barrier_release WHERE k = '${name}');
            PERFORM pg_sleep(0.05);
          END LOOP;
        END $hold$;`,
      release,
      start(childName, script) {
        const marker = `MARK_${name}_${childName}`.toUpperCase().replace(/[^A-Z0-9_]/gu, "_");
        const proc = startScript(`/* ${marker} */ ${script}`);
        const child: Child = { name: childName, marker, proc, result: collect(proc) };
        children.push(child);
        return child;
      },
      async started(child) {
        await pollUntil(
          `child ${child.name} never connected`,
          `SELECT count(*) FROM pg_stat_activity WHERE ${markerPredicate(child.marker)}`,
          WAIT_MS,
        );
      },
      async parked(child) {
        await scope.started(child);
        await pollUntil(
          `child ${child.name} never took advisory lock ${key}`,
          `SELECT count(*) FROM pg_locks
            WHERE locktype = 'advisory' AND classid = 0 AND objid = ${key} AND granted`,
          WAIT_MS,
        );
      },
      async blocked(child) {
        await pollUntil(
          `child ${child.name} never blocked on a lock`,
          `SELECT count(DISTINCT a.pid) FROM pg_stat_activity a
             JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
            WHERE a.wait_event_type = 'Lock' AND ${markerPredicate(child.marker, "a")}`,
          WAIT_MS,
        );
      },
      async exits(child, ms = CHILD_EXIT_MS) {
        const r = await within(child.result, ms);
        if (r === TIMED_OUT) {
          throw new Error(`harness: child ${child.name} did not exit within ${ms}ms`);
        }
        return r;
      },
      async exitedWithin(child, ms) {
        const r = await within(child.result, ms);
        return r === TIMED_OUT ? null : r;
      },
    };

    let bodyError: unknown;
    try {
      await body(scope);
    } catch (err) {
      bodyError = err;
    }

    const cleanupProblems: string[] = [];
    const note = (what: string, err: unknown) =>
      cleanupProblems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);

    try {
      await release();
    } catch (err) {
      note("gate release failed", err);
    }

    for (const child of children) {
      try {
        let r = await within(child.result, CHILD_EXIT_MS);
        if (r === TIMED_OUT) {
          child.proc.kill();
          r = await within(child.result, CHILD_KILL_MS);
          report.terminated.push(child.name);
          if (r === TIMED_OUT) cleanupProblems.push(`child ${child.name} survived termination`);
        }
      } catch (err) {
        note(`collecting child ${child.name}`, err);
      }
    }

    for (const child of children) {
      try {
        await sql(
          `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
            WHERE ${markerPredicate(child.marker)}`,
        );
        await pollUntil(
          `backend for ${child.name} still present after cleanup`,
          `SELECT CASE WHEN count(*) = 0 THEN 1 ELSE 0 END
             FROM pg_stat_activity WHERE ${markerPredicate(child.marker)}`,
          CHILD_KILL_MS,
        );
      } catch (err) {
        report.leaked.push(`session ${child.name}`);
        note(`terminating leftover backend for ${child.name}`, err);
      }
    }

    try {
      await sql(`DELETE FROM public.test_barrier_release WHERE k = '${name}'`);
      const rows = await sql(
        `SELECT count(*) FROM public.test_barrier_release WHERE k = '${name}'`,
      );
      if (Number(rows) !== 0) report.leaked.push("barrier row");

      const advisory = await sql(
        `SELECT count(*) FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 0 AND objid = ${key}`,
      );
      if (Number(advisory) !== 0) report.leaked.push(`advisory lock ${key}`);

      const ungranted = await sql(
        `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.datname = current_database()
            AND a.pid <> pg_backend_pid()`,
      );
      if (Number(ungranted) !== 0) report.leaked.push(`${ungranted} ungranted lock(s)`);
    } catch (err) {
      note("verifying cleanup", err);
    }

    opts.onCleanup?.(report);

    if (bodyError) {
      if (cleanupProblems.length || report.leaked.length) {
        console.warn(
          `gate "${name}" cleanup after failure: ${[...cleanupProblems, ...report.leaked].join("; ")}`,
        );
      }
      throw bodyError;
    }

    const unexpected = [
      ...cleanupProblems,
      ...report.leaked.map((l) => `leaked ${l}`),
      ...(opts.allowTermination ? [] : report.terminated.map((c) => `child ${c} had to be terminated`)),
    ];
    if (unexpected.length) {
      throw new Error(`harness: gate "${name}" cleanup failed — ${unexpected.join("; ")}`);
    }
    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Bootstrap
  // ═══════════════════════════════════════════════════════════════════════

  test(
    "the whole chain including 0054 applies clean on a disposable database",
    async () => {
      for (const file of APPLY_CHAIN) {
        expect(existsSync(file), `missing ${file}`).toBe(true);
      }
      await applyChainTo(dbName);
      dbCreated = true;
      ready = true;

      // Sanity: the four new movement types are now legal, the two new
      // tables and two new views exist, and the seeded location is present.
      expect(await sql(`SELECT string_agg(location_code, ',') FROM public.inventory_locations`)).toBe("MAIN");
      const newObjects = await sql(
        `SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables
          WHERE schemaname='public' AND tablename LIKE 'inventory_cost%'`,
      );
      expect(newObjects).toBe("inventory_cost_movement_lines,inventory_cost_movements");
      const newViews = await sql(
        `SELECT string_agg(viewname, ',' ORDER BY viewname) FROM pg_views
          WHERE schemaname='public' AND viewname IN ('inventory_cost_balances','unvalued_inventory_movement_lines')`,
      );
      expect(newViews).toBe("inventory_cost_balances,unvalued_inventory_movement_lines");
    },
    // supabase/tests/purchase_capture_slice_c_hardening.sql alone takes ~200s.
    { timeout: 400_000 },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Weighted-average calculation
  // ═══════════════════════════════════════════════════════════════════════

  test("weighted average: 10 @ 100 satang/unit + 10 @ 200 satang/unit gives qty 20, value 3000, avg 150", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("wavg");
    const receipt = await makeValuedReceipt(`doc-wavg-${product}`, [
      itemJson(product, "10", "1"), // 10 * 1.00 baht * 100 = 1000 satang
      itemJson(product, "10", "2"), // 10 * 2.00 baht * 100 = 2000 satang
    ]);
    expect(receipt.lines).toHaveLength(2);
    expect(receipt.lines[0]?.signed_value_satang).toBe("1000");
    expect(receipt.lines[1]?.signed_value_satang).toBe("2000");

    const bal = await costBalance(product);
    expect(bal).not.toBe("NONE");
    expect((bal as { qty: string }).qty).toBe("20.000000");
    expect((bal as { value: string }).value).toBe("3000");
    expect((bal as { avg: string }).avg).toBe("150.0000000000000000");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Multiple purchases at different costs, then a partial issue
  // ═══════════════════════════════════════════════════════════════════════

  test("a partial issue after multiple purchases values at the moving average and leaves the correct remainder", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("partial");
    await makeValuedReceipt(`doc-partial-${product}`, [
      itemJson(product, "10", "1"),
      itemJson(product, "10", "2"),
    ]);
    expect((await costBalanceRow(product)).qty).toBe("20.000000");

    const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-5" }] });
    const val = await valueConsumption(issueId);
    const lines = val.lines as CostLine[];
    expect(lines).toHaveLength(1);
    // avg = 150 satang/unit; issue 5 -> exactly 750, no rounding needed.
    expect(lines[0]?.signed_value_satang).toBe("-750");

    const bal = await costBalance(product) as { qty: string; value: string; avg: string };
    expect(bal.qty).toBe("15.000000");
    expect(bal.value).toBe("2250");
    expect(bal.avg).toBe("150.0000000000000000");
  });

  test("same-key lines in one ISSUE consume the pre-movement balance exactly once and drain to zero", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("samekey-drain");
    await makeValuedReceipt(`doc-samekey-drain-${product}`, [itemJson(product, "3", "1")]);

    const issueId = await insertRawMovement({
      type: "ISSUE",
      lines: [
        { productKey: product, qty: "-2" },
        { productKey: product, qty: "-1" },
      ],
    });
    const first = await valueConsumption(issueId);
    const lines = first.lines as CostLine[];

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.signed_value_satang)).toEqual(["-200", "-100"]);
    expect(await ledgerQtySum(product)).toBe("0.000000");
    expect(await costBalanceRow(product)).toEqual({
      qty: "0.000000",
      value: "0",
      avg: null,
    });

    // Valuation writes no quantity and seals exactly one cost header with one
    // value line per pre-existing quantity line.
    expect(
      await sql(`SELECT count(*)::text FROM public.inventory_movements WHERE id='${issueId}'`),
    ).toBe("1");
    expect(
      await sql(`SELECT count(*)::text FROM public.inventory_movement_lines WHERE movement_id='${issueId}'`),
    ).toBe("2");
    expect(await costMovementCount(issueId)).toBe("1");
    expect(
      await sql(
        `SELECT count(*)::text
           FROM public.inventory_cost_movement_lines c
           JOIN public.inventory_cost_movements m ON m.id = c.cost_movement_id
          WHERE m.movement_id='${issueId}'`,
      ),
    ).toBe("2");

    const replay = await valueConsumption(issueId);
    expect(replay.replayed).toBe(true);
    expect(replay.cost_movement_id).toBe(first.cost_movement_id);
    expect(await costMovementCount(issueId)).toBe("1");
  });

  test("same-key lines in one partial ISSUE leave the correct valued remainder", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("samekey-partial");
    await makeValuedReceipt(`doc-samekey-partial-${product}`, [itemJson(product, "4", "1")]);

    const issueId = await insertRawMovement({
      type: "ISSUE",
      lines: [
        { productKey: product, qty: "-2" },
        { productKey: product, qty: "-1" },
      ],
    });
    const val = await valueConsumption(issueId);
    expect((val.lines as CostLine[]).map((line) => line.signed_value_satang)).toEqual([
      "-200",
      "-100",
    ]);
    expect(await costBalanceRow(product)).toEqual({
      qty: "1.000000",
      value: "100",
      avg: "100.0000000000000000",
    });
  });

  test("different balance keys in one ISSUE remain isolated", async () => {
    expect(ready).toBe(true);
    const productA = uniqueProduct("multikey-a");
    const productB = uniqueProduct("multikey-b");
    await makeValuedReceipt(`doc-multikey-a-${productA}`, [itemJson(productA, "3", "1")]);
    await makeValuedReceipt(`doc-multikey-b-${productB}`, [itemJson(productB, "4", "2")]);

    const issueId = await insertRawMovement({
      type: "ISSUE",
      lines: [
        { productKey: productA, qty: "-2" },
        { productKey: productB, qty: "-1" },
      ],
    });
    const val = await valueConsumption(issueId);
    expect((val.lines as CostLine[]).map((line) => line.signed_value_satang)).toEqual([
      "-200",
      "-200",
    ]);
    expect(await costBalanceRow(productA)).toEqual({
      qty: "1.000000",
      value: "100",
      avg: "100.0000000000000000",
    });
    expect(await costBalanceRow(productB)).toEqual({
      qty: "3.000000",
      value: "600",
      avg: "200.0000000000000000",
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4 + 5. Exact satang rounding, then exact drain after rounded partials
  // ═══════════════════════════════════════════════════════════════════════

  test("rounded partial issues followed by an exact drain leave quantity AND value at exactly zero", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("round");
    // 3 units for a total of 100 satang: unit_cost 0.3333 baht/unit -> round(3 * 0.3333 * 100) = round(99.99) = 100.
    const receipt = await makeValuedReceipt(`doc-round-${product}`, [itemJson(product, "3", "0.3333")]);
    expect(receipt.lines[0]?.signed_value_satang).toBe("100");
    expect((await costBalanceRow(product)).value).toBe("100");

    // Issue 1: not exact-drain (1 != 3). round(100 * 1 / 3) = round(33.333...) = 33.
    const issue1 = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-1" }] });
    const val1 = await valueConsumption(issue1);
    expect((val1.lines as CostLine[])[0]?.signed_value_satang).toBe("-33");
    let bal = await costBalance(product) as { qty: string; value: string };
    expect(bal.qty).toBe("2.000000");
    expect(bal.value).toBe("67");

    // Issue 1 more: not exact-drain (1 != 2). round(67 * 1 / 2) = round(33.5) = 34 (half away from zero).
    const issue2 = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-1" }] });
    const val2 = await valueConsumption(issue2);
    expect((val2.lines as CostLine[])[0]?.signed_value_satang).toBe("-34");
    bal = await costBalance(product) as { qty: string; value: string };
    expect(bal.qty).toBe("1.000000");
    expect(bal.value).toBe("33");

    // Issue the last 1: exact-drain (1 == 1). Value is the ENTIRE remaining
    // value assigned directly — no division, no rounding — which is exactly
    // what clears the residual left by the two roundings above.
    const issue3 = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-1" }] });
    const val3 = await valueConsumption(issue3);
    expect((val3.lines as CostLine[])[0]?.signed_value_satang).toBe("-33");

    // Both quantity AND value reach exactly zero together — no stranded satang.
    const finalBal = await costBalance(product);
    expect(finalBal).not.toBe("NONE");
    expect((finalBal as { qty: string }).qty).toBe("0.000000");
    expect((finalBal as { value: string }).value).toBe("0");

    // The three issue values sum to exactly the original 100 — nothing lost, nothing invented.
    expect(-33 + -34 + -33).toBe(-100);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Duplicate posting (idempotent replay)
  // ═══════════════════════════════════════════════════════════════════════

  test("duplicate posting replays: second call returns replayed=true, writes no new row, balance unchanged", async () => {
    expect(ready).toBe(true);

    // PURCHASE_RECEIPT
    {
      const product = uniqueProduct("dup-receipt");
      const rid = await makeConfirmed(`doc-dup-receipt-${product}`, [itemJson(product, "4", "5")]);
      const post = await postReceipt(rid);
      const first = await valuePurchaseReceipt(post.movementId);
      const movementsBefore = await sql("SELECT count(*)::text FROM public.inventory_cost_movements");
      const linesBefore = await sql("SELECT count(*)::text FROM public.inventory_cost_movement_lines");
      const balBefore = await costBalance(product);

      const second = await valuePurchaseReceipt(post.movementId);
      expect(second.replayed).toBe(true);
      expect(second.cost_movement_id).toBe(first.cost_movement_id);
      expect(await sql("SELECT count(*)::text FROM public.inventory_cost_movements")).toBe(movementsBefore);
      expect(await sql("SELECT count(*)::text FROM public.inventory_cost_movement_lines")).toBe(linesBefore);
      expect(await costBalance(product)).toEqual(balBefore);
    }

    // ISSUE (consumption RPC)
    {
      const product = uniqueProduct("dup-issue");
      await makeValuedReceipt(`doc-dup-issue-src-${product}`, [itemJson(product, "10", "1")]);
      const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-3" }] });
      const first = await valueConsumption(issueId);
      const movementsBefore = await sql("SELECT count(*)::text FROM public.inventory_cost_movements");
      const linesBefore = await sql("SELECT count(*)::text FROM public.inventory_cost_movement_lines");
      const balBefore = await costBalance(product);

      const second = await valueConsumption(issueId);
      expect(second.replayed).toBe(true);
      expect(second.cost_movement_id).toBe(first.cost_movement_id);
      expect(await sql("SELECT count(*)::text FROM public.inventory_cost_movements")).toBe(movementsBefore);
      expect(await sql("SELECT count(*)::text FROM public.inventory_cost_movement_lines")).toBe(linesBefore);
      expect(await costBalance(product)).toEqual(balBefore);
    }

    // GOOD_RETURN
    {
      const product = uniqueProduct("dup-return");
      await makeValuedReceipt(`doc-dup-return-src-${product}`, [itemJson(product, "5", "1")]);
      const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-2" }] });
      const issueVal = await valueConsumption(issueId);
      const sourceCostLineId = (issueVal.lines as CostLine[])[0]?.movement_line_id;
      // Need the SOURCE COST LINE id, not the ledger line id — fetch it.
      const sourceCostLine = await sql(
        `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${sourceCostLineId}'`,
      );
      const returnId = await insertRawMovement({ type: "GOOD_RETURN", lines: [{ productKey: product, qty: "2" }] });
      const first = await valueGoodReturn(returnId, [sourceCostLine]);
      const movementsBefore = await sql("SELECT count(*)::text FROM public.inventory_cost_movements");
      const linesBefore = await sql("SELECT count(*)::text FROM public.inventory_cost_movement_lines");
      const balBefore = await costBalance(product);

      const second = await valueGoodReturn(returnId, [sourceCostLine]);
      expect(second.replayed).toBe(true);
      expect(second.cost_movement_id).toBe(first.cost_movement_id);
      expect(await sql("SELECT count(*)::text FROM public.inventory_cost_movements")).toBe(movementsBefore);
      expect(await sql("SELECT count(*)::text FROM public.inventory_cost_movement_lines")).toBe(linesBefore);
      expect(await costBalance(product)).toEqual(balBefore);
    }

    // REVERSAL
    {
      const product = uniqueProduct("dup-reversal");
      const receipt = await makeValuedReceipt(`doc-dup-reversal-${product}`, [itemJson(product, "3", "1")]);
      const rev = await reverseQuantityMovement(receipt.movementId, `rev-dup-${product}`, "test", "tester");
      const first = await reverseCostMovement(receipt.costMovementId, rev.reversalId, "test");
      const movementsBefore = await sql("SELECT count(*)::text FROM public.inventory_cost_movements");
      const linesBefore = await sql("SELECT count(*)::text FROM public.inventory_cost_movement_lines");

      const second = await reverseCostMovement(receipt.costMovementId, rev.reversalId, "test");
      expect(second.replayed).toBe(true);
      expect(second.cost_movement_id).toBe(first.cost_movement_id);
      expect(await sql("SELECT count(*)::text FROM public.inventory_cost_movements")).toBe(movementsBefore);
      expect(await sql("SELECT count(*)::text FROM public.inventory_cost_movement_lines")).toBe(linesBefore);
    }
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Concurrent posting — deterministic proof via withGate
  // ═══════════════════════════════════════════════════════════════════════

  test("concurrent consumption valuations against the SAME balance key serialize and the second sees the first's effect", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("conc");
    // 3 units for 100 satang total (unit_cost 0.3333) — chosen so a consumer
    // reading the STALE pre-first-commit balance computes a DIFFERENT (wrong)
    // value than a consumer correctly reading the post-first-commit balance.
    // Stale (wrong) second value: round(100 * 1 / 3) = 33 — SAME as the first's.
    // Correct (serialized) second value: round(67 * 1 / 2) = 34 — DIFFERENT.
    // This is what makes the assertion below a genuine serialization proof
    // rather than a coincidence: only correct serialization produces 34.
    await makeValuedReceipt(`doc-conc-src-${product}`, [itemJson(product, "3", "0.3333")]);
    expect((await costBalance(product) as { value: string }).value).toBe("100");

    const movA = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-1" }] });
    const movB = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-1" }] });

    const KEY = 918_054_701;
    await withGate("p2d-conc-issue", KEY, async (gate) => {
      // A values its issue, then takes a synthetic gate lock and parks with the
      // transaction still OPEN — the real advisory lock the RPC itself takes on
      // this balance key (inventory_cost_lock_balance_keys) is therefore still
      // held too, for the whole duration A is parked.
      const a = gate.start(
        "a",
        `
        BEGIN;
        SELECT public.value_inventory_consumption_movement('${movA}');
        SELECT pg_advisory_xact_lock(${KEY});
        ${gate.hold}
        COMMIT;`,
      );
      await gate.parked(a);

      // B calls the SAME RPC against a DIFFERENT movement but the SAME balance
      // key. It must block on the REAL balance-key advisory lock A is still
      // holding — proven by observing B genuinely waiting on a lock, not by a
      // sleep duration.
      const b = gate.start("b", `SELECT public.value_inventory_consumption_movement('${movB}');`);
      await gate.blocked(b);

      await gate.release();
      const ra = await gate.exits(a);
      const rb = await gate.exits(b);

      expect(ra.code, `session A failed: ${ra.stderr}`).toBe(0);
      expect(rb.code, `session B failed: ${rb.stderr}`).toBe(0);

      const lineA = await sql(
        `SELECT c.signed_value_satang FROM public.inventory_cost_movements m
           JOIN public.inventory_cost_movement_lines c ON c.cost_movement_id = m.id
          WHERE m.movement_id = '${movA}'`,
      );
      const lineB = await sql(
        `SELECT c.signed_value_satang FROM public.inventory_cost_movements m
           JOIN public.inventory_cost_movement_lines c ON c.cost_movement_id = m.id
          WHERE m.movement_id = '${movB}'`,
      );
      expect(lineA, "A (first) consumes at the pre-existing average").toBe("-33");
      expect(
        lineB,
        "B (second) must see A's committed effect — a stale read would also produce -33",
      ).toBe("-34");
    });

    const finalBal = await costBalance(product) as { qty: string; value: string };
    expect(finalBal.qty).toBe("1.000000");
    // 100 (original) - 33 (A) - 34 (B) = 33 remaining — matches a sequential run exactly.
    expect(finalBal.value).toBe("33");
  }, 90_000);

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Reversal
  // ═══════════════════════════════════════════════════════════════════════

  test("reversing a valued movement produces exact negative cost lines, restores the balance, and recomputes nothing", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("rev");
    const receipt = await makeValuedReceipt(`doc-rev-${product}`, [itemJson(product, "10", "1")]);
    expect(receipt.lines[0]?.signed_value_satang).toBe("1000");
    const originalSnapshot = receipt.lines[0]?.unit_cost_satang_snapshot;

    const qtyRev = await reverseQuantityMovement(receipt.movementId, `rev-key-${product}`, "miscount", "tester");
    const costRev = await reverseCostMovement(receipt.costMovementId, qtyRev.reversalId, "miscount", "tester");

    expect(costRev.replayed).toBe(false);
    expect(costRev.cost_event_type).toBe("REVERSAL");
    expect(costRev.valuation_basis).toBe("EXACT_NEGATION");
    const revLines = costRev.lines as CostLine[];
    expect(revLines).toHaveLength(1);
    expect(revLines[0]?.signed_value_satang).toBe("-1000");
    // Nothing recomputed at a later average — the snapshot is copied verbatim.
    expect(revLines[0]?.unit_cost_satang_snapshot).toBe(originalSnapshot);

    // Balance returns to its pre-posting value: zero, exactly.
    const bal = await costBalance(product);
    expect(bal).not.toBe("NONE");
    expect((bal as { qty: string }).qty).toBe("0.000000");
    expect((bal as { value: string }).value).toBe("0");

    // The original header now carries the back-link.
    expect(
      await sql(`SELECT reversed_by_cost_movement_id::text FROM public.inventory_cost_movements WHERE id='${receipt.costMovementId}'`),
    ).toBe(String(costRev.cost_movement_id));
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Sale/withdrawal consumption
  // ═══════════════════════════════════════════════════════════════════════

  test("an ISSUE movement consumes at the moving average effective at posting time", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("issue9");
    await makeValuedReceipt(`doc-issue9-${product}`, [itemJson(product, "8", "2.5")]); // 8 * 2.5 * 100 = 2000 satang, avg 250
    expect((await costBalance(product) as { avg: string }).avg).toBe("250.0000000000000000");

    const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-3" }] });
    const val = await valueConsumption(issueId);
    expect(val.cost_event_type).toBe("ISSUE");
    expect(val.valuation_basis).toBe("MOVING_AVERAGE");
    expect((val.lines as CostLine[])[0]?.signed_value_satang).toBe("-750"); // 3 * 250

    const bal = await costBalance(product) as { qty: string; value: string };
    expect(bal.qty).toBe("5.000000");
    expect(bal.value).toBe("1250");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Return restoration — original issue cost, not the current average
  // ═══════════════════════════════════════════════════════════════════════

  test("a GOOD_RETURN restores the ORIGINAL issue cost even though the average has since moved", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("return10");
    // 5 @ 1.00 baht = 500 satang, avg 100.
    await makeValuedReceipt(`doc-return10-a-${product}`, [itemJson(product, "5", "1")]);
    const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-2" }] });
    const issueVal = await valueConsumption(issueId);
    const issueLine = (issueVal.lines as CostLine[])[0]!;
    expect(issueLine.signed_value_satang).toBe("-200"); // 2 * 100, exact
    const sourceCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${issueLine.movement_line_id}'`,
    );

    // Move the average: buy 3 more @ 3.00 baht = 900 satang.
    // Balance before this purchase: qty 3, value 300 (avg 100).
    // After: qty 6, value 1200, avg 200 — the average has DOUBLED.
    await makeValuedReceipt(`doc-return10-b-${product}`, [itemJson(product, "3", "3")]);
    const balBeforeReturn = await costBalance(product) as { qty: string; value: string; avg: string };
    expect(balBeforeReturn.qty).toBe("6.000000");
    expect(balBeforeReturn.value).toBe("1200");
    expect(balBeforeReturn.avg).toBe("200.0000000000000000");

    // Return the full 2 units originally issued. At the CURRENT average (200)
    // this would be 400; the contract requires the ORIGINAL issue cost (200).
    const returnId = await insertRawMovement({ type: "GOOD_RETURN", lines: [{ productKey: product, qty: "2" }] });
    const returnVal = await valueGoodReturn(returnId, [sourceCostLineId]);
    expect(returnVal.cost_event_type).toBe("GOOD_RETURN");
    expect(returnVal.valuation_basis).toBe("SOURCE_ISSUE_SNAPSHOT");
    const returnLine = (returnVal.lines as CostLine[])[0]!;
    expect(returnLine.signed_value_satang, "restored at the ORIGINAL issue cost, not the current average").toBe("200");
    expect(returnLine.source_cost_line_id).toBe(sourceCostLineId);

    const balAfterReturn = await costBalance(product) as { qty: string; value: string };
    expect(balAfterReturn.qty).toBe("8.000000");
    expect(balAfterReturn.value).toBe("1400"); // 1200 + 200, NOT 1200 + 400
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Cumulative return guard
  // ═══════════════════════════════════════════════════════════════════════

  test("two good returns exceeding the issued quantity refuse with unprovable_return_cost", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("guard11");
    await makeValuedReceipt(`doc-guard11-${product}`, [itemJson(product, "2", "1")]); // 2 @ 100 satang = 200
    const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-2" }] });
    const issueVal = await valueConsumption(issueId);
    const issueLine = (issueVal.lines as CostLine[])[0]!;
    expect(issueLine.signed_value_satang).toBe("-200"); // exact drain, all 2 units
    const sourceCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${issueLine.movement_line_id}'`,
    );

    // First return: the FULL 2 units — exact match, restores exactly 200.
    const return1Id = await insertRawMovement({ type: "GOOD_RETURN", lines: [{ productKey: product, qty: "2" }] });
    const return1Val = await valueGoodReturn(return1Id, [sourceCostLineId]);
    expect((return1Val.lines as CostLine[])[0]?.signed_value_satang).toBe("200");
    expect(await costBalance(product)).toEqual({ qty: "2.000000", value: "200", avg: "100.0000000000000000" });

    // Second return against the SAME source cost line: nothing left to return
    // (2 of 2 already restored) — must refuse, not silently over-restore.
    const return2Id = await insertRawMovement({ type: "GOOD_RETURN", lines: [{ productKey: product, qty: "1" }] });
    const err = await valueGoodReturnFails(return2Id, [sourceCostLineId]);
    expect(err).toMatch(/unprovable_return_cost/iu);
    expect(await costMovementCount(return2Id)).toBe("0");
    expect(await costBalance(product)).toEqual({ qty: "2.000000", value: "200", avg: "100.0000000000000000" });
  });

  test("a sequence of PARTIAL returns totalling exactly the issued quantity restores exactly the issued value with zero residue", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("partreturn11");
    // 3 units for 100 satang total (unit_cost 0.3333) — source_unit_cost = 100/3.
    await makeValuedReceipt(`doc-partreturn11-${product}`, [itemJson(product, "3", "0.3333")]);
    const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-3" }] });
    const issueVal = await valueConsumption(issueId);
    const issueLine = (issueVal.lines as CostLine[])[0]!;
    expect(issueLine.signed_value_satang).toBe("-100"); // exact drain
    const sourceCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${issueLine.movement_line_id}'`,
    );

    const values: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const rid = await insertRawMovement({ type: "GOOD_RETURN", lines: [{ productKey: product, qty: "1" }] });
      const val = await valueGoodReturn(rid, [sourceCostLineId]);
      values.push((val.lines as CostLine[])[0]!.signed_value_satang);
    }
    // round(100/3 * 1) = 33 for the first two partials; the THIRD (which
    // completes the issued quantity) is the exact-drain remainder: 100-33-33=34.
    expect(values).toEqual(["33", "33", "34"]);
    expect(values.reduce((a, b) => a + Number(b), 0)).toBe(100);

    const bal = await costBalance(product) as { qty: string; value: string };
    expect(bal.qty).toBe("3.000000");
    expect(bal.value).toBe("100"); // fully restored, zero rounding residue
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Damaged write-off
  // ═══════════════════════════════════════════════════════════════════════

  test("a DAMAGED_WRITE_OFF consumes at the average and decreases the sellable balance; it never restores stock", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("dmg12");
    await makeValuedReceipt(`doc-dmg12-${product}`, [itemJson(product, "5", "1")]); // avg 100
    const dmgId = await insertRawMovement({ type: "DAMAGED_WRITE_OFF", lines: [{ productKey: product, qty: "-2" }] });
    const val = await valueConsumption(dmgId);
    expect(val.cost_event_type).toBe("DAMAGED_WRITE_OFF");
    expect(val.valuation_basis).toBe("MOVING_AVERAGE");
    expect((val.lines as CostLine[])[0]?.signed_value_satang).toBe("-200");

    const bal = await costBalance(product) as { qty: string; value: string };
    expect(bal.qty, "sellable balance decreased").toBe("3.000000");
    expect(bal.value).toBe("300");

    expect(
      await sql(`SELECT cost_event_type FROM public.inventory_cost_movements WHERE movement_id='${dmgId}'`),
    ).toBe("DAMAGED_WRITE_OFF");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13. Insufficient/negative inventory refusal
  // ═══════════════════════════════════════════════════════════════════════

  test("a consumption that would drive the balance negative raises insufficient_inventory and writes nothing", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("insuff13");
    await makeValuedReceipt(`doc-insuff13-${product}`, [itemJson(product, "2", "1")]);
    const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-5" }] });

    const err = await valueConsumptionFails(issueId);
    expect(err).toMatch(/insufficient_inventory/iu);
    expect(await costMovementCount(issueId)).toBe("0");
    expect(await sql(`SELECT count(*)::text FROM public.inventory_cost_movement_lines WHERE movement_line_id IN
      (SELECT id FROM public.inventory_movement_lines WHERE movement_id='${issueId}')`)).toBe("0");
    expect((await costBalance(product) as { qty: string }).qty).toBe("2.000000");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14. Unvalued source refusal
  // ═══════════════════════════════════════════════════════════════════════

  test("a consumption against unvalued ledger stock raises unvalued_source_inventory, distinct from insufficient_inventory", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("unvalued14");
    // Post a real receipt through the real pipeline, but deliberately never
    // call value_purchase_receipt_movement — the ledger stock exists (real
    // quantity) but no cost line values it.
    const rid = await makeConfirmed(`doc-unvalued14-${product}`, [itemJson(product, "5", "1")]);
    await postReceipt(rid);
    expect((await ledgerQtySum(product))).toBe("5.000000");
    expect(await costBalance(product)).toBe("NONE");

    const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-2" }] });
    const err = await valueConsumptionFails(issueId);
    expect(err).toMatch(/unvalued_source_inventory/iu);
    expect(err).not.toMatch(/insufficient_inventory/iu);
    expect(await costMovementCount(issueId)).toBe("0");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15. Receipt/source mismatch
  // ═══════════════════════════════════════════════════════════════════════

  test("each RPC refuses a movement of the wrong type, and a return cannot borrow an unrelated product's cost", async () => {
    expect(ready).toBe(true);

    // value_purchase_receipt_movement refuses a non-PURCHASE_RECEIPT movement.
    {
      const product = uniqueProduct("mismatch15a");
      await makeValuedReceipt(`doc-mismatch15a-src-${product}`, [itemJson(product, "5", "1")]);
      const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-1" }] });
      const err = await sqlFails(`SELECT public.value_purchase_receipt_movement('${issueId}')`);
      expect(err).toMatch(/unsupported_movement_type/iu);
    }

    // value_inventory_consumption_movement refuses a non-consumption movement.
    {
      const product = uniqueProduct("mismatch15b");
      const receipt = await makeValuedReceipt(`doc-mismatch15b-${product}`, [itemJson(product, "5", "1")]);
      const err = await sqlFails(`SELECT public.value_inventory_consumption_movement('${receipt.movementId}')`);
      expect(err).toMatch(/unsupported_movement_type/iu);
    }

    // value_good_return_movement refuses a non-GOOD_RETURN movement.
    {
      const product = uniqueProduct("mismatch15c");
      const receipt = await makeValuedReceipt(`doc-mismatch15c-${product}`, [itemJson(product, "5", "1")]);
      const err = await sqlFails(
        `SELECT public.value_good_return_movement('${receipt.movementId}', ARRAY['${receipt.lines[0]?.movement_line_id}']::uuid[])`,
      );
      expect(err).toMatch(/unsupported_movement_type/iu);
    }

    // A good return naming a source cost line for a DIFFERENT (location, product, unit) refuses.
    {
      const productA = uniqueProduct("mismatch15d-a");
      const productB = uniqueProduct("mismatch15d-b");
      await makeValuedReceipt(`doc-mismatch15d-${productA}`, [itemJson(productA, "5", "1")]);
      const issueA = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: productA, qty: "-1" }] });
      const issueValA = await valueConsumption(issueA);
      const lineA = (issueValA.lines as CostLine[])[0]!;
      const sourceCostLineA = await sql(
        `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${lineA.movement_line_id}'`,
      );

      const returnB = await insertRawMovement({ type: "GOOD_RETURN", lines: [{ productKey: productB, qty: "1" }] });
      const err = await valueGoodReturnFails(returnB, [sourceCostLineA]);
      expect(err).toMatch(/unprovable_return_cost/iu);
      expect(err).toMatch(/different key/iu);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15b. P2E accountability-round provenance
  // ═══════════════════════════════════════════════════════════════════════

  test("a same-round ISSUE to GOOD_RETURN restores the source issue cost", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("round-same");
    await makeValuedReceipt(`doc-round-same-${product}`, [itemJson(product, "3", "1")]);

    const issueId = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "-1" }],
    });
    const issueVal = await valueConsumption(issueId);
    const issueLine = (issueVal.lines as CostLine[])[0]!;
    const sourceCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${issueLine.movement_line_id}'`,
    );

    const returnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "1" }],
    });
    const returnVal = await valueGoodReturn(returnId, [sourceCostLineId]);
    expect((returnVal.lines as CostLine[])[0]?.signed_value_satang).toBe("100");
    expect(await costBalance(product)).toEqual({
      qty: "3.000000",
      value: "300",
      avg: "100.0000000000000000",
    });
  });

  test("a cross-round GOOD_RETURN refuses the source ISSUE cost", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("round-cross");
    await makeValuedReceipt(`doc-round-cross-${product}`, [itemJson(product, "3", "1")]);

    const issueId = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "-1" }],
    });
    const issueVal = await valueConsumption(issueId);
    const issueLine = (issueVal.lines as CostLine[])[0]!;
    const sourceCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${issueLine.movement_line_id}'`,
    );

    const returnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: ROUND_B,
      lines: [{ productKey: product, qty: "1" }],
    });
    const err = await valueGoodReturnFails(returnId, [sourceCostLineId]);
    expect(err).toMatch(/unprovable_return_cost/iu);
    expect(err).toMatch(/across accountability rounds/iu);
    expect(await costMovementCount(returnId)).toBe("0");
  });

  test("a GOOD_RETURN refuses missing source or return round provenance", async () => {
    expect(ready).toBe(true);
    const sourceNullProduct = uniqueProduct("round-source-null");
    await makeValuedReceipt(`doc-round-source-null-${sourceNullProduct}`, [itemJson(sourceNullProduct, "2", "1")]);
    const sourceNullIssueId = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: null,
      lines: [{ productKey: sourceNullProduct, qty: "-1" }],
    });
    const sourceNullIssueVal = await valueConsumption(sourceNullIssueId);
    const sourceNullIssueLine = (sourceNullIssueVal.lines as CostLine[])[0]!;
    const sourceNullCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${sourceNullIssueLine.movement_line_id}'`,
    );
    const boundReturnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: sourceNullProduct, qty: "1" }],
    });
    expect(await valueGoodReturnFails(boundReturnId, [sourceNullCostLineId])).toMatch(
      /ISSUE movement .* has no accountability_round_id/iu,
    );
    expect(await costMovementCount(boundReturnId)).toBe("0");

    const returnNullProduct = uniqueProduct("round-return-null");
    await makeValuedReceipt(`doc-round-return-null-${returnNullProduct}`, [itemJson(returnNullProduct, "2", "1")]);
    const boundIssueId = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: returnNullProduct, qty: "-1" }],
    });
    const boundIssueVal = await valueConsumption(boundIssueId);
    const boundIssueLine = (boundIssueVal.lines as CostLine[])[0]!;
    const boundSourceCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${boundIssueLine.movement_line_id}'`,
    );
    const nullReturnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: null,
      lines: [{ productKey: returnNullProduct, qty: "1" }],
    });
    expect(await valueGoodReturnFails(nullReturnId, [boundSourceCostLineId])).toMatch(
      /GOOD_RETURN movement .* has no accountability_round_id/iu,
    );
    expect(await costMovementCount(nullReturnId)).toBe("0");
  });

  test("a GOOD_RETURN refuses a source cost event that is not an active ISSUE", async () => {
    expect(ready).toBe(true);
    const wrongTypeProduct = uniqueProduct("source-type");
    const receipt = await makeValuedReceipt(
      `doc-source-type-${wrongTypeProduct}`,
      [itemJson(wrongTypeProduct, "2", "1")],
    );
    const receiptCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${receipt.lines[0]!.movement_line_id}'`,
    );
    const wrongTypeReturnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: wrongTypeProduct, qty: "1" }],
    });
    expect(await valueGoodReturnFails(wrongTypeReturnId, [receiptCostLineId])).toMatch(
      /does not belong to an ISSUE movement/iu,
    );
    expect(await costMovementCount(wrongTypeReturnId)).toBe("0");

    const reversedProduct = uniqueProduct("source-reversed");
    await makeValuedReceipt(`doc-source-reversed-${reversedProduct}`, [itemJson(reversedProduct, "2", "1")]);
    const issueId = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: reversedProduct, qty: "-1" }],
    });
    const issueVal = await valueConsumption(issueId);
    const issueLine = (issueVal.lines as CostLine[])[0]!;
    const sourceCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${issueLine.movement_line_id}'`,
    );
    const sourceCostMovementId = await sql(
      `SELECT cost_movement_id::text FROM public.inventory_cost_movement_lines WHERE id='${sourceCostLineId}'`,
    );
    const quantityReversal = await reverseQuantityMovement(
      issueId,
      `round-source-reversed-${reversedProduct}`,
      "test",
      "tester",
    );
    await reverseCostMovement(sourceCostMovementId, quantityReversal.reversalId, "test");

    const reversedSourceReturnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: reversedProduct, qty: "1" }],
    });
    expect(await valueGoodReturnFails(reversedSourceReturnId, [sourceCostLineId])).toMatch(
      /ISSUE cost movement .* has been reversed/iu,
    );
    expect(await costMovementCount(reversedSourceReturnId)).toBe("0");
  });

  test("an ISSUE cost movement cannot be reversed before its active GOOD_RETURN", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("source-active-return");
    await makeValuedReceipt(`doc-source-active-return-${product}`, [itemJson(product, "2", "1")]);
    const issueId = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "-1" }],
    });
    const issueVal = await valueConsumption(issueId);
    const issueLine = (issueVal.lines as CostLine[])[0]!;
    const issueCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${issueLine.movement_line_id}'`,
    );

    const returnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "1" }],
    });
    const returnVal = await valueGoodReturn(returnId, [issueCostLineId]);
    const issueQuantityReversal = await reverseQuantityMovement(
      issueId,
      `source-active-issue-${product}`,
      "test",
      "tester",
    );
    expect(
      await sqlFails(
        `SELECT public.reverse_inventory_cost_movement(
          '${issueVal.cost_movement_id}', '${issueQuantityReversal.reversalId}', 'test')`,
      ),
    ).toMatch(/source_issue_has_active_returns/iu);
    expect(await costMovementCount(issueQuantityReversal.reversalId)).toBe("0");

    const returnQuantityReversal = await reverseQuantityMovement(
      returnId,
      `source-active-return-${product}`,
      "test",
      "tester",
    );
    await reverseCostMovement(
      returnVal.cost_movement_id as string,
      returnQuantityReversal.reversalId,
      "test",
    );
    const issueCostReversal = await reverseCostMovement(
      issueVal.cost_movement_id as string,
      issueQuantityReversal.reversalId,
      "test",
    );
    expect(issueCostReversal.cost_event_type).toBe("REVERSAL");
  });

  test("reversing a GOOD_RETURN releases its cumulative return capacity", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("return-reversal-cap");
    await makeValuedReceipt(`doc-return-reversal-cap-${product}`, [itemJson(product, "1", "1")]);
    const issueId = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "-1" }],
    });
    const issueVal = await valueConsumption(issueId);
    const issueLine = (issueVal.lines as CostLine[])[0]!;
    const sourceCostLineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE movement_line_id='${issueLine.movement_line_id}'`,
    );

    const firstReturnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "1" }],
    });
    const firstReturn = await valueGoodReturn(firstReturnId, [sourceCostLineId]);
    const returnQuantityReversal = await reverseQuantityMovement(
      firstReturnId,
      `round-return-reversal-${product}`,
      "test",
      "tester",
    );
    await reverseCostMovement(
      firstReturn.cost_movement_id as string,
      returnQuantityReversal.reversalId,
      "test",
    );

    const replacementReturnId = await insertRawMovement({
      type: "GOOD_RETURN",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "1" }],
    });
    const replacementReturn = await valueGoodReturn(replacementReturnId, [sourceCostLineId]);
    expect((replacementReturn.lines as CostLine[])[0]?.signed_value_satang).toBe("100");
    expect(await costBalance(product)).toEqual({
      qty: "1.000000",
      value: "100",
      avg: "100.0000000000000000",
    });
  });

  test("accountability rounds do not partition the weighted-average balance key", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("round-shared-pool");
    await makeValuedReceipt(`doc-round-pool-a-${product}`, [itemJson(product, "2", "1")]);
    await makeValuedReceipt(`doc-round-pool-b-${product}`, [itemJson(product, "2", "3")]);
    expect(await costBalance(product)).toEqual({
      qty: "4.000000",
      value: "800",
      avg: "200.0000000000000000",
    });

    const issueA = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: ROUND_A,
      lines: [{ productKey: product, qty: "-1" }],
    });
    const issueB = await insertRawMovement({
      type: "ISSUE",
      accountabilityRoundId: ROUND_B,
      lines: [{ productKey: product, qty: "-1" }],
    });
    const valueA = await valueConsumption(issueA);
    const valueB = await valueConsumption(issueB);
    expect((valueA.lines as CostLine[])[0]?.signed_value_satang).toBe("-200");
    expect((valueB.lines as CostLine[])[0]?.signed_value_satang).toBe("-200");
    expect(await costBalance(product)).toEqual({
      qty: "2.000000",
      value: "400",
      avg: "200.0000000000000000",
    });
    expect(
      await sql(
        `SELECT count(*)::text FROM public.inventory_cost_balances
          WHERE location_code='MAIN' AND product_key=${sqlLiteral(product)} AND unit_key='kg'`,
      ),
    ).toBe("1");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 16. No quantity/value divergence
  // ═══════════════════════════════════════════════════════════════════════

  test("after full valuation, unvalued_inventory_movement_lines is empty for the key and quantity_balance equals the ledger's own sum", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("reconcile16");
    await makeValuedReceipt(`doc-reconcile16-${product}`, [itemJson(product, "10", "1.5")]);
    const issue1 = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-3" }] });
    await valueConsumption(issue1);
    const issue2 = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-2" }] });
    await valueConsumption(issue2);

    const unvaluedForKey = await sql(
      `SELECT count(*)::text FROM public.unvalued_inventory_movement_lines
        WHERE location_code='MAIN' AND product_key=${sqlLiteral(product)} AND unit_key='kg'`,
    );
    expect(unvaluedForKey).toBe("0");

    const bal = await costBalance(product) as { qty: string };
    const ledgerSum = await ledgerQtySum(product);
    expect(bal.qty).toBe(ledgerSum);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 17. Crash/retry recovery
  // ═══════════════════════════════════════════════════════════════════════

  test("a valuation aborted mid-transaction persists nothing; a subsequent real call produces exactly one cost movement", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("crash17");
    await makeValuedReceipt(`doc-crash17-src-${product}`, [itemJson(product, "5", "1")]);
    const issueId = await insertRawMovement({ type: "ISSUE", lines: [{ productKey: product, qty: "-2" }] });

    const aborted = await collect(
      startScript(`BEGIN; SELECT public.value_inventory_consumption_movement('${issueId}'); ROLLBACK;`),
    );
    expect(aborted.code, `aborted script errored unexpectedly: ${aborted.stderr}`).toBe(0);
    expect(await costMovementCount(issueId)).toBe("0");
    expect((await costBalance(product) as { qty: string }).qty).toBe("5.000000");

    const real = await valueConsumption(issueId);
    expect(real.replayed).toBe(false);
    expect(await costMovementCount(issueId)).toBe("1");
    expect((await costBalance(product) as { qty: string }).qty).toBe("3.000000");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 18. Permissions and RLS
  // ═══════════════════════════════════════════════════════════════════════

  const COST_TABLES = ["inventory_cost_movements", "inventory_cost_movement_lines"] as const;
  const COST_VIEWS = ["inventory_cost_balances", "unvalued_inventory_movement_lines"] as const;
  const COST_RPCS = [
    "get_inventory_cost_balances",
    "value_purchase_receipt_movement",
    "value_inventory_consumption_movement",
    "value_good_return_movement",
    "reverse_inventory_cost_movement",
  ] as const;
  const COST_INTERNAL_FUNCTIONS = [
    "inventory_cost_movement_lines_forbid_mutation",
    "inventory_cost_movement_lines_assert_sealed",
    "inventory_cost_movement_lines_assert_sign_agreement",
    "inventory_cost_movement_lines_assert_binding_integrity",
    "inventory_cost_movements_forbid_mutation",
    "inventory_cost_movements_guard_reversal_target",
    "inventory_cost_movements_assert_line_count",
    "inventory_cost_lock_balance_keys",
    "inventory_cost_movement_lines_payload",
  ] as const;

  test("RLS is enabled on both cost tables, with zero policies", async () => {
    expect(ready).toBe(true);
    for (const table of COST_TABLES) {
      expect(
        await sql(`SELECT relrowsecurity::text FROM pg_class WHERE oid='public.${table}'::regclass`),
        `${table} must have RLS enabled`,
      ).toBe("true");
    }
    expect(
      await sql(
        `SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN
          ('${COST_TABLES[0]}','${COST_TABLES[1]}')`,
      ),
    ).toBe("0");
  });

  // ONE psql call, not one per (role, object, privilege). Each sql() here spawns
  // a fresh psql.exe and therefore a fresh TCP connection; the per-triple loop
  // this replaced made several hundred of them back to back and failed
  // intermittently on a DIFFERENT object each run, with psql exiting non-zero
  // and an empty stderr — the signature of local connection/ephemeral-port
  // exhaustion, not of a privilege actually being granted. Asking the database
  // once and asserting in TypeScript is faster and deterministic, and the
  // assertion still names the exact offending grant when it regresses.
  test("anon and authenticated hold NO privilege on any 0054 table, view, or function", async () => {
    expect(ready).toBe(true);

    const relList = [...COST_TABLES, ...COST_VIEWS].map((r) => sqlLiteral(r)).join(",");
    const fnList = [...COST_RPCS, ...COST_INTERNAL_FUNCTIONS].map((f) => sqlLiteral(f)).join(",");

    const granted = JSON.parse(
      await sql(
        `SELECT coalesce(jsonb_agg(g ORDER BY g->>'what'), '[]'::jsonb)::text FROM (
           SELECT jsonb_build_object('role', r.role, 'what', t.rel, 'priv', p.priv) AS g
             FROM unnest(ARRAY['anon','authenticated']) AS r(role)
             CROSS JOIN unnest(ARRAY[${relList}]) AS t(rel)
             CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(priv)
            WHERE has_table_privilege(r.role, 'public.' || t.rel, p.priv)
           UNION ALL
           SELECT jsonb_build_object('role', r.role, 'what', f.fn, 'priv', 'EXECUTE')
             FROM unnest(ARRAY['anon','authenticated']) AS r(role)
             CROSS JOIN unnest(ARRAY[${fnList}]) AS f(fn)
             JOIN pg_proc pr ON pr.proname = f.fn
             JOIN pg_namespace n ON n.oid = pr.pronamespace AND n.nspname = 'public'
            WHERE has_function_privilege(r.role, pr.oid, 'EXECUTE')
         ) AS granted`,
      ),
    ) as { role: string; what: string; priv: string }[];

    expect(granted, `unexpected grants leaked: ${JSON.stringify(granted)}`).toEqual([]);
  }, 120_000);

  test("service_role holds SELECT on the tables/views and EXECUTE on the RPCs, but NOT INSERT/UPDATE/DELETE", async () => {
    expect(ready).toBe(true);
    for (const rel of [...COST_TABLES, ...COST_VIEWS]) {
      expect(
        await sql(`SELECT has_table_privilege('service_role','public.${rel}','SELECT')::text`),
        `service_role must read ${rel}`,
      ).toBe("true");
      for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        expect(
          await sql(`SELECT has_table_privilege('service_role','public.${rel}','${priv}')::text`),
          `service_role must NOT hold ${priv} on ${rel}`,
        ).toBe("false");
      }
    }
    for (const fn of COST_RPCS) {
      expect(
        await sql(
          `SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))::text
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='${fn}'`,
        ),
        `service_role must execute ${fn}`,
      ).toBe("true");
    }
    // Internal-only functions take NO grant at all, even for service_role.
    for (const fn of COST_INTERNAL_FUNCTIONS) {
      expect(
        await sql(
          `SELECT coalesce(bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')), false)::text
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='${fn}'`,
        ),
        `service_role must NOT execute internal helper ${fn}`,
      ).toBe("false");
    }
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // 19. Append-only
  // ═══════════════════════════════════════════════════════════════════════

  test("cost movements and cost lines are immutable except the one legal reversal back-link transition", async () => {
    expect(ready).toBe(true);
    const product = uniqueProduct("appendonly19");
    const receipt = await makeValuedReceipt(`doc-appendonly19-${product}`, [itemJson(product, "3", "1")]);
    const lineId = await sql(
      `SELECT id::text FROM public.inventory_cost_movement_lines WHERE cost_movement_id='${receipt.costMovementId}'`,
    );

    expect(
      await sqlFails(`UPDATE public.inventory_cost_movement_lines SET signed_value_satang=1 WHERE id='${lineId}'`),
    ).toMatch(/cost_ledger_is_append_only/iu);
    expect(
      await sqlFails(`DELETE FROM public.inventory_cost_movement_lines WHERE id='${lineId}'`),
    ).toMatch(/cost_ledger_is_append_only/iu);

    expect(
      await sqlFails(`UPDATE public.inventory_cost_movements SET line_count=99 WHERE id='${receipt.costMovementId}'`),
    ).toMatch(/cost_ledger_is_append_only/iu);
    expect(
      await sqlFails(`DELETE FROM public.inventory_cost_movements WHERE id='${receipt.costMovementId}'`),
    ).toMatch(/cost_ledger_is_append_only/iu);

    // Setting reversed_by_cost_movement_id to something that is NOT a real
    // REVERSAL of this row is refused, even though it is a NULL -> value move.
    const other = await makeValuedReceipt(`doc-appendonly19-other-${product}`, [itemJson(product, "1", "1")]);
    expect(
      await sqlFails(
        `UPDATE public.inventory_cost_movements SET reversed_by_cost_movement_id='${other.costMovementId}'
          WHERE id='${receipt.costMovementId}'`,
      ),
    ).toMatch(/must reference a REVERSAL cost movement/iu);

    // The only legal UPDATE: NULL -> value, via the real reversal RPC.
    const qtyRev = await reverseQuantityMovement(receipt.movementId, `appendonly19-${product}`, "test", "t");
    const costRev = await reverseCostMovement(receipt.costMovementId, qtyRev.reversalId, "test");
    expect(
      await sql(`SELECT reversed_by_cost_movement_id::text FROM public.inventory_cost_movements WHERE id='${receipt.costMovementId}'`),
    ).toBe(String(costRev.cost_movement_id));

    // And once set, it cannot be changed again.
    expect(
      await sqlFails(
        `UPDATE public.inventory_cost_movements SET reversed_by_cost_movement_id='${other.costMovementId}'
          WHERE id='${receipt.costMovementId}'`,
      ),
    ).toMatch(/cost_ledger_is_append_only/iu);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 20. Deterministic historical replay across two fresh databases
  // ═══════════════════════════════════════════════════════════════════════

  test(
    "an identical sequence of postings on two fresh databases yields byte-identical balances and per-line values",
    async () => {
      expect(ready).toBe(true);
      const dbA = `p2d_0054_replay_a_${randomBytes(4).toString("hex")}`;
      const dbB = `p2d_0054_replay_b_${randomBytes(4).toString("hex")}`;
      let createdA = false;
      let createdB = false;

      try {
        await applyChainTo(dbA);
        createdA = true;
        await applyChainTo(dbB);
        createdB = true;

        async function sqlIn(name: string, text: string): Promise<string> {
          const r = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", name, "-tAc", text], { database: name });
          if (r.code !== 0) throw new Error(`SQL failed on ${name}: ${r.stderr || r.stdout}\n${text}`);
          return (r.stdout || "").trim();
        }

        // Deterministic tag SHARED between the two runs — the whole point is
        // that the two databases produce identical output for identical input.
        const product = "replay20-fixed-product";

        async function runSequence(name: string): Promise<{ movementId: string; costMovementId: string }> {
          const dbSql = (t: string) => sqlIn(name, t);
          const rid = await makeConfirmedIn(dbSql, `doc-replay20-${name}`, [
            itemJson(product, "3", "0.3333"),
          ]);
          const post = JSON.parse(
            await dbSql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
          ) as { movement_id: string };
          const val = JSON.parse(
            await dbSql(`SELECT public.value_purchase_receipt_movement('${post.movement_id}')`),
          ) as { cost_movement_id: string };

          const issueMid = await dbSql(`SELECT gen_random_uuid()`);
          // Header + lines in ONE call — see the comment on insertRawMovement
          // above for why splitting this across two psql invocations would
          // trip the deferred line_count trigger.
          await dbSql(
            `INSERT INTO public.inventory_movements
               (id, movement_type, business_date, source_system, source_document_type,
                source_document_id, dedupe_key, line_count)
             VALUES ('${issueMid}', 'ISSUE', '2026-07-29', 'test-harness', 'manual-issue',
                     gen_random_uuid(), 'replay20-issue-${name}', 1);
             INSERT INTO public.inventory_movement_lines
               (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
             VALUES ('${issueMid}', 1, ${sqlLiteral(product)}, 'kg', 'MAIN', -1)`,
          );
          await dbSql(`SELECT public.value_inventory_consumption_movement('${issueMid}')`);

          return { movementId: post.movement_id, costMovementId: val.cost_movement_id };
        }

        // The real database names, not the labels "A"/"B" — runSequence hands
        // this straight to psql -d.
        await runSequence(dbA);
        await runSequence(dbB);

        const balanceA = await sqlIn(
          dbA,
          `SELECT public.get_inventory_cost_balances('MAIN', ${sqlLiteral(product)}, 'kg', true)::text`,
        );
        const balanceB = await sqlIn(
          dbB,
          `SELECT public.get_inventory_cost_balances('MAIN', ${sqlLiteral(product)}, 'kg', true)::text`,
        );
        expect(balanceA).toBe(balanceB);

        const linesA = await sqlIn(
          dbA,
          `SELECT jsonb_agg(jsonb_build_object('value', c.signed_value_satang::text, 'basis', m.valuation_basis, 'type', m.cost_event_type)
                            ORDER BY c.created_at)::text
             FROM public.inventory_cost_movement_lines c
             JOIN public.inventory_cost_movements m ON m.id = c.cost_movement_id
             JOIN public.inventory_movement_lines l ON l.id = c.movement_line_id
            WHERE l.product_key = ${sqlLiteral(product)}`,
        );
        const linesB = await sqlIn(
          dbB,
          `SELECT jsonb_agg(jsonb_build_object('value', c.signed_value_satang::text, 'basis', m.valuation_basis, 'type', m.cost_event_type)
                            ORDER BY c.created_at)::text
             FROM public.inventory_cost_movement_lines c
             JOIN public.inventory_cost_movements m ON m.id = c.cost_movement_id
             JOIN public.inventory_movement_lines l ON l.id = c.movement_line_id
            WHERE l.product_key = ${sqlLiteral(product)}`,
        );
        expect(linesA).toBe(linesB);
        expect(JSON.parse(linesA)).toEqual([
          { value: "100", basis: "SOURCE_UNIT_COST", type: "PURCHASE_RECEIPT" },
          { value: "-33", basis: "MOVING_AVERAGE", type: "ISSUE" },
        ]);
      } finally {
        if (createdA) await dropDb(dbA);
        if (createdB) await dropDb(dbB);
      }
    },
    // supabase/tests/purchase_capture_slice_c_hardening.sql alone takes ~200s
    // to apply (its own concurrency scenarios use real waits); this test
    // applies the full chain TWICE, so it needs generous headroom.
    { timeout: 900_000 },
  );
});
