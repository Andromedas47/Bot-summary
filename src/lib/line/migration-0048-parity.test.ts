import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Static contract tests for migration 0048.
 *
 * 0048 versions two functions that existed only in Production. These tests are
 * static (no database required) so CI enforces the contract on every run; the
 * behavioral proof lives in the report's clean-database verification.
 *
 * The hashes below are the LF-normalized md5 of each function body as captured
 * from Production (pg_proc.prosrc with CR stripped). They exist to make an
 * accidental edit to a captured baseline body a loud failure rather than a
 * silent behavior change — 0048 is a transcription, not a place to fix things.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "supabase", "migrations");
const FILE = join(MIGRATIONS, "0048_pending_session_function_parity.sql");

/** Line endings vary by platform checkout (core.autocrlf); hash the LF form. */
const sql = readFileSync(FILE, "utf8").replace(/\r/g, "");

/**
 * Executable SQL only. The header explains at length what 0048 deliberately
 * does NOT do, naming 0049's identifiers to do so; those mentions are the
 * point of the comment and must not be mistaken for the feature leaking in.
 */
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const PRODUCTION_BODY_MD5 = {
  register_pending_session_ingest: "644eb21eef45ee59d26aa1e32c341acf",
  check_pending_close_ready: "9c57de266a7f21c4056ef536b96aca88",
} as const;

/** Extracts the Nth $fn$-quoted body, in file order. */
function bodies(): string[] {
  return [...sql.matchAll(/AS \$fn\$([\s\S]*?)\$fn\$;/g)].map((match) => match[1]);
}

describe("migration 0048 — pending-session function parity", () => {
  test("the migration exists and is tracked", () => {
    expect(existsSync(FILE)).toBe(true);
    expect(readdirSync(MIGRATIONS)).toContain("0048_pending_session_function_parity.sql");
  });

  test("both previously-unversioned functions are now defined", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.register_pending_session_ingest(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.check_pending_close_ready(");
  });

  test("signatures match the ones migration 0044 asserts", () => {
    const assertions = readFileSync(
      join(MIGRATIONS, "0044_reconcile_pending_close_baseline.sql"),
      "utf8",
    );

    // 0044 asserts these exact identity arguments and result types.
    expect(assertions).toContain("'register_pending_session_ingest(text,text,bigint,text)'");
    expect(assertions).toContain("'check_pending_close_ready(text)'");

    expect(sql).toMatch(
      /register_pending_session_ingest\(\s*p_session_key\s+text,\s*p_line_event_id\s+text,\s*p_line_timestamp_ms\s+bigint,\s*p_raw_text\s+text DEFAULT NULL::text\s*\)/,
    );
    expect(sql).toMatch(/check_pending_close_ready\(\s*p_session_key text\s*\)/);
  });

  test("result types match 0044's contract", () => {
    expect(sql).toMatch(/p_raw_text\s+text DEFAULT NULL::text\s*\)\s*RETURNS void/);
    expect(sql).toMatch(/check_pending_close_ready\(\s*p_session_key text\s*\)\s*RETURNS jsonb/);
  });

  test("captured bodies are byte-identical to the Production baseline", () => {
    const [registerBody, checkBody] = bodies();
    expect(bodies()).toHaveLength(2);

    expect(createHash("md5").update(registerBody, "utf8").digest("hex")).toBe(
      PRODUCTION_BODY_MD5.register_pending_session_ingest,
    );
    expect(createHash("md5").update(checkBody, "utf8").digest("hex")).toBe(
      PRODUCTION_BODY_MD5.check_pending_close_ready,
    );
  });

  test("the legacy_accumulated compatibility path is preserved verbatim", () => {
    expect(sql).toContain("'legacy_accumulated'");
    expect(sql).toContain("-- Pre-0042 rows: accumulated_text already holds items");
    // Readiness semantics are untouched: the same three-part predicate.
    expect(sql).toContain(
      "(v_admission_count = v_ingest_count AND v_straggler_count = 0 AND v_admission_count > 0)",
    );
  });

  test("no structured-session behavior leaks into the baseline capture", () => {
    // entry_origin is 0049's guard. Executing it here would mean a behavior
    // change rode along with a transcription. The header may name it in prose.
    for (const identifier of [
      "entry_origin",
      "command_contract_version",
      "guided_postback",
      "operator_identity",
      "line_menu_states",
      "line_operator_identities",
    ]) {
      expect(code).not.toContain(identifier);
    }
  });

  test("the migration itself mutates no schema and no rows", () => {
    // Only what 0048 executes at apply time. The captured bodies legitimately
    // contain an INSERT — that is what register_pending_session_ingest does at
    // runtime — so the function bodies are excluded from this check.
    const applyTime = code.replace(/AS \$fn\$[\s\S]*?\$fn\$;/g, "AS <captured-body>;");

    expect(applyTime).not.toMatch(/^\s*ALTER TABLE/mi);
    expect(applyTime).not.toMatch(/^\s*CREATE TABLE/mi);
    expect(applyTime).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\s/mi);
    expect(applyTime).not.toContain("supabase_migrations");
  });

  test("SECURITY INVOKER is preserved for both baseline definitions", () => {
    // A bare CREATE FUNCTION is SECURITY INVOKER; the string must not appear
    // as a definition clause. The guard assertions mention it in error text,
    // so match the DDL form specifically.
    expect(code).not.toMatch(/^\s*SECURITY DEFINER\s*$/mi);
    expect(sql).toContain("must remain SECURITY INVOKER");
  });

  test("search_path is deliberately not pinned (documented trade-off)", () => {
    expect(code).not.toMatch(/^\s*SET search_path/mi);
    expect(sql).toContain("proconfig NULL to match the captured baseline");
  });

  test("EXECUTE is granted to service_role only", () => {
    for (const fn of [
      "public.register_pending_session_ingest(text, text, bigint, text)",
      "public.check_pending_close_ready(text)",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role;`);
    }
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO (anon|authenticated)/);
  });

  test("prerequisites are asserted before either function is replaced", () => {
    const firstCreate = sql.indexOf("CREATE OR REPLACE FUNCTION");
    for (const required of [
      "public.pending_sessions",
      "public.pending_session_ingest",
      "public.pending_session_admission",
    ]) {
      const assertion = sql.indexOf(`to_regclass('${required}') IS NULL`);
      expect(assertion).toBeGreaterThan(-1);
      expect(assertion).toBeLessThan(firstCreate);
    }
  });

  test("reserved migration 0042 remains absent and unreferenced as SQL", () => {
    const files = readdirSync(MIGRATIONS);
    expect(files.some((name) => name.startsWith("0042"))).toBe(false);
    // Prose may explain why 0042 is reserved; nothing may execute it.
    expect(sql).not.toMatch(/\\i\s|\\ir\s/);
  });
});
