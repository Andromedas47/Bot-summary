/**
 * Real PostgreSQL harness for P2B migration 0052.
 *
 * - Creates a disposable DB and applies bootstrap + 0052 via psql.
 * - Runs REAL multi-connection concurrency cases (>=2 independent psql processes).
 * - Asserts the RLS/grant posture: anon/authenticated see and do nothing;
 *   service_role reads but cannot write except through the DEFINER RPCs.
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
const MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "0052_purchase_receipt_persistence.sql",
);

type PsqlResult = { code: number; stdout: string; stderr: string };

function resolvePsql(): string | null {
  if (existsSync(WIN_PSQL)) return WIN_PSQL;
  return "psql";
}

async function runPsql(
  psql: string,
  args: string[],
  opts?: { database?: string },
): Promise<PsqlResult> {
  const proc = Bun.spawn([psql, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: opts?.database ?? "postgres",
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

async function probeConnection(psql: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await runPsql(psql, [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "postgres",
      "-tAc",
      "SELECT 1",
    ]);
    if (r.code !== 0) {
      return {
        ok: false,
        detail: `psql exit ${r.code}: ${(r.stderr || r.stdout).trim() || "no output"}`,
      };
    }
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function psqlScalar(psql: string, database: string, sql: string): Promise<string> {
  const r = await runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sql], {
    database,
  });
  if (r.code !== 0) {
    throw new Error(`psqlScalar failed: ${r.stderr || r.stdout}\nSQL: ${sql}`);
  }
  return (r.stdout || "").trim();
}

/** Runs SQL expected to FAIL; returns the error text. */
async function psqlExpectFailure(
  psql: string,
  database: string,
  sql: string,
): Promise<string> {
  const r = await runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sql], {
    database,
  });
  if (r.code === 0) {
    throw new Error(`expected failure but SQL succeeded:\n${sql}\n${r.stdout}`);
  }
  return (r.stderr || r.stdout).trim();
}

/** Two independent psql processes (two DB connections). */
async function concurrentPsql(
  psql: string,
  database: string,
  sqlA: string,
  sqlB: string,
): Promise<[PsqlResult, PsqlResult]> {
  return Promise.all([
    runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sqlA], { database }),
    runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sqlB], { database }),
  ]);
}

const ITEMS_ONE = `'[{"product_key":"mango","raw_product_text":"m","quantity":"2.5","unit_key":"kg","raw_unit":"kg","unit_cost":"12.3456"}]'::jsonb`;

function draftSql(draftKey: string, items: string = ITEMS_ONE): string {
  return `SELECT public.upsert_purchase_receipt_draft(
    '${draftKey}','p2b-slice-a-v1','2026-07-29', ${items})`;
}

const resolvedPsql = resolvePsql();
const probe = resolvedPsql
  ? await probeConnection(resolvedPsql)
  : { ok: false, detail: "psql binary not found" };

const pgAvailable = Boolean(resolvedPsql && probe.ok);
const pgSkipReason = pgAvailable
  ? null
  : `SKIPPED: PostgreSQL unavailable (${probe.detail}). Tried: ${resolvedPsql ?? "none"}`;

if (pgSkipReason) {
  console.warn(`P2B 0052 PG tests ${pgSkipReason}`);
}

describe.skipIf(!pgAvailable)("P2B migration 0052 PostgreSQL", () => {
  const dbName = `p2b_0052_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;
  let ready = false;

  test("bootstrap + 0052 apply cleanly on a disposable DB", async () => {
    expect(existsSync(BOOTSTRAP)).toBe(true);
    expect(existsSync(MIGRATION)).toBe(true);

    const create = await runPsql(psqlPath, [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "postgres",
      "-c",
      `CREATE DATABASE ${dbName}`,
    ]);
    expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
    dbCreated = true;

    const boot = await runPsql(
      psqlPath,
      ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", BOOTSTRAP],
      { database: dbName },
    );
    expect(boot.code, `bootstrap failed:\n${boot.stderr}`).toBe(0);

    const mig = await runPsql(
      psqlPath,
      ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", MIGRATION],
      { database: dbName },
    );
    expect(mig.code, `migration 0052 failed:\n${mig.stderr}`).toBe(0);
    ready = true;
  }, 60_000);

  // ── Scope guard: P2B writes documents, not stock ──────────────────────────

  test("0052 creates no inventory-movement or valuation object", async () => {
    expect(ready).toBe(true);

    const tables = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT coalesce(string_agg(tablename, ','), '')
         FROM pg_tables WHERE schemaname = 'public'`,
    );
    const created = tables.split(",").filter(Boolean).sort();
    // raw_messages is the bootstrap FK stub, not part of 0052.
    expect(created).toEqual([
      "purchase_receipt_items",
      "purchase_receipt_lifecycle_events",
      "purchase_receipts",
      "raw_messages",
    ]);
    expect(tables).not.toMatch(/movement|ledger|valuation|cogs|stock_/iu);
  });

  test("no 0052 function writes to a movement/valuation table", async () => {
    const bodies = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT coalesce(string_agg(lower(prosrc), ' '), '')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'`,
    );
    expect(bodies).not.toMatch(/insert\s+into\s+public\.(inventory|stock|valuation)/u);
    expect(bodies).not.toMatch(/produce_sessions|physical_inventory|pending_sessions/u);
  });

  test("the confirmation contract declares that it posts nothing", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("scope-1"));
    const payload = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT public.purchase_receipt_confirmation_payload(
         (SELECT id FROM public.purchase_receipts WHERE draft_key='scope-1'))::text`,
    );
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.posts_inventory_movement).toBe(false);
    expect(parsed.posts_valuation).toBe(false);
    expect(parsed.contract_version).toBe("p2b-purchase-confirm-v1");
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  test("draft -> confirmed -> void is the only legal path", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("life-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='life-1'`,
    );

    expect(
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT (public.confirm_purchase_receipt('${id}','ck-life-1',1))->>'status'`,
      ),
    ).toBe("confirmed");

    expect(
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT (public.void_purchase_receipt('${id}','staff error'))->>'status'`,
      ),
    ).toBe("void");

    // void is terminal.
    const err = await psqlExpectFailure(
      psqlPath,
      dbName,
      `UPDATE public.purchase_receipts SET status='draft' WHERE id='${id}'`,
    );
    expect(err).toMatch(/terminal and immutable/u);
  });

  test("a confirmed receipt cannot be edited", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("frozen-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='frozen-1'`,
    );
    await psqlScalar(
      psqlPath,
      dbName,
      `SELECT public.confirm_purchase_receipt('${id}','ck-frozen-1',1)`,
    );

    const headerErr = await psqlExpectFailure(
      psqlPath,
      dbName,
      `UPDATE public.purchase_receipts SET business_date='2026-01-01' WHERE id='${id}'`,
    );
    expect(headerErr).toMatch(/immutable except for void/u);

    const itemErr = await psqlExpectFailure(
      psqlPath,
      dbName,
      `UPDATE public.purchase_receipt_items SET quantity=99 WHERE receipt_id='${id}'`,
    );
    expect(itemErr).toMatch(/immutable once the receipt leaves draft/u);

    const deleteErr = await psqlExpectFailure(
      psqlPath,
      dbName,
      `DELETE FROM public.purchase_receipt_items WHERE receipt_id='${id}'`,
    );
    expect(deleteErr).toMatch(/immutable once the receipt leaves draft/u);
  });

  test("a confirmed receipt cannot be re-drafted", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("redraft-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='redraft-1'`,
    );
    await psqlScalar(
      psqlPath,
      dbName,
      `SELECT public.confirm_purchase_receipt('${id}','ck-redraft-1',1)`,
    );

    const err = await psqlExpectFailure(psqlPath, dbName, draftSql("redraft-1"));
    expect(err).toMatch(/can no longer be drafted/u);
  });

  test("a receipt with no items cannot be confirmed", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("empty-1", `'[]'::jsonb`));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='empty-1'`,
    );
    const err = await psqlExpectFailure(
      psqlPath,
      dbName,
      `SELECT public.confirm_purchase_receipt('${id}','ck-empty-1')`,
    );
    expect(err).toMatch(/has no items/u);
  });

  test("lifecycle events are append-only", async () => {
    const err = await psqlExpectFailure(
      psqlPath,
      dbName,
      `UPDATE public.purchase_receipt_lifecycle_events SET actor='x'`,
    );
    expect(err).toMatch(/append-only/u);
  });

  test("redelivered draft replaces items instead of appending", async () => {
    const twoItems = `'[{"product_key":"a","raw_product_text":"a","quantity":"1","unit_key":"kg","raw_unit":"kg"},
                        {"product_key":"b","raw_product_text":"b","quantity":"2","unit_key":"kg","raw_unit":"kg"}]'::jsonb`;
    await psqlScalar(psqlPath, dbName, draftSql("replace-1", twoItems));
    await psqlScalar(psqlPath, dbName, draftSql("replace-1", twoItems));
    await psqlScalar(psqlPath, dbName, draftSql("replace-1", twoItems));

    const count = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT count(*) FROM public.purchase_receipt_items i
         JOIN public.purchase_receipts r ON r.id = i.receipt_id
        WHERE r.draft_key='replace-1'`,
    );
    expect(count).toBe("2");

    const receipts = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT count(*) FROM public.purchase_receipts WHERE draft_key='replace-1'`,
    );
    expect(receipts).toBe("1");
  });

  // ── Money and identity ────────────────────────────────────────────────────

  test("line amount is derived, not caller-supplied", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("money-1"));
    // 2.5 * 12.3456 * 100 = 3086.4 -> 3086 (half away from zero at satang)
    expect(
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT i.line_amount_satang FROM public.purchase_receipt_items i
           JOIN public.purchase_receipts r ON r.id=i.receipt_id
          WHERE r.draft_key='money-1'`,
      ),
    ).toBe("3086");

    const err = await psqlExpectFailure(
      psqlPath,
      dbName,
      `UPDATE public.purchase_receipt_items SET line_amount_satang = 1`,
    );
    expect(err).toMatch(/generated column|cannot be used/iu);
  });

  test("a missing unit rate yields a NULL line amount, never zero", async () => {
    await psqlScalar(
      psqlPath,
      dbName,
      draftSql(
        "norate-1",
        `'[{"product_key":"x","raw_product_text":"x","quantity":"3","unit_key":"kg","raw_unit":"kg"}]'::jsonb`,
      ),
    );
    const amount = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT coalesce(i.line_amount_satang::text,'NULL') FROM public.purchase_receipt_items i
         JOIN public.purchase_receipts r ON r.id=i.receipt_id WHERE r.draft_key='norate-1'`,
    );
    expect(amount).toBe("NULL");

    const payload = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT public.purchase_receipt_confirmation_payload(
         (SELECT id FROM public.purchase_receipts WHERE draft_key='norate-1'))::text`,
    );
    // The contract reports the gap rather than silently valuing it at zero.
    expect(JSON.parse(payload).items_missing_unit_cost_count).toBe(1);
  });

  test("zero VAT must be declared NONE, not AMOUNT 0", async () => {
    const err = await psqlExpectFailure(
      psqlPath,
      dbName,
      `SELECT public.upsert_purchase_receipt_draft('vat-bad','p2b-slice-a-v1','2026-07-29',
         ${ITEMS_ONE}, p_vat_kind=>'AMOUNT', p_vat_satang=>0,
         p_vat_included_in_item_prices=>true, p_vat_recoverable=>true)`,
    );
    expect(err).toMatch(/purchase_receipts_vat_shape/u);
  });

  test("supplier identity text must be paired", async () => {
    const err = await psqlExpectFailure(
      psqlPath,
      dbName,
      `SELECT public.upsert_purchase_receipt_draft('sup-bad','p2b-slice-a-v1','2026-07-29',
         ${ITEMS_ONE}, p_supplier_key=>'acme')`,
    );
    expect(err).toMatch(/purchase_receipts_supplier_pairing/u);
  });

  test("a receipt may confirm with no supplier known", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("nosup-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='nosup-1'`,
    );
    expect(
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT (public.confirm_purchase_receipt('${id}','ck-nosup-1'))->>'status'`,
      ),
    ).toBe("confirmed");
  });

  test("document exceeding 500 lines is rejected", async () => {
    const many = `(SELECT jsonb_agg(jsonb_build_object(
        'product_key','p','raw_product_text','p','quantity','1','unit_key','kg','raw_unit','kg'))
      FROM generate_series(1,501))`;
    const err = await psqlExpectFailure(psqlPath, dbName, draftSql("big-1", many));
    expect(err).toMatch(/500-line document limit/u);
  });

  // ── Confirmation contract stability ───────────────────────────────────────

  test("the confirmation hash is stable across repeated computation", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("hash-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='hash-1'`,
    );
    const a = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT public.purchase_receipt_confirmation_hash('${id}')`,
    );
    const b = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT public.purchase_receipt_confirmation_hash('${id}')`,
    );
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).toBe(b);
  });

  test("the confirmation hash changes when document content changes", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("hash-2"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='hash-2'`,
    );
    const before = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT public.purchase_receipt_confirmation_hash('${id}')`,
    );
    await psqlScalar(
      psqlPath,
      dbName,
      draftSql(
        "hash-2",
        `'[{"product_key":"mango","raw_product_text":"m","quantity":"9.5","unit_key":"kg","raw_unit":"kg","unit_cost":"12.3456"}]'::jsonb`,
      ),
    );
    const after = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT public.purchase_receipt_confirmation_hash('${id}')`,
    );
    expect(after).not.toBe(before);
  });

  test("contract exposes items ordered by ordinal with string numerics", async () => {
    const items = `'[{"product_key":"b","raw_product_text":"b","quantity":"1.5","unit_key":"kg","raw_unit":"kg","unit_cost":"2"},
                     {"product_key":"a","raw_product_text":"a","quantity":"2","unit_key":"kg","raw_unit":"kg","unit_cost":"3"}]'::jsonb`;
    await psqlScalar(psqlPath, dbName, draftSql("order-1", items));
    const payload = JSON.parse(
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.purchase_receipt_confirmation_payload(
           (SELECT id FROM public.purchase_receipts WHERE draft_key='order-1'))::text`,
      ),
    ) as { items: Array<Record<string, unknown>> };

    expect(payload.items.map((i) => i.item_ordinal)).toEqual([1, 2]);
    expect(payload.items.map((i) => i.product_key)).toEqual(["b", "a"]);
    // Numerics are strings: nothing crosses the boundary as a float.
    expect(typeof payload.items[0]!.quantity).toBe("string");
    expect(typeof payload.items[0]!.line_amount_satang).toBe("string");
  });

  test("the contract is only readable for a confirmed receipt", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("read-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='read-1'`,
    );
    const err = await psqlExpectFailure(
      psqlPath,
      dbName,
      `SELECT public.get_purchase_receipt_confirmation('${id}')`,
    );
    expect(err).toMatch(/only confirmed receipts expose a confirmation contract/u);
  });

  // ── Concurrency (real, multi-connection) ──────────────────────────────────

  test("concurrent first drafts of one document create exactly one receipt", async () => {
    const sql = draftSql("race-draft-1");
    const [a, b] = await concurrentPsql(psqlPath, dbName, sql, sql);
    expect(
      a.code === 0 || b.code === 0,
      `both concurrent drafts failed:\n${a.stderr}\n${b.stderr}`,
    ).toBe(true);

    const receipts = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT count(*) FROM public.purchase_receipts WHERE draft_key='race-draft-1'`,
    );
    expect(receipts).toBe("1");

    // Neither racer may leave duplicate lines behind.
    const items = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT count(*) FROM public.purchase_receipt_items i
         JOIN public.purchase_receipts r ON r.id=i.receipt_id
        WHERE r.draft_key='race-draft-1'`,
    );
    expect(items).toBe("1");
  }, 30_000);

  test("concurrent confirms with the SAME key confirm exactly once", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("race-confirm-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='race-confirm-1'`,
    );
    const sql = `SELECT (public.confirm_purchase_receipt('${id}','ck-race-1'))->>'confirmation_hash'`;
    const [a, b] = await concurrentPsql(psqlPath, dbName, sql, sql);

    expect(a.code, `confirm A failed: ${a.stderr}`).toBe(0);
    expect(b.code, `confirm B failed: ${b.stderr}`).toBe(0);
    // Both callers observe the identical frozen contract.
    expect(a.stdout.trim()).toBe(b.stdout.trim());
    expect(a.stdout.trim()).toMatch(/^[0-9a-f]{64}$/u);

    expect(
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*) FROM public.purchase_receipt_lifecycle_events
          WHERE receipt_id='${id}' AND event='confirmed'`,
      ),
    ).toBe("1");
  }, 30_000);

  test("concurrent confirms with DIFFERENT keys let exactly one win", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("race-confirm-2"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='race-confirm-2'`,
    );
    const [a, b] = await concurrentPsql(
      psqlPath,
      dbName,
      `SELECT public.confirm_purchase_receipt('${id}','ck-race-2a')`,
      `SELECT public.confirm_purchase_receipt('${id}','ck-race-2b')`,
    );

    const succeeded = [a, b].filter((r) => r.code === 0).length;
    expect(succeeded, `expected exactly one winner\nA:${a.stderr}\nB:${b.stderr}`).toBe(1);
    const loser = a.code === 0 ? b : a;
    expect(loser.stderr).toMatch(/already confirmed under a different confirmation_key/u);

    expect(
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*) FROM public.purchase_receipt_lifecycle_events
          WHERE receipt_id='${id}' AND event='confirmed'`,
      ),
    ).toBe("1");
  }, 30_000);

  test("a draft moving under a confirm is refused by the revision check", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("race-rev-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='race-rev-1'`,
    );
    // Caller read revision 1, then the document was redrafted to revision 2.
    await psqlScalar(psqlPath, dbName, draftSql("race-rev-1"));

    const err = await psqlExpectFailure(
      psqlPath,
      dbName,
      `SELECT public.confirm_purchase_receipt('${id}','ck-race-rev-1',1)`,
    );
    expect(err).toMatch(/draft_revision moved/u);
  });

  test("concurrent draft and confirm never produce a confirmed-but-edited document", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("race-mix-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='race-mix-1'`,
    );
    await concurrentPsql(
      psqlPath,
      dbName,
      `SELECT public.confirm_purchase_receipt('${id}','ck-race-mix-1')`,
      draftSql("race-mix-1"),
    );

    // Whichever order they landed in, the stored hash must still describe the
    // stored content — a confirmed document can never have drifted from its hash.
    const status = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT status FROM public.purchase_receipts WHERE id='${id}'`,
    );
    if (status === "confirmed") {
      const stored = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT confirmation_hash FROM public.purchase_receipts WHERE id='${id}'`,
      );
      const recomputed = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.purchase_receipt_confirmation_hash('${id}')`,
      );
      expect(recomputed).toBe(stored);
    }
  }, 30_000);

  test("concurrent voids record exactly one void event", async () => {
    await psqlScalar(psqlPath, dbName, draftSql("race-void-1"));
    const id = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT id FROM public.purchase_receipts WHERE draft_key='race-void-1'`,
    );
    const sql = `SELECT public.void_purchase_receipt('${id}','dupe')`;
    const [a, b] = await concurrentPsql(psqlPath, dbName, sql, sql);

    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*) FROM public.purchase_receipt_lifecycle_events
          WHERE receipt_id='${id}' AND event='voided'`,
      ),
    ).toBe("1");
  }, 30_000);

  // ── RLS and grants ────────────────────────────────────────────────────────

  test("RLS is enabled with no permissive policy on every 0052 table", async () => {
    const rls = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT string_agg(relname || '=' || relrowsecurity::text, ',' ORDER BY relname)
         FROM pg_class WHERE relname IN
           ('purchase_receipts','purchase_receipt_items','purchase_receipt_lifecycle_events')`,
    );
    expect(rls).toBe(
      "purchase_receipt_items=true,purchase_receipt_lifecycle_events=true,purchase_receipts=true",
    );

    const policies = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT count(*) FROM pg_policies WHERE schemaname='public'
        AND tablename LIKE 'purchase_receipt%'`,
    );
    expect(policies).toBe("0");
  });

  test("anon and authenticated hold no table privilege at all", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of [
        "purchase_receipts",
        "purchase_receipt_items",
        "purchase_receipt_lifecycle_events",
      ]) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect(
            await psqlScalar(
              psqlPath,
              dbName,
              `SELECT has_table_privilege('${role}','public.${table}','${priv}')::text`,
            ),
            `${role} must not hold ${priv} on ${table}`,
          ).toBe("false");
        }
      }
    }
  });

  test("anon and authenticated cannot execute any 0052 RPC", async () => {
    const fns = [
      "public.upsert_purchase_receipt_draft",
      "public.confirm_purchase_receipt",
      "public.void_purchase_receipt",
      "public.get_purchase_receipt_confirmation",
      "public.purchase_receipt_confirmation_payload",
      "public.purchase_receipt_confirmation_hash",
    ];
    for (const role of ["anon", "authenticated"]) {
      for (const fn of fns) {
        const granted = await psqlScalar(
          psqlPath,
          dbName,
          `SELECT bool_or(has_function_privilege('${role}', p.oid, 'EXECUTE'))::text
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname || '.' || p.proname = '${fn}'`,
        );
        expect(granted, `${role} must not execute ${fn}`).toBe("false");
      }
    }
  });

  test("service_role may read but holds no direct table DML", async () => {
    for (const table of [
      "purchase_receipts",
      "purchase_receipt_items",
      "purchase_receipt_lifecycle_events",
    ]) {
      expect(
        await psqlScalar(
          psqlPath,
          dbName,
          `SELECT has_table_privilege('service_role','public.${table}','SELECT')::text`,
        ),
      ).toBe("true");

      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        expect(
          await psqlScalar(
            psqlPath,
            dbName,
            `SELECT has_table_privilege('service_role','public.${table}','${priv}')::text`,
          ),
          `service_role must not hold ${priv} on ${table}`,
        ).toBe("false");
      }
    }
  });

  test("service_role may execute every 0052 RPC", async () => {
    const fns = [
      "upsert_purchase_receipt_draft",
      "confirm_purchase_receipt",
      "void_purchase_receipt",
      "get_purchase_receipt_confirmation",
    ];
    for (const fn of fns) {
      expect(
        await psqlScalar(
          psqlPath,
          dbName,
          `SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))::text
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='${fn}'`,
        ),
        `service_role must execute ${fn}`,
      ).toBe("true");
    }
  });

  test("every 0052 RPC is SECURITY DEFINER with a pinned search_path", async () => {
    // Newline-separated: a pinned search_path itself contains commas.
    // Trigger guards are excluded — they are asserted NOT to be DEFINER below.
    const rows = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT string_agg(p.proname || '=' || p.prosecdef::text || ':' ||
                (coalesce(array_to_string(p.proconfig, ' '), 'none')), E'\\n' ORDER BY p.proname)
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public'
          AND p.proname LIKE '%purchase_receipt%'
          AND p.prorettype <> 'trigger'::regtype::oid`,
    );
    const entries = rows.split("\n").filter(Boolean);
    expect(entries.length).toBe(6);
    for (const entry of entries) {
      expect(entry, `${entry} must be SECURITY DEFINER`).toMatch(/=true:/u);
      expect(entry, `${entry} must pin search_path`).toMatch(/search_path=/u);
    }
  });

  test("the trigger guard functions are NOT security definer", async () => {
    // Trigger guards must run as the mutating role; DEFINER there would be a
    // privilege-escalation surface with no benefit.
    const rows = await psqlScalar(
      psqlPath,
      dbName,
      `SELECT string_agg(p.proname || '=' || p.prosecdef::text, ',' ORDER BY p.proname)
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prorettype='trigger'::regtype::oid`,
    );
    for (const entry of rows.split(",").filter(Boolean)) {
      expect(entry).toMatch(/=false$/u);
    }
  });

  afterAll(async () => {
    if (!dbCreated || !resolvedPsql) return;
    await runPsql(resolvedPsql, [
      "-d",
      "postgres",
      "-c",
      `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`,
    ]);
  });
});
