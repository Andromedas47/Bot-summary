/**
 * PostgreSQL proof for migration 20260821140000
 * (fix_accountability_round_slip_date_parsing).
 *
 * Pins the 2026-08-21 production incident: unbound slip_date '20/8/2569'
 * must INSERT, and bound slash dates must parse as D/M with Buddhist Era
 * — never via DateStyle.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..", "..", "..");
const bootstrap = join(root, "supabase", "tests", "p2e_accountability_round_bootstrap.sql");
const identity = join(root, "supabase", "migrations", "20260808105001_p2e_accountability_round_identity.sql");
const contract = join(root, "supabase", "migrations", "20260808212137_p2e_accountability_round_identity_contract.sql");
const hotfix = join(root, "supabase", "migrations", "20260821140000_fix_accountability_round_slip_date_parsing.sql");
const psql = existsSync("C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe")
  ? "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe"
  : "psql";
const env = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "localhost",
  PGUSER: process.env.PGUSER ?? "postgres",
  PGPASSWORD: process.env.PGPASSWORD ?? "postgres",
  PGPORT: process.env.PGPORT ?? "5432",
  PGCLIENTENCODING: "UTF8",
};

async function run(args: string[], database = "postgres") {
  const proc = Bun.spawn([psql, "-q", ...args], {
    cwd: root,
    env: { ...env, PGDATABASE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

const probe = await run(["-v", "ON_ERROR_STOP=1", "-tAc", "SELECT 1"]).catch((error) => ({
  code: 1,
  stdout: "",
  stderr: String(error),
}));
const available = probe.code === 0;
if (!available && process.env.REQUIRE_P2E_POSTGRES === "1") {
  throw new Error(`slip-date round-guard PostgreSQL is required: ${probe.stderr}`);
}

describe.skipIf(!available)("accountability-round slip_date parsing hotfix", () => {
  const db = `slipdate_${randomBytes(4).toString("hex")}`;
  let created = false;

  async function sql(statement: string) {
    const result = await run(["-v", "ON_ERROR_STOP=1", "-tAc", statement], db);
    if (result.code !== 0) throw new Error(`${result.stderr}\n${statement}`);
    return result.stdout;
  }
  async function fails(statement: string, pattern: RegExp) {
    const result = await run(["-v", "ON_ERROR_STOP=1", "-tAc", statement], db);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(pattern);
  }
  async function apply(file: string) {
    const result = await run(["-v", "ON_ERROR_STOP=1", "-f", file], db);
    expect(result.code, `${file}\n${result.stderr}`).toBe(0);
  }

  test("unbound Thai slash dates insert and bound dates parse as D/M", async () => {
    expect((await run(["-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${db}`])).code).toBe(0);
    created = true;
    await apply(bootstrap);
    await apply(identity);
    await apply(contract);
    await sql(`ALTER TABLE public.slip_batches ALTER COLUMN slip_date TYPE text USING slip_date::text`);

    // Production bug: DECLARE ::date throws before the unbound early-return.
    // DateStyle must be set in the same session as the INSERT.
    await fails(
      `SET DateStyle TO 'ISO, MDY';
       INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date)
       VALUES ('G1','group','U1','Seller','Market','20/8/2569')`,
      /date\/time field value out of range/i,
    );

    await apply(hotfix);
    await apply(hotfix);

    expect(await sql(`SET DateStyle TO 'ISO, MDY'; SELECT public.parse_accountability_artifact_date('20/8/2569')`)).toBe("2026-08-20");
    expect(await sql(`SET DateStyle TO 'ISO, MDY'; SELECT public.parse_accountability_artifact_date('11/8/2569')`)).toBe("2026-08-11");
    expect(await sql(`SET DateStyle TO 'ISO, MDY'; SELECT public.parse_accountability_artifact_date('20/8/2026')`)).toBe("2026-08-20");
    expect(await sql(`SET DateStyle TO 'ISO, MDY'; SELECT public.parse_accountability_artifact_date('2026-08-20')`)).toBe("2026-08-20");
    expect(await sql(`SET DateStyle TO 'ISO, MDY'; SELECT public.parse_accountability_artifact_date('2569-08-20')`)).toBe("2026-08-20");
    expect(await sql(`SET DateStyle TO 'ISO, MDY'; SELECT public.parse_accountability_artifact_date('2201-01-01')`)).toBe("2201-01-01");
    expect(await sql(`SET DateStyle TO 'SQL, MDY'; SELECT public.parse_accountability_artifact_date('11/8/2569') = DATE '2026-08-11'`)).toBe("t");
    expect(await sql(`SET DateStyle TO 'ISO, DMY'; SELECT public.parse_accountability_artifact_date('11/8/2569') = DATE '2026-08-11'`)).toBe("t");
    expect(await sql(`SET DateStyle TO 'ISO, MDY'; SELECT public.parse_accountability_artifact_date('11/8/2569') = DATE '2026-11-08'`)).toBe("f");
    await fails(`SELECT public.parse_accountability_artifact_date('31/2/2569')`, /P2E: artifact date is invalid/);
    await fails(`SELECT public.parse_accountability_artifact_date('8/20/2569')`, /P2E: artifact date is invalid/);

    // CASE 1 — exact production incident
    expect(await sql(
      `INSERT INTO slip_batches(id,source_id,source_type,sender_id,seller_name,market_name,slip_date)
       VALUES ('10000000-0000-4000-8000-000000000001','G1','group','U1','พี่ดำ','วัดตะกล่ำ','20/8/2569')
       RETURNING slip_date`,
    )).toBe("20/8/2569");

    // CASE 8 — unbound malformed legacy text is not the round guard's job
    expect(await sql(
      `INSERT INTO slip_batches(id,source_id,source_type,sender_id,seller_name,market_name,slip_date)
       VALUES ('10000000-0000-4000-8000-000000000008','G1','group','U1','Seller','Market','23/6/69')
       RETURNING slip_date`,
    )).toBe("23/6/69");

    const aug20 = await sql(`INSERT INTO accountability_rounds(
      source_type,source_id,owner_line_user_id,business_date,seller_label,market_label,market_label_normalized,created_line_event_id)
      VALUES ('group','G1','U1','2026-08-20','Seller','Market','Market','evt-aug20') RETURNING id`);
    const aug11 = await sql(`INSERT INTO accountability_rounds(
      source_type,source_id,owner_line_user_id,business_date,seller_label,market_label,market_label_normalized,created_line_event_id)
      VALUES ('group','G1','U1','2026-08-11','Seller','Market','Market','evt-aug11') RETURNING id`);
    const nov8 = await sql(`INSERT INTO accountability_rounds(
      source_type,source_id,owner_line_user_id,business_date,seller_label,market_label,market_label_normalized,created_line_event_id)
      VALUES ('group','G1','U1','2026-11-08','Seller','Market','Market','evt-nov8') RETURNING id`);

    // CASE 2 — bound Thai date day > 12
    expect(await sql(
      `INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U1','Seller','Market','20/8/2569','${aug20}') RETURNING slip_date`,
    )).toBe("20/8/2569");

    // CASE 3 — bound Gregorian slash
    expect(await sql(
      `INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U1','Seller','Market','20/8/2026','${aug20}') RETURNING slip_date`,
    )).toBe("20/8/2026");

    // CASE 4 — ISO
    expect(await sql(
      `INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U1','Seller','Market','2026-08-20','${aug20}') RETURNING slip_date`,
    )).toBe("2026-08-20");

    // CASE 5 — day/month is not swapped, even under production DateStyle MDY
    expect(await sql(
      `SET DateStyle TO 'ISO, MDY';
       INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U1','Seller','Market','11/8/2569','${aug11}') RETURNING slip_date`,
    )).toBe("11/8/2569");
    await fails(
      `SET DateStyle TO 'ISO, MDY';
       INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U1','Seller','Market','11/8/2569','${nov8}')`,
      /artifact business date does not match/i,
    );

    // CASE 6 — real mismatch
    await fails(
      `INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U1','Seller','Market','21/8/2569','${aug20}')`,
      /artifact business date does not match/i,
    );

    // CASE 7 — invalid calendar date fail-closed, no March overflow
    await fails(
      `INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U1','Seller','Market','31/2/2569','${aug20}')`,
      /P2E: artifact date is invalid/,
    );

    await fails(
      `INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U1','Other','Market','20/8/2569','${aug20}')`,
      /artifact seller does not match/i,
    );
    await fails(
      `INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G2','group','U1','Seller','Market','20/8/2569','${aug20}')`,
      /artifact source does not match/i,
    );
    await fails(
      `INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id)
       VALUES ('G1','group','U2','Seller','Market','20/8/2569','${aug20}')`,
      /artifact owner does not match/i,
    );

    await sql(`INSERT INTO settlement_entries(settlement_date,settlement_time,staff_name,market_name,source_id,accountability_round_id)
      VALUES ('2026-08-20','10:00','Seller','Market','G1','${aug20}')`);
    await fails(
      `INSERT INTO settlement_entries(settlement_date,settlement_time,staff_name,market_name,source_id,accountability_round_id)
       VALUES ('2026-08-21','11:00','Seller','Market','G1','${aug20}')`,
      /artifact business date does not match/i,
    );
    await sql(`INSERT INTO transfer_reconciliations(source_id,business_date,accountability_round_id)
      VALUES ('G1','2026-08-20','${aug20}')`);
    await fails(
      `INSERT INTO transfer_reconciliations(source_id,business_date,accountability_round_id)
       VALUES ('G1','2026-08-21','${aug11}')`,
      /artifact business date does not match/i,
    );
    await sql(`INSERT INTO digital_white_sheet_cash_entries(source_id,market_label_normalized,business_date,accountability_round_id)
      VALUES ('G1','Market','2026-08-20','${aug20}')`);
    await sql(`INSERT INTO manual_slip_sessions(source_id,business_date,market_label,market_key,opened_by_line_user_id,accountability_round_id)
      VALUES ('G1','2026-08-20','Market','Market','U1','${aug20}')`);

    expect(await sql(`
      SELECT string_agg(c.relname, ',' ORDER BY c.relname)
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE p.proname = 'assert_accountability_round_artifact' AND NOT t.tgisinternal
    `)).toBe([
      "digital_white_sheet_cash_entries",
      "manual_slip_sessions",
      "manual_white_sheet_note_sessions",
      "settlement_entries",
      "settlement_finalizations",
      "slip_batches",
      "slip_evidences",
      "transfer_reconciliations",
    ].join(","));
    expect(await sql(`SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE p.proname = 'assert_accountability_round_artifact' AND c.relname IN ('pending_sessions','produce_sessions')`)).toBe("0");

    expect(await sql(`SELECT has_function_privilege('anon','public.parse_accountability_artifact_date(text)','EXECUTE')`)).toBe("f");
    expect(await sql(`SELECT has_function_privilege('authenticated','public.parse_accountability_artifact_date(text)','EXECUTE')`)).toBe("f");
    expect(await sql(`SELECT has_function_privilege('service_role','public.parse_accountability_artifact_date(text)','EXECUTE')`)).toBe("t");
    expect(await sql(`SELECT has_function_privilege('anon','public.assert_accountability_round_artifact()','EXECUTE')`)).toBe("f");

    expect(await sql(`SET ROLE service_role; INSERT INTO slip_batches(source_id,source_type,sender_id,seller_name,market_name,slip_date)
      VALUES ('G1','group','U1','พี่ดำ','วัดตะกล่ำ','20/8/2569') RETURNING slip_date; RESET ROLE`)).toBe("20/8/2569");
  }, 60_000);

  afterAll(async () => {
    if (created) await run(["-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE ${db} WITH (FORCE)`]);
  });
});
