/**
 * The close-recovery sweep is the LAST step of the finalize cron. A failure
 * here must not erase the work the earlier steps already did — but it also must
 * not hide a real recovery failure, because an unrecovered close is an
 * operator's document sitting in limbo.
 */
import { describe, expect, it } from "bun:test";
import { recoverStrandedPendingCloses } from "@/lib/line/pending-close-recovery";

interface RpcError {
  message: string;
  code?: string;
}

function fakeDb(result: { data?: unknown; error?: RpcError | null }) {
  const calls: string[] = [];
  return {
    calls,
    rpc(name: string) {
      calls.push(name);
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("stranded close recovery", () => {
  it("reports what it recovered", async () => {
    const db = fakeDb({
      data: [{
        session_key: "group:C:user:A",
        session_generation: "gen-a",
        source_id: "C1",
        accountability_round_id: null,
        round_outcome: "cancelled",
        close_refused_at: new Date().toISOString(),
      }],
    });
    expect(await recoverStrandedPendingCloses(db)).toEqual({
      recovered: 1,
      roundsCancelled: 1,
    });
  });

  it("skips quietly when the function is not installed yet", async () => {
    // App-first deploy: 20260817090200 has not landed. Nothing this build wrote
    // is stranded yet, so there is nothing to recover and no reason to fail the
    // whole cron.
    for (const code of ["42883", "PGRST202"]) {
      const db = fakeDb({ error: { message: "function does not exist", code } });
      expect(await recoverStrandedPendingCloses(db)).toEqual({
        recovered: 0,
        roundsCancelled: 0,
      });
    }
  });

  it("still throws on every other RPC failure", async () => {
    // Matched on code, never on message text — otherwise a real failure whose
    // wording happened to mention a missing function would be swallowed.
    for (const error of [
      { message: "deadlock detected", code: "40P01" },
      { message: "permission denied for function", code: "42501" },
      { message: "function does not exist" },
      { message: "boom", code: null as unknown as string },
    ]) {
      await expect(recoverStrandedPendingCloses(fakeDb({ error })))
        .rejects.toThrow("stranded close recovery failed");
    }
  });
});
