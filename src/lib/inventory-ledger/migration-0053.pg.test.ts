/**
 * Real PostgreSQL harness for P2C migration 0053 (inventory movement ledger).
 *
 * - Creates a disposable DB, applies the P2B bootstrap + 0052, then seeds a
 *   PRODUCTION-LIKE broad default ACL before applying 0053. Production grants
 *   ALL on new tables in `public` to service_role/anon/authenticated by default,
 *   so a migration that merely GRANTs without REVOKEing first inherits
 *   INSERT/UPDATE/DELETE it never intended. Applying the broad grant BEFORE 0053
 *   is what makes the privilege assertions meaningful rather than vacuous.
 * - Concurrency cases use SEPARATE connections plus a DETERMINISTIC, controller-
 *   released barrier owned by withGate(). The blocker takes an advisory lock
 *   right after its mutating statement and then parks until the controller
 *   commits a release row; the controller waits on pg_locks / pg_stat_activity
 *   for observed facts, never on a sleep being "long enough". Every wait is
 *   bounded and cleanup is unconditional: withGate() releases the gate, collects
 *   or kills each child it started, drops the barrier row and verifies no
 *   session, lock or row leaked — then re-throws the ORIGINAL failure. Two tests
 *   exercise those cleanup paths directly.
 * - Two cases use fault injection: the P2B posting-lock RPC and the P2B
 *   confirmation getter are temporarily replaced, then restored from the
 *   definition captured beforehand. Both prove a guard fires that cannot be
 *   reached through a well-behaved P2B.
 * - SKIP (not green PASS) when psql/connection is unavailable.
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

const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BOOTSTRAP = join(REPO_ROOT, "supabase", "tests", "p2b_0052_bootstrap.sql");
const MIGRATION_0052 = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260729084558_purchase_receipt_persistence.sql",
);
const MIGRATION_0053 = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260729172613_inventory_movement_ledger.sql",
);

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

const resolvedPsql = resolvePsql();
const probe = resolvedPsql
  ? await probeConnection(resolvedPsql)
  : { ok: false, detail: "psql binary not found" };

const pgAvailable = Boolean(resolvedPsql && probe.ok);
if (!pgAvailable) {
  console.warn(
    `P2C 0053 PG tests SKIPPED: PostgreSQL unavailable (${probe.detail}). Tried: ${resolvedPsql ?? "none"}`,
  );
}

describe.skipIf(!pgAvailable)("P2C migration 0053 PostgreSQL", () => {
  const dbName = `p2c_0053_${randomBytes(4).toString("hex")}`;
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

  const LEDGER_TABLES = [
    "inventory_locations",
    "inventory_movements",
    "inventory_movement_lines",
  ] as const;

  const LEDGER_RPCS = [
    "get_inventory_balances",
    "post_purchase_receipt_inventory_movement",
    "reverse_inventory_movement",
  ] as const;

  function itemJson(
    productKey: string,
    quantity: string,
    unitKey = "kg",
    extra = "",
  ): string {
    return `{"product_key":"${productKey}","raw_product_text":"${productKey}","quantity":"${quantity}",` +
      `"unit_key":"${unitKey}","raw_unit":"${unitKey}","unit_cost":"10"${extra ? "," + extra : ""}}`;
  }

  /** Drafts and confirms a receipt, returning its id. */
  async function makeConfirmed(
    key: string,
    items: readonly string[] = [itemJson("mango", "2.5")],
  ): Promise<string> {
    await sql(
      `SELECT public.upsert_purchase_receipt_draft(
        'line-text','${key}','p2b-slice-a-v1','2026-07-29',
        '[${items.join(",")}]'::jsonb,
        p_source_type=>'group', p_source_id=>'G1')`,
    );
    const id = await sql(
      `SELECT id FROM public.purchase_receipts WHERE document_key='${key}'`,
    );
    await sql(`SELECT public.confirm_purchase_receipt('${id}','ck-${key}')`);
    return id;
  }

  /** Drafts only — no confirmation. */
  async function makeDraft(key: string): Promise<string> {
    await sql(
      `SELECT public.upsert_purchase_receipt_draft(
        'line-text','${key}','p2b-slice-a-v1','2026-07-29',
        '[${itemJson("mango", "1")}]'::jsonb,
        p_source_type=>'group', p_source_id=>'G1')`,
    );
    return sql(`SELECT id FROM public.purchase_receipts WHERE document_key='${key}'`);
  }

  /**
   * Balance for ONE (location, product, unit). The unit is explicit because a
   * product legitimately holds separate balances per unit, and collapsing them
   * with a LIMIT 1 would silently assert against whichever row sorted first.
   */
  async function balanceOf(product: string, unit = "kg", location = "MAIN"): Promise<string> {
    return sql(
      `SELECT coalesce((
         SELECT b->>'quantity_balance'
           FROM jsonb_array_elements(
                  public.get_inventory_balances('${location}','${product}','${unit}',true)->'balances') b
          LIMIT 1), 'NONE')`,
    );
  }

  /** The exact frozen values P2B issues for a receipt. */
  async function frozenOf(rid: string): Promise<{ hash: string; dedupeKey: string }> {
    const hash = await sql(
      `SELECT confirmation_hash FROM public.purchase_receipts WHERE id='${rid}'`,
    );
    const dedupeKey = await sql(
      `SELECT public.get_purchase_receipt_confirmation('${rid}') ->> 'p2c_dedupe_key'`,
    );
    return { hash, dedupeKey };
  }

  /**
   * A stand-in `get_purchase_receipt_confirmation` returning a crafted contract.
   *
   * Needed only for shapes a well-behaved P2B cannot produce (a missing hash, a
   * quantity with 7 decimals, a repeated receipt_item_id). Always used inside a
   * transaction that is ROLLED BACK, so the real function is restored by the
   * database rather than by a manual step that could fail.
   */
  function fakeContractSql(opts: {
    hash: string; // SQL expression
    dedupeKey: string; // SQL expression
    items: string; // jsonb array expression
    itemCount: number;
  }): string {
    return `
      CREATE OR REPLACE FUNCTION public.get_purchase_receipt_confirmation(p_receipt_id uuid)
      RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = public, extensions, pg_temp AS $fake$
        SELECT jsonb_build_object(
          'receipt_id', p_receipt_id::text,
          'confirmation', jsonb_build_object(
            'hash', ${opts.hash},
            'contract_version','p2b-purchase-confirm-v1',
            'confirmation_key','fake',
            'payload', jsonb_build_object(
              'business_date','2026-07-29', 'intended_warehouse_code','MAIN',
              'has_blocking_blockers', false, 'posts_inventory_movement', false,
              'item_count', ${opts.itemCount},
              'document_namespace','line-text','document_key','x',
              'parser_contract_version','p2b-slice-a-v1',
              'items', ${opts.items})),
          'p2c_dedupe_key', ${opts.dedupeKey})
      $fake$;`;
  }

  function fakeItem(fields: Record<string, string>): string {
    const base: Record<string, string> = {
      receipt_item_id: `'77777777-7777-4777-8777-777777777777'`,
      item_ordinal: "1",
      product_key: `'mango'`,
      unit_key: `'kg'`,
      quantity: `'1'`,
      raw_product_text: `'m'`,
      raw_unit: `'kg'`,
      product_identity_status: `'RESOLVED'`,
      unit_identity_status: `'RESOLVED'`,
      ...fields,
    };
    const pairs = Object.entries(base)
      .map(([k, v]) => `'${k}', ${v}`)
      .join(", ");
    return `jsonb_build_object(${pairs})`;
  }

  /**
   * Runs an injected-contract posting attempt inside a rolled-back transaction
   * and asserts it fails with `needle`, leaving no movement, no line and no
   * posting lock behind.
   */
  async function expectInjectedRejection(
    rid: string,
    inject: string,
    needle: string,
  ): Promise<void> {
    const r = await collect(
      startScript(`
        BEGIN;
        ${inject}
        DO $probe$
        DECLARE n integer;
        BEGIN
          BEGIN
            PERFORM public.post_purchase_receipt_inventory_movement('${rid}');
            RAISE EXCEPTION 'PROBE_FAIL: the malformed contract was accepted';
          EXCEPTION WHEN OTHERS THEN
            IF position('PROBE_FAIL' IN SQLERRM) > 0 THEN RAISE; END IF;
            IF position(${needle} IN SQLERRM) = 0 THEN
              RAISE EXCEPTION 'PROBE_FAIL: wrong error %', SQLERRM;
            END IF;
          END;
          SELECT count(*) INTO n FROM public.inventory_movements
            WHERE source_document_id = '${rid}';
          IF n <> 0 THEN RAISE EXCEPTION 'PROBE_FAIL: % movements survived', n; END IF;
          SELECT count(*) INTO n FROM public.inventory_movement_lines l
            JOIN public.inventory_movements m ON m.id = l.movement_id
           WHERE m.source_document_id = '${rid}';
          IF n <> 0 THEN RAISE EXCEPTION 'PROBE_FAIL: % lines survived', n; END IF;
          SELECT count(*) INTO n FROM public.purchase_receipts
           WHERE id = '${rid}' AND posting_locked_at IS NOT NULL;
          IF n <> 0 THEN RAISE EXCEPTION 'PROBE_FAIL: posting lock survived'; END IF;
          RAISE NOTICE 'PROBE_OK';
        END $probe$;
        ROLLBACK;`),
    );
    expect(r.code, `probe errored: ${r.stderr}`).toBe(0);
    expect(r.stderr, `probe did not reach PROBE_OK: ${r.stderr}`).toMatch(/PROBE_OK/u);
    expect(r.stderr).not.toMatch(/PROBE_FAIL/u);
  }

  /**
   * Runs a posting attempt inside a ROLLED-BACK transaction after `setup`, and
   * asserts it fails with `needle` leaving no movement and no line behind.
   *
   * Separate from expectInjectedRejection because these cases deliberately leave
   * a posting lock in place: the assertion is that the lock is untouched, not
   * that it is absent. `lockOwner` is the SQL literal the lock must still read
   * as afterwards ('NULL' for none).
   */
  async function expectPostRejectedInTx(opts: {
    rid: string;
    setup: string;
    needle: string;
    lockOwner: string;
  }): Promise<void> {
    const r = await collect(
      startScript(`
        BEGIN;
        ${opts.setup}
        DO $probe$
        DECLARE n integer; v_owner text;
        BEGIN
          BEGIN
            PERFORM public.post_purchase_receipt_inventory_movement('${opts.rid}');
            RAISE EXCEPTION 'PROBE_FAIL: the post was accepted';
          EXCEPTION WHEN OTHERS THEN
            IF position('PROBE_FAIL' IN SQLERRM) > 0 THEN RAISE; END IF;
            IF position(${opts.needle} IN SQLERRM) = 0 THEN
              RAISE EXCEPTION 'PROBE_FAIL: wrong error %', SQLERRM;
            END IF;
          END;
          SELECT count(*) INTO n FROM public.inventory_movements
            WHERE source_document_id = '${opts.rid}';
          IF n <> 0 THEN RAISE EXCEPTION 'PROBE_FAIL: % movements survived', n; END IF;
          SELECT count(*) INTO n FROM public.inventory_movement_lines l
            JOIN public.inventory_movements m ON m.id = l.movement_id
           WHERE m.source_document_id = '${opts.rid}';
          IF n <> 0 THEN RAISE EXCEPTION 'PROBE_FAIL: % lines survived', n; END IF;
          SELECT posting_locked_by INTO v_owner FROM public.purchase_receipts
           WHERE id = '${opts.rid}';
          IF v_owner IS DISTINCT FROM ${opts.lockOwner} THEN
            RAISE EXCEPTION 'PROBE_FAIL: lock owner is now %', coalesce(v_owner, '<null>');
          END IF;
          RAISE NOTICE 'PROBE_OK';
        END $probe$;
        ROLLBACK;`),
    );
    expect(r.code, `probe errored: ${r.stderr}`).toBe(0);
    expect(r.stderr, `probe did not reach PROBE_OK: ${r.stderr}`).toMatch(/PROBE_OK/u);
    expect(r.stderr).not.toMatch(/PROBE_FAIL/u);
  }

  // ── Controller-released barrier with unconditional cleanup ───────────────
  //
  // The blocking session parks in a poll loop until the controller commits its
  // release row, instead of running out a fixed pg_sleep. Under READ COMMITTED
  // each iteration takes a fresh snapshot, so the committed row becomes visible
  // inside the still-open transaction. Overlap is a fact the test establishes,
  // not a duration it hoped was long enough.
  //
  // Every wait is BOUNDED and every release runs in a finally path. A controller
  // that throws mid-scenario — a failed assertion, a wait that timed out — would
  // otherwise leave the parked session and its psql child alive until Bun's outer
  // timeout, poisoning every later test in this file with a held row lock. So
  // withGate() owns the whole lifecycle: it releases the gate, collects or kills
  // every child it started, drops the barrier row, and verifies nothing leaked —
  // and it re-throws the ORIGINAL failure rather than masking it with whatever
  // the cleanup found.

  const CHILD_EXIT_MS = 20_000;
  const CHILD_KILL_MS = 5_000;
  const WAIT_MS = 20_000;
  const TIMED_OUT = Symbol("timed-out");

  /** Bounded wait. Never leaves a timer behind to hold the loop open. */
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
    /** Started once at spawn: the streams must not be read twice. */
    result: Promise<PsqlResult>;
  };

  type GateReport = { terminated: string[]; leaked: string[] };

  type GateScope = {
    /** SQL the blocking session runs to park until the controller releases it. */
    hold: string;
    start(name: string, script: string): Child;
    /** Bounded: the child's backend is connected and visible. */
    started(child: Child): Promise<void>;
    /** Bounded: the blocker ran its mutation and its transaction is open. */
    parked(child: Child): Promise<void>;
    /** Bounded: the child is genuinely waiting on a lock. */
    blocked(child: Child): Promise<void>;
    /** Bounded; throws a clear harness failure if the child overran. */
    exits(child: Child, ms?: number): Promise<PsqlResult>;
    /** Bounded; returns null instead of throwing when the child overran. */
    exitedWithin(child: Child, ms: number): Promise<PsqlResult | null>;
    release(): Promise<void>;
  };

  async function ensureBarrierTable(): Promise<void> {
    await sql(`CREATE TABLE IF NOT EXISTS public.test_barrier_release (k text PRIMARY KEY)`);
  }

  /** Backends running `marker`, excluding the controller's own probe queries. */
  function markerPredicate(marker: string, alias = ""): string {
    const q = alias ? `${alias}.` : "";
    return `${q}datname = current_database()
              AND ${q}pid <> pg_backend_pid()
              AND ${q}query LIKE '%${marker}%'
              AND ${q}query NOT LIKE '%pg_stat_activity%'`;
  }

  async function pollUntil(
    label: string,
    query: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Number(await sql(query)) > 0) return;
      if (Date.now() > deadline) throw new Error(`harness: ${label} within ${timeoutMs}ms`);
      await Bun.sleep(25);
    }
  }

  /**
   * Runs a concurrency scenario with a controller-released gate.
   *
   * Cleanup is unconditional and runs in a finally path. Returns what cleanup
   * had to do, so a test can deliberately exercise the termination path; for
   * every ordinary scenario a child needing termination, or any leaked session,
   * lock or barrier row, is itself a failure.
   */
  async function withGate(
    name: string,
    key: number,
    body: (gate: GateScope) => Promise<void>,
    opts: {
      allowTermination?: boolean;
      /**
       * Receives the cleanup report even when the body threw and the original
       * error is about to be re-thrown — the only way a test can assert on what
       * cleanup had to do along a failure path.
       */
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
        // A Lock wait AND an ungranted pg_locks row for that same backend. Two
        // independent views of the same fact; neither is a sleep.
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

    // ── Cleanup: always runs, whatever the body did ─────────────────────────
    const cleanupProblems: string[] = [];
    const note = (what: string, err: unknown) =>
      cleanupProblems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);

    // 1. Release first — a parked child cannot exit until this lands.
    try {
      await release();
    } catch (err) {
      note("gate release failed", err);
    }

    // 2. Collect every child; terminate any that overran, then wait for the kill.
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

    // 3. Backstop: a killed psql can leave its backend finishing a statement.
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

    // 4. Drop controller state and verify nothing is left holding anything.
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

    // 5. The original failure wins. Cleanup findings are reported only when the
    //    body itself succeeded, so a real assertion failure is never masked by a
    //    secondary cleanup error.
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

  afterAll(async () => {
    if (!pgAvailable || !dbCreated) return;
    await runPsql(psqlPath, [
      "-d", "postgres", "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
    ]);
    await runPsql(psqlPath, ["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${dbName}`]);
  });

  // ── Apply ───────────────────────────────────────────────────────────────

  test("bootstrap + 0052 + broad production-like ACL + 0053 apply cleanly", async () => {
    expect(existsSync(BOOTSTRAP)).toBe(true);
    expect(existsSync(MIGRATION_0052)).toBe(true);
    expect(existsSync(MIGRATION_0053)).toBe(true);

    const create = await runPsql(psqlPath, [
      "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`,
    ]);
    expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
    dbCreated = true;

    const boot = await runPsql(
      psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", BOOTSTRAP], { database: dbName },
    );
    expect(boot.code, `bootstrap failed:\n${boot.stderr}`).toBe(0);

    const mig52 = await runPsql(
      psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", MIGRATION_0052], { database: dbName },
    );
    expect(mig52.code, `migration 0052 failed:\n${mig52.stderr}`).toBe(0);

    // Production-like hazard: every future table in `public` is granted wholesale.
    await sql(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT ALL ON TABLES TO service_role, anon, authenticated`,
    );

    const mig53 = await runPsql(
      psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", MIGRATION_0053], { database: dbName },
    );
    expect(mig53.code, `migration 0053 failed:\n${mig53.stderr}`).toBe(0);
    ready = true;
  }, 90_000);

  test("MAIN is the only seeded location", async () => {
    expect(ready).toBe(true);
    expect(await sql(`SELECT string_agg(location_code, ',' ORDER BY location_code)
                        FROM public.inventory_locations`)).toBe("MAIN");
    expect(await sql(`SELECT location_type FROM public.inventory_locations`)).toBe("WAREHOUSE");
  });

  // ── Scope guard: no valuation / COGS anywhere ───────────────────────────

  test("0053 creates no valuation, cost or COGS object", async () => {
    expect(ready).toBe(true);

    const ledgerColumns = await sql(
      `SELECT coalesce(string_agg(table_name || '.' || column_name, ',' ORDER BY table_name, column_name), '')
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name LIKE 'inventory_%'`,
    );
    expect(ledgerColumns).not.toMatch(
      /cost|valuation|cogs|satang|amount|price|value|currency|baht/iu,
    );

    // The balance surface must expose quantity only.
    const viewColumns = await sql(
      `SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='inventory_balances'`,
    );
    expect(viewColumns).toBe("location_code,product_key,unit_key,quantity_balance");

    const newTables = await sql(
      `SELECT coalesce(string_agg(tablename, ',' ORDER BY tablename), '')
         FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'inventory%'`,
    );
    expect(newTables.split(",").sort()).toEqual([
      "inventory_locations",
      "inventory_movement_lines",
      "inventory_movements",
    ]);
  });

  // ── Security ────────────────────────────────────────────────────────────

  test("RLS is enabled on every ledger table, with zero policies", async () => {
    for (const table of LEDGER_TABLES) {
      expect(
        await sql(`SELECT relrowsecurity::text FROM pg_class WHERE oid='public.${table}'::regclass`),
        `${table} must have RLS enabled`,
      ).toBe("true");
    }
    expect(
      await sql(
        `SELECT count(*) FROM pg_policies
          WHERE schemaname='public' AND tablename LIKE 'inventory_%'`,
      ),
    ).toBe("0");
  });

  test("the broad production-like default ACL is neutralized for service_role", async () => {
    // Proves the REVOKE-before-GRANT actually did something: without it these
    // would all be true, inherited from ALTER DEFAULT PRIVILEGES above.
    for (const table of [...LEDGER_TABLES, "inventory_balances"]) {
      expect(
        await sql(`SELECT has_table_privilege('service_role','public.${table}','SELECT')::text`),
        `service_role must read ${table}`,
      ).toBe("true");

      for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        expect(
          await sql(`SELECT has_table_privilege('service_role','public.${table}','${priv}')::text`),
          `service_role must NOT hold ${priv} on ${table}`,
        ).toBe("false");
      }
    }
  });

  test("anon and authenticated hold no access to any ledger relation", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of [...LEDGER_TABLES, "inventory_balances"]) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect(
            await sql(`SELECT has_table_privilege('${role}','public.${table}','${priv}')::text`),
            `${role} must NOT hold ${priv} on ${table}`,
          ).toBe("false");
        }
      }
    }
  });

  test("RPC EXECUTE is granted to service_role only", async () => {
    for (const fn of LEDGER_RPCS) {
      expect(
        await sql(
          `SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))::text
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='${fn}'`,
        ),
        `service_role must execute ${fn}`,
      ).toBe("true");

      for (const role of ["anon", "authenticated"]) {
        expect(
          await sql(
            `SELECT coalesce(bool_or(has_function_privilege('${role}', p.oid, 'EXECUTE')), false)::text
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='${fn}'`,
          ),
          `${role} must NOT execute ${fn}`,
        ).toBe("false");
      }
    }
  });

  test("only the two mutating RPCs are SECURITY DEFINER, and all pin search_path", async () => {
    // Read-only balances need no elevation, so a leaked grant still cannot read
    // past the caller's own table privileges.
    expect(
      await sql(
        `SELECT prosecdef::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='get_inventory_balances'`,
      ),
    ).toBe("false");

    for (const fn of ["post_purchase_receipt_inventory_movement", "reverse_inventory_movement"]) {
      expect(
        await sql(
          `SELECT prosecdef::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='${fn}'`,
        ),
        `${fn} must be SECURITY DEFINER`,
      ).toBe("true");
    }

    for (const fn of LEDGER_RPCS) {
      expect(
        await sql(
          `SELECT coalesce(array_to_string(p.proconfig, ','), '')
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='${fn}'`,
        ),
        `${fn} must pin search_path`,
      ).toBe("search_path=public, extensions, pg_temp");
    }
  });

  test("no trigger guard is accidentally SECURITY DEFINER", async () => {
    expect(
      await sql(
        `SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '')
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public'
            AND p.proname LIKE 'inventory_%'
            AND p.prorettype='trigger'::regtype::oid
            AND p.prosecdef`,
      ),
    ).toBe("");
  });

  // ── Posting ─────────────────────────────────────────────────────────────

  test("a confirmed receipt posts once into MAIN and increases the balance", async () => {
    const rid = await makeConfirmed("doc-post-1", [
      itemJson("mango", "2.5"),
      itemJson("papaya", "10.250000"),
      itemJson("mango", "1.5", "ลัง"),
    ]);

    const res = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}','tester')`),
    );

    expect(res.replayed).toBe(false);
    expect(res.line_count).toBe(3);
    expect(res.receipt_id).toBe(rid);
    expect(res.dedupe_key).toStartWith(`purchase-receipt-confirmation:v1:${rid}:`);
    expect(res.reversed_by_movement_id).toBeNull();

    // Exact decimals, grouped by location/product/unit. The same product in two
    // units keeps two independent balances — they must never be summed together.
    expect(await balanceOf("mango", "kg")).toBe("2.500000");
    expect(await balanceOf("papaya", "kg")).toBe("10.250000");
    expect(await balanceOf("mango", "ลัง")).toBe("1.500000");

    // All lines positive, all in MAIN, each bound to its receipt item.
    expect(
      await sql(
        `SELECT count(*) FROM public.inventory_movement_lines l
          WHERE l.movement_id='${res.movement_id}'
            AND l.location_code='MAIN' AND l.signed_quantity > 0
            AND l.source_line_id IN (SELECT id FROM public.purchase_receipt_items WHERE receipt_id='${rid}')`,
      ),
    ).toBe("3");
  });

  test("the P2B posting lock is set by the SAME call", async () => {
    const rid = await makeConfirmed("doc-post-lock");
    const res = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    expect(res.posting_locked_by).toBe("p2c-inventory-ledger");
    expect(
      await sql(`SELECT posting_locked_by FROM public.purchase_receipts WHERE id='${rid}'`),
    ).toBe("p2c-inventory-ledger");

    // And P2B now refuses a standalone void — the barrier 0053 must not weaken.
    expect(await sqlFails(`SELECT public.void_purchase_receipt('${rid}','changed mind')`))
      .toMatch(/locked for posting/iu);
  });

  test("replaying the same dedupe key returns the original movement and writes nothing", async () => {
    const rid = await makeConfirmed("doc-replay");
    const first = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    const before = await sql(`SELECT count(*) FROM public.inventory_movement_lines`);

    const second = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );

    expect(second.replayed).toBe(true);
    expect(second.movement_id).toBe(first.movement_id);
    expect(second.dedupe_key).toBe(first.dedupe_key);
    expect(await sql(`SELECT count(*) FROM public.inventory_movement_lines`)).toBe(before);
    expect(
      await sql(
        `SELECT count(*) FROM public.inventory_movements WHERE source_document_id='${rid}'`,
      ),
    ).toBe("1");
  });

  test("a different payload reusing an existing source identity fails closed", async () => {
    const rid = await makeConfirmed("doc-conflict");
    await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`);

    // Simulate a re-confirmation under a different frozen hash: the dedupe key
    // would differ, but the source identity is already posted.
    await sql(
      `DELETE FROM public.inventory_movement_lines WHERE false;
       UPDATE public.purchase_receipts SET confirmation_hash = confirmation_hash WHERE false`,
    );
    const err = await sqlFails(
      `INSERT INTO public.inventory_movements
         (movement_type, business_date, source_system, source_document_type,
          source_document_id, dedupe_key, line_count)
       VALUES ('PURCHASE_RECEIPT','2026-07-29','p2b-purchase-receipts','purchase_receipt',
               '${rid}','some-other-key',1)`,
    );
    expect(err).toMatch(/inventory_movements_source_posting_uidx|duplicate key/iu);
  });

  test("a receipt already posted under a different dedupe key is refused by name", async () => {
    // A synthetic posting bound to the receipt but carrying a different key: the
    // RPC must report the source conflict rather than silently double-posting.
    const rid = await makeConfirmed("doc-conflict-named");
    await sql(
      `INSERT INTO public.inventory_movements
         (id, movement_type, business_date, source_system, source_document_type,
          source_document_id, dedupe_key, line_count)
       VALUES ('55555555-5555-4555-8555-555555555555','PURCHASE_RECEIPT','2026-07-29',
               'p2b-purchase-receipts','purchase_receipt','${rid}','foreign-key',1);
       INSERT INTO public.inventory_movement_lines
         (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
       VALUES ('55555555-5555-4555-8555-555555555555',1,'mango','kg','MAIN',1)`,
    );

    const err = await sqlFails(
      `SELECT public.post_purchase_receipt_inventory_movement('${rid}')`,
    );
    expect(err).toMatch(/already posted as movement/iu);
    expect(
      await sql(
        `SELECT count(*) FROM public.inventory_movements WHERE source_document_id='${rid}'`,
      ),
    ).toBe("1");
  });

  // ── Replay must verify the source binding, not just the key ──────────────

  describe("replay fails closed unless the existing movement really is this posting", () => {
    /** Inserts a synthetic movement holding `dedupeKey`, with one line. */
    async function synthetic(fields: {
      dedupeKey: string;
      movementType?: string;
      sourceSystem?: string;
      sourceDocType?: string;
      sourceDocId: string;
      version: string | null;
      reversalOf?: string | null;
      reason?: string | null;
    }): Promise<string> {
      const id = await sql(`SELECT gen_random_uuid()`);
      await sql(
        `INSERT INTO public.inventory_movements
           (id, movement_type, business_date, source_system, source_document_type,
            source_document_id, source_document_version, dedupe_key, line_count,
            reversal_of_movement_id, reversal_reason)
         VALUES ('${id}','${fields.movementType ?? "PURCHASE_RECEIPT"}','2026-07-29',
                 '${fields.sourceSystem ?? "p2b-purchase-receipts"}',
                 '${fields.sourceDocType ?? "purchase_receipt"}',
                 '${fields.sourceDocId}',
                 ${fields.version === null ? "NULL" : `'${fields.version}'`},
                 '${fields.dedupeKey}', 1,
                 ${fields.reversalOf ? `'${fields.reversalOf}'` : "NULL"},
                 ${fields.reason ? `'${fields.reason}'` : "NULL"});
         INSERT INTO public.inventory_movement_lines
           (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
         VALUES ('${id}',1,'synthetic','kg','MAIN',1)`,
      );
      return id;
    }

    test("the dedupe key is bound to a DIFFERENT receipt", async () => {
      const rid = await makeConfirmed("doc-replay-other-receipt");
      const { dedupeKey } = await frozenOf(rid);
      await synthetic({
        dedupeKey,
        sourceDocId: "12121212-1212-4212-8212-121212121212",
        version: "b".repeat(64),
      });

      const err = await sqlFails(
        `SELECT public.post_purchase_receipt_inventory_movement('${rid}')`,
      );
      expect(err).toMatch(/replay source mismatch/iu);
      expect(await sql(`SELECT count(*) FROM public.inventory_movements
                          WHERE source_document_id='${rid}'`)).toBe("0");
    });

    test("the dedupe key is held by a REVERSAL rather than a posting", async () => {
      const rid = await makeConfirmed("doc-replay-wrong-type");
      const { dedupeKey } = await frozenOf(rid);
      // A reversal needs a real non-reversal target, so build one first.
      const target = await synthetic({
        dedupeKey: "replay-wrong-type-target",
        sourceDocId: "13131313-1313-4313-8313-131313131313",
        version: "c".repeat(64),
      });
      await synthetic({
        dedupeKey,
        movementType: "REVERSAL",
        sourceDocId: "13131313-1313-4313-8313-131313131313",
        version: "c".repeat(64),
        reversalOf: target,
        reason: "synthetic",
      });

      const err = await sqlFails(
        `SELECT public.post_purchase_receipt_inventory_movement('${rid}')`,
      );
      expect(err).toMatch(/replay source mismatch/iu);
    });

    test("the receipt matches but the confirmation hash does NOT", async () => {
      const rid = await makeConfirmed("doc-replay-wrong-hash");
      const { dedupeKey } = await frozenOf(rid);
      await synthetic({ dedupeKey, sourceDocId: rid, version: "d".repeat(64) });

      const err = await sqlFails(
        `SELECT public.post_purchase_receipt_inventory_movement('${rid}')`,
      );
      expect(err).toMatch(/replay source mismatch/iu);
    });

    test("the source binding is malformed (null version, foreign source_system)", async () => {
      const rid = await makeConfirmed("doc-replay-malformed");
      const { dedupeKey } = await frozenOf(rid);
      await synthetic({
        dedupeKey,
        sourceSystem: "some-other-system",
        sourceDocId: rid,
        version: null,
      });

      expect(
        await sqlFails(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
      ).toMatch(/replay source mismatch/iu);
    });

    test("the movement exists but the receipt carries NO posting lock", async () => {
      const rid = await makeConfirmed("doc-replay-no-lock");
      const { dedupeKey, hash } = await frozenOf(rid);
      // Source binding is entirely correct — only the lock is missing.
      await synthetic({ dedupeKey, sourceDocId: rid, version: hash });

      expect(
        await sql(`SELECT coalesce(posting_locked_at::text,'NULL')
                     FROM public.purchase_receipts WHERE id='${rid}'`),
      ).toBe("NULL");

      const err = await sqlFails(
        `SELECT public.post_purchase_receipt_inventory_movement('${rid}')`,
      );
      expect(err).toMatch(/posting lock mismatch/iu);
    });

    test("the movement exists but the lock is held by someone else", async () => {
      const rid = await makeConfirmed("doc-replay-wrong-locker");
      const { dedupeKey, hash } = await frozenOf(rid);
      await synthetic({ dedupeKey, sourceDocId: rid, version: hash });
      await sql(`SELECT public.lock_purchase_receipt_for_posting('${rid}','someone-else')`);

      const err = await sqlFails(
        `SELECT public.post_purchase_receipt_inventory_movement('${rid}')`,
      );
      expect(err).toMatch(/posting lock mismatch/iu);
      expect(err).toMatch(/someone-else/u);
    });

    test("a genuine retry still returns the original movement with replayed=true", async () => {
      const rid = await makeConfirmed("doc-replay-genuine", [itemJson("cherry", "6.5")]);
      const first = JSON.parse(
        await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
      );
      const { hash, dedupeKey } = await frozenOf(rid);

      const second = JSON.parse(
        await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
      );
      expect(second.replayed).toBe(true);
      expect(second.movement_id).toBe(first.movement_id);
      expect(second.dedupe_key).toBe(dedupeKey);
      expect(second.posting_locked_by).toBe("p2c-inventory-ledger");

      // The binding the replay guard checks is exactly what was stored.
      expect(
        await sql(`SELECT source_document_version FROM public.inventory_movements
                     WHERE id='${first.movement_id}'`),
      ).toBe(hash);
      expect(await balanceOf("cherry")).toBe("6.500000");
    });
  });

  // ── Frozen confirmation hash is mandatory ────────────────────────────────

  describe("a missing or malformed frozen confirmation hash fails closed", () => {
    const badHashes: ReadonlyArray<[string, string]> = [
      ["null", "NULL::text"],
      ["blank", `''`],
      ["whitespace only", `'   '`],
    ];

    for (const [label, expr] of badHashes) {
      test(`rejects a ${label} hash`, async () => {
        const rid = await makeConfirmed(`doc-hash-${label.replace(/\s+/gu, "-")}`);
        await expectInjectedRejection(
          rid,
          fakeContractSql({
            hash: expr,
            dedupeKey: `'hash-probe-${label.replace(/\s+/gu, "-")}'`,
            items: `jsonb_build_array(${fakeItem({})})`,
            itemCount: 1,
          }),
          `'no frozen confirmation hash'`,
        );
      });
    }

    test("a well-formed hash is stored verbatim as source_document_version", async () => {
      const rid = await makeConfirmed("doc-hash-verbatim");
      const { hash } = await frozenOf(rid);
      const res = JSON.parse(
        await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
      );
      expect(
        await sql(`SELECT source_document_version FROM public.inventory_movements
                     WHERE id='${res.movement_id}'`),
      ).toBe(hash);
      // Never recomputed: it equals P2B's stored column exactly.
      expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    });
  });

  // ── Quantities must never be silently rounded ────────────────────────────

  describe("a quantity that would not survive numeric(18,6) fails closed", () => {
    const badQuantities: ReadonlyArray<[string, string, string]> = [
      ["7 fractional digits", `'1.1234567'`, "not a plain decimal"],
      ["many fractional digits", `'0.12345678901234'`, "not a plain decimal"],
      ["exponent notation", `'1e3'`, "not a plain decimal"],
      ["negative exponent", `'1E-7'`, "not a plain decimal"],
      ["NaN text", `'NaN'`, "not a plain decimal"],
      ["Infinity text", `'Infinity'`, "not a plain decimal"],
      ["negative", `'-5'`, "not a plain decimal"],
      ["leading plus", `'+5'`, "not a plain decimal"],
      ["whitespace padded", `' 5 '`, "not a plain decimal"],
      ["empty string", `''`, "not a plain decimal"],
      ["malformed text", `'abc'`, "not a plain decimal"],
      ["double dot", `'1.2.3'`, "not a plain decimal"],
      ["leading zeros", `'007'`, "not a plain decimal"],
      ["bare zero", `'0'`, "non-positive quantity"],
      ["zero with decimals", `'0.000000'`, "non-positive quantity"],
      ["precision overflow", `'1000000000000'`, "exceeds the numeric(18,6) envelope"],
    ];

    for (const [label, expr, needle] of badQuantities) {
      test(`rejects ${label}`, async () => {
        const rid = await makeConfirmed(`doc-qty-${label.replace(/\s+/gu, "-")}`);
        await expectInjectedRejection(
          rid,
          fakeContractSql({
            hash: `repeat('a',64)`,
            dedupeKey: `'qty-probe-${label.replace(/\s+/gu, "-")}'`,
            items: `jsonb_build_array(${fakeItem({ quantity: expr })})`,
            itemCount: 1,
          }),
          `'${needle}'`,
        );
      });
    }

    test("exact supported decimals are stored unchanged", async () => {
      // Full 6dp precision, and a value near the top of the envelope.
      const rid = await makeConfirmed("doc-qty-exact", [
        itemJson("exactfruit", "0.000001"),
        itemJson("bigfruit", "999999999999.999999"),
      ]);
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`);
      expect(await balanceOf("exactfruit")).toBe("0.000001");
      expect(await balanceOf("bigfruit")).toBe("999999999999.999999");
    });
  });

  // ── One ledger line per source item ──────────────────────────────────────

  test("a payload repeating one receipt_item_id under two ordinals fails atomically", async () => {
    const rid = await makeConfirmed("doc-dup-source-line");
    await expectInjectedRejection(
      rid,
      fakeContractSql({
        hash: `repeat('a',64)`,
        dedupeKey: `'dup-source-line-probe'`,
        items:
          `jsonb_build_array(` +
          `${fakeItem({ item_ordinal: "1", quantity: `'5'` })},` +
          // Same receipt_item_id, different ordinal: would double-count stock.
          `${fakeItem({ item_ordinal: "2", quantity: `'5'` })})`,
        itemCount: 2,
      }),
      `'inventory_movement_lines_source_item_uidx'`,
    );
  });

  test("distinct source items in one movement are fine, and a reversal reuses them", async () => {
    // The uniqueness is scoped to (movement_id, source_line_id) — a reversal
    // carries the same source_line_id values under a different movement_id.
    const rid = await makeConfirmed("doc-dup-scope", [
      itemJson("fig", "1"),
      itemJson("date", "2"),
    ]);
    const posted = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    const rev = JSON.parse(
      await sql(`SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-dup-scope','r','t')`),
    );

    expect(
      await sql(`SELECT count(DISTINCT source_line_id) FROM public.inventory_movement_lines
                   WHERE movement_id='${posted.movement_id}'`),
    ).toBe("2");
    // Reversal reuses both source_line_id values without tripping the index.
    expect(
      await sql(`SELECT count(*) FROM public.inventory_movement_lines r
                   JOIN public.inventory_movement_lines o
                     ON o.movement_id='${posted.movement_id}'
                    AND o.source_line_id = r.source_line_id
                  WHERE r.movement_id='${rev.reversal_id}'`),
    ).toBe("2");
    expect(await balanceOf("fig")).toBe("0.000000");
  });

  // ── Rejections, and the "nothing partial survives" guarantee ─────────────

  test("a receipt with blocking blockers is rejected and leaves no trace", async () => {
    const rid = await makeConfirmed("doc-blocked", [
      `{"product_key":"mango","raw_product_text":"m","quantity":"1","unit_key":"kg",` +
        `"raw_unit":"kg","unit_cost":"10","product_identity_status":"UNRESOLVED"}`,
    ]);

    const err = await sqlFails(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`);
    expect(err).toMatch(/blocking blockers/iu);

    expect(
      await sql(`SELECT count(*) FROM public.inventory_movements WHERE source_document_id='${rid}'`),
    ).toBe("0");
    // No posting lock either: the pair is all-or-nothing.
    expect(
      await sql(`SELECT coalesce(posting_locked_at::text,'NULL')
                   FROM public.purchase_receipts WHERE id='${rid}'`),
    ).toBe("NULL");
  });

  test("an unresolved unit is rejected", async () => {
    const rid = await makeConfirmed("doc-unresolved-unit", [
      `{"product_key":"mango","raw_product_text":"m","quantity":"1","unit_key":"kg",` +
        `"raw_unit":"kg","unit_cost":"10","unit_identity_status":"UNRESOLVED"}`,
    ]);
    const err = await sqlFails(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`);
    expect(err).toMatch(/blocking blockers|UNRESOLVED unit identity/iu);
    expect(
      await sql(`SELECT count(*) FROM public.inventory_movements WHERE source_document_id='${rid}'`),
    ).toBe("0");
  });

  test("a draft (never confirmed) receipt is rejected", async () => {
    const rid = await makeDraft("doc-draft");
    const err = await sqlFails(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`);
    expect(err).toMatch(/is not confirmed/iu);
    expect(await sql(`SELECT count(*) FROM public.inventory_movements
                        WHERE source_document_id='${rid}'`)).toBe("0");
  });

  test("a void receipt is rejected", async () => {
    const rid = await makeConfirmed("doc-void");
    await sql(`SELECT public.void_purchase_receipt('${rid}','staff cancelled')`);
    const err = await sqlFails(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`);
    expect(err).toMatch(/is void and must not be posted/iu);
    expect(await sql(`SELECT count(*) FROM public.inventory_movements
                        WHERE source_document_id='${rid}'`)).toBe("0");
  });

  test("an unknown receipt is rejected", async () => {
    const err = await sqlFails(
      `SELECT public.post_purchase_receipt_inventory_movement('66666666-6666-4666-8666-666666666666')`,
    );
    expect(err).toMatch(/not found/iu);
  });

  test("the per-item identity barrier behind the blocker gate is live, not dead code", async () => {
    // P2B marks unresolved identity BLOCKING, so the blocker gate always fires
    // first through a well-behaved P2B. Fault-inject a contract that claims no
    // blockers while carrying an unresolved item, to prove the second barrier
    // exists.
    //
    // The injection runs inside a transaction that is ROLLED BACK. PostgreSQL
    // DDL is transactional, so the real function is restored by the database
    // itself — a manual restore step could fail and silently leak the fake into
    // every later test.
    const rid = await makeConfirmed("doc-barrier");
    const r = await collect(
      startScript(`
        BEGIN;
        CREATE OR REPLACE FUNCTION public.get_purchase_receipt_confirmation(p_receipt_id uuid)
        RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = public, extensions, pg_temp AS $fake$
          SELECT jsonb_build_object(
            'receipt_id', p_receipt_id::text,
            'confirmation', jsonb_build_object('hash', repeat('a',64),
                                               'contract_version','p2b-purchase-confirm-v1',
                                               'confirmation_key','fake',
              'payload', jsonb_build_object(
                'business_date','2026-07-29', 'intended_warehouse_code','MAIN',
                'has_blocking_blockers', false, 'posts_inventory_movement', false,
                'item_count', 1, 'document_namespace','line-text','document_key','x',
                'parser_contract_version','p2b-slice-a-v1',
                'items', jsonb_build_array(jsonb_build_object(
                  'receipt_item_id','77777777-7777-4777-8777-777777777777',
                  'item_ordinal', 1, 'product_key','mango','unit_key','kg',
                  'quantity','1', 'raw_product_text','m','raw_unit','kg',
                  'product_identity_status','UNRESOLVED',
                  'unit_identity_status','RESOLVED')))),
            'p2c_dedupe_key', 'fake-barrier-key')
        $fake$;
        DO $probe$
        DECLARE n integer;
        BEGIN
          BEGIN
            PERFORM public.post_purchase_receipt_inventory_movement('${rid}');
            RAISE EXCEPTION 'BARRIER_FAIL: unresolved item was accepted';
          EXCEPTION WHEN invalid_parameter_value THEN
            IF position('UNRESOLVED product identity' IN SQLERRM) = 0 THEN
              RAISE EXCEPTION 'BARRIER_FAIL: wrong error %', SQLERRM;
            END IF;
          END;
          SELECT count(*) INTO n FROM public.inventory_movements
            WHERE dedupe_key = 'fake-barrier-key';
          IF n <> 0 THEN RAISE EXCEPTION 'BARRIER_FAIL: % movements survived', n; END IF;
          RAISE NOTICE 'BARRIER_OK';
        END $probe$;
        ROLLBACK;`),
    );

    expect(r.code, `barrier probe failed: ${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/BARRIER_OK/u);
    expect(r.stderr).not.toMatch(/BARRIER_FAIL/u);

    // The rollback restored the real P2B getter: a normal post works again.
    const res = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    expect(res.replayed).toBe(false);
  });

  test("a posting-lock failure leaves NO movement behind", async () => {
    // The only way to reach this branch is fault injection: every reachable
    // precondition is already checked before the lock call. Proving the rollback
    // is the whole point of the claim "never movements without the posting lock".
    // Same transactional-DDL trick: the injected failure cannot leak.
    const rid = await makeConfirmed("doc-lock-fail");
    const r = await collect(
      startScript(`
        BEGIN;
        CREATE OR REPLACE FUNCTION public.lock_purchase_receipt_for_posting(
          p_receipt_id uuid, p_locked_by text)
        RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = public, extensions, pg_temp AS $fake$
        BEGIN
          RAISE EXCEPTION 'injected posting lock failure'
            USING ERRCODE = 'internal_error';
        END $fake$;
        DO $probe$
        DECLARE n integer;
        BEGIN
          BEGIN
            PERFORM public.post_purchase_receipt_inventory_movement('${rid}');
            RAISE EXCEPTION 'LOCKFAIL_FAIL: posting survived a failed lock';
          EXCEPTION WHEN internal_error THEN
            IF position('injected posting lock failure' IN SQLERRM) = 0 THEN
              RAISE EXCEPTION 'LOCKFAIL_FAIL: wrong error %', SQLERRM;
            END IF;
          END;
          SELECT count(*) INTO n FROM public.inventory_movements
            WHERE source_document_id = '${rid}';
          IF n <> 0 THEN RAISE EXCEPTION 'LOCKFAIL_FAIL: % movements survived', n; END IF;
          SELECT count(*) INTO n FROM public.inventory_movement_lines l
            JOIN public.inventory_movements m ON m.id = l.movement_id
           WHERE m.source_document_id = '${rid}';
          IF n <> 0 THEN RAISE EXCEPTION 'LOCKFAIL_FAIL: % lines survived', n; END IF;
          SELECT count(*) INTO n FROM public.purchase_receipts
           WHERE id = '${rid}' AND posting_locked_at IS NOT NULL;
          IF n <> 0 THEN RAISE EXCEPTION 'LOCKFAIL_FAIL: posting lock survived'; END IF;
          RAISE NOTICE 'LOCKFAIL_OK';
        END $probe$;
        ROLLBACK;`),
    );

    expect(r.code, `lock-failure probe failed: ${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/LOCKFAIL_OK/u);
    expect(r.stderr).not.toMatch(/LOCKFAIL_FAIL/u);

    // Restored by the rollback: movement AND lock now land together.
    const res = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    expect(res.replayed).toBe(false);
    expect(res.posting_locked_by).toBe("p2c-inventory-ledger");
  });

  test("an explicit rollback discards both the movement and the posting lock", async () => {
    const rid = await makeConfirmed("doc-rollback");
    const script = `BEGIN;
      SELECT public.post_purchase_receipt_inventory_movement('${rid}');
      ROLLBACK;`;
    const r = await collect(startScript(script));
    expect(r.code).toBe(0);

    expect(await sql(`SELECT count(*) FROM public.inventory_movements
                        WHERE source_document_id='${rid}'`)).toBe("0");
    expect(await sql(`SELECT coalesce(posting_locked_at::text,'NULL')
                        FROM public.purchase_receipts WHERE id='${rid}'`)).toBe("NULL");
  });

  // ── Append-only ─────────────────────────────────────────────────────────

  test("movement headers and lines are immutable, and deletes are forbidden", async () => {
    const rid = await makeConfirmed("doc-immutable");
    const res = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    const mid = res.movement_id;

    expect(await sqlFails(`UPDATE public.inventory_movements SET business_date='2000-01-01'
                             WHERE id='${mid}'`)).toMatch(/append-only and immutable/iu);
    expect(await sqlFails(`UPDATE public.inventory_movements SET line_count=99
                             WHERE id='${mid}'`)).toMatch(/append-only and immutable/iu);
    expect(await sqlFails(`DELETE FROM public.inventory_movements WHERE id='${mid}'`))
      .toMatch(/append-only and immutable/iu);
    expect(await sqlFails(`UPDATE public.inventory_movement_lines SET signed_quantity=999
                             WHERE movement_id='${mid}'`)).toMatch(/append-only and immutable/iu);
    expect(await sqlFails(`DELETE FROM public.inventory_movement_lines WHERE movement_id='${mid}'`))
      .toMatch(/append-only and immutable/iu);
  });

  test("a line cannot be appended to a movement from an earlier transaction", async () => {
    const rid = await makeConfirmed("doc-late-line");
    const res = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    const before = await balanceOf("mango");

    const err = await sqlFails(
      `INSERT INTO public.inventory_movement_lines
         (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
       VALUES ('${res.movement_id}', 99, 'sneaky', 'kg', 'MAIN', 1)`,
    );
    expect(err).toMatch(/is sealed at \d+ lines/iu);

    // The append is rejected at commit, so nothing persists and no balance moved.
    expect(await sql(
      `SELECT count(*) FROM public.inventory_movement_lines
        WHERE movement_id='${res.movement_id}'`,
    )).toBe(String(res.line_count));
    expect(await balanceOf("mango")).toBe(before);
  });

  test("the seal does not depend on created_at, so a forged timestamp cannot defeat it", async () => {
    // The earlier design compared the parent's created_at to now() and treated
    // equality as proof of "same transaction". created_at is caller-suppliable,
    // so that check could be satisfied by a value rather than by a fact. Here the
    // movement is created in ONE transaction carrying an explicitly chosen
    // created_at, and a LATER transaction appends a line while supplying the very
    // same timestamp it would have needed to match. The seal still rejects it,
    // because it rests on line_count, not on the clock.
    const forged = "2030-01-01 00:00:00+00";
    const mid = "99999999-9999-4999-8999-999999999999";

    await sql(
      `INSERT INTO public.inventory_movements
         (id, movement_type, business_date, source_system, source_document_type,
          source_document_id, dedupe_key, line_count, created_at)
       VALUES ('${mid}','PURCHASE_RECEIPT','2026-07-29','test','forged-clock',
               gen_random_uuid(),'forged-clock-key',1,'${forged}');
       INSERT INTO public.inventory_movement_lines
         (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
       VALUES ('${mid}',1,'forged','kg','MAIN',1)`,
    );

    // Confirm the trap is genuinely armed: the stored timestamp is the forged one.
    expect(
      await sql(`SELECT created_at = '${forged}'::timestamptz
                   FROM public.inventory_movements WHERE id='${mid}'`),
    ).toBe("t");

    // Separate transaction; created_at supplied explicitly to match the parent.
    const err = await sqlFails(
      `INSERT INTO public.inventory_movement_lines
         (movement_id, line_ordinal, product_key, unit_key, location_code,
          signed_quantity, created_at)
       VALUES ('${mid}', 2, 'forged','kg','MAIN', 100, '${forged}')`,
    );
    expect(err).toMatch(/is sealed at 1 lines but now has 2/iu);

    expect(await balanceOf("forged")).toBe("1.000000");
  });

  test("a movement cannot commit with MORE lines than it declares", async () => {
    const err = await sqlFails(
      `DO $probe$
       DECLARE v_mid uuid := gen_random_uuid();
       BEGIN
         INSERT INTO public.inventory_movements
           (id, movement_type, business_date, source_system, source_document_type,
            source_document_id, dedupe_key, line_count)
         VALUES (v_mid,'PURCHASE_RECEIPT','2026-07-29','test','over-declared',
                 gen_random_uuid(),'over-declared-key',1);
         INSERT INTO public.inventory_movement_lines
           (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
         VALUES (v_mid, 1, 'a','kg','MAIN', 1), (v_mid, 2, 'b','kg','MAIN', 1);
       END $probe$`,
    );
    expect(err).toMatch(/sealed at 1 lines but now has 2|declares 1 lines but has 2/iu);
  });

  test("a movement whose declared line_count does not match cannot commit", async () => {
    const err = await sqlFails(
      `INSERT INTO public.inventory_movements
         (movement_type, business_date, source_system, source_document_type,
          source_document_id, dedupe_key, line_count)
       VALUES ('PURCHASE_RECEIPT','2026-07-29','x','ghost',gen_random_uuid(),'ghost-1',1)`,
    );
    expect(err).toMatch(/declares 1 lines but has 0|all-or-nothing/iu);
  });

  test("a zero signed_quantity line is rejected", async () => {
    // Written against a parent created in the SAME transaction, so the CHECK is
    // what rejects it rather than the earlier cross-transaction guard.
    const err = await sqlFails(
      `DO $probe$
       DECLARE v_mid uuid := gen_random_uuid();
       BEGIN
         INSERT INTO public.inventory_movements
           (id, movement_type, business_date, source_system, source_document_type,
            source_document_id, dedupe_key, line_count)
         VALUES (v_mid,'PURCHASE_RECEIPT','2026-07-29','test','zero-qty',
                 gen_random_uuid(),'zero-qty-key',1);
         INSERT INTO public.inventory_movement_lines
           (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
         VALUES (v_mid, 1, 'x','kg','MAIN', 0);
       END $probe$`,
    );
    expect(err).toMatch(/signed_quantity/iu);
  });

  test("the reversal back-link cannot be forged by direct UPDATE", async () => {
    const rid = await makeConfirmed("doc-forge");
    const res = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    const other = await makeConfirmed("doc-forge-other");
    const otherRes = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${other}')`),
    );

    // Pointing at a movement that is not a REVERSAL of this row must be refused.
    const err = await sqlFails(
      `UPDATE public.inventory_movements
          SET reversed_by_movement_id='${otherRes.movement_id}' WHERE id='${res.movement_id}'`,
    );
    expect(err).toMatch(/must reference a REVERSAL movement/iu);
  });

  // ── Reversal ────────────────────────────────────────────────────────────

  test("a full reversal returns the balance to its original value with exact negatives", async () => {
    const rid = await makeConfirmed("doc-rev", [
      itemJson("durian", "7.125000"),
      itemJson("lychee", "3"),
    ]);
    const before = await balanceOf("durian");
    expect(before).toBe("NONE");

    const posted = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    expect(await balanceOf("durian")).toBe("7.125000");

    const rev = JSON.parse(
      await sql(
        `SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-doc-rev','miscount','tester')`,
      ),
    );
    expect(rev.replayed).toBe(false);
    expect(rev.line_count).toBe(2);
    expect(rev.dedupe_key).toBe("inventory-movement-reversal:v1:rev-doc-rev");

    expect(await balanceOf("durian")).toBe("0.000000");
    expect(await balanceOf("lychee")).toBe("0.000000");

    // Exact negative copies, preserving every linkage field and the ordinal.
    expect(
      await sql(
        `SELECT count(*) FROM public.inventory_movement_lines o
           JOIN public.inventory_movement_lines r
             ON r.movement_id='${rev.reversal_id}' AND r.line_ordinal=o.line_ordinal
          WHERE o.movement_id='${posted.movement_id}'
            AND r.signed_quantity = -o.signed_quantity
            AND r.product_key = o.product_key
            AND r.unit_key = o.unit_key
            AND r.location_code = o.location_code
            AND r.source_line_id IS NOT DISTINCT FROM o.source_line_id`,
      ),
    ).toBe("2");

    // Linked both ways, and the reversal inherits the original's business date.
    expect(
      await sql(`SELECT reversed_by_movement_id FROM public.inventory_movements
                   WHERE id='${posted.movement_id}'`),
    ).toBe(rev.reversal_id);
    expect(
      await sql(`SELECT reversal_of_movement_id FROM public.inventory_movements
                   WHERE id='${rev.reversal_id}'`),
    ).toBe(posted.movement_id);
    expect(
      await sql(`SELECT business_date::text FROM public.inventory_movements
                   WHERE id='${rev.reversal_id}'`),
    ).toBe("2026-07-29");
    expect(
      await sql(`SELECT reversal_reason FROM public.inventory_movements
                   WHERE id='${rev.reversal_id}'`),
    ).toBe("miscount");
  });

  test("reversal is idempotent on the same key and fails closed on a different one", async () => {
    const rid = await makeConfirmed("doc-rev-idem");
    const posted = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    const first = JSON.parse(
      await sql(
        `SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-idem','a','t')`,
      ),
    );
    const second = JSON.parse(
      await sql(
        `SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-idem','a','t')`,
      ),
    );
    expect(second.replayed).toBe(true);
    expect(second.reversal_id).toBe(first.reversal_id);
    expect(
      await sql(`SELECT count(*) FROM public.inventory_movements
                   WHERE reversal_of_movement_id='${posted.movement_id}'`),
    ).toBe("1");

    const err = await sqlFails(
      `SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-idem-other','b','t')`,
    );
    expect(err).toMatch(/already reversed/iu);
    expect(
      await sql(`SELECT count(*) FROM public.inventory_movements
                   WHERE reversal_of_movement_id='${posted.movement_id}'`),
    ).toBe("1");
  });

  test("a reversal cannot itself be reversed", async () => {
    const rid = await makeConfirmed("doc-rev-rev");
    const posted = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    const rev = JSON.parse(
      await sql(`SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-rr','a','t')`),
    );
    expect(
      await sqlFails(`SELECT public.reverse_inventory_movement('${rev.reversal_id}','rev-rr2','b','t')`),
    ).toMatch(/itself a reversal/iu);
  });

  test("a reversal key already bound to another movement is refused", async () => {
    const ridA = await makeConfirmed("doc-rev-keyA");
    const ridB = await makeConfirmed("doc-rev-keyB");
    const a = JSON.parse(await sql(`SELECT public.post_purchase_receipt_inventory_movement('${ridA}')`));
    const b = JSON.parse(await sql(`SELECT public.post_purchase_receipt_inventory_movement('${ridB}')`));

    await sql(`SELECT public.reverse_inventory_movement('${a.movement_id}','shared-key','a','t')`);
    expect(
      await sqlFails(`SELECT public.reverse_inventory_movement('${b.movement_id}','shared-key','b','t')`),
    ).toMatch(/already in use by a different movement/iu);
  });

  test("reversing an unknown movement is rejected, and a blank key or reason is refused", async () => {
    expect(
      await sqlFails(
        `SELECT public.reverse_inventory_movement('66666666-6666-4666-8666-666666666667','k','r','t')`,
      ),
    ).toMatch(/not found/iu);

    const rid = await makeConfirmed("doc-rev-blank");
    const posted = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    expect(
      await sqlFails(`SELECT public.reverse_inventory_movement('${posted.movement_id}','  ','r','t')`),
    ).toMatch(/reversal key is required/iu);
    expect(
      await sqlFails(`SELECT public.reverse_inventory_movement('${posted.movement_id}','k','  ','t')`),
    ).toMatch(/reversal reason is required/iu);
  });

  test("a replayed posting reports the reversal that negated it", async () => {
    const rid = await makeConfirmed("doc-rev-replay");
    const posted = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    const rev = JSON.parse(
      await sql(`SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-rp','a','t')`),
    );
    const replay = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.reversed_by_movement_id).toBe(rev.reversal_id);
  });

  // ── Balances ────────────────────────────────────────────────────────────

  test("balances group, filter, order deterministically and stay exact", async () => {
    const rid = await makeConfirmed("doc-bal", [
      itemJson("zucchini", "1.000001"),
      itemJson("apple", "2"),
      itemJson("apple", "3", "ลัง"),
    ]);
    await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`);

    const all = JSON.parse(await sql(`SELECT public.get_inventory_balances()`)).balances as Array<
      Record<string, string>
    >;
    const keys = all.map((b) => `${b.location_code}/${b.product_key}/${b.unit_key}`);
    expect([...keys], "ordering must be location, product, unit").toEqual([...keys].sort());

    // Exact decimal, carried as a string — never a JSON number.
    const zucchini = all.find((b) => b.product_key === "zucchini");
    expect(zucchini?.quantity_balance).toBe("1.000001");
    expect(typeof zucchini?.quantity_balance).toBe("string");

    // Same product, two units, kept apart.
    expect(await sql(
      `SELECT count(*) FROM jsonb_array_elements(
         public.get_inventory_balances(NULL,'apple')->'balances') b`,
    )).toBe("2");

    // Filters narrow correctly.
    expect(await sql(
      `SELECT count(*) FROM jsonb_array_elements(
         public.get_inventory_balances('MAIN','apple','ลัง')->'balances') b`,
    )).toBe("1");
    expect(await sql(
      `SELECT count(*) FROM jsonb_array_elements(
         public.get_inventory_balances('NOWHERE')->'balances') b`,
    )).toBe("0");
  });

  test("zero balances are omitted by default and returned on request", async () => {
    const rid = await makeConfirmed("doc-bal-zero", [itemJson("kiwi", "4")]);
    const posted = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );
    await sql(`SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-zero','a','t')`);

    expect(await sql(
      `SELECT count(*) FROM jsonb_array_elements(
         public.get_inventory_balances(NULL,'kiwi')->'balances') b`,
    )).toBe("0");

    expect(await sql(
      `SELECT b->>'quantity_balance' FROM jsonb_array_elements(
         public.get_inventory_balances(NULL,'kiwi',NULL,true)->'balances') b`,
    )).toBe("0.000000");
  });

  test("a negative balance is representable and reported, not suppressed", async () => {
    // No adapter issues stock in 0053, so the negative line is written directly
    // to prove the read model reports an oversold product rather than hiding it.
    await sql(
      `INSERT INTO public.inventory_movements
         (id, movement_type, business_date, source_system, source_document_type,
          source_document_id, dedupe_key, line_count)
       VALUES ('88888888-8888-4888-8888-888888888888','PURCHASE_RECEIPT','2026-07-29',
               'test','manual-negative',gen_random_uuid(),'negative-balance-key',1);
       INSERT INTO public.inventory_movement_lines
         (movement_id, line_ordinal, product_key, unit_key, location_code, signed_quantity)
       VALUES ('88888888-8888-4888-8888-888888888888',1,'oversold','kg','MAIN',-2.5)`,
    );
    expect(await balanceOf("oversold")).toBe("-2.500000");
  });

  test("the balance view is SECURITY INVOKER and cannot be written through", async () => {
    expect(
      await sql(
        `SELECT (c.reloptions::text LIKE '%security_invoker=true%')::text
           FROM pg_class c WHERE c.oid='public.inventory_balances'::regclass`,
      ),
    ).toBe("true");
    expect(
      await sqlFails(`INSERT INTO public.inventory_balances
                        VALUES ('MAIN','x','kg',1)`),
    ).toMatch(/cannot insert into view|no INSERT rule|cannot change/iu);
  });

  // ── The P2B posting lock is owned, not merely present ────────────────────
  //
  // lock_purchase_receipt_for_posting() reports an idempotent replay for ANY
  // pre-existing lock and never inspects posting_locked_by. Left unguarded, a
  // fresh post under someone else's lock would COMMIT stock while the caller
  // was told it failed. The adapter brackets that helper on both sides.

  describe("a fresh post refuses to run under a posting lock it does not own", () => {
    test("foreign-owner lock: post fails, nothing is written, the lock is untouched", async () => {
      const rid = await makeConfirmed("doc-lock-foreign", [itemJson("lockfruit-foreign", "3")]);
      await sql(`SELECT public.lock_purchase_receipt_for_posting('${rid}','some-other-writer')`);
      const lockedAt = await sql(
        `SELECT posting_locked_at FROM public.purchase_receipts WHERE id='${rid}'`,
      );

      const err = await sqlFails(
        `SELECT public.post_purchase_receipt_inventory_movement('${rid}')`,
      );
      expect(err).toMatch(/posting lock conflict/iu);
      expect(err).toMatch(/locked for posting by some-other-writer/iu);
      expect(err).toMatch(/does not own/iu);

      expect(
        await sql(`SELECT count(*) FROM public.inventory_movements
                     WHERE source_document_id='${rid}'`),
        "a foreign lock must stop the post before any movement header is written",
      ).toBe("0");
      expect(
        await sql(`SELECT count(*) FROM public.inventory_movement_lines l
                     JOIN public.inventory_movements m ON m.id=l.movement_id
                    WHERE m.source_document_id='${rid}'`),
      ).toBe("0");
      expect(await balanceOf("lockfruit-foreign")).toBe("NONE");

      // The other writer's lock is left exactly as it was found.
      expect(
        await sql(`SELECT posting_locked_by FROM public.purchase_receipts WHERE id='${rid}'`),
      ).toBe("some-other-writer");
      expect(
        await sql(`SELECT posting_locked_at FROM public.purchase_receipts WHERE id='${rid}'`),
      ).toBe(lockedAt);
    });

    test("orphan p2c lock with no movement: post fails and the lock is NOT repaired", async () => {
      const rid = await makeConfirmed("doc-lock-orphan", [itemJson("lockfruit-orphan", "4")]);
      await sql(`SELECT public.lock_purchase_receipt_for_posting('${rid}','p2c-inventory-ledger')`);
      const lockedAt = await sql(
        `SELECT posting_locked_at FROM public.purchase_receipts WHERE id='${rid}'`,
      );

      const err = await sqlFails(
        `SELECT public.post_purchase_receipt_inventory_movement('${rid}')`,
      );
      expect(err).toMatch(/posting lock conflict/iu);
      expect(err).toMatch(/orphan p2c-inventory-ledger/iu);
      expect(err).toMatch(/refusing to adopt it/iu);

      expect(
        await sql(`SELECT count(*) FROM public.inventory_movements
                     WHERE source_document_id='${rid}'`),
        "an orphan lock must never be adopted by a fresh posting",
      ).toBe("0");
      expect(await balanceOf("lockfruit-orphan")).toBe("NONE");

      // Still visible for operational repair — the RPC does not clear it, and
      // does not quietly post on top of it either.
      expect(
        await sql(`SELECT posting_locked_by FROM public.purchase_receipts WHERE id='${rid}'`),
      ).toBe("p2c-inventory-ledger");
      expect(
        await sql(`SELECT posting_locked_at FROM public.purchase_receipts WHERE id='${rid}'`),
      ).toBe(lockedAt);
    });

    // 0052's purchase_receipts_posting_lock_paired CHECK makes a half-written
    // lock unreachable through supported writes, so the constraint is dropped
    // inside a rolled-back transaction to reach the branch at all. If the
    // invariant is ever lost for real, the adapter must still refuse.
    test("malformed lock (locked_at set, locked_by null) fails before any write", async () => {
      const rid = await makeConfirmed("doc-lock-half-at", [itemJson("durian", "1")]);
      await expectPostRejectedInTx({
        rid,
        setup: `ALTER TABLE public.purchase_receipts
                  DROP CONSTRAINT purchase_receipts_posting_lock_paired;
                UPDATE public.purchase_receipts
                   SET posting_locked_at = now(), posting_locked_by = NULL
                 WHERE id = '${rid}';`,
        needle: `'malformed posting lock'`,
        lockOwner: "NULL",
      });
    });

    test("malformed lock (locked_by set, locked_at null) fails before any write", async () => {
      const rid = await makeConfirmed("doc-lock-half-by", [itemJson("durian", "2")]);
      await expectPostRejectedInTx({
        rid,
        setup: `ALTER TABLE public.purchase_receipts
                  DROP CONSTRAINT purchase_receipts_posting_lock_paired;
                UPDATE public.purchase_receipts
                   SET posting_locked_at = NULL, posting_locked_by = 'half-written'
                 WHERE id = '${rid}';`,
        needle: `'malformed posting lock'`,
        lockOwner: `'half-written'`,
      });
    });
  });

  describe("the posting lock is asserted after the helper returns", () => {
    test("a helper that returns success without locking rolls the movement back", async () => {
      const rid = await makeConfirmed("doc-lock-noop-helper", [itemJson("longan", "6")]);

      // The real helper's contract is exactly what cannot be trusted: it returns
      // a success shape for a lock it did not take. Here it takes none at all.
      await expectPostRejectedInTx({
        rid,
        setup: `
          CREATE OR REPLACE FUNCTION public.lock_purchase_receipt_for_posting(
            p_receipt_id uuid, p_locked_by text
          ) RETURNS jsonb LANGUAGE sql
          SET search_path = public, extensions, pg_temp AS $noop$
            SELECT jsonb_build_object('receipt_id', p_receipt_id::text, 'replayed', true)
          $noop$;`,
        needle: `'posting lock not established'`,
        lockOwner: "NULL",
      });
    });

    test("a helper that locks under the WRONG owner rolls the movement back", async () => {
      const rid = await makeConfirmed("doc-lock-wrong-owner", [itemJson("longan", "7")]);
      await expectPostRejectedInTx({
        rid,
        setup: `
          CREATE OR REPLACE FUNCTION public.lock_purchase_receipt_for_posting(
            p_receipt_id uuid, p_locked_by text
          ) RETURNS jsonb LANGUAGE sql
          SET search_path = public, extensions, pg_temp AS $wrong$
            WITH u AS (
              UPDATE public.purchase_receipts
                 SET posting_locked_at = now(), posting_locked_by = 'not-p2c'
               WHERE id = p_receipt_id RETURNING id)
            SELECT jsonb_build_object('receipt_id', (SELECT id::text FROM u),
                                      'replayed', false)
          $wrong$;`,
        needle: `'posting lock not established'`,
        // NULL, not 'not-p2c'. The probe catches the failure in a subtransaction,
        // which unwinds the fake helper's own lock write along with the movement.
        // That IS the property under test: a post that raises on a wrong-owner
        // lock leaves neither the stock nor the bad lock behind.
        lockOwner: "NULL",
      });
    });
  });

  describe("valid posting behaviour is unchanged by the lock guards", () => {
    test("a fresh post commits the movement, its lines and the p2c lock together", async () => {
      const rid = await makeConfirmed("doc-lock-fresh-ok", [
        itemJson("rambutan", "8"),
        itemJson("santol", "2"),
      ]);
      const posted = JSON.parse(
        await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}','fresh')`),
      );

      expect(posted.replayed).toBe(false);
      expect(posted.line_count).toBe(2);
      expect(posted.posting_locked_by).toBe("p2c-inventory-ledger");
      expect(posted.posting_locked_at).not.toBeNull();

      expect(
        await sql(`SELECT count(*) FROM public.inventory_movement_lines
                    WHERE movement_id='${posted.movement_id}'`),
      ).toBe("2");
      expect(
        await sql(`SELECT posting_locked_by FROM public.purchase_receipts WHERE id='${rid}'`),
      ).toBe("p2c-inventory-ledger");
      expect(await balanceOf("rambutan")).toBe("8.000000");
    });

    test("a replay over an exact movement and an owned p2c lock still returns replayed", async () => {
      const rid = await makeConfirmed("doc-lock-replay-ok", [itemJson("mangosteen", "5")]);
      const first = JSON.parse(
        await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
      );
      const second = JSON.parse(
        await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
      );

      // The fresh-path lock rejection must NOT reach the replay path, where the
      // p2c lock being present is precisely the healthy state.
      expect(second.replayed).toBe(true);
      expect(second.movement_id).toBe(first.movement_id);
      expect(second.posting_locked_by).toBe("p2c-inventory-ledger");

      expect(
        await sql(`SELECT count(*) FROM public.inventory_movements
                     WHERE source_document_id='${rid}'`),
      ).toBe("1");
      expect(
        await sql(`SELECT count(*) FROM public.inventory_movement_lines
                    WHERE movement_id='${first.movement_id}'`),
      ).toBe("1");
      expect(await balanceOf("mangosteen")).toBe("5.000000");
    });
  });

  // ── Concurrency (deterministic barriers, no sleep-dependent assertions) ──

  test("concurrent posting of ONE receipt creates exactly one movement", async () => {
    const rid = await makeConfirmed("doc-conc-same", [itemJson("melon", "5")]);

    await withGate("conc-same", 918_053_001, async (gate) => {
      // A posts, publishes an "I am mid-transaction" advisory lock, then parks
      // until the controller releases it. No fixed sleep decides the window.
      const a = gate.start("a", `
        BEGIN;
        SELECT public.post_purchase_receipt_inventory_movement('${rid}','A');
        SELECT pg_advisory_xact_lock(918053001);
        ${gate.hold}
        COMMIT;`);
      await gate.parked(a);

      // B contends for the same receipt row. Overlap is PROVEN by observing B
      // actually waiting on a lock, not inferred from how long A slept.
      const b = gate.start("b", `
        SELECT public.post_purchase_receipt_inventory_movement('${rid}','B');`);
      await gate.blocked(b);

      await gate.release();
      const ra = await gate.exits(a);
      const rb = await gate.exits(b);

      expect(ra.code, `session A failed: ${ra.stderr}`).toBe(0);
      expect(rb.code, `session B failed: ${rb.stderr}`).toBe(0);

      expect(
        await sql(`SELECT count(*) FROM public.inventory_movements
                     WHERE source_document_id='${rid}'`),
        "exactly one movement must exist for a concurrently posted receipt",
      ).toBe("1");
      expect(await balanceOf("melon")).toBe("5.000000");
      // B was blocked behind A, so B is necessarily the replay.
      expect(rb.stdout).toMatch(/"replayed": true/u);
      expect(ra.stdout).toMatch(/"replayed": false/u);
    });
  }, 90_000);

  test("concurrent posting of DIFFERENT receipts both succeed", async () => {
    const ridA = await makeConfirmed("doc-conc-a", [itemJson("guava", "1")]);
    const ridB = await makeConfirmed("doc-conc-b", [itemJson("guava", "2")]);

    await withGate("conc-diff", 918_053_002, async (gate) => {
      const a = gate.start("a", `
        BEGIN;
        SELECT public.post_purchase_receipt_inventory_movement('${ridA}','A');
        SELECT pg_advisory_xact_lock(918053002);
        ${gate.hold}
        COMMIT;`);
      await gate.parked(a);

      // Different receipt, different row: B must NOT block. B running to
      // completion while A is provably still parked is the assertion. If B
      // blocks instead, the bounded wait returns null and the failure is
      // raised here — cleanup in withGate still releases A and reaps both.
      const b = gate.start("b", `
        SELECT public.post_purchase_receipt_inventory_movement('${ridB}','B');`);
      const rb = await gate.exitedWithin(b, CHILD_EXIT_MS);
      expect(
        rb,
        "B posts a DIFFERENT receipt and must not block behind A",
      ).not.toBeNull();
      expect(rb!.code, `session B failed: ${rb!.stderr}`).toBe(0);

      expect(
        await sql(`SELECT count(*) FROM pg_locks
                     WHERE locktype='advisory' AND classid=0 AND objid=918053002 AND granted`),
        "session A must still be mid-transaction when B finished",
      ).not.toBe("0");

      await gate.release();
      const ra = await gate.exits(a);
      expect(ra.code, `session A failed: ${ra.stderr}`).toBe(0);

      expect(await sql(`SELECT count(*) FROM public.inventory_movements
                          WHERE source_document_id IN ('${ridA}','${ridB}')`)).toBe("2");
      expect(await balanceOf("guava")).toBe("3.000000");
    });
  }, 90_000);

  test("concurrent reversal of ONE movement creates exactly one reversal", async () => {
    const rid = await makeConfirmed("doc-conc-rev", [itemJson("plum", "9")]);
    const posted = JSON.parse(
      await sql(`SELECT public.post_purchase_receipt_inventory_movement('${rid}')`),
    );

    await withGate("conc-rev", 918_053_003, async (gate) => {
      const a = gate.start("a", `
        BEGIN;
        SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-conc-a','a','A');
        SELECT pg_advisory_xact_lock(918053003);
        ${gate.hold}
        COMMIT;`);
      await gate.parked(a);

      const b = gate.start("b", `
        SELECT public.reverse_inventory_movement('${posted.movement_id}','rev-conc-b','b','B');`);
      await gate.blocked(b);
      // Still waiting, not already finished: proven by the child not having exited.
      expect(
        await gate.exitedWithin(b, 250),
        "the losing reversal must still be waiting, not already finished",
      ).toBeNull();

      await gate.release();
      const ra = await gate.exits(a);
      const rb = await gate.exits(b);

      expect(ra.code, `session A failed: ${ra.stderr}`).toBe(0);
      // B used a different key against an already-reversed movement: fail closed.
      expect(rb.code, "the losing reversal must fail, not silently double-reverse").not.toBe(0);
      expect(rb.stderr).toMatch(/already reversed/iu);

      expect(
        await sql(`SELECT count(*) FROM public.inventory_movements
                     WHERE reversal_of_movement_id='${posted.movement_id}'`),
      ).toBe("1");
      expect(await balanceOf("plum")).toBe("0.000000");
    });
  }, 90_000);

  // ── The harness's own failure paths ──────────────────────────────────────
  //
  // These do not test 0053. They test that a controller which dies mid-scenario
  // cannot leave a parked session, a live psql child, a held lock or a barrier
  // row behind — because if it could, one failing concurrency test would cascade
  // into every test that ran after it. Correctness here must not depend on the
  // suite-level DROP DATABASE.

  describe("the concurrency harness cleans up on its own failure paths", () => {
    test("an unexpected block releases A, reaps B, and rethrows the ORIGINAL failure", async () => {
      const rid = await makeConfirmed("doc-gate-cleanup", [itemJson("gate-fruit", "1")]);
      const key = 918_053_101;
      let observed: unknown;
      let cleanup: GateReport | undefined;
      const started = Date.now();

      // B contends for the SAME receipt, so it blocks. The body then treats a
      // block as unexpected — the exact shape of the different-receipt case
      // going wrong — and throws while A is still parked and B still stuck.
      // Note the body never calls gate.release(): only the finally path can.
      try {
        await withGate(
          "gate-cleanup",
          key,
          async (gate) => {
            const a = gate.start("a", `
              BEGIN;
              SELECT public.post_purchase_receipt_inventory_movement('${rid}','A');
              SELECT pg_advisory_xact_lock(${key});
              ${gate.hold}
              COMMIT;`);
            await gate.parked(a);

            const b = gate.start("b", `
              SELECT public.post_purchase_receipt_inventory_movement('${rid}','B');`);
            await gate.blocked(b);

            const rb = await gate.exitedWithin(b, 500);
            if (rb === null) throw new Error("ORIGINAL_FAILURE: B blocked unexpectedly");
          },
          { onCleanup: (r) => { cleanup = r; } },
        );
      } catch (err) {
        observed = err;
      }

      // 6. The original assertion failure survives cleanup unmasked.
      expect(observed, "the body's failure must not be replaced by a cleanup error")
        .toBeInstanceOf(Error);
      expect((observed as Error).message).toBe("ORIGINAL_FAILURE: B blocked unexpectedly");

      // The gate was released in the FINALLY path, so A unparked and exited on
      // its own. Without that release A would only have gone away when the
      // bounded collect gave up and killed it — which is exactly what this
      // asserts did not happen. (Killing is a fallback, never the design.)
      expect(cleanup, "cleanup must report even when the body threw").toBeDefined();
      expect(
        cleanup!.terminated,
        "A must exit because the gate was released, not because cleanup killed it",
      ).toEqual([]);
      expect(cleanup!.leaked).toEqual([]);
      expect(
        Date.now() - started,
        "cleanup must not have waited out the child-exit timeout",
      ).toBeLessThan(CHILD_EXIT_MS);

      // A was released and both children were reaped, despite the throw.
      expect(
        await sql(`SELECT count(*) FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid()
                      AND query LIKE '%MARK_GATE_CLEANUP%'
                      AND query NOT LIKE '%pg_stat_activity%'`),
        "no child session may survive the gate",
      ).toBe("0");
      expect(
        await sql(`SELECT count(*) FROM pg_locks
                    WHERE locktype='advisory' AND classid=0 AND objid=${key}`),
        "the advisory lock must be gone",
      ).toBe("0");
      expect(
        await sql(`SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                    WHERE NOT l.granted AND a.datname = current_database()
                      AND a.pid <> pg_backend_pid()`),
        "no ungranted lock may remain",
      ).toBe("0");
      expect(
        await sql(`SELECT count(*) FROM public.test_barrier_release WHERE k='gate-cleanup'`),
        "the barrier row must be dropped",
      ).toBe("0");

      // And the database is still usable: A committed, so the receipt posted once.
      expect(
        await sql(`SELECT count(*) FROM public.inventory_movements
                     WHERE source_document_id='${rid}'`),
      ).toBe("1");
    }, 90_000);

    test("a child that will not exit on its own is terminated by cleanup", async () => {
      const key = 918_053_102;

      // This child ignores the gate entirely and would outlive the scenario.
      // Cleanup must kill it rather than wait for Bun's outer timeout.
      const report = await withGate(
        "gate-kill",
        key,
        async (gate) => {
          const stuck = gate.start("stuck", `SELECT pg_sleep(600);`);
          await gate.started(stuck);
          expect(
            await gate.exitedWithin(stuck, 250),
            "the stuck child must still be running when the body ends",
          ).toBeNull();
        },
        { allowTermination: true },
      );

      expect(report.terminated, "cleanup must have terminated the stuck child")
        .toEqual(["stuck"]);
      expect(report.leaked, "termination must not leave anything behind").toEqual([]);

      expect(
        await sql(`SELECT count(*) FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid()
                      AND query LIKE '%MARK_GATE_KILL%'
                      AND query NOT LIKE '%pg_stat_activity%'`),
        "the terminated child must leave no backend behind",
      ).toBe("0");
      expect(
        await sql(`SELECT count(*) FROM public.test_barrier_release WHERE k='gate-kill'`),
      ).toBe("0");
    }, 90_000);
  });
});
