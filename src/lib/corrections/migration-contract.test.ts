import { describe, expect, test } from "bun:test";

const migrationPath = new URL(
  "../../../supabase/migrations/0037_transaction_corrections.sql",
  import.meta.url,
);
const sql = await Bun.file(migrationPath).text();

describe("transaction correction database security contract", () => {
  test("removes direct authenticated writes and exposes an auth-bound request RPC", () => {
    expect(sql).toContain("CREATE POLICY transaction_corrections_authenticated_read");
    expect(sql).not.toContain("CREATE POLICY transaction_corrections_authenticated_insert");
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.request_transaction_correction(");
    expect(sql).toContain("v_actor             uuid := auth.uid()");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.request_transaction_correction(");
  });

  test("builds before and after snapshots from trusted raw data", () => {
    expect(sql).toContain("public.build_trusted_raw_transaction_snapshot");
    expect(sql).toContain("FROM public.produce_items pi");
    expect(sql).toContain("'sourceVersion', 'raw:' || v_target.id::text");
    expect(sql).toContain("public.build_transaction_correction_after_snapshot(");
    expect(sql).toContain("round(v_quantity * v_price_amount / v_price_quantity, 2)");
    expect(sql).toContain("'totalAmount', v_total");
    expect(sql).toContain("WHEN v_duplicate THEN 0");
  });

  test("requires typed, bounded canonical requested changes", () => {
    expect(sql).toContain("jsonb_typeof(p_changes->'quantity') <> 'number'");
    expect(sql).toContain("jsonb_typeof(p_changes->'priceAmount') <> 'number'");
    expect(sql).toContain("jsonb_typeof(p_changes->'priceQuantity') <> 'number'");
    expect(sql).toContain("jsonb_typeof(p_changes->'productName') <> 'string'");
    expect(sql).toContain("jsonb_typeof(p_changes->'unit') <> 'string'");
    expect(sql).toContain("IF v_number <= 0 OR v_number > 1000000");
    expect(sql).toContain("IF v_number < 0 OR v_number > 1000000");
    expect(sql).toContain("IF v_number < 0.001 OR v_number > 1000000");
    expect(sql).toContain("requested_changes = public.canonicalize_transaction_correction_changes(requested_changes)");
  });

  test("enforces database-owned actors, timestamps and immutable snapshots", () => {
    expect(sql).toContain("v_now               timestamptz := clock_timestamp()");
    expect(sql).toContain("requested_at = created_at AND updated_at >= created_at");
    expect(sql).toContain("NEW.requested_changes, NEW.before_snapshot, NEW.after_snapshot");
    expect(sql).toContain("NEW.requested_by, NEW.requested_at, NEW.supersedes_correction_id");
    expect(sql).toContain("invalid supersede transition");
    expect(sql).toContain("correction status transition is not allowed");
    expect(sql).toContain("CREATE TRIGGER transaction_corrections_immutable_delete");
  });

  test("approval is authorized, locked, idempotent and fully revalidated", () => {
    expect(sql).toContain("raw_app_meta_data->>'role' = 'admin'");
    expect(sql).toContain("NOT public.is_transaction_correction_approver()");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("IF v_correction.status = 'approved'");
    expect(sql).toContain("v_recomputed_after := public.build_transaction_correction_after_snapshot");
    expect(sql).toContain("stale version conflict");
    expect(sql).toContain("stale correction chain conflict");
    expect(sql).toContain("transaction_corrections_one_active_approved_idx");
    expect(sql).toContain("SET status = 'superseded'");
  });

  test("effective view ignores malformed or non-approved overlays without unsafe casts", () => {
    expect(sql).toContain("public.safe_transaction_correction_numeric");
    expect(sql).toContain("tc.status = 'approved'");
    expect(sql).toContain("public.is_valid_transaction_correction_snapshot(tc.before_snapshot)");
    expect(sql).toContain("public.is_valid_transaction_correction_after_snapshot(tc.after_snapshot)");
    expect(sql).toContain("tc.after_snapshot->'voided' = 'true'::jsonb");
    expect(sql).not.toContain("(tc.after_snapshot->>'totalAmount')::numeric");
    expect(sql).toContain("original_total_amount");
  });
});
