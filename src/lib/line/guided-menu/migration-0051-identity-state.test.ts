import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";

const migration = new URL(
  "../../../../supabase/migrations/20260729074617_guided_menu_identity_and_state.sql",
  import.meta.url,
);
const sql = await Bun.file(migration).text();
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function sha256Lf(text: string): string {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return createHash("sha256").update(lf, "utf8").digest("hex");
}

function lfByteCount(text: string): number {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return Buffer.byteLength(lf, "utf8");
}

/** Canonical committed LF blob — updated when 0051 is edited in place (unapplied). */
const CANONICAL_LF_SHA256 =
  "7a39709d2af3ff7d4a17a55dd2c8fa21340eafb4d7aa0082667baa5f14fd4a38";
const CANONICAL_LF_BYTES = 29629;

describe("0051 migration — schema contract", () => {
  it("creates foundation tables including trusted markets", () => {
    expect(code).toContain("CREATE TABLE public.line_operator_identities");
    expect(code).toContain("CREATE TABLE public.line_menu_states");
    expect(code).toContain("CREATE TABLE public.line_guided_menu_markets");
    expect(code).not.toContain("INSERT INTO public.line_operator_identities");
    expect(code).toContain("INSERT INTO public.line_guided_menu_markets");
  });

  it("enables RLS with zero policies and service_role grants without DELETE", () => {
    expect(code).toContain(
      "ALTER TABLE public.line_operator_identities ENABLE ROW LEVEL SECURITY",
    );
    expect(code).toContain(
      "ALTER TABLE public.line_menu_states ENABLE ROW LEVEL SECURITY",
    );
    expect(code).toContain(
      "ALTER TABLE public.line_guided_menu_markets ENABLE ROW LEVEL SECURITY",
    );
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).toContain(
      "REVOKE ALL ON TABLE public.line_operator_identities FROM service_role",
    );
    expect(code).toContain(
      "REVOKE ALL ON TABLE public.line_guided_menu_markets FROM service_role",
    );
    expect(code).toContain(
      "REVOKE ALL ON TABLE public.line_menu_states FROM service_role",
    );
    expect(code).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE public.line_operator_identities TO service_role",
    );
    expect(code).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE public.line_menu_states TO service_role",
    );
    expect(code).not.toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.line_menu_states/,
    );
    expect(code).toContain("FROM anon, authenticated");
    expect(code).not.toMatch(/ALTER DEFAULT PRIVILEGES/i);
  });

  it("adds create/consume/record RPCs as SECURITY INVOKER with search_path", () => {
    expect(code).toContain(
      "CREATE OR REPLACE FUNCTION public.create_line_menu_state(",
    );
    expect(code).toContain(
      "CREATE OR REPLACE FUNCTION public.consume_line_menu_state(",
    );
    expect(code).toContain(
      "CREATE OR REPLACE FUNCTION public.record_line_menu_state_result(",
    );
    expect(code).not.toMatch(/SECURITY DEFINER/i);
    expect(code).toContain("SET search_path TO public, pg_temp");
    expect(code).toContain("invalid_or_expired");
    expect(code).toContain("already_consumed");
    expect(code).toContain("result_conflict");
    expect(code).toContain("guided_menu_payload_valid");
    expect(code).toContain("trg_enforce_line_menu_state_invariants");
  });

  it("stores token_hash only with lowercase hex CHECK and forbids trusted labels", () => {
    expect(code).toContain("token_hash              text PRIMARY KEY");
    expect(code).toContain("line_menu_states_token_hash_sha256_hex");
    expect(code).toContain("^[0-9a-f]{64}$");
    expect(code).not.toMatch(/raw_token/i);
    expect(code).toContain("line_menu_states_payload_no_trusted_labels");
    expect(code).toContain("staff_label");
    expect(code).toContain("market_label");
  });

  it("redacts different-event already_consumed and binds result RPC fully", () => {
    expect(code).toContain(
      "RETURN jsonb_build_object('status', 'already_consumed');",
    );
    expect(code).toContain("p_line_user_id           text");
    expect(code).toContain("p_source_type            text");
    expect(code).toContain("p_source_id              text");
    expect(code).toContain("interval '30 minutes'");
    expect(code).toContain("interval '10 minutes'");
  });

  it("matches the canonical LF SHA-256 and reports byte count", () => {
    expect(sha256Lf(sql)).toBe(CANONICAL_LF_SHA256);
    expect(lfByteCount(sql)).toBe(CANONICAL_LF_BYTES);
  });
});
