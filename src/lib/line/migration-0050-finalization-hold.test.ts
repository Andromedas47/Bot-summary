import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";

const migration = new URL(
  "../../../supabase/migrations/0050_produce_finalization_hold.sql",
  import.meta.url,
);
const sql = await Bun.file(migration).text();
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("0050 migration — schema contract", () => {
  it("adds the three hold columns without DEFAULT or backfill", () => {
    expect(code).toContain("ADD COLUMN finalize_hold_until");
    expect(code).toContain("ADD COLUMN finalize_confirmed_at");
    expect(code).toContain("ADD COLUMN finalize_confirm_line_event_id");
    const alter = code.slice(
      code.indexOf("ADD COLUMN finalize_hold_until"),
      code.indexOf("pending_sessions_finalize_hold_structured_only"),
    );
    expect(alter).not.toMatch(/DEFAULT/i);
    expect(alter).not.toMatch(/IF NOT EXISTS/i);
  });

  it("declares the four hold CHECK constraints", () => {
    for (const name of [
      "pending_sessions_finalize_hold_structured_only",
      "pending_sessions_finalize_confirm_pair",
      "pending_sessions_finalize_confirm_releases_hold",
      "pending_sessions_finalize_confirm_event_nonblank",
    ]) {
      expect(code).toContain(name);
    }
  });

  it("preserves close signature and adds the 10-minute hold", () => {
    expect(code).toContain(
      "CREATE OR REPLACE FUNCTION public.close_produce_structured_session(",
    );
    expect(code).toContain("finalize_hold_until      = now() + interval '10 minutes'");
    expect(code).toContain(
      "public.close_produce_structured_session(text,text,text,bigint,uuid,integer)",
    );
  });

  it("adds confirm RPC as SECURITY INVOKER with service_role-only grants", () => {
    const start = code.indexOf(
      "CREATE OR REPLACE FUNCTION public.confirm_produce_structured_finalization(",
    );
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf(
      "CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation(",
      start,
    );
    const confirm = code.slice(start, end);
    expect(confirm).not.toMatch(/SECURITY DEFINER/i);
    expect(confirm).toContain("GRANT EXECUTE");
    expect(confirm).toContain("TO service_role");
    expect(confirm).toContain("FROM anon, authenticated");
  });

  it("gates try_finalize with awaiting_confirmation and review_not_confirmed", () => {
    expect(code).toContain("awaiting_confirmation");
    expect(code).toContain("review_not_confirmed");
    const tryIdx = code.indexOf(
      "CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation",
    );
    const holdIdx = code.indexOf("finalize_hold_until IS NOT NULL", tryIdx);
    const staleIdx = code.indexOf(
      "ingest_revision IS DISTINCT FROM p_snapshot_revision",
      tryIdx,
    );
    expect(holdIdx).toBeGreaterThan(tryIdx);
    expect(staleIdx).toBeGreaterThan(holdIdx);
  });

  it("asserts postconditions for columns, grants, and hold gate", () => {
    expect(code).toContain("expected 3 hold columns");
    expect(code).toContain("confirm_produce_structured_finalization must be SECURITY INVOKER");
    expect(code).toContain("try_finalize must contain the hold gate");
  });
});

describe("0050 migration — checksum stability", () => {
  it("records a stable sha256 for review", () => {
    const hash = createHash("sha256").update(sql).digest("hex");
    expect(hash).toHaveLength(64);
    // Printed for the implementation report; change only when SQL intentionally changes.
    expect(hash).toBe(
      "c0f982277346f74425c2a42a31e8e7d68318c3407783fd6341ab612d2172ca37",
    );
  });
});
