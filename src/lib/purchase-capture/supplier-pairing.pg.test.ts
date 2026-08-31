/**
 * Regression: P2C Production UAT 2026-08-08 — a normal LINE purchase document
 * whose header declares `ผู้ขาย: <text>` failed to persist with
 *
 *   new row for relation "purchase_receipts" violates check constraint
 *   "purchase_receipts_supplier_pairing"
 *
 * leaving the capture session stuck at `closing` with no receipt and no
 * inventory movement. The parser adapter emitted supplier_raw with a NULL
 * supplier_key; 0052 requires `(supplier_key IS NULL) = (supplier_raw IS NULL)`.
 *
 * The document below is the verbatim UAT text: Thai supplier name, one item
 * resolving to a real product/unit, zero costs, no VAT. It is driven through
 * the REAL parser and the REAL adapter, and the resulting draft is written by
 * the REAL upsert_purchase_receipt_draft on a disposable PostgreSQL database —
 * the same RPC receipt-service.saveDraft calls in Production, and the same one
 * replace_purchase_capture_draft delegates to on the recheck path.
 *
 * Harness (psql resolution, probeConnection, REQUIRE_POSTGRES_TESTS hard-fail,
 * describe.skipIf, temp DB naming, psqlScalar, sqlLiteral) follows
 * integration-slice-c2.pg.test.ts — see that file for the harness's commentary.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import {
  buildPurchaseReceiptDraftInput,
  parsePurchaseCaptureAssembly,
  type PurchaseCaptureParseContext,
} from "./parser-adapter";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const REQUIRE_POSTGRES_TESTS = process.env.REQUIRE_POSTGRES_TESTS === "1";

const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BOOTSTRAP = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_b_bootstrap.sql");
const MIGRATION_0052 = join(REPO_ROOT, "supabase", "migrations", "20260729084558_purchase_receipt_persistence.sql");

/** Verbatim Production UAT document (2026-08-08 10:40, UAT-001). */
const UAT_DOCUMENT = [
  `เริ่มซื้อ 8/8/2569 10:40
ผู้ขาย: ร้านทดสอบ UAT
ใบอ้างอิง: UAT-001
ปลายทาง: MAIN`,
  `ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 10 โล
ราคา: 85 บาท/โล`,
  `สรุปค่าใช้จ่ายซื้อ
ค่าขนส่ง: 0 บาท
ค่าจัดการ: 0 บาท
ส่วนลด: 0 บาท
ภาษีมูลค่าเพิ่ม: ไม่มี`,
  "ปิดซื้อ 1 รายการ",
].join("\n\n");

const UAT_SUPPLIER = "ร้านทดสอบ UAT";

/** Registries that resolve the UAT item, so no identity blocker masks the bug. */
const products = new Map([
  ["หมอนทอง", { raw_product_text: "หมอนทอง", product_key: "durian-monthong", active: true }],
]);
const units = new Map([["โล", { raw_unit_text: "โล", unit_key: "kg", active: true }]]);

const context: PurchaseCaptureParseContext = {
  sourceType: "group",
  sourceId: "G-uat-supplier",
  senderLineUserId: "U-uat-supplier",
  openedLineEventId: "evt-uat-supplier-open",
};

function buildUatDraft() {
  const assembly = parsePurchaseCaptureAssembly(
    [
      {
        line_event_id: context.openedLineEventId,
        line_timestamp_ms: 1786000000000,
        kind: "item" as const,
        raw_text: UAT_DOCUMENT,
        ingest_ordinal: 1,
        line_message_id: "msg-uat-supplier",
        raw_message_id: null,
      },
    ],
    context,
  );
  const draft = buildPurchaseReceiptDraftInput({
    assembly,
    context,
    products,
    units,
    latestLineEventId: context.openedLineEventId,
  });
  if (!draft) throw new Error("UAT fixture must assemble a COMPLETE document");
  return draft;
}

type PsqlResult = { code: number; stdout: string; stderr: string };

function resolvePsql(): string | null {
  if (existsSync(WIN_PSQL)) return WIN_PSQL;
  return "psql";
}

async function runPsql(
  psql: string,
  args: string[],
  database?: string,
  stdinSql?: string,
): Promise<PsqlResult> {
  const proc = Bun.spawn([psql, ...args], {
    cwd: REPO_ROOT,
    // Thai never travels through argv: on Windows the process command line is
    // transcoded to the ANSI codepage and every Thai character becomes '?'.
    // SQL carrying Thai is fed on stdin, which psql reads as PGCLIENTENCODING.
    ...(stdinSql === undefined ? {} : { stdin: new TextEncoder().encode(stdinSql) }),
    // Thai supplier text is the whole point of this file: pin the client
    // encoding so a Windows console codepage cannot silently mangle it to '?'.
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGCLIENTENCODING: "UTF8",
      PGDATABASE: database ?? "postgres",
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
    const r = await runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-tAc", "SELECT 1"]);
    if (r.code !== 0) {
      return { ok: false, detail: `psql exit ${r.code}: ${(r.stderr || r.stdout).trim() || "no output"}` };
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
  console.warn(`Purchase supplier pairing PG tests SKIPPED: PostgreSQL unavailable (${probe.detail})`);
}
if (REQUIRE_POSTGRES_TESTS && !pgAvailable) {
  throw new Error(
    `PostgreSQL tests are required but unavailable at ${PGHOST}:${PGPORT}: ${probe.detail}`,
  );
}

describe.skipIf(!pgAvailable)("LINE purchase supplier pairing (real PostgreSQL)", () => {
  const dbName = `pc_supplier_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;

  async function psqlScalar(sql: string): Promise<string> {
    const r = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tA"], dbName, sql);
    if (r.code !== 0) throw new Error(`psqlScalar failed: ${r.stderr || r.stdout}\nSQL: ${sql}`);
    return (r.stdout || "").trim();
  }

  beforeAll(async () => {
    const create = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`]);
    expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
    dbCreated = true;

    for (const file of [BOOTSTRAP, MIGRATION_0052]) {
      const result = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", file], dbName);
      expect(result.code, `${file} failed:\n${result.stderr}\n${result.stdout}`).toBe(0);
    }
  }, 300_000);

  afterAll(async () => {
    if (!dbCreated) return;
    await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`]);
  });

  /** Drives the adapter's draft through the RPC Production actually calls. */
  async function saveUatDraft(documentKey: string): Promise<string> {
    const draft = buildUatDraft();
    const items = draft.items.map((item) => ({
      product_key: item.productKey,
      raw_product_text: item.rawProductText,
      product_identity_status: item.productIdentityStatus ?? "RESOLVED",
      quantity: item.quantity,
      unit_key: item.unitKey,
      raw_unit: item.rawUnit,
      unit_identity_status: item.unitIdentityStatus ?? "RESOLVED",
      unit_cost: item.unitCost ?? null,
      price_unit_text: item.priceUnitText ?? null,
      price_unit_status: item.priceUnitStatus ?? "NOT_APPLICABLE",
      item_number: item.itemNumber ?? null,
      source_evidence: item.sourceEvidence ?? {},
    }));
    const supplierKeyArg = draft.supplierKey == null ? "NULL" : sqlLiteral(draft.supplierKey);
    const supplierRawArg = draft.supplierRaw == null ? "NULL" : sqlLiteral(draft.supplierRaw);

    return psqlScalar(
      `SELECT (public.upsert_purchase_receipt_draft(
         'line-text', ${sqlLiteral(documentKey)}, ${sqlLiteral(draft.contractVersion)},
         ${sqlLiteral(draft.businessDate)}::date,
         ${sqlLiteral(JSON.stringify(items))}::jsonb,
         p_purchase_time => ${draft.purchaseTime == null ? "NULL" : `${sqlLiteral(draft.purchaseTime)}::time`},
         p_supplier_key => ${supplierKeyArg},
         p_supplier_raw => ${supplierRawArg},
         p_reference_text => ${draft.referenceText == null ? "NULL" : sqlLiteral(draft.referenceText)},
         p_source_type => 'group',
         p_source_id => ${sqlLiteral(context.sourceId)},
         p_sender_line_user_id => ${sqlLiteral(context.senderLineUserId)}
       )->>'receipt_id')`,
    );
  }

  test("the UAT document persists with a paired supplier_key and supplier_raw", async () => {
    // Fails on the pre-fix adapter with:
    //   violates check constraint "purchase_receipts_supplier_pairing"
    const receiptId = await saveUatDraft(context.openedLineEventId);
    expect(receiptId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await psqlScalar(
      `SELECT supplier_key || '|' || supplier_raw || '|' || item_count::text
         FROM public.purchase_receipts WHERE id = ${sqlLiteral(receiptId)}::uuid`,
    );
    expect(row).toBe(`${UAT_SUPPLIER}|${UAT_SUPPLIER}|1`);

    // No movement is posted by the document layer — 0052 is document-only.
    expect(
      await psqlScalar(
        `SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(receiptId)}::uuid`,
      ),
    ).toBe("draft");
  });

  test("redraft of the same document is idempotent on supplier identity", async () => {
    // The retry path for the stuck Production session: same document, same key.
    const first = await saveUatDraft("evt-uat-supplier-retry");
    const second = await saveUatDraft("evt-uat-supplier-retry");
    expect(second).toBe(first);
    expect(
      await psqlScalar(
        `SELECT count(DISTINCT supplier_key)::text FROM public.purchase_receipts
          WHERE document_key = 'evt-uat-supplier-retry'`,
      ),
    ).toBe("1");
  });

  test("the frozen confirmation snapshot carries the supplier pair", async () => {
    const receiptId = await saveUatDraft("evt-uat-supplier-confirm");
    const revision = await psqlScalar(
      `SELECT draft_revision::text FROM public.purchase_receipts WHERE id = ${sqlLiteral(receiptId)}::uuid`,
    );
    await psqlScalar(
      `SELECT public.confirm_purchase_receipt(
         ${sqlLiteral(receiptId)}::uuid, 'confirm-uat-supplier', ${revision}::bigint, 'actor-uat'
       )::text`,
    );
    const snapshot = await psqlScalar(
      `SELECT (confirmation_payload->>'supplier_key') || '|' || (confirmation_payload->>'supplier_raw')
         FROM public.purchase_receipts WHERE id = ${sqlLiteral(receiptId)}::uuid`,
    );
    expect(snapshot).toBe(`${UAT_SUPPLIER}|${UAT_SUPPLIER}`);
  });
});
