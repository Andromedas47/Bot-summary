import { describe, expect, it } from "bun:test";

const finalizerPath = new URL("./pending-session-finalizer.ts", import.meta.url);
const migrationPath = new URL(
  "../../../supabase/migrations/0034_produce_notification_delivery.sql",
  import.meta.url,
);

describe("produce finalization notification boundary", () => {
  it("snapshots the success summary before the authoritative RPC", async () => {
    const source = await Bun.file(finalizerPath).text();
    const payload = source.indexOf(
      "notification_payload: buildWeighSessionSummary(parsed)",
    );
    const finalize = source.indexOf("service.tryFinalizeGeneration(");

    expect(payload).toBeGreaterThan(0);
    expect(payload).toBeLessThan(finalize);
    expect(source).toContain("notification_source_id: snapshot.source_id");
    expect(source).toContain("correlation_id: correlationId");
  });

  it("uses direct success push only as a pre-migration rolling fallback", async () => {
    const source = await Bun.file(finalizerPath).text();
    const notificationBranch = source.indexOf("let message: string | null");
    const summaryBuild = source.indexOf(
      "notification_payload: buildWeighSessionSummary(parsed)",
    );

    expect(summaryBuild).toBeLessThan(notificationBranch);
    expect(source).toContain(
      'result.status === "finalized" && !result.notification_id',
    );
    expect(source).toContain("pre-0034 RPC cannot create an outbox row");
  });

  it("persists exact timing without introducing a same-event fast path", async () => {
    const source = await Bun.file(finalizerPath).text();
    const sql = await Bun.file(migrationPath).text();

    expect(source).toContain('log.info("produce finalization started"');
    expect(source).toContain("closeEventTimestampMs");
    expect(source).toContain("nextAttemptAt");
    expect(source).toContain("closeDeadlineAt");
    expect(sql).toContain("finalization_started_at");
    expect(sql).toContain("finalized_at");
    expect(sql).not.toContain("same_event");
    expect(sql).not.toContain("fast_path");
  });

  it("keeps finalization, items, and pending notification in one transaction", async () => {
    const sql = await Bun.file(migrationPath).text();
    const functionSql = sql.slice(sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation",
    ));
    const sessionInsert = functionSql.indexOf(
      "INSERT INTO public.produce_sessions",
    );
    const itemInsert = functionSql.indexOf("INSERT INTO public.produce_items");
    const notificationInsert = functionSql.indexOf(
      "INSERT INTO public.produce_session_notifications",
    );
    const terminalTransition = functionSql.indexOf(
      "finalization_status = 'finalized'",
    );

    expect(sessionInsert).toBeGreaterThan(0);
    expect(itemInsert).toBeGreaterThan(sessionInsert);
    expect(notificationInsert).toBeGreaterThan(itemInsert);
    expect(terminalTransition).toBeGreaterThan(notificationInsert);
  });
});
