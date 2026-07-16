import { describe, expect, test } from "bun:test";

const migrationPath = new URL("../../../supabase/migrations/0037_transaction_corrections.sql", import.meta.url);
const sql = await Bun.file(migrationPath).text();

describe("transaction correction database contract", () => {
  test("is append-only for authenticated users and protects approval server-side", () => {
    expect(sql).toContain("REVOKE UPDATE, DELETE ON public.transaction_corrections FROM authenticated");
    expect(sql).toContain("NOT public.is_transaction_correction_approver()");
    expect(sql).toContain("raw_app_meta_data->>'role' = 'admin'");
  });

  test("approval is atomic, idempotent, stale-safe, and has one active correction", () => {
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("IF v_correction.status = 'approved'");
    expect(sql).toContain("stale version conflict");
    expect(sql).toContain("stale correction chain conflict");
    expect(sql).toContain("transaction_corrections_one_active_approved_idx");
    expect(sql).toContain("SET status = 'superseded'");
  });

  test("effective view applies approved overlays once and omits void duplicates", () => {
    expect(sql).toContain("tc.status = 'approved'");
    expect(sql).toContain("WHERE COALESCE((tc.after_snapshot->>'voided')::boolean, false) = false");
    expect(sql).toContain("original_total_amount");
  });
});
