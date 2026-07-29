import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";

const migration = new URL(
  "../../../../supabase/migrations/0051_guided_menu_identity_and_state.sql",
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

/** Canonical committed LF blob SHA-256 (git stores LF). */
const CANONICAL_LF_SHA256 =
  "1928700ef68ac08c26a44d231e08c5f498d824328a2eb7b336db219eda6e4d9d";

describe("0051 migration — schema contract", () => {
  it("creates exactly the two foundation tables", () => {
    expect(code).toContain("CREATE TABLE public.line_operator_identities");
    expect(code).toContain("CREATE TABLE public.line_menu_states");
    expect(code).not.toContain("INSERT INTO public.line_operator_identities");
  });

  it("enables RLS with zero policies and service_role-only grants", () => {
    expect(code).toContain(
      "ALTER TABLE public.line_operator_identities ENABLE ROW LEVEL SECURITY",
    );
    expect(code).toContain(
      "ALTER TABLE public.line_menu_states ENABLE ROW LEVEL SECURITY",
    );
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.line_operator_identities TO service_role",
    );
    expect(code).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.line_menu_states TO service_role",
    );
    expect(code).toContain("FROM anon, authenticated");
  });

  it("adds consume + record RPCs as SECURITY INVOKER", () => {
    expect(code).toContain(
      "CREATE OR REPLACE FUNCTION public.consume_line_menu_state(",
    );
    expect(code).toContain(
      "CREATE OR REPLACE FUNCTION public.record_line_menu_state_result(",
    );
    expect(code).not.toMatch(/SECURITY DEFINER/i);
    expect(code).toContain("invalid_or_expired");
    expect(code).toContain("already_consumed");
    expect(code).toContain("result_conflict");
  });

  it("stores token_hash only and forbids trusted labels in payload", () => {
    expect(code).toContain("token_hash              text PRIMARY KEY");
    expect(code).not.toMatch(/raw_token/i);
    expect(code).toContain("line_menu_states_payload_no_trusted_labels");
    expect(code).toContain("staff_label");
    expect(code).toContain("market_label");
  });

  it("matches the canonical LF SHA-256", () => {
    expect(sha256Lf(sql)).toBe(CANONICAL_LF_SHA256);
  });
});
