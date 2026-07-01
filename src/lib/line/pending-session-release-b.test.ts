import { describe, expect, it } from "bun:test";
import { PendingSessionService } from "./pending-session-service";
import {
  buildMissingItemsMessage,
  findMissingItemNumbers,
} from "./pending-session-finalizer";
import { parseExpectedItemCount } from "./webhook-service";

const migrationPath = new URL(
  "../../../supabase/migrations/0032_pending_session_finalization_barrier.sql",
  import.meta.url,
);
const finalizerPath = new URL("./pending-session-finalizer.ts", import.meta.url);

describe("Release B close command and completeness protocol", () => {
  it("parses จบรายการ N รายการ while bare close remains best-effort", () => {
    expect(parseExpectedItemCount("จบรายการ 18 รายการ")).toBe(18);
    expect(parseExpectedItemCount("09:12 ก้อย จบรายการ 18 รายการ")).toBe(18);
    expect(parseExpectedItemCount("จบรายการ")).toBeNull();
    expect(parseExpectedItemCount("จบรายการเบิก")).toBeNull();
  });

  it("reports exactly missing item numbers 9 through 13 for expected count 18", () => {
    const observed = [
      1, 2, 3, 4, 5, 6, 7, 8,
      14, 15, 16, 17, 18,
    ];
    const missing = findMissingItemNumbers(18, observed);

    expect(missing).toEqual([9, 10, 11, 12, 13]);
    expect(buildMissingItemsMessage(missing))
      .toContain("9, 10, 11, 12, 13");
  });

  it("pins generation, sender, and ingest revision in the finalizer RPC call", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: { status: "stale_snapshot", current_revision: 8 }, error: null };
      },
    };
    const service = new PendingSessionService(supabase as never);

    const result = await service.tryFinalizeGeneration(
      "group:g-1:user:u-1",
      "11111111-1111-4111-8111-111111111111",
      "u-1",
      7,
      "hash",
      "raw",
      { staff_name: "ก้อย" },
      [],
    );

    expect(result.status).toBe("stale_snapshot");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("try_finalize_pending_generation");
    expect(calls[0].args.p_expected_generation)
      .toBe("11111111-1111-4111-8111-111111111111");
    expect(calls[0].args.p_expected_line_user_id).toBe("u-1");
    expect(calls[0].args.p_snapshot_revision).toBe(7);
  });
});

describe("Release B migration transaction contract", () => {
  it("contains immutable boundary, 8-second quiet, and 30-second deadline guards", async () => {
    const sql = await Bun.file(migrationPath).text();

    expect(sql).toContain("close_session_generation");
    expect(sql).toContain("v_was_closing AND p_mark_close");
    expect(sql).toContain("interval '8 seconds'");
    expect(sql).toContain("interval '30 seconds'");
    expect(sql).toContain("p_line_timestamp_ms > v_row.close_event_timestamp_ms");
    expect(sql.indexOf("reason', 'after_close_boundary'"))
      .toBeLessThan(sql.indexOf("INSERT INTO public.pending_session_admission"));
  });

  it("rejects stale parser snapshots before every produce write", async () => {
    const sql = await Bun.file(migrationPath).text();
    const staleGuard = sql.indexOf(
      "v_row.ingest_revision IS DISTINCT FROM p_snapshot_revision",
    );
    const produceWrite = sql.indexOf("INSERT INTO public.produce_sessions");

    expect(staleGuard).toBeGreaterThan(0);
    expect(staleGuard).toBeLessThan(produceWrite);
    expect(sql).toContain("'status', 'stale_snapshot'");
  });

  it("fails closed for missing indexed items before dedup or produce writes", async () => {
    const sql = await Bun.file(migrationPath).text();
    const failedClosed = sql.indexOf(
      "'status', 'failed_closed', 'reason', 'missing_items'",
    );
    const dedupWrite = sql.indexOf("INSERT INTO public.imported_sessions");
    const produceWrite = sql.indexOf("INSERT INTO public.produce_sessions");

    expect(failedClosed).toBeGreaterThan(0);
    expect(failedClosed).toBeLessThan(dedupWrite);
    expect(failedClosed).toBeLessThan(produceWrite);
  });

  it("serializes duplicate finalizers and terminalizes within the same authority", async () => {
    const sql = await Bun.file(migrationPath).text();
    const functionStart = sql.indexOf(
      "CREATE FUNCTION public.try_finalize_pending_generation",
    );
    const functionSql = sql.slice(functionStart);

    expect(functionSql).toContain("FOR UPDATE");
    expect(functionSql).toContain("IF v_row.terminalized THEN");
    expect(functionSql).toContain("INSERT INTO public.imported_sessions");
    expect(functionSql).toContain("INSERT INTO public.produce_sessions");
    expect(functionSql).toContain("INSERT INTO public.produce_items");
    expect(functionSql).toContain("SET terminalized = true, next_attempt_at = NULL");
  });

  it("never authorizes a different generation or sender", async () => {
    const sql = await Bun.file(migrationPath).text();

    expect(sql).toContain(
      "v_row.session_generation IS DISTINCT FROM p_expected_generation",
    );
    expect(sql).toContain(
      "v_row.line_user_id IS DISTINCT FROM p_expected_line_user_id",
    );
    expect(sql).toContain(
      "v_row.close_session_generation IS DISTINCT FROM p_expected_generation",
    );
  });

  it("does not create a Supabase cron job", async () => {
    const sql = await Bun.file(migrationPath).text();
    expect(sql).not.toContain("cron.schedule");
  });

  it("cron worker selects due, non-terminal sessions only", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain('.eq("terminalized", false)');
    expect(source).toContain('.not("next_attempt_at", "is", null)');
    expect(source).toContain('.lte("next_attempt_at", new Date().toISOString())');
  });
});
