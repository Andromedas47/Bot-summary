import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const migration = readFileSync(join(root, "supabase/migrations/20260905090000_legacy_anon_surface_lockdown.sql"), "utf8");
const windowsPsql = "C:/Program Files/PostgreSQL/17/bin/psql.exe";
const database = `legacy_anon_${randomBytes(6).toString("hex")}`;
const tables = ["raw_messages", "parse_errors", "daily_summaries", "line_groups",
  "produce_items", "produce_round_events", "produce_sessions", "settlement_draft_history",
  "settlement_drafts", "work_round_selections", "work_rounds"];
const views = ["produce_transactions", "produce_transactions_all"];
const calls = ["claim_work_round_selection(NULL::uuid, '', '', 1, ARRAY[]::text[])",
  "insert_produce_round_events_ignore('{}'::jsonb)"];

async function run(sql: string, db = database) {
  const proc = Bun.spawn([existsSync(windowsPsql) ? windowsPsql : "psql",
    "-X", "-w", "-v", "ON_ERROR_STOP=1", "-qAt", "-f", "-"], {
    stdin: new TextEncoder().encode(sql), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: process.env.PGPORT ?? "5432",
      PGUSER: "postgres", PGPASSWORD: process.env.PGPASSWORD ?? "postgres", PGDATABASE: db },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr };
}

async function ok(sql: string, db = database) {
  const result = await run(sql, db);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function denied(sql: string) {
  const result = await run(sql);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("permission denied");
}

test.skipIf(process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1")(
  "legacy anon boundary: missing drift, actual role access, RPCs and future defaults",
  async () => {
    // Hardcoded loopback/user and generated database: never use an application URL.
    expect(database).toMatch(/^legacy_anon_[a-f0-9]{12}$/);
    await ok(`CREATE DATABASE ${database}`, "postgres");
    try {
      // Reuse cluster roles without modifying them (the existing boundary-test convention).
      await ok(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;`);
      // A clean chain may contain none of the drift objects. This must succeed.
      await ok(migration);
      await ok(`
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
        ${tables.map((table) => `
          CREATE TABLE public.${table}(id integer);
          INSERT INTO public.${table} VALUES (1);
          ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
          CREATE POLICY legacy_read ON public.${table} FOR SELECT TO ${["raw_messages", "parse_errors"].includes(table) ? "PUBLIC" : "anon"} USING (true);
        `).join("\n")}
        CREATE POLICY authenticated_read ON public.produce_sessions FOR SELECT TO authenticated USING (true);
        ${views.map((view) => `CREATE VIEW public.${view} AS SELECT * FROM public.raw_messages;`).join("\n")}
        CREATE FUNCTION public.claim_work_round_selection(uuid,text,text,integer,text[])
          RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
        CREATE FUNCTION public.insert_produce_round_events_ignore(jsonb)
          RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'INSERT INTO public.produce_round_events VALUES (2) RETURNING id';
      `);
      for (const relation of [...tables, ...views]) {
        expect(await ok(`SET ROLE anon; SELECT count(*) FROM public.${relation}`)).toBe("1");
      }
      for (const role of ["anon", "authenticated"]) {
        for (const call of calls) await ok(`SET ROLE ${role}; SELECT public.${call}`);
      }
      await ok(migration);
      await ok(migration); // Idempotence with drift present.
      for (const relation of [...tables, ...views]) {
        await denied(`SET ROLE anon; SELECT * FROM public.${relation}`);
        expect(Number(await ok(`SET ROLE service_role; SELECT count(*) FROM public.${relation}`))).toBeGreaterThan(0);
      }
      expect(await ok(`SELECT count(*) FROM pg_policy WHERE polname='legacy_read'`)).toBe("0");
      expect(await ok(`SET ROLE authenticated; SELECT count(*) FROM public.produce_sessions`)).toBe("1");
      for (const table of ["raw_messages", "parse_errors"]) {
        expect(await ok(`SET ROLE authenticated; SELECT count(*) FROM public.${table}`)).toBe("0");
      }
      for (const call of calls) {
        for (const role of ["anon", "authenticated"]) await denied(`SET ROLE ${role}; SELECT public.${call}`);
        await ok(`SET ROLE service_role; SELECT public.${call}`);
      }
      await ok(`SET ROLE postgres;
        CREATE TABLE public.future_table(id integer);
        CREATE SEQUENCE public.future_sequence;
        CREATE FUNCTION public.future_function() RETURNS integer LANGUAGE sql AS 'SELECT 1';`);
      await denied(`SET ROLE anon; SELECT * FROM public.future_table`);
      await denied(`SET ROLE anon; SELECT nextval('public.future_sequence')`);
      await denied(`SET ROLE anon; SELECT public.future_function()`);
      expect(await ok(`SELECT
        has_table_privilege('anon','public.future_table','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
        has_sequence_privilege('anon','public.future_sequence','USAGE,SELECT,UPDATE') OR
        has_function_privilege('anon','public.future_function()','EXECUTE')`)).toBe("f");
      for (const role of ["authenticated", "service_role"]) {
        expect(await ok(`SET ROLE ${role}; INSERT INTO public.future_table VALUES (1);
          SELECT nextval('public.future_sequence'); SELECT public.future_function()`)).toEndWith("1");
      }
    } finally {
      await ok(`DROP DATABASE ${database}`, "postgres");
    }
  }, 120_000,
);
