import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { finalizeSlipBatch, parseAbandonedMinutes } from "./batch-finalizer";
import type { Database } from "@/types/database";

// ── parseAbandonedMinutes ──────────────────────────────────────────────────

describe("parseAbandonedMinutes", () => {
  it("returns 60 for undefined", () => {
    expect(parseAbandonedMinutes(undefined)).toBe(60);
  });

  it("returns 60 for empty string", () => {
    expect(parseAbandonedMinutes("")).toBe(60);
  });

  it("returns 60 for non-numeric string", () => {
    expect(parseAbandonedMinutes("abc")).toBe(60);
  });

  it("returns 60 for zero", () => {
    expect(parseAbandonedMinutes("0")).toBe(60);
  });

  it("returns 60 for negative number", () => {
    expect(parseAbandonedMinutes("-5")).toBe(60);
  });

  it("returns 60 for NaN-producing input (empty string via parseInt)", () => {
    // parseInt("", 10) = NaN; Math.max(1, NaN) = NaN — the old bug.
    // parseAbandonedMinutes must return 60 instead.
    expect(parseAbandonedMinutes("")).toBe(60);
    expect(Number.isFinite(parseAbandonedMinutes(""))).toBe(true);
  });

  it("returns 30 for '30'", () => {
    expect(parseAbandonedMinutes("30")).toBe(30);
  });

  it("returns 60 for '60'", () => {
    expect(parseAbandonedMinutes("60")).toBe(60);
  });

  it("returns 1 for '1' (minimum positive)", () => {
    expect(parseAbandonedMinutes("1")).toBe(1);
  });

  it("returns 480 for '480'", () => {
    expect(parseAbandonedMinutes("480")).toBe(480);
  });
});

// ── finalizeSlipBatch delivery state ──────────────────────────────────────

/**
 * Minimal supabase stub for finalizeSlipBatch tests.
 *
 * All slip_batches updates are captured in `statusUpdates`.
 * slip_evidences always returns empty (simplest path, avoids slip_checks query).
 */
function makeFinalizerSupabase({
  batchData,
  updateError = null,
  statusUpdates = [],
}: {
  batchData: Record<string, unknown> | null;
  updateError?: { message: string } | null;
  statusUpdates?: Array<Record<string, unknown>>;
}): SupabaseClient<Database> {
  return {
    from(table: string) {
      if (table === "slip_batches") {
        return {
          select() {
            return {
              eq(_col: string, _val: unknown) {
                return {
                  async maybeSingle() {
                    return { data: batchData, error: null };
                  },
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            statusUpdates.push(values);
            return {
              eq(_col: string, _val: unknown) {
                return Promise.resolve({ data: null, error: updateError });
              },
            };
          },
        };
      }

      if (table === "slip_evidences") {
        return {
          select() {
            return {
              eq(_col: string, _val: unknown) {
                return {
                  order(_col2: string, _opts: unknown) {
                    return Promise.resolve({ data: [], error: null });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "slip_checks") {
        return {
          select() {
            return {
              in(_col: string, _vals: unknown[]) {
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

describe("finalizeSlipBatch delivery state", () => {
  it("skips silently when summary_sent_at is already set (idempotency guard)", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: "2026-01-01T00:00:00Z" },
      statusUpdates,
    });

    let sendCalled = false;
    await finalizeSlipBatch(supabase, "batch-1", async () => { sendCalled = true; });

    expect(sendCalled).toBe(false);
    expect(statusUpdates).toHaveLength(0);
  });

  it("reverts batch to collecting when LINE fails before send (user can retry)", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: null },
      // updateError=null so the revert itself succeeds
      statusUpdates,
    });

    // sendMessage throws before messageSent is set — pre-send failure
    await expect(
      finalizeSlipBatch(supabase, "batch-1", async () => {
        throw new Error("LINE API error");
      }),
    ).rejects.toThrow("LINE API error");

    // Must revert to collecting so user can retry "จบสลิป"
    const revert = statusUpdates.find((u) => u.status === "collecting");
    expect(revert).toBeDefined();

    // Must NOT permanently mark as failed (that would block retry)
    const permanentFail = statusUpdates.find((u) => u.status === "failed");
    expect(permanentFail).toBeUndefined();
  });

  it("does not throw or revert when DB update fails after successful LINE send", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeFinalizerSupabase({
      batchData: { id: "batch-1", summary_sent_at: null },
      updateError: { message: "db connection lost" },
      statusUpdates,
    });

    let sendCalled = false;

    // sendMessage succeeds (messageSent=true), then the DB update fails.
    // The function should resolve — not throw — because the summary was delivered.
    await expect(
      finalizeSlipBatch(supabase, "batch-1", async () => { sendCalled = true; }),
    ).resolves.toBeUndefined();

    expect(sendCalled).toBe(true);

    // Update was attempted (the failed one)
    expect(statusUpdates.length).toBeGreaterThan(0);
    // No revert to collecting — summary already delivered, reverting would allow duplicate send
    const revert = statusUpdates.find((u) => u.status === "collecting");
    expect(revert).toBeUndefined();
  });
});
