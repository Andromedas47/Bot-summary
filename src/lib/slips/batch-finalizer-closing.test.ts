/**
 * Tests for finalizeClosingSlipBatches — the cron-driven stage that transitions
 * slip batches from 'closing' to 'processing' once the quiet period has elapsed
 * and all OCR checks are terminal (or the max timeout is reached).
 *
 * The atomic readiness check + claim is handled by the claim_closing_slip_batch
 * SQL RPC (see migration 0024).  The TypeScript layer tests the orchestration:
 * which batches are fed to the claim function, and what happens based on its result.
 *
 * Concurrency contracts (enforced by the SQL RPC, described here for clarity):
 *   • Late image wins: attach_evidence_to_slip_batch updates last_image_at while
 *     holding a row lock; claim_closing_slip_batch reads the refreshed value after
 *     acquiring the same lock → quiet period not elapsed → claim returns null.
 *   • Finalizer wins: claim transitions status to 'processing' while holding the
 *     lock; attach_evidence_to_slip_batch's WHERE status IN ('collecting','closing')
 *     predicate then fails → late image is rejected, cannot enter finalized batch.
 */
import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  finalizeClosingSlipBatches,
  parseCloseSeconds,
  type ClaimFn,
} from "./batch-finalizer";
import type { Database } from "@/types/database";

// ── parseCloseSeconds ─────────────────────────────────────────────────────────

describe("parseCloseSeconds", () => {
  it("returns default for undefined",    () => expect(parseCloseSeconds(undefined, 10)).toBe(10));
  it("returns default for empty string", () => expect(parseCloseSeconds("", 10)).toBe(10));
  it("returns default for non-numeric",  () => expect(parseCloseSeconds("abc", 10)).toBe(10));
  it("returns default for zero",         () => expect(parseCloseSeconds("0", 10)).toBe(10));
  it("returns default for negative",     () => expect(parseCloseSeconds("-5", 30)).toBe(30));
  it("parses a valid positive integer",  () => expect(parseCloseSeconds("15", 10)).toBe(15));
  it("minimum is 1",                     () => expect(parseCloseSeconds("1", 10)).toBe(1));
});

// ── Supabase stub ─────────────────────────────────────────────────────────────

type ClosingBatchRow = { id: string; source_id: string };

function makeStub(closingBatches: ClosingBatchRow[]): SupabaseClient<Database> {
  return {
    from(table: string) {
      if (table === "slip_batches") {
        return {
          select(_cols: string) {
            return {
              eq(_col: string, _val: unknown) {
                return Promise.resolve({ data: closingBatches, error: null });
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

/** No-op finalizer so tests focus on claim orchestration. */
const noopFinalize = async () => {};

// ── Helper: build an injectable claim function ────────────────────────────────

/**
 * Returns a ClaimFn that uses a per-batch allowlist.  Batches in allowedIds are
 * claimed and returned; others return null.  Captures which batch IDs were presented.
 */
function makeClaimFn(
  allowedIds:  string[],
  wasTimeout = false,
): { claim: ClaimFn; presented: string[] } {
  const presented: string[] = [];
  const allowed = new Set(allowedIds);
  const claim: ClaimFn = async (_supabase, batchId) => {
    presented.push(batchId);
    if (!allowed.has(batchId)) return null;
    return { id: batchId, source_id: `src-${batchId}`, wasTimeout };
  };
  return { claim, presented };
}

// ── Core orchestration tests ──────────────────────────────────────────────────

describe("finalizeClosingSlipBatches — atomic claim orchestration", () => {

  it("calls claim for each closing batch and finalizes claimed ones", async () => {
    const batches: ClosingBatchRow[] = [
      { id: "batch-1", source_id: "src-1" },
      { id: "batch-2", source_id: "src-2" },
    ];
    const supabase = makeStub(batches);
    const { claim, presented } = makeClaimFn(["batch-1"]); // only batch-1 is ready
    const finalizedBatches: string[] = [];

    const count = await finalizeClosingSlipBatches(
      supabase, async () => {}, 10, 120,
      async (_sb, batchId) => { finalizedBatches.push(batchId); },
      claim,
    );

    expect(presented).toEqual(["batch-1", "batch-2"]); // both presented to claim
    expect(count).toBe(1);
    expect(finalizedBatches).toEqual(["batch-1"]); // only ready one finalized
  });

  it("returns 0 when there are no closing batches", async () => {
    const supabase = makeStub([]);
    const { claim } = makeClaimFn([]);
    const count = await finalizeClosingSlipBatches(
      supabase, async () => {}, 10, 120, noopFinalize, claim,
    );
    expect(count).toBe(0);
  });

  it("skips batch when claim returns null (not yet ready)", async () => {
    const supabase = makeStub([{ id: "batch-1", source_id: "src-1" }]);
    const { claim } = makeClaimFn([]); // nothing ready
    const finalizedBatches: string[] = [];

    const count = await finalizeClosingSlipBatches(
      supabase, async () => {}, 10, 120,
      async (_sb, batchId) => { finalizedBatches.push(batchId); },
      claim,
    );

    expect(count).toBe(0);
    expect(finalizedBatches).toHaveLength(0);
  });

  it("does not double-finalize when concurrent worker already claimed the batch", async () => {
    // Simulates the RPC returning null for a batch that was just claimed by another worker.
    const supabase = makeStub([{ id: "batch-1", source_id: "src-1" }]);
    const { claim } = makeClaimFn([]); // claim returns null (another worker won)
    const finalizedBatches: string[] = [];

    const count = await finalizeClosingSlipBatches(
      supabase, async () => {}, 10, 120,
      async (_sb, batchId) => { finalizedBatches.push(batchId); },
      claim,
    );

    expect(count).toBe(0);
    expect(finalizedBatches).toHaveLength(0);
  });

  // ── Concurrency contract tests ─────────────────────────────────────────────
  //
  // The SQL RPC serializes against attach_evidence_to_slip_batch via the same
  // row-level lock.  These tests express the intended outcomes using the injectable
  // claim function to simulate what the RPC does in each scenario.

  it("late image wins: claim returns null when last_image_at was refreshed by attach", async () => {
    // Simulates: attach_evidence_to_slip_batch ran first, updated last_image_at
    // to now(), the RPC read the refreshed value and found quiet period not elapsed
    // → returns no rows (null).
    const supabase = makeStub([{ id: "batch-1", source_id: "src-1" }]);
    // Claim returns null — the quiet window was extended by the late image
    const { claim } = makeClaimFn([]);
    const finalizedBatches: string[] = [];

    const count = await finalizeClosingSlipBatches(
      supabase, async () => {}, 10, 120,
      async (_sb, batchId) => { finalizedBatches.push(batchId); },
      claim,
    );

    expect(count).toBe(0); // batch not finalized — quiet window still open
    expect(finalizedBatches).toHaveLength(0);
  });

  it("finalizer wins: claim completes, late image cannot silently enter finalized batch", async () => {
    // Simulates: claim_closing_slip_batch locked the row and transitioned
    // status to 'processing' before the late image arrived.
    // attach_evidence_to_slip_batch's WHERE status IN ('collecting','closing')
    // would fail and raise an exception in the DB — the late image is rejected.
    // Here we only test the TypeScript side: claimed batch IS finalized.
    const supabase = makeStub([{ id: "batch-1", source_id: "src-1" }]);
    const { claim } = makeClaimFn(["batch-1"]);
    const finalizedBatches: string[] = [];

    const count = await finalizeClosingSlipBatches(
      supabase, async () => {}, 10, 120,
      async (_sb, batchId) => { finalizedBatches.push(batchId); },
      claim,
    );

    expect(count).toBe(1);
    expect(finalizedBatches).toEqual(["batch-1"]);
  });

  // ── isTimeoutForced is forwarded to the finalizer ─────────────────────────

  it("passes isTimeoutForced=true to finalizer when RPC reports timeout", async () => {
    const supabase = makeStub([{ id: "batch-1", source_id: "src-1" }]);
    const { claim } = makeClaimFn(["batch-1"], true); // wasTimeout=true
    const receivedOptions: Array<{ isTimeoutForced?: boolean }> = [];

    await finalizeClosingSlipBatches(
      supabase, async () => {}, 10, 120,
      async (_sb, _id, _send, opts) => { receivedOptions.push(opts ?? {}); },
      claim,
    );

    expect(receivedOptions).toHaveLength(1);
    expect(receivedOptions[0].isTimeoutForced).toBe(true);
  });

  it("passes isTimeoutForced=false to finalizer for normal (quiet) finalization", async () => {
    const supabase = makeStub([{ id: "batch-1", source_id: "src-1" }]);
    const { claim } = makeClaimFn(["batch-1"], false); // wasTimeout=false
    const receivedOptions: Array<{ isTimeoutForced?: boolean }> = [];

    await finalizeClosingSlipBatches(
      supabase, async () => {}, 10, 120,
      async (_sb, _id, _send, opts) => { receivedOptions.push(opts ?? {}); },
      claim,
    );

    expect(receivedOptions[0].isTimeoutForced).toBe(false);
  });

  // ── Retry key is threaded through sendMessage closure ─────────────────────

  it("sendMessage closure uses batch ID as LINE retry key", async () => {
    const supabase = makeStub([{ id: "batch-a", source_id: "src-a" }]);
    // Use an inline claim that returns the exact source_id from the stub row.
    const claim: ClaimFn = async (_supabase, batchId) => ({
      id: batchId, source_id: "src-a", wasTimeout: false,
    });
    const pushCalls: Array<{ to: string; retryKey?: string }> = [];

    await finalizeClosingSlipBatches(
      supabase,
      async (to, _text, retryKey) => { pushCalls.push({ to, retryKey }); },
      10, 120,
      async (_sb, _id, sendMessage) => { await sendMessage("test summary"); },
      claim,
    );

    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].to).toBe("src-a");
    expect(pushCalls[0].retryKey).toBe("batch-a");
  });
});

// ── vercel.json cron schedule ─────────────────────────────────────────────────

describe("vercel.json cron schedule", () => {
  it("finalize-slip-batches is NOT scheduled in vercel.json (Hobby plan: per-minute crons not allowed)", async () => {
    const file = await import("../../../vercel.json", { with: { type: "json" } });
    const config = file.default as { crons?: Array<{ path: string; schedule: string }> };
    const entry = config.crons?.find((c) => c.path === "/api/cron/finalize-slip-batches");
    expect(entry).toBeUndefined();
  });

  it("daily-summary cron is disabled", async () => {
    const file = await import("../../../vercel.json", { with: { type: "json" } });
    const config = file.default as { crons?: Array<{ path: string; schedule: string }> };
    const entry = config.crons?.find((c) => c.path === "/api/cron/daily-summary");
    expect(entry).toBeUndefined();
  });
});
