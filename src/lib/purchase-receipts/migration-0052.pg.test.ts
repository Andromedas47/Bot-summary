/**
 * Real PostgreSQL harness for P2B migration 0052.
 *
 * - Creates a disposable DB and applies bootstrap + 0052 via psql.
 * - Concurrency cases use SEPARATE connections plus a DETERMINISTIC barrier:
 *   the blocking session takes an advisory lock immediately after its mutating
 *   statement, and the test polls pg_locks until that lock is visible before
 *   starting the racing session. Nothing here depends on Promise scheduling or
 *   on a sleep being "long enough".
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
    `P2B 0052 PG tests SKIPPED: PostgreSQL unavailable (${probe.detail}). Tried: ${resolvedPsql ?? "none"}`,
  );
}

describe.skipIf(!pgAvailable)("P2B migration 0052 PostgreSQL", () => {
  const dbName = `p2b_0052_${randomBytes(4).toString("hex")}`;
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

  /**
   * Deterministic barrier: block until `key` is visible as a held advisory lock.
   * The racing session takes it immediately AFTER its mutating statement, so
   * seeing it proves that statement has executed and its transaction is open.
   */
  async function waitForAdvisoryLock(key: number, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const held = await sql(
        `SELECT count(*) FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 0 AND objid = ${key} AND granted`,
      );
      if (Number(held) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(`advisory lock ${key} never appeared within ${timeoutMs}ms`);
      }
      await Bun.sleep(25);
    }
  }

  const ITEM_ONE = `{"product_key":"mango","raw_product_text":"m","quantity":"2.5","unit_key":"kg","raw_unit":"kg","unit_cost":"12.3456"}`;

  function draftSql(
    key: string,
    items: string = `'[${ITEM_ONE}]'::jsonb`,
    extra = `p_source_type=>'group', p_source_id=>'G1'`,
  ): string {
    return `SELECT public.upsert_purchase_receipt_draft(
      'line-text','${key}','p2b-slice-a-v1','2026-07-29', ${items}, ${extra})`;
  }

  async function makeConfirmed(key: string, ck: string): Promise<string> {
    await sql(draftSql(key));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='${key}'`);
    await sql(`SELECT public.confirm_purchase_receipt('${id}','${ck}')`);
    return id;
  }

  test("bootstrap + 0052 apply cleanly on a disposable DB", async () => {
    expect(existsSync(BOOTSTRAP)).toBe(true);
    expect(existsSync(MIGRATION)).toBe(true);

    const create = await runPsql(psqlPath, [
      "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`,
    ]);
    expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
    dbCreated = true;

    const boot = await runPsql(
      psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", BOOTSTRAP], { database: dbName },
    );
    expect(boot.code, `bootstrap failed:\n${boot.stderr}`).toBe(0);

    const mig = await runPsql(
      psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", MIGRATION], { database: dbName },
    );
    expect(mig.code, `migration 0052 failed:\n${mig.stderr}`).toBe(0);
    ready = true;
  }, 60_000);

  // ── Scope guard ───────────────────────────────────────────────────────────

  test("0052 creates no inventory-movement or valuation object", async () => {
    expect(ready).toBe(true);
    const tables = await sql(
      `SELECT coalesce(string_agg(tablename, ',' ORDER BY tablename), '')
         FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(tables.split(",").sort()).toEqual([
      "purchase_receipt_document_namespaces",
      "purchase_receipt_items",
      "purchase_receipt_lifecycle_events",
      "purchase_receipts",
      "raw_messages",
    ]);
    expect(tables).not.toMatch(/movement|ledger|valuation|cogs|stock_/iu);
  });

  test("no 0052 function writes to a movement/valuation or Production table", async () => {
    const bodies = await sql(
      `SELECT coalesce(string_agg(lower(prosrc), ' '), '')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
    );
    expect(bodies).not.toMatch(/insert\s+into\s+public\.(inventory|stock|valuation)/u);
    expect(bodies).not.toMatch(/produce_sessions|physical_inventory|pending_sessions/u);
  });

  test("the frozen contract declares that P2B posts nothing", async () => {
    const id = await makeConfirmed("scope-1", "ck-scope-1");
    const payload = JSON.parse(
      await sql(`SELECT (public.get_purchase_receipt_confirmation('${id}'))->'confirmation'->'payload'`),
    ) as Record<string, unknown>;
    expect(payload.posts_inventory_movement).toBe(false);
    expect(payload.posts_valuation).toBe(false);
    expect(payload.contract_version).toBe("p2b-purchase-confirm-v1");
  });

  // ── 1. Confirmation payload immutability ──────────────────────────────────

  test("every confirmed header field that feeds the payload is immutable", async () => {
    const id = await makeConfirmed("frozen-1", "ck-frozen-1");

    // Exhaustive: every column EXCEPT the documented void/supersede/posting-lock
    // mutable set must be rejected. Derived from the catalog so a column added
    // by a future migration is covered without editing this test.
    // A second confirmed receipt, so supersedes_receipt_id can be pointed at a
    // genuinely different yet FK-valid value.
    const other = await makeConfirmed("frozen-other", "ck-frozen-other");
    // A real raw_messages row so source_raw_message_id can be pointed at a
    // genuinely different yet FK-valid value.
    const rawMessageId = await sql(
      `WITH inserted AS (
         INSERT INTO public.raw_messages (id) VALUES (gen_random_uuid()) RETURNING id
       ) SELECT id::text FROM inserted`,
    );

    const columns = (
      await sql(
        `SELECT string_agg(column_name, ',' ORDER BY column_name)
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='purchase_receipts'
            AND column_name NOT IN ('status','voided_at','voided_by','void_reason',
              'superseded_by_receipt_id','posting_locked_at','posting_locked_by','updated_at',
              -- CHECK pins this to the single value 'MAIN': it has no second
              -- legal value, so it is immutable by construction rather than by
              -- the freeze guard.
              'intended_warehouse_code')`,
      )
    ).split(",");

    expect(columns.length).toBeGreaterThan(25);

    // Every value below genuinely DIFFERS from the confirmed row and is
    // otherwise valid, so the freeze guard is the only thing that can reject it.
    const mutations: Record<string, string> = {
      contract_version: `'other'`,
      business_date: `'2026-01-01'`,
      purchase_time: `'01:02'`,
      supplier_key: `'x'`,
      supplier_raw: `'x'`,
      supplier_ref: `'x'`,
      reference_text: `'x'`,
      freight_satang: `1`,
      handling_satang: `1`,
      discount_satang: `1`,
      vat_kind: `'AMOUNT'`,
      vat_satang: `1`,
      vat_included_in_item_prices: `true`,
      vat_recoverable: `true`,
      item_count: `9`,
      source_type: `'user'`,
      source_id: `'other'`,
      sender_line_user_id: `'other'`,
      source_line_event_id: `'other'`,
      source_raw_message_id: `'${rawMessageId}'::uuid`,
      source_evidence: `'{"a":1}'::jsonb`,
      review_flags: `'[{"code":"x"}]'::jsonb`,
      draft_revision: `99`,
      confirmation_key: `'other'`,
      confirmation_hash: `repeat('b',64)`,
      confirmation_payload: `'{"tampered":true}'::jsonb`,
      confirmation_contract_version: `'v9'`,
      confirmation_canonical_form: `'other'`,
      confirmation_hash_algorithm: `'md5'`,
      confirmed_at: `now()`,
      confirmed_by: `'other'`,
      document_key: `'other'`,
      document_namespace: `'manual-entry'`,
      supersedes_receipt_id: `'${other}'::uuid`,
      created_at: `now() + interval '1 day'`,
      id: `gen_random_uuid()`,
    };

    for (const column of columns) {
      const value = mutations[column];
      expect(value, `no mutation defined for confirmed column ${column}`).toBeDefined();
      const err = await sqlFails(
        `UPDATE public.purchase_receipts SET ${column} = ${value} WHERE id='${id}'`,
      );
      expect(err, `${column} must be frozen after confirmation`).toMatch(
        /is immutable|immutable except for void|document identity is immutable/u,
      );
    }
  }, 120_000);

  test("the stored hash always equals the hash of the stored payload", async () => {
    const id = await makeConfirmed("hash-eq-1", "ck-hash-eq-1");
    const stored = await sql(`SELECT confirmation_hash FROM public.purchase_receipts WHERE id='${id}'`);
    const recomputed = await sql(
      `SELECT encode(extensions.digest(convert_to(
         public.purchase_receipt_canonical_json(
           (SELECT confirmation_payload FROM public.purchase_receipts WHERE id='${id}')), 'UTF8'),
         'sha256'), 'hex')`,
    );
    expect(recomputed).toBe(stored);
  });

  test("confirmed items reject update and delete", async () => {
    const id = await makeConfirmed("frozen-items-1", "ck-frozen-items-1");
    expect(
      await sqlFails(`UPDATE public.purchase_receipt_items SET quantity=99 WHERE receipt_id='${id}'`),
    ).toMatch(/immutable once the receipt leaves draft/u);
    expect(
      await sqlFails(`DELETE FROM public.purchase_receipt_items WHERE receipt_id='${id}'`),
    ).toMatch(/immutable once the receipt leaves draft/u);
    expect(
      await sqlFails(
        `INSERT INTO public.purchase_receipt_items
           (receipt_id,item_ordinal,product_key,raw_product_text,quantity,unit_key,raw_unit)
         VALUES ('${id}',9,'p','p',1,'kg','kg')`,
      ),
    ).toMatch(/immutable once the receipt leaves draft/u);
  });

  test("lifecycle events are append-only", async () => {
    expect(await sqlFails(`UPDATE public.purchase_receipt_lifecycle_events SET actor='x'`))
      .toMatch(/append-only/u);
    expect(await sqlFails(`DELETE FROM public.purchase_receipt_lifecycle_events`))
      .toMatch(/append-only/u);
  });

  // ── 2. Amount overflow contract ───────────────────────────────────────────

  test("a line amount beyond bigint is stored exactly, not overflowed", async () => {
    // Max in-envelope: quantity < 10^12, unit_cost < 10^14 => ~10^28 satang,
    // far beyond bigint's 9.22*10^18. Exact numeric storage is the fix.
    await sql(
      draftSql(
        "ovf-max",
        `'[{"product_key":"p","raw_product_text":"p","quantity":"999999999999.999999","unit_key":"kg","raw_unit":"kg","unit_cost":"99999999999999.9999"}]'::jsonb`,
      ),
    );
    const amount = await sql(
      `SELECT i.line_amount_satang::text FROM public.purchase_receipt_items i
         JOIN public.purchase_receipts r ON r.id=i.receipt_id WHERE r.document_key='ovf-max'`,
    );
    expect(amount).toMatch(/^\d+$/u);
    // Beyond bigint's 9223372036854775807 (19 digits) — a bigint column would
    // have raised "out of range" here instead of storing the value.
    expect(amount.length).toBeGreaterThan(19);
    expect(BigInt(amount) > BigInt("9223372036854775807")).toBe(true);
    // Equals the arithmetic computed independently of the generated column.
    expect(amount).toBe(
      await sql(`SELECT round(999999999999.999999::numeric * 99999999999999.9999::numeric * 100)::text`),
    );
  });

  test("just below the quantity boundary is accepted", async () => {
    await sql(
      draftSql(
        "ovf-just-below",
        `'[{"product_key":"p","raw_product_text":"p","quantity":"999999999999.999999","unit_key":"kg","raw_unit":"kg","unit_cost":"1"}]'::jsonb`,
      ),
    );
    expect(
      await sql(
        `SELECT count(*) FROM public.purchase_receipts WHERE document_key='ovf-just-below'`,
      ),
    ).toBe("1");
  });

  test("at the quantity boundary is rejected with a business error, not an overflow", async () => {
    const err = await sqlFails(
      draftSql(
        "ovf-at",
        `'[{"product_key":"p","raw_product_text":"p","quantity":"1000000000000","unit_key":"kg","raw_unit":"kg","unit_cost":"1"}]'::jsonb`,
      ),
    );
    expect(err).toMatch(/exceeds the documented numeric\(18,6\) envelope/u);
    expect(err).not.toMatch(/out of range|numeric field overflow/iu);
  });

  test("an over-boundary unit cost is rejected with a business error", async () => {
    const err = await sqlFails(
      draftSql(
        "ovf-rate",
        `'[{"product_key":"p","raw_product_text":"p","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_cost":"100000000000000"}]'::jsonb`,
      ),
    );
    expect(err).toMatch(/exceeds the documented numeric\(18,4\) envelope/u);
    expect(err).not.toMatch(/out of range|numeric field overflow/iu);
  });

  test("document money beyond the documented envelope is a named CHECK failure", async () => {
    const err = await sqlFails(draftSql("ovf-doc", `'[${ITEM_ONE}]'::jsonb`,
      `p_freight_satang=>1000000000000000`));
    expect(err).toMatch(/purchase_receipts_freight_envelope/u);
  });

  test("rounding stays exact and half away from zero at satang", async () => {
    await sql(
      draftSql(
        "round-1",
        `'[{"product_key":"p","raw_product_text":"p","quantity":"2.5","unit_key":"kg","raw_unit":"kg","unit_cost":"12.3456"},
           {"product_key":"q","raw_product_text":"q","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_cost":"0.005"}]'::jsonb`,
      ),
    );
    const amounts = await sql(
      `SELECT string_agg(i.line_amount_satang::text, ',' ORDER BY i.item_ordinal)
         FROM public.purchase_receipt_items i JOIN public.purchase_receipts r ON r.id=i.receipt_id
        WHERE r.document_key='round-1'`,
    );
    // 2.5*12.3456*100 = 3086.4 -> 3086 ; 1*0.005*100 = 0.5 -> 1 (away from zero)
    expect(amounts).toBe("3086,1");
  });

  test("line amount is generated and cannot be written directly", async () => {
    const err = await sqlFails(`UPDATE public.purchase_receipt_items SET line_amount_satang = 1`);
    expect(err).toMatch(/generated column|cannot be used/iu);
  });

  // ── 3. Stable document identity ───────────────────────────────────────────

  test("document keys are normalized identically for insert and lookup", async () => {
    await sql(draftSql("  Doc   Space  "));
    expect(
      await sql(`SELECT document_key FROM public.purchase_receipts WHERE document_key='Doc Space'`),
    ).toBe("Doc Space");

    // Whitespace variants resolve to the SAME document, not new ones.
    await sql(draftSql("Doc\tSpace"));
    await sql(draftSql("Doc  Space"));
    expect(
      await sql(`SELECT count(*) FROM public.purchase_receipts WHERE document_key='Doc Space'`),
    ).toBe("1");
  });

  test("a blank or whitespace-only key is refused", async () => {
    expect(await sqlFails(draftSql("   "))).toMatch(/must not be blank/u);
    expect(await sqlFails(draftSql(""))).toMatch(/must not be blank/u);
  });

  test("the same key under a different source binding fails closed", async () => {
    await sql(draftSql("collide-1", `'[${ITEM_ONE}]'::jsonb`, `p_source_type=>'group', p_source_id=>'G1'`));
    const err = await sqlFails(
      draftSql("collide-1", `'[${ITEM_ONE}]'::jsonb`, `p_source_type=>'group', p_source_id=>'G2'`),
    );
    expect(err).toMatch(/different source binding/u);

    // The original document is untouched — no wholesale replacement.
    expect(
      await sql(
        `SELECT source_id FROM public.purchase_receipts WHERE document_key='collide-1'`,
      ),
    ).toBe("G1");
  });

  test("the same key in a different namespace is a different document", async () => {
    await sql(draftSql("ns-shared"));
    await sql(
      `SELECT public.upsert_purchase_receipt_draft('guided-postback','ns-shared','p2b-slice-a-v1',
         '2026-07-29','[${ITEM_ONE}]'::jsonb, p_source_type=>'group', p_source_id=>'G1')`,
    );
    expect(
      await sql(`SELECT count(*) FROM public.purchase_receipts WHERE document_key='ns-shared'`),
    ).toBe("2");
  });

  test("an unregistered namespace is refused", async () => {
    const err = await sqlFails(
      `SELECT public.upsert_purchase_receipt_draft('made-up-ns','x','p2b-slice-a-v1',
         '2026-07-29','[${ITEM_ONE}]'::jsonb)`,
    );
    expect(err).toMatch(/purchase_receipts_document_namespace_fkey|violates foreign key/u);
  });

  test("redelivery keeps identity while updating delivery metadata", async () => {
    await sql(draftSql("redeliver-1", `'[${ITEM_ONE}]'::jsonb`,
      `p_source_type=>'group', p_source_id=>'G1', p_source_line_event_id=>'evt-1'`));
    await sql(draftSql("redeliver-1", `'[${ITEM_ONE}]'::jsonb`,
      `p_source_type=>'group', p_source_id=>'G1', p_source_line_event_id=>'evt-2'`));

    const row = await sql(
      `SELECT source_line_event_id || '|' || draft_revision::text
         FROM public.purchase_receipts WHERE document_key='redeliver-1'`,
    );
    // Delivery id moved; identity did not fork.
    expect(row).toBe("evt-2|2");
    expect(
      await sql(`SELECT count(*) FROM public.purchase_receipts WHERE document_key='redeliver-1'`),
    ).toBe("1");
  });

  test("document identity is immutable even while draft", async () => {
    await sql(draftSql("immutable-id-1"));
    const err = await sqlFails(
      `UPDATE public.purchase_receipts SET document_key='other' WHERE document_key='immutable-id-1'`,
    );
    expect(err).toMatch(/document identity is immutable/u);
  });

  // ── 4. Frozen confirmation snapshot ───────────────────────────────────────

  test("the getter returns the STORED snapshot, not a recomputation", async () => {
    const id = await makeConfirmed("snap-1", "ck-snap-1");
    const returned = await sql(
      `SELECT (public.get_purchase_receipt_confirmation('${id}'))->'confirmation'->'payload'`,
    );
    const stored = await sql(
      `SELECT confirmation_payload FROM public.purchase_receipts WHERE id='${id}'`,
    );
    expect(returned).toBe(stored);

    // Proof it is not recomputed: the stored snapshot is byte-identical to what
    // the hash was taken over, and the live builder is a separate function.
    expect(
      await sql(
        `SELECT (public.purchase_receipt_canonical_json(
           (SELECT confirmation_payload FROM public.purchase_receipts WHERE id='${id}'))
           = public.purchase_receipt_canonical_json(
             (public.get_purchase_receipt_confirmation('${id}'))->'confirmation'->'payload'))::text`,
      ),
    ).toBe("true");
  });

  test("the snapshot carries contract, canonical form and hash algorithm versions", async () => {
    const id = await makeConfirmed("snap-2", "ck-snap-2");
    const envelope = JSON.parse(
      await sql(`SELECT (public.get_purchase_receipt_confirmation('${id}'))->'confirmation'`),
    ) as Record<string, unknown>;
    expect(envelope.contract_version).toBe("p2b-purchase-confirm-v1");
    expect(envelope.canonical_form).toBe("purchase-receipt-canonical-json-v1");
    expect(envelope.hash_algorithm).toBe("sha256");
    expect(envelope.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("each frozen item carries stable identity and evidence", async () => {
    const id = await makeConfirmed("snap-3", "ck-snap-3");
    const item = JSON.parse(
      await sql(
        `SELECT (public.get_purchase_receipt_confirmation('${id}'))->'confirmation'->'payload'->'items'->0`,
      ),
    ) as Record<string, unknown>;

    expect(String(item.receipt_item_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(
      await sql(
        `SELECT count(*) FROM public.purchase_receipt_items WHERE id='${String(item.receipt_item_id)}'`,
      ),
    ).toBe("1");
    // Precision-sensitive numerics stay canonical strings.
    expect(typeof item.quantity).toBe("string");
    expect(typeof item.unit_cost).toBe("string");
    expect(typeof item.line_amount_satang).toBe("string");
    expect(item.source_evidence).toEqual({});
  });

  test("the frozen payload carries source identity", async () => {
    await sql(draftSql("snap-src", `'[${ITEM_ONE}]'::jsonb`,
      `p_source_type=>'group', p_source_id=>'G1', p_source_line_event_id=>'evt-7'`));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='snap-src'`);
    await sql(`SELECT public.confirm_purchase_receipt('${id}','ck-snap-src')`);

    const source = JSON.parse(
      await sql(
        `SELECT (public.get_purchase_receipt_confirmation('${id}'))->'confirmation'->'payload'->'source'`,
      ),
    ) as Record<string, unknown>;
    expect(source.source_id).toBe("G1");
    expect(source.source_line_event_id).toBe("evt-7");
  });

  test("canonical json is key-sorted and stable", async () => {
    expect(await sql(`SELECT public.purchase_receipt_canonical_json('{"b":1,"a":2}'::jsonb)`))
      .toBe('{"a":2,"b":1}');
    // Array order is significant and preserved.
    expect(await sql(`SELECT public.purchase_receipt_canonical_json('[3,1,2]'::jsonb)`))
      .toBe("[3,1,2]");
    // Same logical document written with different key order hashes identically.
    expect(
      await sql(
        `SELECT (public.purchase_receipt_canonical_json('{"a":{"y":1,"x":2}}'::jsonb)
               = public.purchase_receipt_canonical_json('{"a":{"x":2,"y":1}}'::jsonb))::text`,
      ),
    ).toBe("true");
  });

  test("the hash changes when document content changes", async () => {
    await sql(draftSql("hash-2"));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='hash-2'`);
    const before = await sql(`SELECT public.purchase_receipt_canonical_json(
      public.purchase_receipt_build_confirmation_payload('${id}'))`);
    await sql(
      draftSql(
        "hash-2",
        `'[{"product_key":"mango","raw_product_text":"m","quantity":"9.5","unit_key":"kg","raw_unit":"kg","unit_cost":"12.3456"}]'::jsonb`,
      ),
    );
    const after = await sql(`SELECT public.purchase_receipt_canonical_json(
      public.purchase_receipt_build_confirmation_payload('${id}'))`);
    expect(after).not.toBe(before);
  });

  // ── 5. Void / correction / P2C handoff ────────────────────────────────────

  test("the confirmation survives void and reports lifecycle separately", async () => {
    const id = await makeConfirmed("void-1", "ck-void-1");
    const hashBefore = await sql(
      `SELECT (public.get_purchase_receipt_confirmation('${id}'))->'confirmation'->>'hash'`,
    );
    await sql(`SELECT public.void_purchase_receipt('${id}','staff error','tester')`);

    const after = JSON.parse(await sql(`SELECT public.get_purchase_receipt_confirmation('${id}')`)) as
      Record<string, Record<string, unknown>>;
    expect(after.confirmation!.hash).toBe(hashBefore);
    expect(after.lifecycle!.status).toBe("void");
    expect(after.void!.void_reason).toBe("staff error");
    expect((after.confirmation!.payload as Record<string, unknown>).item_count).toBe(1);
  });

  test("a never-confirmed receipt exposes no contract", async () => {
    await sql(draftSql("never-1"));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='never-1'`);
    expect(await sqlFails(`SELECT public.get_purchase_receipt_confirmation('${id}')`))
      .toMatch(/never been confirmed/u);
  });

  test("confirming a correction links both documents", async () => {
    const original = await makeConfirmed("corr-orig", "ck-corr-orig");
    await sql(draftSql("corr-new", `'[${ITEM_ONE}]'::jsonb`,
      `p_source_type=>'group', p_source_id=>'G1', p_supersedes_receipt_id=>'${original}'`));
    const replacement = await sql(
      `SELECT id FROM public.purchase_receipts WHERE document_key='corr-new'`,
    );
    await sql(`SELECT public.confirm_purchase_receipt('${replacement}','ck-corr-new')`);

    expect(
      await sql(`SELECT superseded_by_receipt_id FROM public.purchase_receipts WHERE id='${original}'`),
    ).toBe(replacement);

    const correction = JSON.parse(
      await sql(`SELECT (public.get_purchase_receipt_confirmation('${replacement}'))->'correction'`),
    ) as Record<string, unknown>;
    expect(correction.supersedes_receipt_id).toBe(original);

    expect(
      await sql(
        `SELECT count(*) FROM public.purchase_receipt_lifecycle_events
          WHERE receipt_id='${original}' AND event='superseded'`,
      ),
    ).toBe("1");
  });

  test("a posting lock blocks a standalone void", async () => {
    const id = await makeConfirmed("lock-1", "ck-lock-1");
    await sql(`SELECT public.lock_purchase_receipt_for_posting('${id}','p2c-poster')`);

    const err = await sqlFails(`SELECT public.void_purchase_receipt('${id}','oops')`);
    expect(err).toMatch(/locked for posting/u);
    expect(await sql(`SELECT status FROM public.purchase_receipts WHERE id='${id}'`)).toBe("confirmed");
  });

  test("a posting lock is idempotent and only applies to confirmed receipts", async () => {
    const id = await makeConfirmed("lock-2", "ck-lock-2");
    expect(await sql(`SELECT (public.lock_purchase_receipt_for_posting('${id}','p2c'))->>'replayed'`))
      .toBe("false");
    expect(await sql(`SELECT (public.lock_purchase_receipt_for_posting('${id}','p2c'))->>'replayed'`))
      .toBe("true");

    await sql(draftSql("lock-3"));
    const draftId = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='lock-3'`);
    expect(await sqlFails(`SELECT public.lock_purchase_receipt_for_posting('${draftId}','p2c')`))
      .toMatch(/only a confirmed purchase receipt can be locked/u);
  });

  test("the P2C dedupe identity is exact and hash-bound", async () => {
    const id = await makeConfirmed("dedupe-1", "ck-dedupe-1");
    const row = JSON.parse(await sql(`SELECT public.get_purchase_receipt_confirmation('${id}')`)) as
      Record<string, unknown>;
    const hash = (row.confirmation as Record<string, unknown>).hash as string;
    expect(row.p2c_dedupe_key).toBe(`purchase-receipt-confirmation:v1:${id}:${hash}`);
  });

  // ── 6. Structured blockers ────────────────────────────────────────────────

  test("a missing unit cost is a blocker and never zero", async () => {
    await sql(
      draftSql(
        "blk-cost",
        `'[{"product_key":"p","raw_product_text":"p","quantity":"3","unit_key":"kg","raw_unit":"kg"}]'::jsonb`,
      ),
    );
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='blk-cost'`);
    const payload = JSON.parse(
      await sql(`SELECT public.purchase_receipt_build_confirmation_payload('${id}')`),
    ) as Record<string, unknown>;

    const blockers = payload.blockers as Array<Record<string, unknown>>;
    expect(blockers.map((b) => b.code)).toContain("MISSING_UNIT_COST");
    expect(blockers[0]!.item_ordinals).toEqual([1]);
    expect(payload.has_blocking_blockers).toBe(true);
    // Amount stays null; the total becomes non-computable rather than zero.
    expect((payload.items as Array<Record<string, unknown>>)[0]!.line_amount_satang).toBeNull();
    expect((payload.totals as Record<string, unknown>).line_subtotal_satang).toBeNull();
  });

  test("unresolved product, unit and price-unit identities each raise a blocker", async () => {
    await sql(
      draftSql(
        "blk-ident",
        `'[{"product_key":"raw text","raw_product_text":"raw text","product_identity_status":"UNRESOLVED",
            "quantity":"1","unit_key":"raw unit","raw_unit":"raw unit","unit_identity_status":"UNRESOLVED",
            "unit_cost":"5","price_unit_text":"ลัง","price_unit_status":"UNRESOLVED"}]'::jsonb`,
      ),
    );
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='blk-ident'`);
    const payload = JSON.parse(
      await sql(`SELECT public.purchase_receipt_build_confirmation_payload('${id}')`),
    ) as Record<string, unknown>;
    const codes = (payload.blockers as Array<Record<string, unknown>>).map((b) => b.code);

    expect(codes).toContain("UNRESOLVED_PRODUCT_IDENTITY");
    expect(codes).toContain("UNRESOLVED_UNIT_IDENTITY");
    expect(codes).toContain("UNRESOLVED_PRICE_UNIT");
    expect(payload.has_blocking_blockers).toBe(true);
  });

  test("source review flags surface as a REVIEW blocker", async () => {
    await sql(draftSql("blk-flags", `'[${ITEM_ONE}]'::jsonb`,
      `p_source_type=>'group', p_source_id=>'G1', p_review_flags=>'[{"code":"UNKNOWN_PURCHASE_TIME"}]'::jsonb`));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='blk-flags'`);
    const payload = JSON.parse(
      await sql(`SELECT public.purchase_receipt_build_confirmation_payload('${id}')`),
    ) as Record<string, unknown>;
    const blockers = payload.blockers as Array<Record<string, unknown>>;

    const flagBlocker = blockers.find((b) => b.code === "SOURCE_REVIEW_FLAGS");
    expect(flagBlocker).toBeDefined();
    expect(flagBlocker!.severity).toBe("REVIEW");
    // A review flag alone must not make the document look blocked.
    expect(payload.has_blocking_blockers).toBe(false);
  });

  test("a complete document reports no blockers", async () => {
    const id = await makeConfirmed("blk-none", "ck-blk-none");
    const payload = JSON.parse(
      await sql(`SELECT (public.get_purchase_receipt_confirmation('${id}'))->'confirmation'->'payload'`),
    ) as Record<string, unknown>;
    expect(payload.blockers).toEqual([]);
    expect(payload.has_blocking_blockers).toBe(false);
  });

  // ── 7. Document totals ────────────────────────────────────────────────────

  test("totals expose subtotal, costs and a computed payable total", async () => {
    await sql(draftSql("tot-1", `'[${ITEM_ONE}]'::jsonb`,
      `p_source_type=>'group', p_source_id=>'G1',
       p_freight_satang=>5000, p_handling_satang=>1000, p_discount_satang=>500,
       p_vat_kind=>'AMOUNT', p_vat_satang=>7000,
       p_vat_included_in_item_prices=>false, p_vat_recoverable=>true`));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='tot-1'`);
    const totals = JSON.parse(
      await sql(`SELECT (public.purchase_receipt_build_confirmation_payload('${id}'))->'totals'`),
    ) as Record<string, unknown>;

    expect(totals.line_subtotal_satang).toBe("3086");
    expect(totals.freight_satang).toBe("5000");
    expect(totals.handling_satang).toBe("1000");
    expect(totals.discount_satang).toBe("500");
    expect(totals.vat_satang).toBe("7000");
    // 3086 + 5000 + 1000 - 500 + 7000 (VAT not included in item prices)
    expect(totals.payable_total_satang).toBe("15586");
    // Slice A captures no declared total, so reconciliation is unavailable.
    expect(totals.declared_total_satang).toBeNull();
    expect(totals.reconciliation_status).toBe("COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE");
  });

  test("VAT already included in item prices is not added again", async () => {
    await sql(draftSql("tot-2", `'[${ITEM_ONE}]'::jsonb`,
      `p_source_type=>'group', p_source_id=>'G1',
       p_vat_kind=>'AMOUNT', p_vat_satang=>7000,
       p_vat_included_in_item_prices=>true, p_vat_recoverable=>true`));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='tot-2'`);
    const totals = JSON.parse(
      await sql(`SELECT (public.purchase_receipt_build_confirmation_payload('${id}'))->'totals'`),
    ) as Record<string, unknown>;
    expect(totals.payable_total_satang).toBe("3086");
  });

  test("a missing rate makes totals non-computable rather than wrong", async () => {
    await sql(
      draftSql(
        "tot-3",
        `'[${ITEM_ONE},{"product_key":"q","raw_product_text":"q","quantity":"1","unit_key":"kg","raw_unit":"kg"}]'::jsonb`,
      ),
    );
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='tot-3'`);
    const totals = JSON.parse(
      await sql(`SELECT (public.purchase_receipt_build_confirmation_payload('${id}'))->'totals'`),
    ) as Record<string, unknown>;
    expect(totals.line_subtotal_satang).toBeNull();
    expect(totals.payable_total_satang).toBeNull();
    expect(totals.reconciliation_status).toBe("NOT_COMPUTABLE_MISSING_UNIT_COST");
  });

  // ── 10. Deterministic concurrency ─────────────────────────────────────────

  test("item DML begun while draft cannot commit after the receipt is confirmed", async () => {
    await sql(draftSql("race-item-1"));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='race-item-1'`);
    const LOCK = 811001;

    // Session A mutates an item, then signals by taking an advisory lock and
    // holds its transaction open. The item trigger has already taken the PARENT
    // row lock at this point.
    const a = startScript(
      `BEGIN;
       UPDATE public.purchase_receipt_items SET raw_unit='changed' WHERE receipt_id='${id}';
       SELECT pg_advisory_lock(${LOCK});
       SELECT pg_sleep(2);
       COMMIT;
       SELECT pg_advisory_unlock(${LOCK});`,
    );
    await waitForAdvisoryLock(LOCK);

    // Session B confirms while A still holds the row lock. It must block, not
    // interleave, and must see A's committed content.
    const b = startScript(`SELECT public.confirm_purchase_receipt('${id}','ck-race-item-1')`);
    const [ra, rb] = await Promise.all([collect(a), collect(b)]);

    expect(ra.code, `session A failed: ${ra.stderr}`).toBe(0);
    expect(rb.code, `session B failed: ${rb.stderr}`).toBe(0);

    // The frozen hash must describe the content actually stored.
    const stored = await sql(`SELECT confirmation_hash FROM public.purchase_receipts WHERE id='${id}'`);
    const recomputed = await sql(
      `SELECT encode(extensions.digest(convert_to(
         public.purchase_receipt_canonical_json(
           public.purchase_receipt_build_confirmation_payload('${id}')), 'UTF8'), 'sha256'), 'hex')`,
    );
    expect(recomputed).toBe(stored);
    // A's change committed BEFORE the confirm, so it is inside the snapshot.
    expect(
      await sql(
        `SELECT (public.get_purchase_receipt_confirmation('${id}'))
           ->'confirmation'->'payload'->'items'->0->>'raw_unit'`,
      ),
    ).toBe("changed");
  }, 60_000);

  test("item DML is refused once a confirm committed first", async () => {
    await sql(draftSql("race-item-2"));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='race-item-2'`);
    const LOCK = 811002;

    // A confirms and holds the transaction open.
    const a = startScript(
      `BEGIN;
       SELECT public.confirm_purchase_receipt('${id}','ck-race-item-2');
       SELECT pg_advisory_lock(${LOCK});
       SELECT pg_sleep(2);
       COMMIT;
       SELECT pg_advisory_unlock(${LOCK});`,
    );
    await waitForAdvisoryLock(LOCK);

    // B's item update blocks on the parent lock, then re-reads status=confirmed.
    const b = startScript(
      `UPDATE public.purchase_receipt_items SET raw_unit='late' WHERE receipt_id='${id}'`,
    );
    const [ra, rb] = await Promise.all([collect(a), collect(b)]);

    expect(ra.code, `confirm failed: ${ra.stderr}`).toBe(0);
    expect(rb.code, "late item update must fail").not.toBe(0);
    expect(rb.stderr).toMatch(/immutable once the receipt leaves draft/u);
    expect(await sql(`SELECT raw_unit FROM public.purchase_receipt_items WHERE receipt_id='${id}'`))
      .toBe("kg");
  }, 60_000);

  test("a draft replace racing a confirm serializes on the receipt row", async () => {
    await sql(draftSql("race-draft-confirm"));
    const id = await sql(
      `SELECT id FROM public.purchase_receipts WHERE document_key='race-draft-confirm'`,
    );
    const LOCK = 811003;

    const a = startScript(
      `BEGIN;
       ${draftSql("race-draft-confirm")};
       SELECT pg_advisory_lock(${LOCK});
       SELECT pg_sleep(2);
       COMMIT;
       SELECT pg_advisory_unlock(${LOCK});`,
    );
    await waitForAdvisoryLock(LOCK);

    const b = startScript(`SELECT public.confirm_purchase_receipt('${id}','ck-race-dc')`);
    const [, rb] = await Promise.all([collect(a), collect(b)]);

    // Whether the confirm won or lost, the stored hash must match stored content.
    const status = await sql(`SELECT status FROM public.purchase_receipts WHERE id='${id}'`);
    if (status === "confirmed") {
      expect(rb.code).toBe(0);
      const stored = await sql(`SELECT confirmation_hash FROM public.purchase_receipts WHERE id='${id}'`);
      const recomputed = await sql(
        `SELECT encode(extensions.digest(convert_to(
           public.purchase_receipt_canonical_json(
             public.purchase_receipt_build_confirmation_payload('${id}')), 'UTF8'), 'sha256'), 'hex')`,
      );
      expect(recomputed).toBe(stored);
    }
  }, 60_000);

  test("concurrent first drafts of one document create exactly one receipt", async () => {
    const script = draftSql("race-first-1");
    const [a, b, c] = await Promise.all([
      collect(startScript(script)),
      collect(startScript(script)),
      collect(startScript(script)),
    ]);

    // Every caller must complete safely — none may be left with a broken state.
    for (const [name, r] of [["A", a], ["B", b], ["C", c]] as const) {
      expect(r.code, `first-draft racer ${name} failed: ${r.stderr}`).toBe(0);
    }
    expect(
      await sql(`SELECT count(*) FROM public.purchase_receipts WHERE document_key='race-first-1'`),
    ).toBe("1");
    expect(
      await sql(
        `SELECT count(*) FROM public.purchase_receipt_items i
           JOIN public.purchase_receipts r ON r.id=i.receipt_id WHERE r.document_key='race-first-1'`,
      ),
    ).toBe("1");
  }, 60_000);

  test("concurrent confirms with the same key confirm exactly once", async () => {
    await sql(draftSql("race-confirm-1"));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='race-confirm-1'`);
    const LOCK = 811004;

    const a = startScript(
      `BEGIN;
       SELECT public.confirm_purchase_receipt('${id}','ck-race-1');
       SELECT pg_advisory_lock(${LOCK});
       SELECT pg_sleep(2);
       COMMIT;
       SELECT pg_advisory_unlock(${LOCK});`,
    );
    await waitForAdvisoryLock(LOCK);
    const b = startScript(
      `SELECT (public.confirm_purchase_receipt('${id}','ck-race-1'))->'confirmation'->>'hash'`,
    );
    const [ra, rb] = await Promise.all([collect(a), collect(b)]);

    expect(ra.code, ra.stderr).toBe(0);
    expect(rb.code, rb.stderr).toBe(0);
    expect(
      await sql(
        `SELECT count(*) FROM public.purchase_receipt_lifecycle_events
          WHERE receipt_id='${id}' AND event='confirmed'`,
      ),
    ).toBe("1");
  }, 60_000);

  test("concurrent confirms with different keys let exactly one win", async () => {
    await sql(draftSql("race-confirm-2"));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='race-confirm-2'`);
    const LOCK = 811005;

    const a = startScript(
      `BEGIN;
       SELECT public.confirm_purchase_receipt('${id}','ck-race-2a');
       SELECT pg_advisory_lock(${LOCK});
       SELECT pg_sleep(2);
       COMMIT;
       SELECT pg_advisory_unlock(${LOCK});`,
    );
    await waitForAdvisoryLock(LOCK);
    const b = startScript(`SELECT public.confirm_purchase_receipt('${id}','ck-race-2b')`);
    const [ra, rb] = await Promise.all([collect(a), collect(b)]);

    expect(ra.code, ra.stderr).toBe(0);
    expect(rb.code).not.toBe(0);
    expect(rb.stderr).toMatch(/already confirmed under a different confirmation_key/u);
    expect(
      await sql(
        `SELECT count(*) FROM public.purchase_receipt_lifecycle_events
          WHERE receipt_id='${id}' AND event='confirmed'`,
      ),
    ).toBe("1");
  }, 60_000);

  test("a validation failure rolls back header mutation and item deletion entirely", async () => {
    await sql(
      draftSql(
        "rollback-1",
        `'[{"product_key":"a","raw_product_text":"a","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_cost":"1"},
           {"product_key":"b","raw_product_text":"b","quantity":"2","unit_key":"kg","raw_unit":"kg","unit_cost":"2"}]'::jsonb`,
      ),
    );
    const before = await sql(
      `SELECT r.draft_revision::text || '|' || r.business_date::text || '|' ||
              (SELECT string_agg(i.product_key, ',' ORDER BY i.item_ordinal)
                 FROM public.purchase_receipt_items i WHERE i.receipt_id=r.id)
         FROM public.purchase_receipts r WHERE r.document_key='rollback-1'`,
    );

    // Third item is out of envelope: the RPC has ALREADY updated the header and
    // deleted the items by the time it fails.
    const err = await sqlFails(
      `SELECT public.upsert_purchase_receipt_draft('line-text','rollback-1','p2b-slice-a-v1','2030-01-01',
         '[{"product_key":"x","raw_product_text":"x","quantity":"1","unit_key":"kg","raw_unit":"kg"},
           {"product_key":"y","raw_product_text":"y","quantity":"1","unit_key":"kg","raw_unit":"kg"},
           {"product_key":"z","raw_product_text":"z","quantity":"1000000000000","unit_key":"kg","raw_unit":"kg"}]'::jsonb,
         p_source_type=>'group', p_source_id=>'G1')`,
    );
    expect(err).toMatch(/exceeds the documented/u);

    const after = await sql(
      `SELECT r.draft_revision::text || '|' || r.business_date::text || '|' ||
              (SELECT string_agg(i.product_key, ',' ORDER BY i.item_ordinal)
                 FROM public.purchase_receipt_items i WHERE i.receipt_id=r.id)
         FROM public.purchase_receipts r WHERE r.document_key='rollback-1'`,
    );
    expect(after).toBe(before);
    expect(after).toContain("a,b");
  });

  test("a retry after a lost response commits no second document", async () => {
    // Models timeout-after-commit: the caller never saw the result and retries.
    await sql(draftSql("retry-1"));
    const first = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='retry-1'`);
    await sql(draftSql("retry-1"));
    expect(
      await sql(`SELECT count(*) FROM public.purchase_receipts WHERE document_key='retry-1'`),
    ).toBe("1");

    await sql(`SELECT public.confirm_purchase_receipt('${first}','ck-retry-1')`);
    const hash = await sql(`SELECT confirmation_hash FROM public.purchase_receipts WHERE id='${first}'`);
    // Retried confirm returns the same frozen contract and writes nothing.
    expect(
      await sql(`SELECT (public.confirm_purchase_receipt('${first}','ck-retry-1'))->>'replayed'`),
    ).toBe("true");
    expect(await sql(`SELECT confirmation_hash FROM public.purchase_receipts WHERE id='${first}'`))
      .toBe(hash);
    expect(
      await sql(
        `SELECT count(*) FROM public.purchase_receipt_lifecycle_events
          WHERE receipt_id='${first}' AND event='confirmed'`,
      ),
    ).toBe("1");

    // Void is likewise replay-safe.
    await sql(`SELECT public.void_purchase_receipt('${first}','dupe')`);
    expect(await sql(`SELECT (public.void_purchase_receipt('${first}','dupe'))->>'replayed'`))
      .toBe("true");
    expect(
      await sql(
        `SELECT count(*) FROM public.purchase_receipt_lifecycle_events
          WHERE receipt_id='${first}' AND event='voided'`,
      ),
    ).toBe("1");
  });

  test("no stale item survives a full replacement", async () => {
    await sql(
      draftSql(
        "stale-1",
        `'[{"product_key":"a","raw_product_text":"a","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_cost":"1"},
           {"product_key":"b","raw_product_text":"b","quantity":"2","unit_key":"kg","raw_unit":"kg","unit_cost":"2"},
           {"product_key":"c","raw_product_text":"c","quantity":"3","unit_key":"kg","raw_unit":"kg","unit_cost":"3"}]'::jsonb`,
      ),
    );
    await sql(
      draftSql(
        "stale-1",
        `'[{"product_key":"z","raw_product_text":"z","quantity":"9","unit_key":"kg","raw_unit":"kg","unit_cost":"9"}]'::jsonb`,
      ),
    );
    const rows = await sql(
      `SELECT string_agg(i.product_key || ':' || i.item_ordinal::text, ',' ORDER BY i.item_ordinal)
         FROM public.purchase_receipt_items i JOIN public.purchase_receipts r ON r.id=i.receipt_id
        WHERE r.document_key='stale-1'`,
    );
    expect(rows).toBe("z:1");
    expect(
      await sql(
        `SELECT item_count FROM public.purchase_receipts WHERE document_key='stale-1'`,
      ),
    ).toBe("1");
  });

  test("a blocked writer fails on lock_timeout instead of hanging", async () => {
    await sql(draftSql("deadlock-1"));
    const id = await sql(`SELECT id FROM public.purchase_receipts WHERE document_key='deadlock-1'`);
    const LOCK = 811006;

    const a = startScript(
      `BEGIN;
       UPDATE public.purchase_receipt_items SET raw_unit='held' WHERE receipt_id='${id}';
       SELECT pg_advisory_lock(${LOCK});
       SELECT pg_sleep(4);
       COMMIT;
       SELECT pg_advisory_unlock(${LOCK});`,
    );
    await waitForAdvisoryLock(LOCK);

    const b = startScript(
      `SET lock_timeout = '400ms';
       SELECT public.confirm_purchase_receipt('${id}','ck-deadlock-1')`,
    );
    const [ra, rb] = await Promise.all([collect(a), collect(b)]);

    expect(ra.code, ra.stderr).toBe(0);
    // Bounded failure, not an indefinite wait.
    expect(rb.code).not.toBe(0);
    expect(rb.stderr).toMatch(/lock timeout|canceling statement due to lock timeout/iu);
  }, 60_000);

  // ── RLS and grants ────────────────────────────────────────────────────────

  test("RLS is enabled with no permissive policy on every 0052 table", async () => {
    const rls = await sql(
      `SELECT string_agg(relname || '=' || relrowsecurity::text, ',' ORDER BY relname)
         FROM pg_class WHERE relname LIKE 'purchase_receipt%' AND relkind = 'r'`,
    );
    expect(rls).toBe(
      "purchase_receipt_document_namespaces=true,purchase_receipt_items=true," +
        "purchase_receipt_lifecycle_events=true,purchase_receipts=true",
    );
    expect(
      await sql(
        `SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'purchase_receipt%'`,
      ),
    ).toBe("0");
  });

  test("anon and authenticated hold no table privilege at all", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of [
        "purchase_receipts",
        "purchase_receipt_items",
        "purchase_receipt_lifecycle_events",
        "purchase_receipt_document_namespaces",
      ]) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect(
            await sql(`SELECT has_table_privilege('${role}','public.${table}','${priv}')::text`),
            `${role} must not hold ${priv} on ${table}`,
          ).toBe("false");
        }
      }
    }
  }, 60_000);

  test("anon and authenticated cannot execute any 0052 RPC", async () => {
    for (const role of ["anon", "authenticated"]) {
      const granted = await sql(
        `SELECT coalesce(bool_or(has_function_privilege('${role}', p.oid, 'EXECUTE')), false)::text
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname LIKE '%purchase_receipt%'
            AND p.prorettype <> 'trigger'::regtype::oid`,
      );
      expect(granted, `${role} must not execute any purchase RPC`).toBe("false");
    }
  });

  test("service_role may read but holds no direct table DML", async () => {
    for (const table of [
      "purchase_receipts",
      "purchase_receipt_items",
      "purchase_receipt_lifecycle_events",
      "purchase_receipt_document_namespaces",
    ]) {
      expect(await sql(`SELECT has_table_privilege('service_role','public.${table}','SELECT')::text`))
        .toBe("true");
      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        expect(
          await sql(`SELECT has_table_privilege('service_role','public.${table}','${priv}')::text`),
          `service_role must not hold ${priv} on ${table}`,
        ).toBe("false");
      }
    }
  }, 60_000);

  test("service_role may execute every 0052 RPC", async () => {
    expect(
      await sql(
        `SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))::text
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname LIKE '%purchase_receipt%'
            AND p.prorettype <> 'trigger'::regtype::oid`,
      ),
    ).toBe("true");
  });

  test("every 0052 RPC is SECURITY DEFINER with a pinned search_path", async () => {
    const rows = await sql(
      `SELECT string_agg(p.proname || '=' || p.prosecdef::text || ':' ||
                coalesce(array_to_string(p.proconfig, ' '), 'none'), E'\\n' ORDER BY p.proname)
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE '%purchase_receipt%'
          AND p.prorettype <> 'trigger'::regtype::oid
          AND p.provolatile <> 'i'`,
    );
    const entries = rows.split("\n").filter(Boolean);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      expect(entry, `${entry} must be SECURITY DEFINER`).toMatch(/=true:/u);
      expect(entry, `${entry} must pin search_path`).toMatch(/search_path=/u);
    }
  });

  test("trigger guard functions are NOT security definer", async () => {
    // They must run as the mutating role; DEFINER would be escalation for no gain.
    const rows = await sql(
      `SELECT string_agg(p.proname || '=' || p.prosecdef::text, ',' ORDER BY p.proname)
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prorettype='trigger'::regtype::oid`,
    );
    for (const entry of rows.split(",").filter(Boolean)) {
      expect(entry).toMatch(/=false$/u);
    }
  });

  // ── 11. Cleanup / schema hygiene ──────────────────────────────────────────

  test("jsonb evidence columns are constrained to documented shapes", async () => {
    expect(
      await sqlFails(draftSql("shape-1", `'[${ITEM_ONE}]'::jsonb`, `p_review_flags=>'{"a":1}'::jsonb`)),
    ).toMatch(/review_flags_check|violates check constraint/u);
    expect(
      await sqlFails(draftSql("shape-2", `'[${ITEM_ONE}]'::jsonb`, `p_source_evidence=>'[1]'::jsonb`)),
    ).toMatch(/source_evidence_check|violates check constraint/u);
  });

  test("no redundant index duplicates the items unique constraint", async () => {
    const indexes = await sql(
      `SELECT string_agg(indexdef, E'\\n' ORDER BY indexname)
         FROM pg_indexes WHERE schemaname='public' AND tablename='purchase_receipt_items'`,
    );
    // UNIQUE (receipt_id, item_ordinal) already serves receipt-prefixed lookups.
    const receiptOnly = indexes
      .split("\n")
      .filter((def) => /\(receipt_id, item_ordinal\)/u.test(def));
    expect(receiptOnly).toHaveLength(1);
    expect(receiptOnly[0]).toMatch(/UNIQUE/u);
  });

  afterAll(async () => {
    if (!dbCreated || !resolvedPsql) return;
    await runPsql(resolvedPsql, [
      "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`,
    ]);
  });
});
