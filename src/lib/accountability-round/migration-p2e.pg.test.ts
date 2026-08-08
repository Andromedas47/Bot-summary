import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..", "..", "..");
const bootstrap = join(root, "supabase", "tests", "p2e_accountability_round_bootstrap.sql");
const migration = join(root, "supabase", "migrations", "20260808105001_p2e_accountability_round_identity.sql");
const psql = existsSync("C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe") ? "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe" : "psql";
const env = { ...process.env, PGHOST: process.env.PGHOST ?? "localhost", PGUSER: process.env.PGUSER ?? "postgres", PGPASSWORD: process.env.PGPASSWORD ?? "postgres", PGPORT: process.env.PGPORT ?? "5432", PGCLIENTENCODING: "UTF8" };

async function run(args: string[], database = "postgres") {
  const proc = Bun.spawn([psql, ...args], { cwd: root, env: { ...env, PGDATABASE: database }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

const probe = await run(["-v", "ON_ERROR_STOP=1", "-tAc", "SELECT 1"]).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
const available = probe.code === 0;
if (!available && process.env.REQUIRE_P2E_POSTGRES === "1") throw new Error(`P2E PostgreSQL is required: ${probe.stderr}`);

describe.skipIf(!available)("P2E accountability-round migration", () => {
  const db = `p2e_${randomBytes(4).toString("hex")}`;
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
  async function open(opts: { key: string; event: string; type?: string; kind?: string; declared?: string | null; additional?: string | null; round?: string | null; source?: string; owner?: string }) {
    const unicode: Record<string, string> = {
      "เบิก": "U&'\\0E40\\0E1A\\0E34\\0E01'",
      "เบิกเพิ่ม": "U&'\\0E40\\0E1A\\0E34\\0E01\\0E40\\0E1E\\0E34\\0E48\\0E21'",
      "คืน": "U&'\\0E04\\0E37\\0E19'",
      "คืนเสีย": "U&'\\0E04\\0E37\\0E19\\0E40\\0E2A\\0E35\\0E22'",
      "เพิ่ม": "U&'\\0E40\\0E1E\\0E34\\0E48\\0E21'",
    };
    const q = (value: string | null | undefined) => value == null ? "NULL" : (unicode[value] ?? `'${value}'`);
    return JSON.parse(await sql(`SELECT public.open_accountability_round_produce_session(
      p_session_key=>'${opts.key}', p_source_type=>'group', p_source_id=>'${opts.source ?? "G1"}',
      p_line_user_id=>'${opts.owner ?? "U1"}', p_opened_line_event_id=>'${opts.event}',
      p_line_timestamp_ms=>1, p_command_contract_version=>1, p_business_date=>'2026-08-08',
      p_transaction_time=>'08:00', p_transaction_time_source=>'operator', p_staff_label=>'Seller',
      p_market_label=>'Market', p_market_label_normalized=>'Market', p_session_kind=>'${opts.kind ?? "main"}',
      p_initial_transaction_type=>${q(opts.type ?? "เบิก")}, p_declared_transaction_type=>${q(opts.declared)},
      p_additional_opener=>${q(opts.additional)}, p_accountability_round_id=>${q(opts.round)}::uuid)`)) as {
        outcome: string; session_generation: string; accountability_round_id: string;
      };
  }

  test("keeps same-description rounds and every bound artifact isolated", async () => {
    expect((await run(["-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${db}`])).code).toBe(0);
    created = true;
    expect((await run(["-v", "ON_ERROR_STOP=1", "-f", bootstrap], db)).code).toBe(0);
    const applied = await run(["-v", "ON_ERROR_STOP=1", "-f", migration], db);
    expect(applied.code, applied.stderr).toBe(0);

    const a = await open({ key: "main-a", event: "event-a" });
    const retry = await open({ key: "main-a", event: "event-a" });
    const b = await open({ key: "main-b", event: "event-b" });
    expect(a.accountability_round_id).toBe(retry.accountability_round_id);
    expect(a.accountability_round_id).not.toBe(b.accountability_round_id);
    expect(await sql(`SELECT count(*) FROM accountability_rounds WHERE source_id='G1' AND business_date='2026-08-08' AND seller_label='Seller' AND market_label_normalized='Market'`)).toBe("2");

    const continuations = await Promise.all([
      open({ key: "add-1", event: "add-1", kind: "additional", type: "เบิกเพิ่ม", declared: "เบิก", additional: "เพิ่ม", round: a.accountability_round_id }),
      open({ key: "add-2", event: "add-2", kind: "additional", type: "เบิกเพิ่ม", declared: "เบิก", additional: "เพิ่ม", round: a.accountability_round_id }),
      open({ key: "return", event: "return", type: "คืน", round: a.accountability_round_id }),
      open({ key: "damage", event: "damage", type: "คืนเสีย", round: a.accountability_round_id }),
    ]);
    expect(new Set(continuations.map((x) => x.accountability_round_id))).toEqual(new Set([a.accountability_round_id]));
    await fails(`SELECT public.open_accountability_round_produce_session('bad','group','G1','U1','bad',1,1,'2026-08-08','08:00','operator','Seller','Market','Market','main',U&'\\0E04\\0E37\\0E19')`, /explicit round/i);
    await fails(`SELECT public.open_accountability_round_produce_session('wrong','group','G2','U1','wrong',1,1,'2026-08-08','08:00','operator','Seller','Market','Market','main',U&'\\0E04\\0E37\\0E19',NULL,NULL,NULL,'${a.accountability_round_id}')`, /identity mismatch/i);
    await fails(`SELECT public.open_accountability_round_produce_session('wrong-owner','group','G1','U2','wrong-owner',1,1,'2026-08-08','08:00','operator','Seller','Market','Market','main',U&'\\0E04\\0E37\\0E19',NULL,NULL,NULL,'${a.accountability_round_id}')`, /identity mismatch/i);

    await sql(`INSERT INTO pending_sessions(session_key,source_type,source_id,line_user_id,opened_line_event_id,line_timestamp_ms,command_contract_version,business_date,transaction_time,transaction_time_source,staff_label,market_label,market_label_normalized,session_kind,initial_transaction_type,entry_origin)
      VALUES ('legacy','group','G1','U1','legacy',1,1,'2026-08-08','08:00','legacy','Seller','Market','Market','main','เบิก','legacy')`);
    expect(await sql(`SELECT accountability_round_id IS NULL FROM pending_sessions WHERE session_key='legacy'`)).toBe("t");

    await sql(`INSERT INTO raw_messages(id,source_id,line_user_id) VALUES ('10000000-0000-4000-8000-000000000001','G1','U1')`);
    const rows = [["main-a", a], ["add-1", continuations[0]], ["add-2", continuations[1]], ["return", continuations[2]], ["damage", continuations[3]]] as const;
    for (const [key, opened] of rows) await sql(`INSERT INTO produce_sessions(raw_message_id,line_user_id,staff_name,session_date,session_title,ingest_idempotency_key)
      VALUES ('10000000-0000-4000-8000-000000000001','U1','Seller','2026-08-08','Market','${key}:${opened.session_generation}')`);
    expect(await sql(`SELECT count(*) FROM produce_sessions WHERE accountability_round_id='${a.accountability_round_id}'`)).toBe("5");

    const session = await sql(`SELECT id FROM produce_sessions WHERE ingest_idempotency_key='main-a:${a.session_generation}'`);
    await sql(`INSERT INTO inventory_movements(movement_type,business_date,source_document_type,source_document_id,source_document_version,dedupe_key,accountability_round_id)
      VALUES ('ISSUE','2026-08-08','produce_session','${session}','v1','issue-a','${a.accountability_round_id}')`);
    const issue = await sql(`SELECT id FROM inventory_movements WHERE dedupe_key='issue-a'`);
    await fails(`INSERT INTO inventory_movements(movement_type,business_date,source_document_type,source_document_id,source_document_version,dedupe_key,accountability_round_id)
      VALUES ('ISSUE','2026-08-08','produce_session','${session}','v1','issue-cross','${b.accountability_round_id}')`, /another accountability round/i);
    await sql(`INSERT INTO inventory_movements(movement_type,business_date,source_document_type,source_document_id,source_document_version,dedupe_key,reversal_of_movement_id)
      VALUES ('REVERSAL','2026-08-08','inventory_movement','${issue}','v1','reverse-a','${issue}')`);
    expect(await sql(`SELECT accountability_round_id FROM inventory_movements WHERE dedupe_key='reverse-a'`)).toBe(a.accountability_round_id);
    await fails(`UPDATE inventory_movements SET accountability_round_id='${b.accountability_round_id}' WHERE dedupe_key='reverse-a'`, /differs|write-once/i);
    await sql(`INSERT INTO inventory_movements(movement_type,business_date,source_document_type,source_document_id,source_document_version,dedupe_key)
      VALUES ('PURCHASE_RECEIPT','2026-08-08','purchase_receipt',gen_random_uuid(),'v1','legacy-receipt')`);

    await sql(`INSERT INTO slip_batches(id,source_id,source_type,sender_id,seller_name,market_name,slip_date,accountability_round_id) VALUES
      ('20000000-0000-4000-8000-000000000001','G1','group','U1','Seller','Market','2026-08-08','${a.accountability_round_id}'),
      ('20000000-0000-4000-8000-000000000002','G1','group','U1','Seller','Market','2026-08-08','${b.accountability_round_id}')`);
    await sql(`INSERT INTO slip_evidences(raw_message_id,line_message_id,source_id,source_type,line_user_id,storage_path,sha256,batch_id)
      VALUES ('10000000-0000-4000-8000-000000000001','slip-a','G1','group','U1','a','a','20000000-0000-4000-8000-000000000001')`);
    expect(await sql(`SELECT accountability_round_id FROM slip_evidences WHERE line_message_id='slip-a'`)).toBe(a.accountability_round_id);
    await fails(`INSERT INTO slip_evidences(raw_message_id,line_message_id,source_id,source_type,line_user_id,storage_path,sha256,batch_id,accountability_round_id)
      VALUES ('10000000-0000-4000-8000-000000000001','slip-cross','G1','group','U1','x','x','20000000-0000-4000-8000-000000000001','${b.accountability_round_id}')`, /rounds differ/i);

    await sql(`INSERT INTO manual_slip_sessions(source_id,business_date,market_label,market_key,opened_by_line_user_id,accountability_round_id)
      VALUES ('G1','2026-08-08','Market','Market','U1','${a.accountability_round_id}')`);
    await sql(`INSERT INTO digital_white_sheet_cash_entries(source_id,market_label_normalized,business_date) VALUES ('G1','Market','2026-08-08')`);
    await sql(`INSERT INTO manual_white_sheet_note_sessions(source_id,market_label,market_label_normalized,business_date,opened_by_line_user_id,opened_line_event_id,accountability_round_id)
      VALUES ('G1','Market','Market','2026-08-08','U1','white-a','${a.accountability_round_id}')`);
    await sql(`UPDATE manual_white_sheet_note_sessions SET status='closed' WHERE opened_line_event_id='white-a'`);
    expect(await sql(`SELECT accountability_round_id FROM digital_white_sheet_cash_entries`)).toBe(a.accountability_round_id);
    await sql(`INSERT INTO digital_white_sheet_cash_entries(source_id,market_label_normalized,business_date,actual_cash_submitted,accountability_round_id)
      VALUES ('G1','Market','2026-08-08',222,'${b.accountability_round_id}')`);
    expect(await sql(`SELECT count(DISTINCT accountability_round_id) FROM digital_white_sheet_cash_entries`)).toBe("2");

    await sql(`INSERT INTO settlement_entries(settlement_date,settlement_time,staff_name,market_name,source_id,accountability_round_id) VALUES
      ('2026-08-08','10:00','Seller','Market','G1','${a.accountability_round_id}'),
      ('2026-08-08','10:00','Seller','Market','G1','${b.accountability_round_id}')`);
    await sql(`INSERT INTO settlement_finalizations(source_id,business_date,accountability_round_id) VALUES
      ('G1','2026-08-08','${a.accountability_round_id}'),
      ('G1','2026-08-08','${b.accountability_round_id}')`);
    await sql(`INSERT INTO transfer_reconciliations(source_id,business_date,accountability_round_id) VALUES
      ('G1','2026-08-08','${a.accountability_round_id}'),
      ('G1','2026-08-08','${b.accountability_round_id}')`);
    expect(await sql(`SELECT count(DISTINCT accountability_round_id) FROM settlement_entries`)).toBe("2");
    expect(await sql(`SELECT count(DISTINCT accountability_round_id) FROM settlement_finalizations`)).toBe("2");
    expect(await sql(`SELECT count(DISTINCT accountability_round_id) FROM transfer_reconciliations`)).toBe("2");
    await sql(`INSERT INTO settlement_entries(settlement_date,settlement_time,staff_name,market_name,source_id,money_cash,accountability_round_id)
      VALUES ('2026-08-08','10:00','Seller','Market','G1',11,'${a.accountability_round_id}')
      ON CONFLICT (settlement_date,settlement_time,staff_name,market_name,accountability_round_id)
      DO UPDATE SET money_cash=EXCLUDED.money_cash`);
    expect(await sql(`SELECT money_cash FROM settlement_entries WHERE accountability_round_id='${a.accountability_round_id}'`)).toBe("11");
    await sql(`INSERT INTO transfer_reconciliations(source_id,business_date,ai_verified_total,accountability_round_id)
      VALUES ('G1','2026-08-08',11,'${a.accountability_round_id}')
      ON CONFLICT (source_id,business_date,accountability_round_id)
      DO UPDATE SET ai_verified_total=EXCLUDED.ai_verified_total`);
    expect(await sql(`SELECT ai_verified_total FROM transfer_reconciliations WHERE accountability_round_id='${a.accountability_round_id}'`)).toBe("11");
    await sql(`UPDATE settlement_entries SET money_cash=10 WHERE accountability_round_id='${a.accountability_round_id}'`);
    await fails(`UPDATE settlement_entries SET accountability_round_id='${b.accountability_round_id}' WHERE settlement_time='10:00'`, /write-once/i);

    const [c1, c2] = await Promise.all([open({ key: "concurrent", event: "concurrent" }), open({ key: "concurrent", event: "concurrent" })]);
    expect(c1.accountability_round_id).toBe(c2.accountability_round_id);
    expect(await sql(`SELECT count(*) FROM accountability_rounds WHERE created_line_event_id='concurrent'`)).toBe("1");
    await sql(`SELECT public.close_accountability_round('${a.accountability_round_id}','G1','U1','close-a')`);
    expect(await sql(`SELECT status FROM accountability_rounds WHERE id='${a.accountability_round_id}'`)).toBe("closed");
    await fails(`SELECT public.open_accountability_round_produce_session('after-close','group','G1','U1','after-close',1,1,'2026-08-08','08:00','operator','Seller','Market','Market','main',U&'\\0E04\\0E37\\0E19',NULL,NULL,NULL,'${a.accountability_round_id}')`, /identity mismatch/i);
    expect(await sql(`SELECT relrowsecurity FROM pg_class WHERE oid='accountability_rounds'::regclass`)).toBe("t");
    expect(await sql(`SELECT relrowsecurity FROM pg_class WHERE oid='settlement_entries'::regclass`)).toBe("t");
    expect(await sql(`SELECT has_table_privilege('anon','settlement_entries','SELECT')::text || has_table_privilege('anon','settlement_entries','INSERT')::text || has_table_privilege('anon','settlement_entries','UPDATE')::text || has_table_privilege('anon','settlement_entries','DELETE')::text`)).toBe("falsefalsefalsefalse");
    expect(await sql(`SELECT has_table_privilege('authenticated','settlement_entries','SELECT')::text || has_table_privilege('authenticated','settlement_entries','INSERT')::text || has_table_privilege('authenticated','settlement_entries','UPDATE')::text || has_table_privilege('authenticated','settlement_entries','DELETE')::text`)).toBe("falsefalsefalsefalse");
    expect(await sql(`SELECT has_table_privilege('service_role','settlement_entries','SELECT')::text || has_table_privilege('service_role','settlement_entries','INSERT')::text || has_table_privilege('service_role','settlement_entries','UPDATE')::text || has_table_privilege('service_role','settlement_entries','DELETE')::text`)).toBe("truetruetruefalse");
    await fails(`SET ROLE anon; SELECT count(*) FROM settlement_entries`, /permission denied|row-level security/i);
    expect(await sql(`SET ROLE service_role; UPDATE settlement_entries SET money_cash=money_cash WHERE accountability_round_id='${a.accountability_round_id}'; SELECT count(*) FROM settlement_entries; RESET ROLE`)).toContain("2");
    expect(await sql(`SELECT has_function_privilege('anon','public.open_accountability_round_produce_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,text,uuid,uuid,text)','EXECUTE')`)).toBe("f");
  }, 60_000);

  afterAll(async () => { if (created) await run(["-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE ${db} WITH (FORCE)`]); });
});
